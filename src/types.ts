/**
 * Response types for the HoodGrow agent API
 * (https://www.hoodgrow.com/api-access). Mirrors the server's own response
 * shapes exactly — see HoodGrow/src/app/api/agent/{tokens,token/[symbol]}/route.ts.
 */

export type PriceSource = "chainlink" | "legacy" | null;

/** Best current Morpho supply APY + Uniswap V3 depth for one token. */
export interface DefiInfo {
  /** Percent, e.g. 4.82 for 4.82%. `null` (not `0`) when the token isn't a
   * loan asset in any known Morpho market — distinct from a real 0% APY. */
  morphoBestSupplyApy: number | null;
  /** The Morpho market id that produced `morphoBestSupplyApy`, if any. */
  morphoBestSupplyApyMarketId: string | null;
  /** Total USD TVL across every Uniswap V3 pool involving this token.
   * `null` (not `0`) when there's no pool at all. */
  uniswapTvlUsd: number | null;
  uniswapPoolCount: number;
}

/** One token's price/supply data, as it appears in a catalog response. */
export interface TokenSummary {
  symbol: string;
  name: string;
  /** On-chain contract address on Robinhood Chain (chain id 4663). */
  address: string;
  priceUsd: number | null;
  priceSource: PriceSource;
  change24hPercent: number | null;
  /** Corporate-action adjusted supply when available, else raw totalSupply. */
  supply: number | null;
  /** True when `supply` reflects the ERC-8056 uiMultiplier adjustment. */
  supplyAdjusted: boolean;
  snapshotTs: string | null;
  defi: DefiInfo;
}

/** A staged, not-yet-effective on-chain multiplier change — rare; only
 * large, price-discontinuity actions (a split) require it. Dividends do
 * NOT appear here — see RecentCorporateAction. */
export interface PendingCorporateAction {
  symbol: string;
  name: string;
  currentMultiplier: number;
  stagedMultiplier: number;
  /** Human-readable summary, e.g. "4-for-1 split". */
  change: string;
  effectiveAt: string;
  checkedAt: string;
}

/** One entry from Robinhood's own official corporate-action ledger —
 * dividends, splits, name changes, and more. The near-continuous feed;
 * prefer this over PendingCorporateAction for routine activity like
 * dividends. */
export interface RecentCorporateAction {
  symbol: string;
  name: string;
  type: string;
  typeLabel: string;
  status: string;
  statusLabel: string;
  /** YYYY-MM-DD. */
  processDate: string;
  detail: string | null;
  details: Record<string, Record<string, string>> | null;
  /** Citable URL for this specific corporate action. */
  url: string;
}

/** GET /api/agent/tokens — the full catalog. */
export interface CatalogResponse {
  chainId: number;
  updatedAt: string;
  tokens: TokenSummary[];
  pendingCorporateActions: PendingCorporateAction[];
  recentCorporateActions: RecentCorporateAction[];
}

/** GET /api/agent/token/{symbol} — one token. Note `defi` sits alongside
 * `token`, not nested inside it (unlike CatalogResponse, where each
 * catalog entry carries its own `defi`) — this mirrors the live API
 * exactly rather than normalizing the two shapes to match. */
export interface TokenDetailResponse {
  chainId: number;
  updatedAt: string;
  token: Omit<TokenSummary, "defi">;
  defi: DefiInfo;
  pendingCorporateActions: PendingCorporateAction[];
  recentCorporateActions: RecentCorporateAction[];
}

export interface CorporateActions {
  pending: PendingCorporateAction[];
  recent: RecentCorporateAction[];
}

/** One Morpho market a token participates in — as the loan asset OR as
 * collateral (a token can appear in multiple markets in either role). */
export interface DefiMarket {
  marketId: string;
  role: "loan" | "collateral";
  /** The OTHER asset in this market. `null` if that side's symbol was
   * never recorded server-side. */
  counterpartSymbol: string | null;
  /** Percent, e.g. 4.82 for 4.82%. */
  supplyApy: number | null;
  borrowApy: number | null;
  tvlUsd: number | null;
  ts: string;
}

export interface DefiPool {
  poolAddress: string;
  tvlUsd: number | null;
  volume24hUsd: number | null;
  /** Pips, e.g. 3000 = 0.3%. */
  feeTierBps: number | null;
  ts: string;
}

/** GET /api/agent/defi/{symbol} — every Morpho market and Uniswap V3 pool
 * a token participates in, not just the single best-APY figure bundled
 * into CatalogResponse/TokenDetailResponse's `defi` field. */
export interface DefiDetailResponse {
  chainId: number;
  symbol: string;
  updatedAt: string;
  morphoMarkets: DefiMarket[];
  uniswapPools: DefiPool[];
}

export interface TopHolder {
  address: string;
  balance: number;
  /** Share of total supply, 0-100. `null` if total supply isn't known. */
  percentOfSupply: number | null;
}

