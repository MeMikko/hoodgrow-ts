import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import type { LocalAccount } from "viem";

import type { CatalogResponse, CorporateActions, TokenDetailResponse } from "./types.js";

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
   * call via x402 — USDC on Base, $0.50 for the full catalog, $0.05 for a
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
   * $0.50/call via x402, free with an API key.
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
}
