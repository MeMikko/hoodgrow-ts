import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import type { LocalAccount } from "viem";

import type {
  BaseTokensResponse,
  CatalogResponse,
  CorporateActions,
  DefiDetailResponse,
  HoldersResponse,
  OhlcInterval,
  OhlcResponse,
  SlippageResponse,
  SlippageSide,
  TokenDetailResponse,
} from "./types.js";

const DEFAULT_BASE_URL = "https://www.hoodgrow.com";
/** Base mainnet, CAIP-2 form — the only network HoodGrow's x402 paywall accepts. */
const NETWORK = "eip155:8453";

export interface HoodGrowClientOptions {
  /**
   * Bearer API key issued from HoodGrow's /admin/api-keys — calls are
   * free (no x402 payment) and unrate-limited beyond the key's own
   * configured limit. Takes priority over `signer` if both are set.
   */
  apiKey?: string;
  /**
   * A viem `LocalAccount` (e.g. from `privateKeyToAccount`, or a KMS/HSM-
   * backed custom account that can sign locally) used to auto-pay per
   * call via x402 — USDC on Base, $0.10 for the full catalog, $0.05 for a
   * single token. A JSON-RPC/browser-wallet account won't work here; x402
   * needs a signer that can sign typed data without a user prompt. Every
   * payment this client makes is real money; never hardcode a raw private
   * key in source, load it from an environment variable or secret
   * manager, and only fund the wallet with what you're willing to spend
   * on this API.
   */
  signer?: LocalAccount;
  /** Override the API base URL — for testing against a non-production
   * deployment. Defaults to https://www.hoodgrow.com. */
  baseUrl?: string;
}

/** Thrown for any non-2xx response other than a 402 x402 handles itself. */
export class HoodGrowError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: unknown
  ) {
    super(message);
    this.name = "HoodGrowError";
  }
}

/**
 * Client for the HoodGrow agent API (https://www.hoodgrow.com/api-access).
 * Construct with either `apiKey` (free, issued access) or `signer` (x402
 * pay-per-call, no signup) — exactly one is required.
 */
export class HoodGrowClient {
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;
  private readonly headers: Record<string, string>;

  constructor(options: HoodGrowClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.headers = {};

    if (options.apiKey) {
      this.headers.Authorization = `Bearer ${options.apiKey}`;
      this.fetchFn = fetch;
    } else if (options.signer) {
      const client = new x402Client().register(NETWORK, new ExactEvmScheme(options.signer));
      this.fetchFn = wrapFetchWithPayment(fetch, client);
    } else {
      throw new Error(
        "HoodGrowClient requires either `apiKey` or `signer` — see https://github.com/MeMikko/hoodgrow-ts#readme"
      );
    }
  }

  private async request<T>(path: string): Promise<T> {
    const res = await this.fetchFn(`${this.baseUrl}${path}`, { headers: this.headers });
    if (!res.ok) {
      let body: unknown = null;
      try {
        body = await res.json();
      } catch {
        // Non-JSON error body — leave `body` null, `status`/`message` still tell the caller what happened.
      }
      throw new HoodGrowError(
        `HoodGrow API request failed: ${res.status} ${res.statusText}`,
        res.status,
        body
      );
    }
    return (await res.json()) as T;
  }

  /**
   * The full token catalog — every listed Robinhood Chain stock token,
   * with price, corporate-action adjusted supply, and DeFi depth.
   * $0.10/call via x402, free with an API key.
   */
  async getCatalog(): Promise<CatalogResponse> {
    return this.request<CatalogResponse>("/api/agent/tokens");
  }

  /**
   * One token by symbol, e.g. "NVDA" — same fields as a catalog entry,
   * cheaper than fetching the whole catalog for a spot check. $0.05/call
   * via x402, free with an API key. Rejects with a 404 HoodGrowError for
   * an unknown symbol.
   */
  async getToken(symbol: string): Promise<TokenDetailResponse> {
    return this.request<TokenDetailResponse>(
      `/api/agent/token/${encodeURIComponent(symbol.toUpperCase())}`
    );
  }

  /**
   * Corporate actions (splits, dividends, name changes). Pass a symbol to
   * scope to one token (uses the cheaper single-token endpoint); omit it
   * for every tracked token's corporate actions (uses the full-catalog
   * endpoint).
   */
  async getCorporateActions(symbol?: string): Promise<CorporateActions> {
    const data = symbol ? await this.getToken(symbol) : await this.getCatalog();
    return {
      pending: data.pendingCorporateActions,
      recent: data.recentCorporateActions,
    };
  }