/** Net total_supply change over ~24h — a real mint/burn proxy (creation/
 * redemption of the underlying tokenized shares), distinct from a
 * corporate-action multiplier change. */
export interface SupplyChange24h {
  supplyNow: number;
  supplyRef: number;
  changePercent: number;
  refTs: string;
}

/** GET /api/agent/holders/{symbol} — holder-count trend, 24h net supply
 * change, and top-holder concentration. */
export interface HoldersResponse {
  chainId: number;
  symbol: string;
  updatedAt: string;
  holderCount: number | null;
  holderCountDelta: number | null;
  holderCountDeltaSinceTs: string | null;
  holderSnapshotTs: string | null;
  supplyChange24h: SupplyChange24h | null;
  topHolders: {
    snapshotTs: string | null;
    totalHolders: number;
    holders: TopHolder[];
  };
}

export type SlippageSide = "buy" | "sell";

/** One pool's price-impact estimate, OR an error explaining why that pool
 * couldn't be priced (`error` set, all the numeric fields absent) — never
 * both. */
export interface SlippagePoolResult {
  poolAddress: string;
  feeTier: number | null;
  snapshotTs: string;
  error?: string;
  amountOut?: number;
  feeAmountUsd?: number;
  midPriceBefore?: number;
  midPriceAfter?: number;
  effectivePrice?: number;
  priceImpactPercent?: number;
  /** `null` means "can't tell" (unrecognized fee tier); `true` means this
   * pool's estimate likely UNDERSTATES real slippage for this trade size. */
  likelyCrossesTick?: boolean | null;
}

/** GET /api/agent/slippage/{symbol} — how much a USD-sized trade would
 * move the price, per Uniswap V3 pool. Per-pool, not an optimal
 * multi-pool route/split — see `note`. */
export interface SlippageResponse {
  chainId: number;
  symbol: string;
  side: SlippageSide;
  amountUsd: number;
  updatedAt: string;
  /** The pool with the lowest priceImpactPercent among the ones that
   * priced successfully. `null` if none did. */
  bestPoolAddress: string | null;
  bestEffectivePrice: number | null;
  pools: SlippagePoolResult[];
  note: string;
}

export type OhlcInterval = "1h" | "4h" | "1d";

export interface OhlcCandle {
  bucketStart: string; // ISO
  bucketEndExclusive: string; // ISO — bucketStart + interval
  open: number;
  high: number;
  low: number;
  close: number;
  /** How many raw ~15-min price snapshots contributed to this candle — a
   * low count (e.g. 1) means a thinner spread, not a data error. */
  sampleCount: number;
}

/** GET /api/agent/ohlc/{symbol} — OHLC price candles for backtesting.
 * Deliberately OHLC, not OHLCV: HoodGrow has no historical trading-volume
 * time series to draw a volume field from, so none is included. */
export interface OhlcResponse {
  chainId: number;
  symbol: string;
  interval: OhlcInterval;
  from: string;
  to: string;
  updatedAt: string;
  candles: OhlcCandle[];
  note: string;
}

export type BaseTokenStatus = "pre_launch" | "live";

/** One Base (chain 8453) B20 native-equity token. `status` flips from
 * "pre_launch" to "live" automatically once real supply appears on-chain
 * — a "pre_launch" entry is not tradable: no price, no DEX liquidity, no
 * holders exist for it yet. */
export interface BaseToken {
  symbol: string;
  name: string;
  address: string;
  decimals: number;
  status: BaseTokenStatus;
  totalSupplyRaw: string;
  totalSupply: number;
  checkedAt: string | null;
}

/** GET /api/agent/base/tokens — Base mainnet B20 native-equity-token
 * registry, a much smaller sibling of CatalogResponse (Robinhood Chain).
 * See `note` and each token's `status` before treating any entry as
 * tradable. */
export interface BaseTokensResponse {
  chainId: number;
  updatedAt: string;
  note: string;
  tokens: BaseToken[];
}

/** One prepaid credit bundle offer — pay `priceUsd` once via x402, receive
 * `creditUsd` of spendable balance (creditUsd >= priceUsd; the difference
 * is the bundle's bonus). See HoodGrowClient.listCreditBundles/buyCredits. */
export interface CreditBundle {
  priceUsd: number;
  creditUsd: number;
}

/** POST /api/agent/credits/purchase response — an acknowledgment, not a
 * confirmed balance: the actual credit lands once x402 settlement
 * confirms server-side (normally before this response arrives). See
 * HoodGrowClient.getCreditBalance to confirm. */
export interface CreditPurchaseAck {
  ok: true;
  bundle: string;
  priceUsd: number;
  creditUsd: number;
  note: string;
}

/** GET /api/agent/credits/balance response. */
export interface CreditBalance {
  walletAddress: string;
  balanceUsd: number;
}
