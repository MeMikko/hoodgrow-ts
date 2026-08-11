# hoodgrow

TypeScript SDK for the [HoodGrow](https://www.hoodgrow.com) Robinhood Chain
stock token API — live price, corporate-action adjusted supply (ERC-8056,
correct through stock splits), Morpho/Uniswap DeFi depth, and corporate
actions (splits, dividends). Pay per call via **x402** (USDC on Base) — no
signup — or use a bearer API key if you have one.

```bash
npm i hoodgrow
```

## Quick start — x402 (pay per call, no signup)

```ts
import { HoodGrowClient } from "hoodgrow";
import { privateKeyToAccount } from "viem/accounts";

// Never hardcode a real private key — load it from an env var / secret
// manager, and only fund this wallet with what you're willing to spend
// on this API.
const signer = privateKeyToAccount(process.env.AGENT_PRIVATE_KEY as `0x${string}`);

const client = new HoodGrowClient({ signer });

const catalog = await client.getCatalog(); // $0.10 — every token
const nvda = await client.getToken("NVDA"); // $0.05 — one token
```

Every call settles a real USDC payment on Base mainnet the first time it's
made against a fresh nonce/request. See **Payment safety** below before you
point this at a funded wallet.

## Quick start — API key (free, issued access)

```ts
import { HoodGrowClient } from "hoodgrow";

const client = new HoodGrowClient({ apiKey: process.env.HOODGROW_API_KEY });

const catalog = await client.getCatalog();
```

Get a key from HoodGrow directly — see
[hoodgrow.com/api-access](https://www.hoodgrow.com/api-access).

## Quick start — prepaid credits (cheaper than x402 per call, still no signup)

Buy a dollar-denominated credit balance once via x402, then spend it down
over many calls with a cheap off-chain wallet signature instead of a fresh
on-chain payment every time:

```ts
import { HoodGrowClient } from "hoodgrow";
import { privateKeyToAccount } from "viem/accounts";

const signer = privateKeyToAccount(process.env.AGENT_PRIVATE_KEY as `0x${string}`);

// One-time: pay via x402 for a bundle. Bundle ids/prices: client.listCreditBundles().
const payingClient = new HoodGrowClient({ signer });
await payingClient.buyCredits("50"); // pay $50, receive $60 of credit

// From then on: spend the balance instead of paying x402 per call.
const client = new HoodGrowClient({ signer, useCredits: true });
const catalog = await client.getCatalog(); // debits $0.10 from the balance, no on-chain tx

const { balanceUsd } = await client.getCreditBalance(); // free, doesn't spend anything
```

A credit spend is a different mechanism from x402 entirely — a short,
single-use, ~60-second-lived signed message, not an on-chain payment — so it
costs no gas and settles instantly. It only ever authenticates against
`www.hoodgrow.com`; nothing here signs a payment authorization.

## API

```ts
new HoodGrowClient({
  apiKey?: string;
  signer?: LocalAccount;
  baseUrl?: string;
  useCredits?: boolean; // spend prepaid credit instead of x402 per call — requires signer + buyCredits() first
  maxRetries?: number;  // auto-retry 429s (Retry-After aware). Bearer path only — never on x402/credit (would risk paying twice). Default 0
})
```

Exactly one of `apiKey` / `signer` is required.

| Method | Price (x402) | Returns |
| --- | --- | --- |
| `getCatalog()` | $0.10 | Every listed token: price, source, 24h change, corporate-action adjusted supply, DeFi depth, plus catalog-wide pending/recent corporate actions |
| `getToken(symbol)` | $0.05 | One token, same fields, scoped |
| `getCorporateActions(symbol?)` | uses `getToken`/`getCatalog` above | `{ pending, recent }` — pass a symbol to scope, omit for every tracked token |
| `getCorporateActionsFeed(options?)` | $0.05 | One page of the filterable, cursor-paginated corporate-actions **event log** (`options: { symbol?, contract?, status?, from?, to?, limit?, cursor? }`) — the cross-symbol append-only feed with detection metadata (block, tx hash, `detectedAt`), distinct from the pending/recent bundle above |
| `iterateCorporateActions(options?)` | $0.05 / page | `AsyncGenerator` over **every** event matching the filter, auto-following `nextCursor` — `for await (const a of client.iterateCorporateActions({ status: "staged" }))`. Each page is a separate billed call on x402/credit; narrow with `from`/`to`/`symbol` |
| `getDefi(symbol)` | $0.05 | Every Morpho market this token participates in (loan OR collateral role) plus its Uniswap V3 pools — not just the single best-APY figure bundled into `getCatalog`/`getToken` |
| `getHolders(symbol, limit?)` | $0.05 | Holder-count trend, 24h net supply change (real mint/burn), and top-holder concentration (`limit` caps how many holders to return, 1-50, defaults to 10) |
| `getSlippage(symbol, amountUsd, side)` | $0.05 | How much a USD-sized trade (`side: "buy" \| "sell"`) would move the price, per Uniswap V3 pool — `bestPoolAddress`/`bestEffectivePrice` pick the best one for you |
| `getOhlc(symbol, interval, options?)` | $0.05 | OHLC price candles for backtesting (`interval: "1h" \| "4h" \| "1d"`; `options: { from?, to?, limit? }`, `from`/`to` accept a `Date` or ISO string, default to the last 30 days). **OHLC only, no volume** — HoodGrow has no historical trading-volume time series to draw a volume field from |
| `getBaseTokens()` | $0.05 | Base mainnet (chain 8453) B20 native-equity-token registry — a much smaller sibling of `getCatalog`. **Pre-launch**: check each token's `status` (`"pre_launch" \| "live"`) before treating it as tradable — `"pre_launch"` means no price, no DEX liquidity, no holders exist for it yet |
| `listCreditBundles()` | free | Current prepaid credit bundle catalog (`{ [id]: { priceUsd, creditUsd } }`) — no auth required |
| `buyCredits(bundleId)` | one x402 payment | Pays for one bundle; requires `signer`. Balance lands once settlement confirms — see `getCreditBalance()` |
| `getCreditBalance()` | free | This wallet's current credit balance; requires `signer` |

Full response shapes are exported as types (`CatalogResponse`,
`TokenDetailResponse`, `TokenSummary`, `DefiInfo`, `PendingCorporateAction`,
`RecentCorporateAction`, `DefiDetailResponse`, `DefiMarket`, `DefiPool`,
`HoldersResponse`, `TopHolder`, `SupplyChange24h`, `SlippageResponse`,
`SlippagePoolResult`, `SlippageSide`, `OhlcResponse`, `OhlcCandle`,
`OhlcInterval`, `BaseTokensResponse`, `BaseToken`, `BaseTokenStatus`,
`CreditBundle`, `CreditPurchaseAck`, `CreditBalance`, `CorporateActionEvent`,
`CorporateActionsFeedResponse`, `CorporateActionsFeedOptions`,
`CorporateActionFeedStatus`, `CorporateActionSource`, `WebhookEvent`).

A failed request (any non-2xx HoodGrow itself returns, after x402 payment
handling — an unknown symbol, a server error) throws `HoodGrowError` with
`.status` and `.body`.

## Webhooks

Subscribe to corporate-action events instead of polling: register a webhook
(a Builder key's `webhookUrl`, or the credit-funded `POST
/api/agent/credits/webhook`) and HoodGrow POSTs each `corporate_action.*`
event to your URL, signed `x-hoodgrow-signature: sha256=<hex>`. **Verify that
signature before trusting the body** — this SDK ships the check so you don't
hand-roll the HMAC:

```ts
import { verifyWebhookSignature, type WebhookEvent } from "hoodgrow";

// Express — read the RAW body, not the parsed JSON (re-serializing breaks the digest):
// app.post("/hooks", express.raw({ type: "application/json" }), (req, res) => {
if (!verifyWebhookSignature(req.body, req.header("x-hoodgrow-signature"), process.env.HOODGROW_WEBHOOK_SECRET!)) {
  return res.sendStatus(401);
}
const event = JSON.parse(req.body.toString()) as WebhookEvent;
// event.event -> "corporate_action.staged" | "corporate_action.paused" | "corporate_action.applied" | "webhook.test"
res.sendStatus(200);
```

`verifyWebhookSignature(rawBody, signatureHeader, secret)` is constant-time,
accepts the header with or without the `sha256=` prefix, and returns `false`
(never throws) for a missing header, malformed signature, or any mismatch.

## Agent-framework tools

Wire HoodGrow into any function-calling agent. The SDK ships the same eight
read tools the [`hoodgrow-mcp`](https://github.com/MeMikko/hoodgrow-mcp) server
exposes — as **framework-agnostic definitions** (name + description + JSON
Schema) plus a dispatcher — with zero extra dependencies:

```ts
import {
  HoodGrowClient,
  hoodgrowTools,          // readonly array: { name, description, parameters (JSON Schema) }
  executeHoodGrowTool,    // (client, name, args, opts?) => Promise<result>
  hoodgrowOpenAiTools,    // OpenAI `tools` format
  hoodgrowAnthropicTools, // Anthropic `tools` format (input_schema)
} from "hoodgrow";
```

**OpenAI** — pass the tools in, dispatch each call:

```ts
const client = new HoodGrowClient({ apiKey: process.env.HOODGROW_API_KEY });
const res = await openai.chat.completions.create({
  model: "gpt-4o",
  messages,
  tools: hoodgrowOpenAiTools(),
});
for (const call of res.choices[0].message.tool_calls ?? []) {
  const result = await executeHoodGrowTool(client, call.function.name, JSON.parse(call.function.arguments));
  // feed `result` back as a tool message…
}
```

**Anthropic** — same idea with `hoodgrowAnthropicTools()` and `tool_use` blocks.

**LangChain.js** — wrap each definition as a `DynamicStructuredTool` (or plain
`tool`) whose `func` calls the dispatcher:

```ts
import { DynamicTool } from "@langchain/core/tools";
const tools = hoodgrowTools.map((t) => new DynamicTool({
  name: t.name,
  description: t.description,
  func: async (input) => JSON.stringify(await executeHoodGrowTool(client, t.name, JSON.parse(input || "{}"))),
}));
```

**Vercel AI SDK** — build a tool set from the definitions using `jsonSchema()`:

```ts
import { jsonSchema } from "ai";
const tools = Object.fromEntries(hoodgrowTools.map((t) => [t.name, {
  description: t.description,
  parameters: jsonSchema(t.parameters),
  execute: (args) => executeHoodGrowTool(client, t.name, args),
}]));
```

`executeHoodGrowTool` returns the same typed response the matching client
method returns, throws `HoodGrowError` on an API failure, and takes an optional
`RequestOptions` (e.g. `{ idempotencyKey }`) as its last argument.

## Payment safety

x402 payments are real money and are **not** idempotent — retrying a timed-
out request can pay twice. Before pointing a signer at this client:

- Only fund the wallet with what you're willing to spend on this API.
- `signer` must be a viem `LocalAccount` (e.g. `privateKeyToAccount`) — a
  browser/JSON-RPC wallet account won't work, x402 needs to sign without a
  user prompt.
- HoodGrow's paywall only ever asks for USDC (`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`)
  on Base mainnet (`eip155:8453`), paid to
  `0x8520B3693a2Cf3c2bEa3a505Af3A9c1b093954c7`, capped at $0.10/call — this
  client's underlying `@x402/fetch`/`@x402/evm` dependencies handle the
  protocol-level verification, but you're responsible for how much you fund
  the signing wallet with.

## Rate limits

30 requests/minute per IP by default for pay-per-call use. A `429` means
back off — check the response's `Retry-After` rather than retrying
immediately (a blind retry after a paid call risks a duplicate payment).

On the **bearer `apiKey`** path (free, idempotent), pass `maxRetries` to have
the client back off and retry `429`s for you, honoring `Retry-After`:

```ts
const client = new HoodGrowClient({ apiKey: process.env.HOODGROW_API_KEY, maxRetries: 3 });
```

`maxRetries` is deliberately **ignored on the x402/credit paths** — those
calls aren't idempotent, so the client never auto-retries a paid request.
Need more sustained throughput? A persistent API key with its own higher
limit is available — see
[hoodgrow.com/api-access](https://www.hoodgrow.com/api-access).

## Idempotent retries (paid calls)

To retry a **paid** call that timed out without risking a double charge, pass
a stable `idempotencyKey` — the server replays the first stored response
instead of charging again. Works on every metered read method (the x402
payment wrapper preserves the header on its paid retry):

```ts
import { randomUUID } from "node:crypto";

const key = randomUUID(); // one stable key per logical call
try {
  return await client.getCatalog({ idempotencyKey: key });
} catch (err) {
  // Timed out / network blip? Retrying with the SAME key is safe — a settled
  // first attempt is replayed, not re-charged.
  return await client.getCatalog({ idempotencyKey: key });
}
```

`idempotencyKey` is the last argument on `getCatalog`, `getToken`, `getDefi`,
`getHolders`, `getSlippage`, `getOhlc`, `getBaseTokens`, and
`getCorporateActionsFeed` (e.g. `getHolders("NVDA", 10, { idempotencyKey })`).
Reuse a key only to retry the exact same call — a key reused for a *different*
request is rejected with `422`.

## Development

```bash
npm install
npm run build   # tsc -> dist/
npm test        # tsx --test test/*.test.ts (mocked fetch, no network)
```

## License

MIT
