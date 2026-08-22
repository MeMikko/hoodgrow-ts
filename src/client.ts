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
  CreditWebhookRegistration,
  DefiDetailResponse,
  DefiSummaryResponse,
  HoldersResponse,
  MarketsResponse,
  OhlcInterval,
  OhlcResponse,
  PingResponse,
  RegisterCreditWebhookOptions,
  SlippageResponse,
  SlippageSide,
  TokenDetailResponse,
  TradesResponse,
} from "./types.js";

const DEFAULT_BASE_URL = "https://www.hoodgrow.com";

/**
 * Reported to the API in the User-Agent on every request.
 *
 * A literal rather than an import of package.json: this package ships both
 * ESM and typed output, and pulling JSON in across that boundary costs more
 * than it saves. A test asserts it equals package.json, so it cannot drift
 * silently — which is exactly how the sibling MCP package ended up reporting
 * 0.4.0 while shipping 0.7.1.
 */
export const SDK_VERSION = "0.17.0";
/** Base mainnet, CAIP-2 form — the only network HoodGrow's x402 paywall accepts. */
const NETWORK = "eip155:8453";
/** Upper bound on any single 429 backoff wait, so a hostile/huge Retry-After
 * can't hang a caller indefinitely. */
const MAX_RETRY_DELAY_MS = 30_000;

/** USDC on Base has 6 decimals; x402 quotes amounts in atomic units. */
const USDC_DECIMALS = 6;

/**
 * A USD ceiling as USDC atomic units, rounded UP.
 *
 * Rounding up on purpose: a ceiling of $0.10 must not reject a quote of
 * exactly $0.10 because of binary floating point, and erring a hundredth of
 * a cent high is harmless where erring low breaks legitimate calls.
 */
function usdToUsdcAtomic(usd: number): bigint {
  return BigInt(Math.ceil(usd * 10 ** USDC_DECIMALS));
}

/**
 * The price a 402 is asking, in atomic units — or null if this quote isn't
 * one we can read.
 *
 * x402 v2 calls the field `amount`; v1 called it `maxAmountRequired`, and a
 * policy is handed either depending on the protocol version the server
 * answered with. Returning null for anything else is deliberate: the one
 * caller filters on it, and an amount we cannot parse must not be treated
 * as "cheap enough".
 */
function quotedAtomicAmount(requirement: unknown): bigint | null {
  const r = requirement as { amount?: unknown; maxAmountRequired?: unknown };
  const raw =
    typeof r.amount === "string"
      ? r.amount
      : typeof r.maxAmountRequired === "string"
        ? r.maxAmountRequired
        : null;
  if (raw === null) return null;
  try {
    return BigInt(raw);
  } catch {
    return null;
  }
}

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
   * Bearer API key, self-served at https://www.hoodgrow.com/profile
   * — calls are free (no x402 payment) and unrate-limited beyond the key's
   * own configured limit. Takes priority over `signer` if both are set.
   */
  apiKey?: string;
  /**
   * A viem `LocalAccount` (e.g. from `privateKeyToAccount`, or a KMS/HSM-
   * backed custom account that can sign locally) used to auto-pay per
   * call via x402 — USDC on Base, $0.05 for a single token and every other
   * data endpoint (the full catalog is free and needs no signer at all). A JSON-RPC/browser-wallet account won't work here; x402
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
   * Replace the `User-Agent` this client sends (default
   * `hoodgrow-ts/<version>`).
   *
   * Set it when this SDK is embedded in something the API should count
   * separately — hoodgrow-mcp wraps this client, and without an override its
   * traffic is indistinguishable from a direct SDK integration. Convention is
   * to keep the SDK visible behind your own name, e.g.
   * `my-app/2.1 (hoodgrow-ts/0.11.0)`.
   */
  userAgent?: string;
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
  /**
   * Refuse to pay more than this many US dollars for any single call.
   *
   * Enforced as an x402 payment policy, so an over-priced 402 is rejected
   * *before* the signer produces a signature — no payment is made and the
   * call fails instead. Without it this client pays whatever a 402 quotes,
   * which is fine against a known-good API and not fine if that API is
   * ever misconfigured or impersonated.
   *
   * No default, deliberately. `buyCredits()` legitimately pays $10–$200,
   * so a built-in ceiling sized for the $0.05 read endpoints would
   * silently break bundle purchases. Set it to the most you are willing to
   * spend on a single call, remembering that it applies to credit
   * purchases too — a read-only agent might set `0.1`, while a client that
   * also buys bundles needs it above the largest bundle.
   */
  maxPriceUsd?: number;
}

