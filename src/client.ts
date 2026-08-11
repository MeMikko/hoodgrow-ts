import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import type { LocalAccount } from "viem";

import type {
  BaseTokensResponse,
  CatalogResponse,
  CorporateActionEvent,
  CorporateActions,
  CorporateActionsFeedOptions,
  CorporateActionsFeedResponse,
  CreditBalance,
  CreditBundle,
  CreditPurchaseAck,
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
/** Upper bound on any single 429 backoff wait, so a hostile/huge Retry-After
 * can't hang a caller indefinitely. */
const MAX_RETRY_DELAY_MS = 30_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Delay before a 429 retry: honor `Retry-After` (seconds) when present and
 * sane, else exponential backoff (0.5s, 1s, 2s, …), both capped. */
function retryAfterMs(header: string | null, attempt: number): number {
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(seconds * 1000, MAX_RETRY_DELAY_MS);
    }
  }
  return Math.min(500 * 2 ** (attempt - 1), MAX_RETRY_DELAY_MS);
}

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
  /**
   * When true AND `signer` is set, every metered call is authenticated by
   * spending from that wallet's prepaid credit balance (see buyCredits())
   * instead of a fresh x402 payment — a lightweight signed message, no
   * gas, no facilitator round trip. Defaults to false, so an existing
   * `signer`-only client keeps paying x402 per call exactly as before;
   * only opt in once you've actually bought credits for this wallet
   * (calling with an empty balance fails the call with a 402
   * HoodGrowError instead of falling back to x402). Ignored when `apiKey`
   * is set — bearer-key calls are already free.
   */
  useCredits?: boolean;
  /**
   * Auto-retry `429 Too Many Requests` this many times, honoring the
   * response's `Retry-After` header (capped, with a small exponential
   * fallback). Defaults to `0` (no retry). **Only applied on the bearer
   * `apiKey` path**, where calls are free and safe to repeat — it is
   * deliberately ignored for the `signer` (x402) and credit paths, because
   * an x402 payment is not idempotent and a blind retry after a paid call
   * can pay twice. There, a `429` throws immediately; back off yourself
   * using the thrown error's context.
   */
  maxRetries?: number;
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
  private readonly signer?: LocalAccount;
  private readonly useCredits: boolean;
  /** True on the free bearer path — the only path where a 429 is retried. */
  private readonly usingApiKey: boolean;
  private readonly maxRetries: number;

  constructor(options: HoodGrowClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.headers = {};
    this.signer = options.signer;
    this.useCredits = Boolean(options.useCredits && options.signer && !options.apiKey);
    this.usingApiKey = Boolean(options.apiKey);
    this.maxRetries = Math.max(0, Math.floor(options.maxRetries ?? 0));

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

  /**
   * Off-chain wallet-signature auth for a credit-funded call — mirrors the
   * server's own buildCreditAuthMessage exactly (HoodGrow/src/lib/
   * creditAuth.ts): method + pathname (no query string, no host) +
   * a fresh unix-second timestamp, EIP-191 `personal_sign`'d by `signer`.
   * The signature is single-use server-side (replay is rejected) and only
   * valid for ~60 seconds, so it's generated fresh per call, never cached.
   */
  private async signCreditAuthHeaders(
    method: string,
    pathWithQuery: string
  ): Promise<Record<string, string>> {
    if (!this.signer) {
      throw new Error("credit auth requires a `signer`");
    }
    const pathname = pathWithQuery.split("?")[0];
    const timestamp = String(Math.floor(Date.now() / 1000));
    const message = `HoodGrow credit spend\nmethod: ${method.toUpperCase()}\npath: ${pathname}\ntimestamp: ${timestamp}`;
    const signature = await this.signer.signMessage({ message });
    return {
      "X-HoodGrow-Credit-Wallet": this.signer.address,
      "X-HoodGrow-Credit-Timestamp": timestamp,
      "X-HoodGrow-Credit-Signature": signature,
    };
  }

  private async request<T>(path: string): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    // Retry a 429 ONLY on the free bearer path. x402/credit calls are not
    // idempotent (a retry can pay twice / re-spend), so they get one shot.
    const maxAttempts = this.usingApiKey ? this.maxRetries + 1 : 1;

    for (let attempt = 1; ; attempt++) {
      // A credit-spend call is NOT an x402 payment — it must bypass the
      // payment-wrapping fetchFn entirely (which otherwise reconstructs its
      // own request and drops these custom headers) and use the plain global
      // fetch instead, same as getCreditBalance()/buyCredits() already do.
      // Re-signed per attempt so a retry never replays a stale signature.
      const headers = this.useCredits
        ? { ...this.headers, ...(await this.signCreditAuthHeaders("GET", path)) }
        : this.headers;
      const fetchFn = this.useCredits ? fetch : this.fetchFn;
      const res = await fetchFn(url, { headers });

      if (res.ok) return (await res.json()) as T;

      if (res.status === 429 && attempt < maxAttempts) {
        await sleep(retryAfterMs(res.headers.get("retry-after"), attempt));
        continue;
      }

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
   * One page of the filterable, cursor-paginated corporate-actions **event
   * log** (`GET /api/corporate-actions`) — the cross-symbol append-only feed
   * with detection metadata (block, tx hash, `detectedAt`), distinct from the
   * pending/recent bundle {@link getCorporateActions} returns for a single
   * token. Filter by `symbol`/`contract`/`status`/`from`/`to`; page with
   * `pagination.nextCursor`, or use {@link iterateCorporateActions} to walk
   * every page automatically. $0.05/call via x402, free with an API key.
   */
  async getCorporateActionsFeed(
    options: CorporateActionsFeedOptions = {}
  ): Promise<CorporateActionsFeedResponse> {
    const params = new URLSearchParams();
    if (options.symbol) params.set("symbol", options.symbol);
    if (options.contract) params.set("contract", options.contract);
    if (options.status) params.set("status", options.status);
    if (options.from !== undefined) {
      params.set("from", options.from instanceof Date ? options.from.toISOString() : options.from);
    }
    if (options.to !== undefined) {
      params.set("to", options.to instanceof Date ? options.to.toISOString() : options.to);
    }
    if (options.limit !== undefined) params.set("limit", String(options.limit));
    if (options.cursor) params.set("cursor", options.cursor);
    const qs = params.toString();
    return this.request<CorporateActionsFeedResponse>(
      `/api/corporate-actions${qs ? `?${qs}` : ""}`
    );
  }

  /**
   * Async iterator over EVERY corporate-action event matching the filter,
   * transparently following `nextCursor` across pages — `for await (const
   * action of client.iterateCorporateActions({ status: "staged" }))`. Note
   * each page is a separate billed request on the x402/credit paths, so a
   * broad filter can fan out into many paid calls; narrow with
   * `from`/`to`/`symbol`, or cap your own loop.
   */
  async *iterateCorporateActions(
    options: Omit<CorporateActionsFeedOptions, "cursor"> = {}
  ): AsyncGenerator<CorporateActionEvent, void, unknown> {
    let cursor: string | undefined;
    do {
      const page = await this.getCorporateActionsFeed({ ...options, cursor });
      for (const action of page.actions) yield action;
      cursor = page.pagination.nextCursor ?? undefined;
    } while (cursor);
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

  /**
   * Lists the current prepaid credit bundles (id -> {priceUsd, creditUsd})
   * — no payment, no auth, works without a `signer` or `apiKey` at all.
   * See buyCredits() to actually purchase one.
   */
  async listCreditBundles(): Promise<Record<string, CreditBundle>> {
    const res = await fetch(`${this.baseUrl}/api/agent/credits/purchase`);
    if (!res.ok) {
      throw new HoodGrowError(
        `failed to list credit bundles: ${res.status} ${res.statusText}`,
        res.status,
        null
      );
    }
    const body = (await res.json()) as { bundles: Record<string, CreditBundle> };
    return body.bundles;
  }

  /**
   * Pays for one prepaid credit bundle via x402 — requires `signer` (a
   * bearer-key client is already free/unmetered, so buying credits makes
   * no sense for it). The wallet's balance is credited server-side once
   * settlement confirms, which normally completes before this call
   * returns; call getCreditBalance() to be sure. After this, construct
   * (or reconstruct) the client with `useCredits: true` to start spending
   * the balance instead of paying x402 per call.
   */
  async buyCredits(bundleId: string): Promise<CreditPurchaseAck> {
    if (!this.signer) {
      throw new Error("buyCredits requires a `signer` — credit bundles are paid via x402");
    }
    const res = await this.fetchFn(
      `${this.baseUrl}/api/agent/credits/purchase?bundle=${encodeURIComponent(bundleId)}`,
      { method: "POST" }
    );
    if (!res.ok) {
      let body: unknown = null;
      try {
        body = await res.json();
      } catch {
        // Non-JSON error body.
      }
      throw new HoodGrowError(
        `credit purchase failed: ${res.status} ${res.statusText}`,
        res.status,
        body
      );
    }
    return (await res.json()) as CreditPurchaseAck;
  }

  /**
   * This wallet's current prepaid credit balance — free (no x402 charge,
   * no credit spend), authenticated with the same wallet-signature scheme
   * every credit-funded call uses. Requires `signer`.
   */
  async getCreditBalance(): Promise<CreditBalance> {
    const path = "/api/agent/credits/balance";
    const headers = await this.signCreditAuthHeaders("GET", path);
    const res = await fetch(`${this.baseUrl}${path}`, { headers });
    if (!res.ok) {
      let body: unknown = null;
      try {
        body = await res.json();
      } catch {
        // Non-JSON error body.
      }
      throw new HoodGrowError(
        `failed to fetch credit balance: ${res.status} ${res.statusText}`,
        res.status,
        body
      );
    }
    return (await res.json()) as CreditBalance;
  }
}