  /**
   * Every Morpho market this token participates in (loan OR collateral
   * role) plus its Uniswap V3 pools — the full picture, not just the
   * single best-APY figure bundled into getCatalog/getToken. $0.05/call
   * via x402, free with an API key. Rejects with a 404 HoodGrowError for
   * an unknown symbol.
   */
  async getDefi(symbol: string): Promise<DefiDetailResponse> {
    return this.request<DefiDetailResponse>(
      `/api/agent/defi/${encodeURIComponent(symbol.toUpperCase())}`
    );
  }

  /**
   * Holder-count trend, 24h net total_supply change (real mint/burn —
   * creation/redemption of the underlying tokenized shares, distinct from
   * a corporate-action multiplier change), and top-holder concentration.
   * `limit` caps how many top holders to return (1-50; the server
   * defaults to 10 if omitted). $0.05/call via x402, free with an API
   * key. Rejects with a 404 HoodGrowError for an unknown symbol.
   */
  async getHolders(symbol: string, limit?: number): Promise<HoldersResponse> {
    const query = limit !== undefined ? `?limit=${encodeURIComponent(String(limit))}` : "";
    return this.request<HoldersResponse>(
      `/api/agent/holders/${encodeURIComponent(symbol.toUpperCase())}${query}`
    );
  }

  /**
   * Price-impact / slippage estimate for a USD-sized trade, per Uniswap
   * V3 pool this token trades on. `side: "buy"` spends USDG for the stock
   * token; `"sell"` spends the stock token for USDG. Per-pool, not an
   * optimal multi-pool route/split — see the response's `note`. $0.05/call
   * via x402, free with an API key. Rejects with a 404 HoodGrowError for
   * an unknown symbol.
   */
  async getSlippage(
    symbol: string,
    amountUsd: number,
    side: SlippageSide
  ): Promise<SlippageResponse> {
    const query = `?amountUsd=${encodeURIComponent(String(amountUsd))}&side=${encodeURIComponent(side)}`;
    return this.request<SlippageResponse>(
      `/api/agent/slippage/${encodeURIComponent(symbol.toUpperCase())}${query}`
    );
  }

  /**
   * OHLC price candles for backtesting, bucketed server-side from price
   * history already collected every ~15 min. `interval` is `"1h"`,
   * `"4h"`, or `"1d"` — the finest granularity meaningful at that
   * collection cadence. `from`/`to` default to the last 30 days if
   * omitted (accepts a `Date` or an ISO 8601 string); the window is
   * capped at 730 days server-side. `limit` caps candles returned (1-1000,
   * defaults to 500). Deliberately OHLC, not OHLCV — HoodGrow has no
   * historical trading-volume time series to draw a volume field from.
   * $0.05/call via x402, free with an API key. Rejects with a 404
   * HoodGrowError for an unknown symbol.
   */
  async getOhlc(
    symbol: string,
    interval: OhlcInterval,
    options?: { from?: Date | string; to?: Date | string; limit?: number }
  ): Promise<OhlcResponse> {
    const params = new URLSearchParams({ interval });
    if (options?.from !== undefined) {
      params.set("from", options.from instanceof Date ? options.from.toISOString() : options.from);
    }
    if (options?.to !== undefined) {
      params.set("to", options.to instanceof Date ? options.to.toISOString() : options.to);
    }
    if (options?.limit !== undefined) {
      params.set("limit", String(options.limit));
    }
    return this.request<OhlcResponse>(
      `/api/agent/ohlc/${encodeURIComponent(symbol.toUpperCase())}?${params.toString()}`
    );
  }

  /**
   * Base mainnet (chain 8453) B20 native-equity-token registry — a much
   * smaller sibling of getCatalog (Robinhood Chain). PRE-LAUNCH: check
   * each token's `status` before treating it as tradable — "pre_launch"
   * means verified on-chain metadata but zero minted supply, so no price,
   * no DEX liquidity, no holders exist for it yet; it flips to "live"
   * automatically once real supply appears on-chain. $0.05/call via x402,
   * free with an API key.
   */
  async getBaseTokens(): Promise<BaseTokensResponse> {
    return this.request<BaseTokensResponse>("/api/agent/base/tokens");
  }
}
