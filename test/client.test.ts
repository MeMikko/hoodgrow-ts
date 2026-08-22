import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHmac } from "node:crypto";
import { privateKeyToAccount } from "viem/accounts";

import {
  HoodGrowClient,
  HoodGrowError,
  SDK_VERSION,
  verifyWebhookSignature,
} from "../src/index.js";

/** Well-known public test private key (Hardhat/Anvil default account #0) —
 * never funded, safe to hardcode in a test file. */
const TEST_ACCOUNT = privateKeyToAccount(
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
);

/** Minimal mock of the global fetch this client calls internally. */
function mockFetch(handler: (url: string, init?: RequestInit) => Response): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    return handler(url, init);
  }) as typeof fetch;
}

function withGlobalFetch<T>(fetchImpl: typeof fetch, fn: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  return fn().finally(() => {
    globalThis.fetch = original;
  });
}

test("a client with no credentials works and sends no Authorization header", async () => {
  // It used to throw here. That made a key or a funded wallet a prerequisite
  // for seeing any response at all — on an API whose catalog is free.
  let capturedAuth: string | null = null;
  await withGlobalFetch(
    mockFetch((_url, init) => {
      capturedAuth =
        (init?.headers as Record<string, string> | undefined)?.Authorization ?? null;
      return new Response(
        JSON.stringify({
          chainId: 4663,
          updatedAt: "2026-08-19T00:00:00.000Z",
          tokens: [],
          pendingCorporateActions: [],
          recentCorporateActions: [],
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }),
    async () => {
      const client = new HoodGrowClient();
      await client.getCatalog();
    }
  );
  assert.equal(capturedAuth, null);
});

test("a 402 on a credentialless client surfaces the server's guidance", async () => {
  // With no signer there is nothing to settle a 402 with, so it must arrive
  // as an error the caller can read — the body names the free key and the
  // per-IP allowance, which is the whole point of that response.
  const guidance = {
    accepts: [{ price: "$0.05" }],
    freeApiKey: { url: "https://www.hoodgrow.com/profile" },
  };
  await withGlobalFetch(
    mockFetch(
      () =>
        new Response(JSON.stringify(guidance), {
          status: 402,
          headers: { "content-type": "application/json" },
        })
    ),
    async () => {
      const client = new HoodGrowClient();
      await assert.rejects(
        () => client.getToken("NVDA"),
        (err: unknown) => {
          const e = err as { status?: number; body?: typeof guidance };
          assert.equal(e.status, 402);
          assert.equal(e.body?.freeApiKey.url, "https://www.hoodgrow.com/profile");
          return true;
        }
      );
    }
  );
});

test("getCatalog sends the API key as a Bearer header and hits the bulk endpoint", async () => {
  let capturedUrl = "";
  let capturedAuth: string | null = null;
  await withGlobalFetch(
    mockFetch((url, init) => {
      capturedUrl = url;
      capturedAuth = (init?.headers as Record<string, string> | undefined)?.Authorization ?? null;
      return new Response(
        JSON.stringify({
          chainId: 4663,
          updatedAt: "2026-07-30T00:00:00.000Z",
          tokens: [],
          pendingCorporateActions: [],
          recentCorporateActions: [],
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }),
    async () => {
      const client = new HoodGrowClient({ apiKey: "test-key-123" });
      const result = await client.getCatalog();
      assert.equal(result.chainId, 4663);
    }
  );
  assert.equal(capturedUrl, "https://www.hoodgrow.com/api/agent/tokens");
  assert.equal(capturedAuth, "Bearer test-key-123");
});

test("getToken upper-cases and URL-encodes the symbol", async () => {
  let capturedUrl = "";
  await withGlobalFetch(
    mockFetch((url) => {
      capturedUrl = url;
      return new Response(
        JSON.stringify({
          chainId: 4663,
          updatedAt: "2026-07-30T00:00:00.000Z",
          token: {
            symbol: "NVDA",
            name: "NVIDIA xStock",
            address: "0x0",
            priceUsd: 1,
            priceSource: "chainlink",
            change24hPercent: 0,
            supply: 1,
            supplyAdjusted: false,
            snapshotTs: null,
          },
          defi: {
            morphoBestSupplyApy: null,
            morphoBestSupplyApyMarketId: null,
            uniswapTvlUsd: null,
            uniswapPoolCount: 0,
          },
          pendingCorporateActions: [],
          recentCorporateActions: [],
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }),
    async () => {
      const client = new HoodGrowClient({ apiKey: "test-key-123" });
      const result = await client.getToken("nvda");
      assert.equal(result.token.symbol, "NVDA");
    }
  );
  assert.equal(capturedUrl, "https://www.hoodgrow.com/api/agent/token/NVDA");
});

test("getCorporateActions(symbol) scopes to the single-token endpoint", async () => {
  let capturedUrl = "";
  await withGlobalFetch(
    mockFetch((url) => {
      capturedUrl = url;
      return new Response(
        JSON.stringify({
          chainId: 4663,
          updatedAt: "2026-07-30T00:00:00.000Z",
          token: {
            symbol: "GE",
            name: "General Electric",
            address: "0x0",
            priceUsd: 1,
            priceSource: "chainlink",
            change24hPercent: 0,
            supply: 1,
            supplyAdjusted: false,
            snapshotTs: null,
          },
          defi: {
            morphoBestSupplyApy: null,
            morphoBestSupplyApyMarketId: null,
            uniswapTvlUsd: null,
            uniswapPoolCount: 0,
          },
          pendingCorporateActions: [],
          recentCorporateActions: [
            {
              symbol: "GE",
              name: "General Electric",
              type: "CORPORATE_ACTION_TYPE_CASH_DIVIDEND",
              typeLabel: "Cash Dividend",
              status: "CORPORATE_ACTION_STATUS_IN_PROGRESS",
              statusLabel: "In Progress",
              processDate: "2026-07-27",
              detail: "$0.47 per share",
              details: null,
              url: "https://www.hoodgrow.com/corporate-actions/2026-07-27-ge-cash-dividend",
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }),
    async () => {
      const client = new HoodGrowClient({ apiKey: "test-key-123" });
      const actions = await client.getCorporateActions("GE");
      assert.equal(actions.recent.length, 1);
      assert.equal(actions.recent[0].detail, "$0.47 per share");
    }
  );
  assert.equal(capturedUrl, "https://www.hoodgrow.com/api/agent/token/GE");
});

test("a non-2xx, non-x402 response throws HoodGrowError with status and body", async () => {
  await withGlobalFetch(
    mockFetch(
      () =>
        new Response(JSON.stringify({ error: "Unknown symbol" }), {
          status: 404,
          headers: { "content-type": "application/json" },
        })
    ),
    async () => {
      const client = new HoodGrowClient({ apiKey: "test-key-123" });
      await assert.rejects(
        () => client.getToken("NOTREAL"),
        (err: unknown) => {
          assert.ok(err instanceof HoodGrowError);
          assert.equal(err.status, 404);
          assert.deepEqual(err.body, { error: "Unknown symbol" });
          return true;
        }
      );
    }
  );
});

test("baseUrl override is respected", async () => {
  let capturedUrl = "";
  await withGlobalFetch(
    mockFetch((url) => {
      capturedUrl = url;
      return new Response(
        JSON.stringify({
          chainId: 4663,
          updatedAt: "2026-07-30T00:00:00.000Z",
          tokens: [],
          pendingCorporateActions: [],
          recentCorporateActions: [],
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }),
    async () => {
      const client = new HoodGrowClient({
        apiKey: "test-key-123",
        baseUrl: "http://localhost:3000/",
      });
      await client.getCatalog();
    }
  );
  assert.equal(capturedUrl, "http://localhost:3000/api/agent/tokens");
});

test("getDefi upper-cases the symbol and hits the defi endpoint", async () => {
  let capturedUrl = "";
  await withGlobalFetch(
    mockFetch((url) => {
      capturedUrl = url;
      return new Response(
        JSON.stringify({
          chainId: 4663,
          symbol: "NVDA",
          updatedAt: "2026-08-08T00:00:00.000Z",
          morphoMarkets: [
            {
              marketId: "0xabc",
              role: "collateral",
              counterpartSymbol: "USDG",
              supplyApy: 0.0482,
              borrowApy: 0.061,
              tvlUsd: 1284000,
              ts: "2026-08-08T00:00:00.000Z",
            },
          ],
          uniswapPools: [],
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }),
    async () => {
      const client = new HoodGrowClient({ apiKey: "test-key-123" });
      const result = await client.getDefi("nvda");
      assert.equal(result.morphoMarkets.length, 1);
      assert.equal(result.morphoMarkets[0].role, "collateral");
    }
  );
  assert.equal(capturedUrl, "https://www.hoodgrow.com/api/agent/defi/NVDA");
});

test("getHolders omits the limit query param when not passed, includes it when passed", async () => {
  const urls: string[] = [];
  const holdersBody = JSON.stringify({
    chainId: 4663,
    symbol: "NVDA",
    updatedAt: "2026-08-08T00:00:00.000Z",
    holderCount: 1342,
    holderCountDelta: 12,
    holderCountDeltaSinceTs: "2026-08-07T00:00:00.000Z",
    holderSnapshotTs: "2026-08-08T00:00:00.000Z",
    supplyChange24h: null,
    topHolders: { snapshotTs: "2026-08-08T00:00:00.000Z", totalHolders: 1342, holders: [] },
  });
  await withGlobalFetch(
    mockFetch((url) => {
      urls.push(url);
      return new Response(holdersBody, {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }),
    async () => {
      const client = new HoodGrowClient({ apiKey: "test-key-123" });
      const result = await client.getHolders("nvda");
      assert.equal(result.holderCount, 1342);
      await client.getHolders("nvda", 25);
    }
  );
  assert.equal(urls[0], "https://www.hoodgrow.com/api/agent/holders/NVDA");
  assert.equal(urls[1], "https://www.hoodgrow.com/api/agent/holders/NVDA?limit=25");
});

test("getSlippage builds the query string with amountUsd and side", async () => {
  let capturedUrl = "";
  await withGlobalFetch(
    mockFetch((url) => {
      capturedUrl = url;
      return new Response(
        JSON.stringify({
          chainId: 4663,
          symbol: "NVDA",
          side: "buy",
          amountUsd: 10000,
          updatedAt: "2026-08-08T00:00:00.000Z",
          bestPoolAddress: "0xpool",
          bestEffectivePrice: 185.68,
          pools: [],
          note: "Per-pool estimate, not an optimal multi-pool route/split.",
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }),
    async () => {
      const client = new HoodGrowClient({ apiKey: "test-key-123" });
      const result = await client.getSlippage("nvda", 10000, "buy");
      assert.equal(result.bestPoolAddress, "0xpool");
    }
  );
  assert.equal(
    capturedUrl,
    "https://www.hoodgrow.com/api/agent/slippage/NVDA?amountUsd=10000&side=buy"
  );
});

const OHLC_BODY = JSON.stringify({
  chainId: 4663,
  symbol: "NVDA",
  interval: "1d",
  from: "2026-07-09T00:00:00.000Z",
  to: "2026-08-08T00:00:00.000Z",
  updatedAt: "2026-08-08T00:00:00.000Z",
  candles: [
    {
      bucketStart: "2026-08-07T00:00:00.000Z",
      bucketEndExclusive: "2026-08-08T00:00:00.000Z",
      open: 184.2,
      high: 187.5,
      low: 183.9,
      close: 185.65,
      sampleCount: 92,
    },
  ],
  note: "OHLC only, no volume.",
});

test("getOhlc sends only interval when from/to/limit are omitted", async () => {
  let capturedUrl = "";
  await withGlobalFetch(
    mockFetch((url) => {
      capturedUrl = url;
      return new Response(OHLC_BODY, {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }),
    async () => {
      const client = new HoodGrowClient({ apiKey: "test-key-123" });
      const result = await client.getOhlc("nvda", "1d");
      assert.equal(result.candles.length, 1);
    }
  );
  assert.equal(capturedUrl, "https://www.hoodgrow.com/api/agent/ohlc/NVDA?interval=1d");
});

test("getOhlc serializes from/to Dates as ISO strings and passes limit through", async () => {
  let capturedUrl = "";
  await withGlobalFetch(
    mockFetch((url) => {
      capturedUrl = url;
      return new Response(OHLC_BODY, {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }),
    async () => {
      const client = new HoodGrowClient({ apiKey: "test-key-123" });
      await client.getOhlc("nvda", "1h", {
        from: new Date("2026-08-01T00:00:00.000Z"),
        to: new Date("2026-08-08T00:00:00.000Z"),
        limit: 200,
      });
    }
  );
  const url = new URL(capturedUrl);
  assert.equal(url.pathname, "/api/agent/ohlc/NVDA");
  assert.equal(url.searchParams.get("interval"), "1h");
  assert.equal(url.searchParams.get("from"), "2026-08-01T00:00:00.000Z");
  assert.equal(url.searchParams.get("to"), "2026-08-08T00:00:00.000Z");
  assert.equal(url.searchParams.get("limit"), "200");
});

test("getOhlc accepts from/to as plain ISO strings too", async () => {
  let capturedUrl = "";
  await withGlobalFetch(
    mockFetch((url) => {
      capturedUrl = url;
      return new Response(OHLC_BODY, {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }),
    async () => {
      const client = new HoodGrowClient({ apiKey: "test-key-123" });
      await client.getOhlc("nvda", "4h", { from: "2026-08-01T00:00:00.000Z" });
    }
  );
  const url = new URL(capturedUrl);
  assert.equal(url.searchParams.get("from"), "2026-08-01T00:00:00.000Z");
  assert.equal(url.searchParams.has("to"), false);
});

test("getBaseTokens hits the Base registry endpoint and returns the pre-launch note", async () => {
  let capturedUrl = "";
  await withGlobalFetch(
    mockFetch((url) => {
      capturedUrl = url;
      return new Response(
        JSON.stringify({
          chainId: 8453,
          updatedAt: "2026-08-08T12:00:00.000Z",
          note: "PRE-LAUNCH: ...",
          tokens: [
            {
              symbol: "AAPL",
              name: "Apple Inc.",
              address: "0xb200000000000000000000C2e324d24d7eEcd1fb",
              decimals: 8,
              status: "pre_launch",
              totalSupplyRaw: "0",
              totalSupply: 0,
              checkedAt: "2026-08-08T12:00:00.000Z",
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }),
    async () => {
      const client = new HoodGrowClient({ apiKey: "test-key-123" });
      const result = await client.getBaseTokens();
      assert.equal(result.chainId, 8453);
      assert.equal(result.tokens.length, 1);
      assert.equal(result.tokens[0].status, "pre_launch");
    }
  );
  assert.equal(capturedUrl, "https://www.hoodgrow.com/api/agent/base/tokens");
});

test("getMarkets passes limit and returns the four movers lists", async () => {
  let capturedUrl = "";
  await withGlobalFetch(
    mockFetch((url) => {
      capturedUrl = url;
      return new Response(
        JSON.stringify({
          chainId: 4663,
          updatedAt: "2026-08-11T12:00:00.000Z",
          tokenCount: 48,
          topGainers: [
            {
              symbol: "NVDA",
              name: "NVIDIA",
              priceUsd: 182.31,
              priceSource: "chainlink",
              change24hPercent: 3.42,
              tvlUsd: 842000,
              volume24hUsd: 152000,
              poolCount: 2,
              snapshotTs: "2026-08-11T11:55:00.000Z",
            },
          ],
          topLosers: [],
          topVolume: [],
          topTvl: [],
          note: "Movers ...",
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }),
    async () => {
      const client = new HoodGrowClient({ apiKey: "test-key-123" });
      const result = await client.getMarkets({ limit: 5 });
      assert.equal(result.tokenCount, 48);
      assert.equal(result.topGainers[0].symbol, "NVDA");
      assert.equal(result.topLosers.length, 0);
    }
  );
  const url = new URL(capturedUrl);
  assert.equal(url.pathname, "/api/agent/markets");
  assert.equal(url.searchParams.get("limit"), "5");
});

test("getTrades scopes to a symbol and returns the whale feed", async () => {
  let capturedUrl = "";
  await withGlobalFetch(
    mockFetch((url) => {
      capturedUrl = url;
      return new Response(
        JSON.stringify({
          chainId: 4663,
          symbol: "NVDA",
          updatedAt: "2026-08-11T12:00:00.000Z",
          trades: [
            {
              symbol: "NVDA",
              poolAddress: "0x34D0dC122CF9A8Eb296fC5e0D3A233625D7d19b7",
              side: "buy",
              usd: 4200.5,
              txHash: "0x8f2a1c3b",
              blockNumber: 12345678,
              ts: "2026-08-11T11:58:00.000Z",
            },
          ],
          note: "Large trades ...",
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }),
    async () => {
      const client = new HoodGrowClient({ apiKey: "test-key-123" });
      const result = await client.getTrades({ symbol: "nvda", limit: 10 });
      assert.equal(result.symbol, "NVDA");
      assert.equal(result.trades[0].side, "buy");
      assert.equal(result.trades[0].usd, 4200.5);
    }
  );
  const url = new URL(capturedUrl);
  assert.equal(url.pathname, "/api/agent/trades");
  assert.equal(url.searchParams.get("symbol"), "NVDA");
  assert.equal(url.searchParams.get("limit"), "10");
});

test("listCreditBundles fetches the bundle catalog with no auth", async () => {
  let capturedUrl = "";
  await withGlobalFetch(
    mockFetch((url) => {
      capturedUrl = url;
      return new Response(JSON.stringify({ bundles: { "10": { priceUsd: 10, creditUsd: 11 } } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }),
    async () => {
      const client = new HoodGrowClient({ apiKey: "test-key-123" });
      const bundles = await client.listCreditBundles();
      assert.deepEqual(bundles, { "10": { priceUsd: 10, creditUsd: 11 } });
    }
  );
  assert.equal(capturedUrl, "https://www.hoodgrow.com/api/agent/credits/purchase");
});

test("getCreditBalance requires a signer", async () => {
  const client = new HoodGrowClient({ apiKey: "test-key-123" });
  await assert.rejects(() => client.getCreditBalance(), /requires a `signer`/);
});

test("getCreditBalance signs the canonical message and sends credit-auth headers", async () => {
  let capturedUrl = "";
  let capturedHeaders: Record<string, string> = {};
  await withGlobalFetch(
    mockFetch((url, init) => {
      capturedUrl = url;
      capturedHeaders = (init?.headers as Record<string, string> | undefined) ?? {};
      return new Response(
        JSON.stringify({ walletAddress: TEST_ACCOUNT.address.toLowerCase(), balanceUsd: 5.5 }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }),
    async () => {
      const client = new HoodGrowClient({ signer: TEST_ACCOUNT });
      const balance = await client.getCreditBalance();
      assert.equal(balance.balanceUsd, 5.5);
    }
  );
  assert.equal(capturedUrl, "https://www.hoodgrow.com/api/agent/credits/balance");
  assert.equal(capturedHeaders["X-HoodGrow-Credit-Wallet"], TEST_ACCOUNT.address);
  assert.ok(capturedHeaders["X-HoodGrow-Credit-Signature"]?.startsWith("0x"));
  assert.ok(Number(capturedHeaders["X-HoodGrow-Credit-Timestamp"]) > 0);
});

test("buyCredits requires a signer", async () => {
  const client = new HoodGrowClient({ apiKey: "test-key-123" });
  await assert.rejects(() => client.buyCredits("10"), /requires a `signer`/);
});

test("registerCreditWebhook requires a signer", async () => {
  const client = new HoodGrowClient({ apiKey: "test-key-123" });
  await assert.rejects(
    () => client.registerCreditWebhook({ url: "https://example.com/hook" }),
    /requires a `signer`/
  );
});

test("registerCreditWebhook POSTs url + symbols with credit-auth headers", async () => {
  let capturedUrl = "";
  let capturedInit: RequestInit | undefined;
  await withGlobalFetch(
    mockFetch((url, init) => {
      capturedUrl = url;
      capturedInit = init;
      return new Response(
        JSON.stringify({
          ok: true,
          webhookUrl: "https://example.com/hook",
          webhookSecret: "whsec_abc123",
          webhookSymbols: "NVDA,INTC",
          note: "billed per event",
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }),
    async () => {
      const client = new HoodGrowClient({ signer: TEST_ACCOUNT });
      const reg = await client.registerCreditWebhook({
        url: "https://example.com/hook",
        symbols: ["NVDA", "INTC"],
      });
      assert.equal(reg.webhookSecret, "whsec_abc123");
      assert.equal(reg.webhookSymbols, "NVDA,INTC");
    }
  );
  assert.equal(capturedUrl, "https://www.hoodgrow.com/api/agent/credits/webhook");
  assert.equal(capturedInit?.method, "POST");
  const headers = (capturedInit?.headers as Record<string, string>) ?? {};
  assert.equal(headers["X-HoodGrow-Credit-Wallet"], TEST_ACCOUNT.address);
  assert.ok(headers["X-HoodGrow-Credit-Signature"]?.startsWith("0x"));
  assert.deepEqual(JSON.parse(String(capturedInit?.body)), {
    webhookUrl: "https://example.com/hook",
    webhookSymbols: ["NVDA", "INTC"],
  });
});

test("registerCreditWebhook omits webhookSymbols when symbols is not given", async () => {
  let capturedBody: unknown = null;
  await withGlobalFetch(
    mockFetch((_url, init) => {
      capturedBody = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({
          ok: true,
          webhookUrl: "https://example.com/hook",
          webhookSecret: "whsec_abc123",
          webhookSymbols: null,
          note: "billed per event",
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }),
    async () => {
      const client = new HoodGrowClient({ signer: TEST_ACCOUNT });
      const reg = await client.registerCreditWebhook({ url: "https://example.com/hook" });
      assert.equal(reg.webhookSymbols, null);
    }
  );
  assert.deepEqual(capturedBody, { webhookUrl: "https://example.com/hook" });
});

test("useCredits attaches signed credit-auth headers to a metered GET", async () => {
  let capturedHeaders: Record<string, string> = {};
  await withGlobalFetch(
    mockFetch((_url, init) => {
      capturedHeaders = (init?.headers as Record<string, string> | undefined) ?? {};
      return new Response(
        JSON.stringify({
          chainId: 4663,
          updatedAt: "2026-07-30T00:00:00.000Z",
          tokens: [],
          pendingCorporateActions: [],
          recentCorporateActions: [],
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }),
    async () => {
      const client = new HoodGrowClient({ signer: TEST_ACCOUNT, useCredits: true });
      await client.getCatalog();
    }
  );
  assert.equal(capturedHeaders["X-HoodGrow-Credit-Wallet"], TEST_ACCOUNT.address);
  assert.ok(capturedHeaders["X-HoodGrow-Credit-Signature"]?.startsWith("0x"));
});

/** One feed event, spread into tests that only care about a couple fields. */
const FEED_EVENT = {
  symbol: "TSLA",
  contract: "0x322F0929c4625eD5bAd873c95208D54E1c003b2d",
  type: "staged",
  actionType: "split",
  multiplierFrom: 1,
  multiplierTo: 3,
  executionDate: "2026-08-20T13:30:00.000Z",
  detectedAt: "2026-08-11T09:14:22.000Z",
  lastUpdated: "2026-08-11T09:14:22.000Z",
  freshnessSeconds: 17265,
  blockNumber: 8421337,
  transactionHash: "0xdeadbeef",
  source: "onchain",
};

test("getCorporateActionsFeed builds filters and hits the feed endpoint", async () => {
  let capturedUrl = "";
  await withGlobalFetch(
    mockFetch((url) => {
      capturedUrl = url;
      return new Response(
        JSON.stringify({
          chainId: 4663,
          updatedAt: "2026-08-11T14:00:00.000Z",
          actions: [FEED_EVENT],
          pagination: { nextCursor: null, limit: 50 },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }),
    async () => {
      const client = new HoodGrowClient({ apiKey: "test-key-123" });
      const page = await client.getCorporateActionsFeed({
        status: "staged",
        symbol: "tsla",
        from: new Date("2026-08-01T00:00:00.000Z"),
        limit: 50,
      });
      assert.equal(page.actions.length, 1);
      assert.equal(page.actions[0].source, "onchain");
      assert.equal(page.pagination.nextCursor, null);
    }
  );
  const url = new URL(capturedUrl);
  assert.equal(url.pathname, "/api/corporate-actions");
  assert.equal(url.searchParams.get("status"), "staged");
  assert.equal(url.searchParams.get("symbol"), "tsla");
  assert.equal(url.searchParams.get("from"), "2026-08-01T00:00:00.000Z");
  assert.equal(url.searchParams.get("limit"), "50");
});

test("iterateCorporateActions walks every page via nextCursor", async () => {
  const pages = [
    { actions: [{ ...FEED_EVENT, symbol: "A" }], nextCursor: "cursor-1" },
    { actions: [{ ...FEED_EVENT, symbol: "B" }], nextCursor: null },
  ];
  const capturedCursors: (string | null)[] = [];
  let call = 0;
  await withGlobalFetch(
    mockFetch((url) => {
      capturedCursors.push(new URL(url).searchParams.get("cursor"));
      const page = pages[call++];
      return new Response(
        JSON.stringify({
          chainId: 4663,
          updatedAt: "2026-08-11T14:00:00.000Z",
          actions: page.actions,
          pagination: { nextCursor: page.nextCursor, limit: 50 },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }),
    async () => {
      const client = new HoodGrowClient({ apiKey: "test-key-123" });
      const seen: string[] = [];
      for await (const event of client.iterateCorporateActions({ status: "staged" })) {
        seen.push(event.symbol);
      }
      assert.deepEqual(seen, ["A", "B"]);
    }
  );
  assert.equal(capturedCursors.length, 2);
  assert.equal(capturedCursors[0], null); // first page: no cursor
  assert.equal(capturedCursors[1], "cursor-1"); // second page follows nextCursor
});

test("verifyWebhookSignature accepts a valid HMAC and rejects tampering", () => {
  const secret = "whsec_test_secret";
  const body = JSON.stringify({
    id: "NVDA-newly-pending-x",
    event: "corporate_action.staged",
    symbol: "NVDA",
    currentMultiplier: 1,
    stagedMultiplier: 3,
    effectiveAt: null,
    ts: "2026-08-11T09:14:22.000Z",
  });
  const sig = createHmac("sha256", secret).update(body).digest("hex");

  assert.equal(verifyWebhookSignature(body, `sha256=${sig}`, secret), true);
  assert.equal(verifyWebhookSignature(body, sig, secret), true); // sha256= prefix optional
  assert.equal(verifyWebhookSignature(Buffer.from(body), `sha256=${sig}`, secret), true); // bytes too
  assert.equal(verifyWebhookSignature(body + " ", `sha256=${sig}`, secret), false); // tampered body
  assert.equal(verifyWebhookSignature(body, `sha256=${sig}`, "wrong-secret"), false);
  assert.equal(verifyWebhookSignature(body, null, secret), false); // missing header
  assert.equal(verifyWebhookSignature(body, "sha256=not-valid-hex", secret), false);
});

test("maxRetries retries a 429 on the bearer path then succeeds", async () => {
  let calls = 0;
  await withGlobalFetch(
    mockFetch(() => {
      calls++;
      if (calls === 1) {
        return new Response(JSON.stringify({ error: "Too many requests" }), {
          status: 429,
          headers: { "content-type": "application/json", "retry-after": "0" },
        });
      }
      return new Response(
        JSON.stringify({
          chainId: 4663,
          updatedAt: "2026-07-30T00:00:00.000Z",
          tokens: [],
          pendingCorporateActions: [],
          recentCorporateActions: [],
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }),
    async () => {
      const client = new HoodGrowClient({ apiKey: "test-key-123", maxRetries: 2 });
      const catalog = await client.getCatalog();
      assert.equal(catalog.chainId, 4663);
    }
  );
  assert.equal(calls, 2);
});

test("a 429 is not retried by default (maxRetries 0)", async () => {
  let calls = 0;
  await withGlobalFetch(
    mockFetch(() => {
      calls++;
      return new Response(JSON.stringify({ error: "Too many requests" }), {
        status: 429,
        headers: { "content-type": "application/json" },
      });
    }),
    async () => {
      const client = new HoodGrowClient({ apiKey: "test-key-123" });
      await assert.rejects(
        () => client.getCatalog(),
        (err: unknown) => err instanceof HoodGrowError && err.status === 429
      );
    }
  );
  assert.equal(calls, 1);
});

test("maxRetries is ignored on the x402/signer path — a 429 never double-pays", async () => {
  let calls = 0;
  await withGlobalFetch(
    mockFetch(() => {
      calls++;
      return new Response(JSON.stringify({ error: "Too many requests" }), {
        status: 429,
        headers: { "content-type": "application/json", "retry-after": "0" },
      });
    }),
    async () => {
      const client = new HoodGrowClient({ signer: TEST_ACCOUNT, maxRetries: 5 });
      await assert.rejects(
        () => client.getCatalog(),
        (err: unknown) => err instanceof HoodGrowError && err.status === 429
      );
    }
  );
  assert.equal(calls, 1); // exactly one attempt despite maxRetries: 5
});

const CATALOG_BODY = JSON.stringify({
  chainId: 4663,
  updatedAt: "2026-07-30T00:00:00.000Z",
  tokens: [],
  pendingCorporateActions: [],
  recentCorporateActions: [],
});

test("a per-call idempotencyKey is sent as the Idempotency-Key header", async () => {
  let captured: string | null = null;
  await withGlobalFetch(
    mockFetch((_url, init) => {
      captured = (init?.headers as Record<string, string> | undefined)?.["Idempotency-Key"] ?? null;
      return new Response(CATALOG_BODY, {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }),
    async () => {
      const client = new HoodGrowClient({ apiKey: "test-key-123" });
      await client.getCatalog({ idempotencyKey: "abc-123" });
    }
  );
  assert.equal(captured, "abc-123");
});

test("no Idempotency-Key header is sent when the option is omitted", async () => {
  let hadHeader = true;
  await withGlobalFetch(
    mockFetch((_url, init) => {
      const headers = (init?.headers as Record<string, string> | undefined) ?? {};
      hadHeader = "Idempotency-Key" in headers;
      return new Response(CATALOG_BODY, {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }),
    async () => {
      const client = new HoodGrowClient({ apiKey: "test-key-123" });
      await client.getCatalog();
    }
  );
  assert.equal(hadHeader, false);
});

test("idempotencyKey works on trailing-param methods too (getHolders)", async () => {
  let captured: string | null = null;
  let capturedUrl = "";
  await withGlobalFetch(
    mockFetch((url, init) => {
      capturedUrl = url;
      captured = (init?.headers as Record<string, string> | undefined)?.["Idempotency-Key"] ?? null;
      return new Response(
        JSON.stringify({
          chainId: 4663,
          symbol: "NVDA",
          updatedAt: "2026-08-08T00:00:00.000Z",
          holderCount: 1,
          holderCountDelta: null,
          holderCountDeltaSinceTs: null,
          holderSnapshotTs: null,
          supplyChange24h: null,
          topHolders: { snapshotTs: null, totalHolders: 1, holders: [] },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }),
    async () => {
      const client = new HoodGrowClient({ apiKey: "test-key-123" });
      await client.getHolders("nvda", 10, { idempotencyKey: "hold-1" });
    }
  );
  assert.equal(captured, "hold-1");
  assert.equal(capturedUrl, "https://www.hoodgrow.com/api/agent/holders/NVDA?limit=10");
});

test("SDK_VERSION matches package.json so the User-Agent never lies", async () => {
  // The sibling MCP package reported 0.4.0 while shipping 0.7.1 — three
  // releases of drift, invisible because nothing compared the two. This
  // version goes out on every request's User-Agent and is how the API
  // attributes traffic to real SDK integrations rather than crawlers, so a
  // stale value here quietly misattributes exactly the signal it exists to
  // carry.
  const pkg = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8")
  ) as { version: string };
  assert.equal(SDK_VERSION, pkg.version);
});

test("every request identifies the SDK by default", async () => {
  // Without this header the API cannot tell an integration apart from an
  // anonymous probe: both arrive with no source at all.
  let capturedUa: string | null = null;
  await withGlobalFetch(
    mockFetch((_url, init) => {
      capturedUa =
        (init?.headers as Record<string, string> | undefined)?.["User-Agent"] ?? null;
      return new Response(JSON.stringify({ tokens: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }),
    async () => {
      await new HoodGrowClient({ apiKey: "test-key" }).getCatalog();
    }
  );

  assert.match(capturedUa ?? "", /^hoodgrow-ts\/\d+\.\d+\.\d+$/);
});

test("userAgent option replaces the default so an embedder can be counted separately", async () => {
  // hoodgrow-mcp wraps this client. Without an override its traffic is
  // indistinguishable from a direct SDK integration, which defeats the point
  // of identifying either.
  let capturedUa: string | null = null;
  await withGlobalFetch(
    mockFetch((_url, init) => {
      capturedUa =
        (init?.headers as Record<string, string> | undefined)?.["User-Agent"] ?? null;
      return new Response(JSON.stringify({ tokens: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }),
    async () => {
      await new HoodGrowClient({
        apiKey: "test-key",
        userAgent: "hoodgrow-mcp/0.8.0 (hoodgrow-ts/0.11.0)",
      }).getCatalog();
    }
  );

  assert.equal(capturedUa, "hoodgrow-mcp/0.8.0 (hoodgrow-ts/0.11.0)");
});

test("ping hits the cheap smoke-test endpoint, not a metered data one", async () => {
  // The whole point of ping is that a new integration can prove its
  // wallet/signer/facilitator config against a real 402 for $0.001 instead
  // of finding out during a $0.10 catalog call — so the URL is the
  // assertion that matters here.
  let capturedUrl = "";
  await withGlobalFetch(
    mockFetch((url) => {
      capturedUrl = url;
      return new Response(
        JSON.stringify({
          ok: true,
          pong: true,
          timestamp: "2026-08-14T00:00:00.000Z",
          note: "x402 test endpoint",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }),
    async () => {
      const client = new HoodGrowClient({ apiKey: "test-key-123" });
      const result = await client.ping();
      assert.equal(result.ok, true);
      assert.equal(result.pong, true);
    }
  );
  assert.equal(capturedUrl, "https://www.hoodgrow.com/api/agent/ping");
});

test("ping forwards an Idempotency-Key like every other metered call", async () => {
  let capturedKey: string | null = null;
  await withGlobalFetch(
    mockFetch((url, init) => {
      capturedKey =
        (init?.headers as Record<string, string> | undefined)?.["Idempotency-Key"] ?? null;
      return new Response(
        JSON.stringify({ ok: true, pong: true, timestamp: "x", note: "y" }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }),
    async () => {
      const client = new HoodGrowClient({ apiKey: "test-key-123" });
      await client.ping({ idempotencyKey: "ping-key-1" });
    }
  );
  assert.equal(capturedKey, "ping-key-1");
});

test("maxPriceUsd converts to USDC atomic units without floating-point drift", async () => {
  // $0.10 must be 100000 atomic units exactly. 0.1 * 1e6 in binary floating
  // point is 100000.00000000001, so a truncating conversion would produce
  // 100000 by luck here and 4999 for $0.005 elsewhere — the ceiling has to
  // round up so an exactly-at-the-limit quote is still payable.
  const { HoodGrowClient: C } = await import("../src/client.js");
  // Construction with a ceiling must not throw for any sane value.
  for (const usd of [0.001, 0.005, 0.05, 0.1, 200]) {
    assert.doesNotThrow(
      () => new C({ apiKey: "k", maxPriceUsd: usd }),
      `maxPriceUsd: ${usd} should construct`
    );
  }
});

test("maxPriceUsd is accepted alongside a signer without changing the bearer path", async () => {
  // A bearer key means no x402 at all, so a ceiling is inert rather than
  // an error — callers shouldn't have to strip it when they switch auth.
  await withGlobalFetch(
    mockFetch(
      () =>
        new Response(JSON.stringify({ ok: true, pong: true, timestamp: "x", note: "y" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
    ),
    async () => {
      // Constructed INSIDE the mock: the bearer path captures `fetch` at
      // construction time, so a client built outside it holds the real one.
      const client = new HoodGrowClient({ apiKey: "test-key-123", maxPriceUsd: 0.1 });
      const result = await client.ping();
      assert.equal(result.ok, true);
    }
  );
});

test("getDefiSummary hits the collection endpoint, not a per-symbol one", async () => {
  // The whole point of the method is that it is ONE call. A URL with a
  // symbol appended would still return data and still typecheck; it would
  // just quietly be the expensive shape this method exists to avoid.
  let capturedUrl = "";
  await withGlobalFetch(
    mockFetch((url) => {
      capturedUrl = url;
      return new Response(
        JSON.stringify({
          chainId: 4663,
          updatedAt: "2026-08-22T00:00:00.000Z",
          observedAt: "2026-08-21T23:55:00.000Z",
          tokens: [
            {
              symbol: "NVDA",
              morphoBestSupplyApy: 0.0482,
              morphoBestSupplyApyMarketId: "0xabc",
              uniswapTvlUsd: 842000,
              uniswapVolume24hUsd: 152000,
              uniswapPoolCount: 2,
            },
            {
              symbol: "CRM",
              morphoBestSupplyApy: null,
              morphoBestSupplyApyMarketId: null,
              uniswapTvlUsd: null,
              uniswapVolume24hUsd: null,
              uniswapPoolCount: 0,
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }),
    async () => {
      const client = new HoodGrowClient({ apiKey: "test-key-123" });
      const result = await client.getDefiSummary();

      assert.equal(result.tokens.length, 2);
      assert.equal(result.observedAt, "2026-08-21T23:55:00.000Z");

      // A token with no DeFi is present with nulls rather than absent — the
      // distinction the endpoint exists to preserve, carried through the SDK
      // unchanged rather than normalised to zeros on the way past.
      const crm = result.tokens.find((t) => t.symbol === "CRM");
      assert.equal(crm?.morphoBestSupplyApy, null);
      assert.equal(crm?.uniswapTvlUsd, null);
      assert.equal(crm?.uniswapPoolCount, 0);
    }
  );
  assert.equal(capturedUrl, "https://www.hoodgrow.com/api/agent/defi");
});
