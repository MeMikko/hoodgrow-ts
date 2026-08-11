import { test } from "node:test";
import assert from "node:assert/strict";

import {
  HoodGrowClient,
  hoodgrowTools,
  executeHoodGrowTool,
  hoodgrowOpenAiTools,
  hoodgrowAnthropicTools,
} from "../src/index.js";

function mockFetch(handler: (url: string) => Response): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    return handler(url);
  }) as typeof fetch;
}

function withGlobalFetch<T>(fetchImpl: typeof fetch, fn: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  return fn().finally(() => {
    globalThis.fetch = original;
  });
}

const EXPECTED_TOOLS = [
  "get_catalog",
  "get_token",
  "get_corporate_actions",
  "get_defi",
  "get_holders",
  "get_slippage",
  "get_ohlc",
  "get_base_tokens",
  "get_markets",
  "get_trades",
];

test("hoodgrowTools exposes the read tools with object schemas", () => {
  assert.deepEqual(
    hoodgrowTools.map((t) => t.name),
    EXPECTED_TOOLS
  );
  for (const t of hoodgrowTools) {
    assert.equal(t.parameters.type, "object");
    assert.equal(t.parameters.additionalProperties, false);
    assert.ok(t.description.length > 20);
  }
  const slippage = hoodgrowTools.find((t) => t.name === "get_slippage")!;
  assert.deepEqual(slippage.parameters.required, ["symbol", "amountUsd", "side"]);
});

test("OpenAI and Anthropic adapters wrap the same tools", () => {
  const openai = hoodgrowOpenAiTools();
  assert.equal(openai.length, EXPECTED_TOOLS.length);
  assert.equal(openai[0].type, "function");
  assert.equal(openai[0].function.name, "get_catalog");

  const anthropic = hoodgrowAnthropicTools();
  assert.equal(anthropic[1].name, "get_token");
  assert.equal(anthropic[1].input_schema.type, "object");
  // Anthropic uses input_schema, never `parameters`.
  assert.ok(!("parameters" in anthropic[1]));
});

test("executeHoodGrowTool dispatches to the right endpoint per tool", async () => {
  const urls: Record<string, string> = {};
  await withGlobalFetch(
    mockFetch((url) => {
      const path = new URL(url).pathname;
      urls[path] = url;
      // Every read endpoint here just needs *some* 200 JSON to parse.
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }),
    async () => {
      const client = new HoodGrowClient({ apiKey: "k" });
      await executeHoodGrowTool(client, "get_catalog");
      await executeHoodGrowTool(client, "get_token", { symbol: "nvda" });
      await executeHoodGrowTool(client, "get_slippage", {
        symbol: "nvda",
        amountUsd: 10000,
        side: "buy",
      });
      await executeHoodGrowTool(client, "get_ohlc", { symbol: "nvda", interval: "1d", limit: 30 });
    }
  );

  assert.ok(urls["/api/agent/tokens"]);
  assert.ok(urls["/api/agent/token/NVDA"]);
  const slip = new URL(urls["/api/agent/slippage/NVDA"]);
  assert.equal(slip.searchParams.get("amountUsd"), "10000");
  assert.equal(slip.searchParams.get("side"), "buy");
  const ohlc = new URL(urls["/api/agent/ohlc/NVDA"]);
  assert.equal(ohlc.searchParams.get("interval"), "1d");
  assert.equal(ohlc.searchParams.get("limit"), "30");
});

test("executeHoodGrowTool forwards an idempotency key", async () => {
  let captured: string | null = null;
  await withGlobalFetch(
    (async (input: RequestInfo | URL, init?: RequestInit) => {
      captured =
        (init?.headers as Record<string, string> | undefined)?.["Idempotency-Key"] ?? null;
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch,
    async () => {
      const client = new HoodGrowClient({ apiKey: "k" });
      await executeHoodGrowTool(client, "get_catalog", {}, { idempotencyKey: "tool-1" });
    }
  );
  assert.equal(captured, "tool-1");
});

test("executeHoodGrowTool rejects an unknown tool name", async () => {
  const client = new HoodGrowClient({ apiKey: "k" });
  await assert.rejects(
    () => executeHoodGrowTool(client, "get_moon_phase"),
    /Unknown HoodGrow tool: get_moon_phase/
  );
});

test("executeHoodGrowTool rejects a missing required argument", async () => {
  const client = new HoodGrowClient({ apiKey: "k" });
  await assert.rejects(
    () => executeHoodGrowTool(client, "get_token", {}),
    /must be a non-empty string/
  );
});
