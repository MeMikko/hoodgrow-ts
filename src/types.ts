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

/**
 * One token's identity, price and supply — the shape the FREE catalog
 * returns, and the shape `TokenDetailResponse.token` has always had.
 *
 * No `defi` field. The catalog used to carry one per token and no longer
 * does: per-token DeFi depth moved to `getDefi(symbol)` (every Morpho market
 * and Uniswap pool) when the catalog became free, and `getToken(symbol)`
 * still returns a `defi` block alongside its `token`.
 */
export interface CatalogToken {
  symbol: string;
  name: string;
  /** On-chain contract address on Robinhood Chain (chain id 4663). */
  address: string;
  priceUsd: number | null;
  priceSource: PriceSource;
  change24hPercent: number | null;
  /** Corporate-action adjusted supply when available, else raw totalSupply. */
  supply: number | null;
  /**
   * True when `supply` reflects the ERC-8056 uiMultiplier adjustment — that
   * the multiplier was READ and applied, not that the number moved. `true`
   * alongside `uiMultiplier: 1` is the ordinary case for a token that has
   * never had a corporate action.
   */
  supplyAdjusted: boolean;
  /**
   * The live ERC-8056 multiplier as a ratio: `1` = never adjusted, `2` = a
   * 2-for-1 split.
   *
   * This is what makes `supply` checkable. "5,362.39 adjusted" says nothing
   * about how much adjusting happened; `5,359.36 × 1.000566` says all of it,
   * and `supply === totalSupply * uiMultiplier` holds whenever both are
   * present.
   *
   * `null` is a FAILED or absent read, never `1`. A token whose multiplier
   * the server could not read is not a token that was never adjusted, and
   * collapsing the two would throw away the distinction `supplyAdjusted`
   * exists to draw. Do not default it to 1.
   */
  uiMultiplier: number | null;
  /**
   * Raw on-chain total supply, BEFORE the multiplier — the number
   * `totalSupply()` returns.
   *
   * Carried because the adjustment cannot be inverted from `supply` alone.
   * `null` when no snapshot has been recorded for this token yet.
   */
  totalSupply: number | null;
  /**
   * Distinct holding addresses at the latest explorer snapshot.
   *
   * `null` (not `0`) when no snapshot has been taken for this token yet —
   * "not counted" and "has no holders" are different claims. For the trend,
   * 24h delta and top-holder concentration, call `getHolders(symbol)`; this is
   * the single number, carried here so a market table does not need one paid
   * call per row to fill a column.
   */
  holderCount: number | null;
  /**
   * Seven days of price, oldest first, one point per 12-hour bucket — enough
   * to draw a sparkline for every row of a market table.
   *
   * Carried here for the same reason `holderCount` is, only more so: the
   * alternative is `getOhlc(symbol)` once per token, which is roughly $10 to
   * draw two hundred thumbnails. The server computes this series for its own
   * directory anyway, so it costs nothing to read.
   *
   * An EMPTY array means too few observations to draw a line, not a flat
   * price — a symbol below the server's minimum is left without a series
   * rather than reduced to a two-point "trend". Render nothing, not a flat
   * line.
   */
  spark7d: number[];
  snapshotTs: string | null;
}

/**
 * @deprecated Renamed to `CatalogToken`, and its `defi` field is gone — the
 * free catalog does not return one. Kept as an alias so an import does not
 * break; a `.defi` access on a catalog entry will now fail to compile, which
 * is the point: at runtime it was already `undefined`.
 */
export type TokenSummary = CatalogToken;

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

/**
 * GET /api/agent/ping — the payment-path smoke test. Carries no market
 * data on purpose; `note` points at the endpoints that do.
 */
export interface PingResponse {
  ok: boolean;
  pong: boolean;
  /** ISO timestamp the server answered at. */
  timestamp: string;
  note: string;
}

/** GET /api/agent/tokens — the full catalog. */
export interface CatalogResponse {
  chainId: number;
  updatedAt: string;
  tokens: CatalogToken[];
  pendingCorporateActions: PendingCorporateAction[];
  recentCorporateActions: RecentCorporateAction[];
}

