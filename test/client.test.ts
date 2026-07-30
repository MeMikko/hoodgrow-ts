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