/** Per-call options accepted by the metered read methods. */
export interface RequestOptions {
  /**
   * An `Idempotency-Key` sent with this request. If the same key + same
   * request reaches the server again within its retention window, the stored
   * response is replayed WITHOUT a second x402 charge (see the API
   * reference's "Idempotency" section) — the safe way to retry a paid call
   * that timed out. Use a fresh, stable key per logical call (e.g. a UUID),
   * and reuse that exact key only to retry that same call.
   */
  idempotencyKey?: string;
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
 * Client for the HoodGrow agent API (https://docs.hoodgrow.com).
 *
 * Credentials are OPTIONAL. `new HoodGrowClient()` with no options is a
 * working client: `getCatalog()` is free and needs nothing, and every other
 * endpoint serves an anonymous per-IP daily allowance before it starts asking
 * for payment. Once that allowance is spent, a call without credentials
 * rejects with a 402 `HoodGrowError` whose `body` names the alternatives.
 *
 * This used to throw unless you passed one of them, which meant a caller had
 * to obtain a key or fund a wallet before they could see a single response —
 * on an API whose catalog costs nothing.
 *
 * Pass `apiKey` (free, issued at hoodgrow.com/profile) for a larger daily
 * allowance, or `signer` (x402 pay-per-call, no signup) to settle payments
 * automatically. `apiKey` wins if both are set.
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
    // Identify the SDK on every request. Without it, calls made through this
    // client arrive with no User-Agent at all and land in the API's
    // "unattributed, no source" bucket — indistinguishable from the crawlers
    // and liveness probes that sweep the public endpoints. That is the exact
    // distinction the API's usage ledger exists to make: an integration built
    // on this SDK is the signal, a probe is the noise, and right now they look
    // identical from the server side.
    //
    // Callers embedding this SDK can identify themselves instead via the
    // `userAgent` option — see its doc comment for why that matters.
    this.headers = { "User-Agent": options.userAgent ?? `hoodgrow-ts/${SDK_VERSION}` };
    this.signer = options.signer;
    this.useCredits = Boolean(options.useCredits && options.signer && !options.apiKey);
    this.usingApiKey = Boolean(options.apiKey);
    this.maxRetries = Math.max(0, Math.floor(options.maxRetries ?? 0));

    if (options.apiKey) {
      this.headers.Authorization = `Bearer ${options.apiKey}`;
      this.fetchFn = fetch;
    } else if (options.signer) {
      // A spend ceiling, when the caller sets one, is enforced as an x402
      // payment policy: it filters the 402's payment requirements before a
      // signature is ever produced, so an over-priced quote leaves nothing
      // acceptable to pay rather than being paid and regretted after the
      // fact. Without one this client settles whatever a 402 asks for.
      const maxAtomic =
        options.maxPriceUsd === undefined ? null : usdToUsdcAtomic(options.maxPriceUsd);
      const client = x402Client.fromConfig({
        schemes: [{ network: NETWORK, client: new ExactEvmScheme(options.signer) }],
        policies:
          maxAtomic === null
            ? []
            : [
                (_version, requirements) =>
                  requirements.filter((r) => {
                    const amount = quotedAtomicAmount(r);
                    return amount !== null && amount <= maxAtomic;
                  }),
              ],
      });
      this.fetchFn = wrapFetchWithPayment(fetch, client);
    } else {
      // No credentials: a plain fetch, no Authorization header, no payment
      // wrapper. The free catalog returns 200; the paid endpoints return 200
      // until the anonymous per-IP allowance runs out and 402 after that.
      // There is no signer to settle with, so a 402 surfaces as a
      // HoodGrowError carrying the server's guidance rather than being paid.
      this.fetchFn = fetch;
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

  private async request<T>(path: string, reqOpts?: RequestOptions): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    // Retry a 429 ONLY on the free bearer path. x402/credit calls are not
    // idempotent (a retry can pay twice / re-spend), so they get one shot.
    const maxAttempts = this.usingApiKey ? this.maxRetries + 1 : 1;
    // Optional idempotency key — flows through on every path (the x402
    // payment wrapper preserves the original request headers on its paid
    // retry), so a caller can safely retry a timed-out paid call.
    const idempotencyHeader: Record<string, string> = reqOpts?.idempotencyKey
      ? { "Idempotency-Key": reqOpts.idempotencyKey }
      : {};

    for (let attempt = 1; ; attempt++) {
      // A credit-spend call is NOT an x402 payment — it must bypass the
      // payment-wrapping fetchFn entirely (which otherwise reconstructs its
      // own request and drops these custom headers) and use the plain global
      // fetch instead, same as getCreditBalance()/buyCredits() already do.
      // Re-signed per attempt so a retry never replays a stale signature.
      const headers = this.useCredits
        ? { ...this.headers, ...idempotencyHeader, ...(await this.signCreditAuthHeaders("GET", path)) }
        : { ...this.headers, ...idempotencyHeader };
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
   * Prove the payment path works, for a tenth of a cent. Carries no market
   * data — it exists so a new x402 integration can hit a real live 402,
   * settle it, and get a 200 back before it risks a real call on an untested
   * wallet, signer or facilitator config. $0.001/call via x402, free with an
   * API key.
   *
   * Make this the first call from any new setup. Every other method is the
   * "then what" once this one returns `{ ok: true }`.
   */
  async ping(opts?: RequestOptions): Promise<PingResponse> {
    return this.request<PingResponse>("/api/agent/ping", opts);
  }

  /**
   * The full token catalog — every listed Robinhood Chain stock token, with
   * its identity, price, 24h change and corporate-action adjusted supply,
   * plus both corporate-action feeds.
   *
   * FREE. No key, no payment, no allowance spent — this works on a client
   * constructed with no options at all. It carries no per-token DeFi depth:
   * use `getToken(symbol)` or `getDefi(symbol)` for that.
   */
  async getCatalog(opts?: RequestOptions): Promise<CatalogResponse> {
    return this.request<CatalogResponse>("/api/agent/tokens", opts);
  }

  /**
   * One token by symbol, e.g. "NVDA" — the same fields as a catalog entry
   * PLUS that token's `defi` block, which the free catalog does not carry.
   * $0.05/call via x402, free with an API key. Rejects with a 404
   * HoodGrowError for an unknown symbol.
   */
  async getToken(symbol: string, opts?: RequestOptions): Promise<TokenDetailResponse> {
    return this.request<TokenDetailResponse>(
      `/api/agent/token/${encodeURIComponent(symbol.toUpperCase())}`,
      opts
    );
  }

  /**
   * Corporate actions (splits, dividends, name changes). Pass a symbol to
   * scope to one token (uses the cheaper single-token endpoint); omit it
   * for every tracked token's corporate actions (uses the full-catalog
   * endpoint).
   */
  async getCorporateActions(
    symbol?: string,
    opts?: RequestOptions
  ): Promise<CorporateActions> {
    const data = symbol ? await this.getToken(symbol, opts) : await this.getCatalog(opts);
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
    options: CorporateActionsFeedOptions = {},
    opts?: RequestOptions
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
      `/api/corporate-actions${qs ? `?${qs}` : ""}`,
      opts
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
   * Best Morpho supply APY, Uniswap V3 TVL, 24h volume and pool count for
   * EVERY listed token, in one call. $0.05/call via x402, free with an API
   * key.
   *
   * Use this to build or rank a list. The alternative — `getDefi(symbol)`
   * per row — is two hundred calls and about $10 to fill two columns, which
   * in practice means the columns stay empty.
   *
   * It is not a cheaper `getDefi`. That one returns each market with its
   * role and both APYs and each pool with its fee tier, and remains the
   * right call when you are looking at one token.
   *
   * Every token appears, including those with no market and no pool; those
   * carry nulls. Read `morphoBestSupplyApy: null` as "no market", never as
   * 0%.
   */
  async getDefiSummary(opts?: RequestOptions): Promise<DefiSummaryResponse> {
    return this.request<DefiSummaryResponse>("/api/agent/defi", opts);
  }

  /**
   * Every Morpho market this token participates in (loan OR collateral
   * role) plus its Uniswap V3 pools — the full picture, not just the
   * single best-APY figure bundled into getCatalog/getToken. $0.05/call
   * via x402, free with an API key. Rejects with a 404 HoodGrowError for
   * an unknown symbol.
   */
  async getDefi(symbol: string, opts?: RequestOptions): Promise<DefiDetailResponse> {
    return this.request<DefiDetailResponse>(
      `/api/agent/defi/${encodeURIComponent(symbol.toUpperCase())}`,
      opts
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
  async getHolders(
    symbol: string,
    limit?: number,
    opts?: RequestOptions
  ): Promise<HoldersResponse> {
    const query = limit !== undefined ? `?limit=${encodeURIComponent(String(limit))}` : "";
    return this.request<HoldersResponse>(
      `/api/agent/holders/${encodeURIComponent(symbol.toUpperCase())}${query}`,
      opts
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
    side: SlippageSide,
    opts?: RequestOptions
  ): Promise<SlippageResponse> {
    const query = `?amountUsd=${encodeURIComponent(String(amountUsd))}&side=${encodeURIComponent(side)}`;
    return this.request<SlippageResponse>(
      `/api/agent/slippage/${encodeURIComponent(symbol.toUpperCase())}${query}`,
      opts
    );
  }

  /**
   * OHLC price candles for backtesting, bucketed server-side from price
   * history already collected every ~15 min. `interval` is `"1h"`,
   * `"4h"`, or `"1d"` — the finest granularity meaningful at that
   * collection cadence. `from`/`to` default to the last 30 days if
   * omitted (accepts a `Date` or an ISO 8601 string); the window is
   * capped at 730 days server-side. `limit` caps candles returned (1-1000,
   * defaults to 500). Each candle also carries per-candle `volumeUsd`/
   * `swapCount` from the on-chain swap-log indexer (`null` for buckets
   * predating its deployment — see `OhlcCandle`). $0.05/call via x402,
   * free with an API key. Rejects with a 404 HoodGrowError for an
   * unknown symbol.
   */
  async getOhlc(
    symbol: string,
    interval: OhlcInterval,
    options?: { from?: Date | string; to?: Date | string; limit?: number },
    opts?: RequestOptions
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
      `/api/agent/ohlc/${encodeURIComponent(symbol.toUpperCase())}?${params.toString()}`,
      opts
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
  async getBaseTokens(opts?: RequestOptions): Promise<BaseTokensResponse> {
    return this.request<BaseTokensResponse>("/api/agent/base/tokens", opts);
  }

  /**
   * Market movers across the whole Robinhood Chain catalog — top gainers and
   * losers by 24h price change, highest 24h swap volume, and deepest Uniswap
   * V3 liquidity (TVL). `options.limit` caps each list (1-50, default 10).
   * $0.05 via x402, free with an API key.
   */
  async getMarkets(
    options?: { limit?: number },
    opts?: RequestOptions
  ): Promise<MarketsResponse> {
    const params = new URLSearchParams();
    if (options?.limit !== undefined) params.set("limit", String(options.limit));
    const qs = params.toString();
    return this.request<MarketsResponse>(
      `/api/agent/markets${qs ? `?${qs}` : ""}`,
      opts
    );
  }

  /**
   * Recent large ("whale") trades in Robinhood Chain stock-token Uniswap V3
   * pools, newest first — each with a buy/sell side, USD size, and tx hash.
   * `options.symbol` scopes to one token (omit for the global feed);
   * `options.limit` caps the list (1-100, default 20). $0.05 via x402, free
   * with an API key.
   */
  async getTrades(
    options?: { symbol?: string; limit?: number },
    opts?: RequestOptions
  ): Promise<TradesResponse> {
    const params = new URLSearchParams();
    if (options?.symbol !== undefined) {
      params.set("symbol", options.symbol.toUpperCase());
    }
    if (options?.limit !== undefined) params.set("limit", String(options.limit));
    const qs = params.toString();
    return this.request<TradesResponse>(
      `/api/agent/trades${qs ? `?${qs}` : ""}`,
      opts
    );
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

  /**
   * Register (or update) a credit-funded corporate-action webhook for this
   * wallet. HoodGrow then POSTs each matching `corporate_action.*` event to
   * `options.url`, signed with the returned `webhookSecret` — verify every
   * delivery with verifyWebhookSignature before trusting it. Requires
   * `signer`.
   *
   * Registering is FREE (no credit spend here); each delivered event is
   * billed per-event against this wallet's prepaid credit balance (see
   * buyCredits/getCreditBalance), so an idle webhook that never fires costs
   * nothing. Calling again with the same URL rotates nothing; a different
   * URL mints a fresh secret.
   *
   * `options.symbols` restricts delivery — and, since billing is per
   * delivered event, what you're charged for — to just those symbols. Omit
   * or pass `[]` to receive every token's events (the default).
   *
   * This is the credit-funded path only. A Builder-subscription webhook is
   * set from the website (it uses wallet-session auth, not this SDK's
   * signer), so there's no SDK method for it.
   */
  async registerCreditWebhook(
    options: RegisterCreditWebhookOptions
  ): Promise<CreditWebhookRegistration> {
    if (!this.signer) {
      throw new Error("registerCreditWebhook requires a `signer`");
    }
    const path = "/api/agent/credits/webhook";
    const headers = {
      "Content-Type": "application/json",
      ...(await this.signCreditAuthHeaders("POST", path)),
    };
    const payload: { webhookUrl: string; webhookSymbols?: string[] } = {
      webhookUrl: options.url,
    };
    if (options.symbols !== undefined) {
      payload.webhookSymbols = options.symbols;
    }
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      let body: unknown = null;
      try {
        body = await res.json();
      } catch {
        // Non-JSON error body.
      }
      throw new HoodGrowError(
        `failed to register credit webhook: ${res.status} ${res.statusText}`,
        res.status,
        body
      );
    }
    return (await res.json()) as CreditWebhookRegistration;
  }
}
