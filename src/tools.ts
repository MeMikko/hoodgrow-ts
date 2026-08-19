import type { HoodGrowClient, RequestOptions } from "./client.js";
import type { OhlcInterval, SlippageSide } from "./types.js";

/**
 * Framework-agnostic tool definitions for wiring HoodGrow into any
 * function-calling agent (OpenAI, Anthropic, LangChain, Vercel AI SDK,
 * CrewAI, …). Each is the same read-only tool the `hoodgrow-mcp` server
 * exposes — name, natural-language description, and a JSON Schema for its
 * arguments — so an LLM can pick and call them.
 *
 * Two ways to use these:
 *   - Pass {@link hoodgrowOpenAiTools} / {@link hoodgrowAnthropicTools} straight
 *     into the OpenAI / Anthropic SDKs, then dispatch tool calls through
 *     {@link executeHoodGrowTool}.
 *   - Or read {@link hoodgrowTools} directly and adapt to any other framework
 *     (see the README for LangChain / Vercel AI SDK / CrewAI snippets).
 *
 * Zero extra dependencies — these are plain data plus a dispatcher over an
 * existing {@link HoodGrowClient}.
 */

/** A single JSON Schema object describing a tool's arguments. */
export interface ToolParameterSchema {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties: false;
}

/** A framework-agnostic tool definition. */
export interface HoodGrowToolDefinition {
  name: string;
  description: string;
  parameters: ToolParameterSchema;
}

const SYMBOL_PROP = {
  type: "string",
  description: 'Ticker symbol, e.g. "NVDA" (case-insensitive).',
} as const;

/**
 * The eight read-only HoodGrow tools, mirroring the `hoodgrow-mcp` server.
 * Prices shown are the x402 per-call cost (free with an API key).
 */
export const hoodgrowTools: readonly HoodGrowToolDefinition[] = [
  {
    name: "get_catalog",
    description:
      "Free catalog and live price feed for all Robinhood Chain stock tokens. Use " +
      "for token discovery, spot prices, and tracking market movers. Returns symbol, " +
      "name, contract address, live price, price source, 24h change and " +
      "corporate-action adjusted supply for every listed token, plus pending and " +
      "recent corporate actions. No API key and no payment. Carries no per-token " +
      "DeFi depth — use get_token or get_defi for that.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "get_token",
    description:
      "One Robinhood Chain stock token by symbol (e.g. NVDA): live price, " +
      "corporate-action adjusted supply, DeFi depth, and pending/recent corporate " +
      "actions. Unlike the free catalog this carries the token's DeFi depth ($0.05 " +
      "via x402, free with an API key). Fails for an unknown symbol.",
    parameters: {
      type: "object",
      properties: { symbol: SYMBOL_PROP },
      required: ["symbol"],
      additionalProperties: false,
    },
  },
  {
    name: "get_corporate_actions",
    description:
      "Pending (on-chain staged) and recent (official Robinhood ledger) corporate " +
      "actions — splits, dividends, name changes. Pass a symbol to scope to one token " +
      "(cheaper); omit it for every tracked token's corporate actions.",
    parameters: {
      type: "object",
      properties: {
        symbol: {
          type: "string",
          description: 'Ticker symbol to scope to, e.g. "NVDA". Omit for all tokens.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "get_defi",
    description:
      "Every Morpho lending market (as loan asset OR collateral, both roles labeled) " +
      "and Uniswap V3 pool involving one token — the full picture for comparing yield/" +
      "borrow options, not just the single best-APY figure in get_token. " +
      "$0.05 via x402, free with an API key. Fails for an unknown symbol.",
    parameters: {
      type: "object",
      properties: { symbol: SYMBOL_PROP },
      required: ["symbol"],
      additionalProperties: false,
    },
  },
  {
    name: "get_holders",
    description:
      "Holder-count trend, 24h net total_supply change (real mint/burn — creation/" +
      "redemption of the underlying tokenized shares, distinct from a corporate-action " +
      "multiplier change), and top-holder concentration for one token. $0.05 via x402, " +
      "free with an API key. Fails for an unknown symbol.",
    parameters: {
      type: "object",
      properties: {
        symbol: SYMBOL_PROP,
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 50,
          description: "How many top holders to return, 1-50. Defaults to 10.",
        },
      },
      required: ["symbol"],
      additionalProperties: false,
    },
  },
  {
    name: "get_slippage",
    description:
      "How much a USD-sized trade would move the price, per Uniswap V3 pool this token " +
      "trades on — plus bestPoolAddress/bestEffectivePrice picking the best of them. " +
      "Per-pool estimate, not an optimal multi-pool route/split; a likelyCrossesTick " +
      "flag means the trade may be large enough to understate real slippage (consider " +
      "splitting into TWAP tranches). $0.05 via x402, free with an API key.",
    parameters: {
      type: "object",
      properties: {
        symbol: SYMBOL_PROP,
        amountUsd: { type: "number", exclusiveMinimum: 0, description: "Trade size in USD." },
        side: {
          type: "string",
          enum: ["buy", "sell"],
          description:
            '"buy" spends USDG for the stock token, "sell" spends the stock token for USDG.',
        },
      },
      required: ["symbol", "amountUsd", "side"],
      additionalProperties: false,
    },
  },
  {
    name: "get_ohlc",
    description:
      "OHLC price candles for backtesting, bucketed from ~15-min price history. Each " +
      "candle also carries volumeUsd/swapCount — USD swap volume across the token's " +
      "Uniswap V3 pools, null for buckets older than the volume indexer's backfill " +
      "window. Defaults to the last 30 days if from/to are omitted; window capped at " +
      "730 days. $0.05 via x402, free with an API key. Fails for an unknown symbol.",
    parameters: {
      type: "object",
      properties: {
        symbol: SYMBOL_PROP,
        interval: { type: "string", enum: ["1h", "4h", "1d"], description: "Candle bucket size." },
        from: { type: "string", description: "ISO 8601 start (default: 30 days before `to`)." },
        to: { type: "string", description: "ISO 8601 end (default: now)." },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 1000,
          description: "Max candles to return, 1-1000. Defaults to 500.",
        },
      },
      required: ["symbol", "interval"],
      additionalProperties: false,
    },
  },
  {
    name: "get_base_tokens",
    description:
      "Base mainnet (chain 8453) B20 native-equity-token registry — verified on-chain " +
      "metadata for a fixed set of known tokens plus a liveness signal. PRE-LAUNCH: " +
      'every token currently has zero minted supply; status flips to "live" once real ' +
      "supply appears on-chain. Do not treat a pre_launch entry as tradable. $0.05 via " +
      "x402, free with an API key.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "get_markets",
    description:
      "Market movers across the Robinhood Chain stock-token catalog: top gainers and " +
      "losers by 24h price change, highest 24h swap volume, and deepest Uniswap V3 " +
      "liquidity (TVL). `limit` caps each list (1-50, default 10); gainers/losers can " +
      "be empty when the market is flat. $0.05 via x402, free with an API key.",
    parameters: {
      type: "object",
      properties: {
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 50,
          description: "Max entries per list (default 10).",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "get_trades",
    description:
      "Recent large (whale) trades in Robinhood Chain stock-token Uniswap V3 pools, " +
      "newest first — each with a buy/sell side, USD size, and transaction hash. Omit " +
      "`symbol` for the global feed. `limit` caps the list (1-100, default 20). $0.05 " +
      "via x402, free with an API key.",
    parameters: {
      type: "object",
      properties: {
        symbol: SYMBOL_PROP,
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 100,
          description: "Max trades to return (default 20).",
        },
      },
      additionalProperties: false,
    },
  },
];

/** Tool names as a union, for callers that want to switch exhaustively. */
export type HoodGrowToolName = (typeof hoodgrowTools)[number]["name"];

function str(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`HoodGrow tool arg "${field}" must be a non-empty string`);
  }
  return value;
}

