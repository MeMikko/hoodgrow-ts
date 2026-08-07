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

## API

```ts
new HoodGrowClient({ apiKey?: string; signer?: LocalAccount; baseUrl?: string })
```

Exactly one of `apiKey` / `signer` is required.

| Method | Price (x402) | Returns |
| --- | --- | --- |
| `getCatalog()` | $0.10 | Every listed token: price, source, 24h change, corporate-action adjusted supply, DeFi depth, plus catalog-wide pending/recent corporate actions |
| `getToken(symbol)` | $0.05 | One token, same fields, scoped |
| `getCorporateActions(symbol?)` | uses `getToken`/`getCatalog` above | `{ pending, recent }` — pass a symbol to scope, omit for every tracked token |

Full response shapes are exported as types (`CatalogResponse`,
`TokenDetailResponse`, `TokenSummary`, `DefiInfo`, `PendingCorporateAction`,
`RecentCorporateAction`).

A failed request (any non-2xx HoodGrow itself returns, after x402 payment
handling — an unknown symbol, a server error) throws `HoodGrowError` with
`.status` and `.body`.

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
Need more sustained throughput? A persistent API key with its own higher
limit is available — see
[hoodgrow.com/api-access](https://www.hoodgrow.com/api-access).

## Development

```bash
npm install
npm run build   # tsc -> dist/
npm test        # tsx --test test/*.test.ts (mocked fetch, no network)
```

## License

MIT
