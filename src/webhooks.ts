import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * The JSON body HoodGrow POSTs to a registered webhook URL when a corporate
 * action is staged, oracle-paused, or applied on-chain (see the Webhooks
 * section of the API reference). Mirrors the server's own
 * WebhookEventPayload exactly (HoodGrow/src/lib/webhooks.ts).
 */
export interface WebhookEvent {
  /** Unique per delivery — safe to dedupe on, and the same `id` returned by
   * GET /api/builder/webhooks for reconciliation. */
  id: string;
  event:
    | "corporate_action.staged"
    | "corporate_action.paused"
    | "corporate_action.applied"
    | "webhook.test";
  symbol: string;
  /** Multiplier before this event. `null` for `paused`, and for `applied`
   * if the prior value was never observed. */
  currentMultiplier: number | null;
  /** Multiplier this event moves to — staged value for `staged`, now-live
   * value for `applied`, `null` for `paused`. */
  stagedMultiplier: number | null;
  /** ISO. For `staged`, the future instant it takes effect; for `applied`,
   * when it took effect; `null` for `paused`. */
  effectiveAt: string | null;
  /** ISO — when HoodGrow emitted the event. */
  ts: string;
}

/**
 * Verify the `x-hoodgrow-signature` header on an incoming webhook against the
 * raw request body and your `webhookSecret` — HMAC-SHA256, constant-time
 * compared. **Always call this before trusting a webhook body**, and always
 * against the RAW bytes exactly as received (do not re-serialize the parsed
 * JSON first — key order/whitespace changes break the digest).
 *
 * The header value is `sha256=<hex>`; the leading `sha256=` is optional here.
 * Returns `false` (never throws) for a missing header, a malformed hex
 * signature, or any mismatch.
 *
 * @example
 * ```ts
 * // Express: app.post("/hooks", express.raw({ type: "application/json" }), ...)
 * import { verifyWebhookSignature, type WebhookEvent } from "hoodgrow";
 *
 * if (!verifyWebhookSignature(req.body, req.header("x-hoodgrow-signature"), secret)) {
 *   return res.sendStatus(401);
 * }
 * const event = JSON.parse(req.body.toString()) as WebhookEvent;
 * ```
 */
export function verifyWebhookSignature(
  rawBody: string | Uint8Array,
  signatureHeader: string | null | undefined,
  secret: string
): boolean {
  if (!signatureHeader || !secret) return false;

  const provided = signatureHeader.startsWith("sha256=")
    ? signatureHeader.slice("sha256=".length)
    : signatureHeader;
  // Reject anything that isn't a clean 64-char hex digest before touching
  // Buffer.from(..., "hex"), which would otherwise silently drop bad chars.
  if (!/^[0-9a-f]{64}$/i.test(provided)) return false;

  const expected = createHmac("sha256", secret)
    .update(typeof rawBody === "string" ? Buffer.from(rawBody, "utf8") : rawBody)
    .digest();
  const providedBytes = Buffer.from(provided, "hex");
  if (providedBytes.length !== expected.length) return false;
  return timingSafeEqual(providedBytes, expected);
}