/**
 * Execute one HoodGrow tool by name against a client, returning the raw
 * response object (the same shape the corresponding client method returns).
 * Throws `HoodGrowError` for an API failure, or `Error` for an unknown tool
 * name / missing required argument. `opts` (e.g. an idempotency key) is
 * forwarded to the underlying paid call.
 */
export async function executeHoodGrowTool(
  client: HoodGrowClient,
  name: string,
  args: Record<string, unknown> = {},
  opts?: RequestOptions
): Promise<unknown> {
  switch (name) {
    case "get_catalog":
      return client.getCatalog(opts);
    case "get_token":
      return client.getToken(str(args.symbol, "symbol"), opts);
    case "get_corporate_actions":
      return client.getCorporateActions(
        args.symbol === undefined ? undefined : str(args.symbol, "symbol"),
        opts
      );
    case "get_defi":
      return client.getDefi(str(args.symbol, "symbol"), opts);
    case "get_holders":
      return client.getHolders(
        str(args.symbol, "symbol"),
        args.limit === undefined ? undefined : Number(args.limit),
        opts
      );
    case "get_slippage":
      return client.getSlippage(
        str(args.symbol, "symbol"),
        Number(args.amountUsd),
        args.side as SlippageSide,
        opts
      );
    case "get_ohlc":
      return client.getOhlc(
        str(args.symbol, "symbol"),
        args.interval as OhlcInterval,
        {
          from: args.from as string | undefined,
          to: args.to as string | undefined,
          limit: args.limit === undefined ? undefined : Number(args.limit),
        },
        opts
      );
    case "get_base_tokens":
      return client.getBaseTokens(opts);
    case "get_markets":
      return client.getMarkets(
        { limit: args.limit === undefined ? undefined : Number(args.limit) },
        opts
      );
    case "get_trades":
      return client.getTrades(
        {
          symbol: args.symbol === undefined ? undefined : str(args.symbol, "symbol"),
          limit: args.limit === undefined ? undefined : Number(args.limit),
        },
        opts
      );
    default:
      throw new Error(`Unknown HoodGrow tool: ${name}`);
  }
}

/** OpenAI Chat Completions / Responses `tools` array. Pass straight to the SDK. */
export function hoodgrowOpenAiTools(): Array<{
  type: "function";
  function: HoodGrowToolDefinition;
}> {
  return hoodgrowTools.map((t) => ({ type: "function", function: t }));
}

/** Anthropic Messages `tools` array (`input_schema` instead of `parameters`). */
export function hoodgrowAnthropicTools(): Array<{
  name: string;
  description: string;
  input_schema: ToolParameterSchema;
}> {
  return hoodgrowTools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters,
  }));
}
