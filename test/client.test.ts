import { test } from "node:test";
import assert from "node:assert/strict";

import { HoodGrowClient, HoodGrowError } from "../src/index.js";

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

test("constructor throws without apiKey or signer", () => {
  assert.throws(() => new HoodGrowClient(), /requires either `apiKey` or `signer`/);
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