/** GET /api/agent/token/{symbol} — one token, with its DeFi depth. `defi`
 * sits alongside `token` rather than inside it, mirroring the live API. This
 * is the endpoint that carries DeFi at all: the free catalog does not. */
export interface TokenDetailResponse {
  chainId: number;
  updatedAt: string;
  token: CatalogToken;
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
 * a token participates in, not just the single best-APY figure in
 * TokenDetailResponse's `defi` field. The free catalog carries no DeFi
 * fields at all, so this and getToken are where they live. */
export interface DefiDetailResponse {
  chainId: number;
  symbol: string;
  updatedAt: string;
  morphoMarkets: DefiMarket[];
  uniswapPools: DefiPool[];
}

/** One token's DeFi position summarised — the shape a market table row needs,
 * as opposed to the per-market/per-pool detail `DefiDetailResponse` carries. */
export interface TokenDefiSummary {
  symbol: string;
  /**
   * Best supply APY across every Morpho market this token is the loan asset
   * of, as a RATIO — `0.0482` is 4.82%, not 4.82. `null` when it is in no
   * market at all, which is NOT the same as 0%: a screener that reads the
   * two the same way ranks a token that has nowhere to lend.
   */
  morphoBestSupplyApy: number | null;
  /** Which market that APY came from, so the figure is checkable on-chain.
   * Present even when `morphoBestSupplyApy` is null — a market can exist
   * without a supply APY, and losing the id would lose that fact. */
  morphoBestSupplyApyMarketId: string | null;
  /** Summed across this token's Uniswap V3 pools. `null` (not 0) when it has
   * no pool, or when no pool has an indexed value yet. */
  uniswapTvlUsd: number | null;
  uniswapVolume24hUsd: number | null;
  /** Unlike the fields above, `0` here is a real count: it has no pools. */
  uniswapPoolCount: number;
}

export interface DefiSummaryResponse {
  chainId: number;
  /** When this response was built. */
  updatedAt: string;
  /** When the underlying pool data was last observed — how old these figures
   * actually are. `updatedAt` cannot answer that. */
  observedAt: string | null;
  /** Every listed token, including those with no market and no pool. Those
   * carry nulls rather than being omitted, so "has no DeFi" stays
   * distinguishable from "was not in the response". */
  tokens: TokenDefiSummary[];
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
  /** USD swap volume across the token's Uniswap V3 pools during this bucket,
   * summed from indexed Swap events. `null` (not `0`) for a bucket with no
   * indexed volume — older than the volume indexer's backfill window. */
  volumeUsd: number | null;
  /** Number of swaps in the bucket, alongside `volumeUsd`. `null` under the
   * same conditions. */
  swapCount: number | null;
}

/** GET /api/agent/ohlc/{symbol} — OHLC price candles for backtesting, with
 * per-candle `volumeUsd`/`swapCount` (USD swap volume across the token's
 * Uniswap V3 pools). Volume is `null` for buckets older than the volume
 * indexer's backfill window. */
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

/** One token's row in a market-movers list. `null` (not `0`) throughout keeps
 * "no data" distinct from a real zero — change24hPercent is null when 24h
 * history is too thin, tvlUsd/volume24hUsd null when the token has no pool or
 * no indexed volume yet. */
export interface MarketToken {
  symbol: string;
  name: string;
  priceUsd: number | null;
  priceSource: PriceSource;
  /** Percent, e.g. 3.21 for +3.21%. */
  change24hPercent: number | null;
  tvlUsd: number | null;
  volume24hUsd: number | null;
  poolCount: number;
  snapshotTs: string | null;
}

/** GET /api/agent/markets — cross-token movers ranked across the whole
 * Robinhood Chain catalog. Each list is capped by the request's `limit`
 * (default 10); gainers/losers can be empty when the market is flat (e.g.
 * weekends). */
export interface MarketsResponse {
  chainId: number;
  updatedAt: string;
  tokenCount: number;
  topGainers: MarketToken[];
  topLosers: MarketToken[];
  topVolume: MarketToken[];
  topTvl: MarketToken[];
  note: string;
}

/** Trade direction from the stock token's perspective: "buy" = the trader
 * spent USDG to acquire the stock token, "sell" = sold it for USDG. */
export type TradeSide = "buy" | "sell";

/** One large ("whale") swap from the trades feed. `usd` is the swap's USDG
 * leg — its USD size. */
export interface Trade {
  symbol: string;
  poolAddress: string;
  side: TradeSide;
  usd: number;
  txHash: string;
  blockNumber: number;
  ts: string;
}

/** GET /api/agent/trades — recent large trades across Robinhood Chain
 * stock-token Uniswap V3 pools, newest first. `symbol` is the filter that was
 * applied (or `null` for the global feed). An empty `trades` list means none
 * were indexed in range. */
export interface TradesResponse {
  chainId: number;
  symbol: string | null;
  updatedAt: string;
  trades: Trade[];
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

/** Options for HoodGrowClient.registerCreditWebhook. */
export interface RegisterCreditWebhookOptions {
  /** HTTPS URL HoodGrow POSTs each corporate-action event to. */
  url: string;
  /** Restrict delivery — and, since billing is per delivered event, what
   * you're charged for — to just these symbols. Case-insensitive, deduped
   * server-side. Omit or pass `[]` for every token's events (the default). */
  symbols?: string[];
}

/** POST /api/agent/credits/webhook response — the registered credit-funded
 * corporate-action webhook. Registering is free; each delivered event is
 * billed per-event against the wallet's prepaid credit balance. */
export interface CreditWebhookRegistration {
  ok: true;
  /** The stored HTTPS delivery URL. */
  webhookUrl: string;
  /** HMAC-SHA256 secret that signs deliveries (`x-hoodgrow-signature`) —
   * pass it to verifyWebhookSignature. Shown here; store it. */
  webhookSecret: string;
  /** The stored symbol filter as a comma-separated list, or `null` for all
   * symbols. */
  webhookSymbols: string | null;
  /** Human-readable note about the per-event billing model. */
  note: string;
}

/** A corporate-action event's stage in the /api/corporate-actions feed.
 * `staged`/`applied`/`paused` are on-chain ERC-8056 transitions;
 * `rhj_ledger` is the official Robinhood ledger record (dividends etc.). */
export type CorporateActionFeedStatus = "staged" | "applied" | "paused" | "rhj_ledger";

/** Where a feed event came from — an on-chain read, or the RHJ registry. */
export type CorporateActionSource = "onchain" | "rhj_registry";

/** One event in the filterable, paginated /api/corporate-actions feed —
 * distinct from the pending/recent bundle on a token (getCorporateActions):
 * this is the cross-symbol append-only event log with its own detection
 * metadata (blockNumber, transactionHash, detectedAt, freshnessSeconds). */
export interface CorporateActionEvent {
  symbol: string;
  contract: string;
  type: CorporateActionFeedStatus;
  actionType: string | null;
  multiplierFrom: number | null;
  multiplierTo: number | null;
  executionDate: string | null;
  detectedAt: string;
  lastUpdated: string;
  /** Seconds since `lastUpdated`, computed at response time. */
  freshnessSeconds: number;
  blockNumber: number | null;
  transactionHash: string | null;
  source: CorporateActionSource;
}

/** GET /api/corporate-actions — one page of the corporate-actions event
 * log. Use `pagination.nextCursor` (or HoodGrowClient.iterateCorporateActions)
 * to page through the rest. */
export interface CorporateActionsFeedResponse {
  chainId: number;
  updatedAt: string;
  actions: CorporateActionEvent[];
  pagination: {
    /** Opaque cursor for the next page, or `null` on the last page. */
    nextCursor: string | null;
    limit: number;
  };
}

/** Filters for the /api/corporate-actions feed. `from`/`to` accept a `Date`
 * or an ISO 8601 string. */
export interface CorporateActionsFeedOptions {
  symbol?: string;
  /** Filter by token contract address instead of symbol. */
  contract?: string;
  status?: CorporateActionFeedStatus;
  from?: Date | string;
  to?: Date | string;
  /** Page size, 1-100 (server default 50). */
  limit?: number;
  /** Opaque cursor from a previous page's `pagination.nextCursor`. */
  cursor?: string;
}
