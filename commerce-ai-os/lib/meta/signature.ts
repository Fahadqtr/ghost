// Pure, network-free helpers for authenticating Meta (Instagram/WhatsApp)
// webhook requests. Kept dependency-light so they run under the repo's
// node:test runner. The HMAC secret and computed digest never leave these
// functions — callers only receive a coarse decision.

import crypto from "crypto";

/** Body returned to the caller when the signing secret is not configured. */
export const WEBHOOK_NOT_CONFIGURED_MESSAGE =
  "Webhook signature verification is not configured.";

/** Body returned to the caller when a signature is missing/malformed/wrong. */
export const WEBHOOK_INVALID_SIGNATURE_MESSAGE = "invalid signature";

/**
 * Result of verifying an `X-Hub-Signature-256` header:
 * - `not_configured` — no `META_APP_SECRET`; the caller MUST fail closed (503)
 *   and perform no parsing/logging/DB/AI/outbound side effects.
 * - `invalid` — signature missing, malformed, wrong length, or mismatched;
 *   the caller returns 401 with no side effects.
 * - `ok` — signature verified; the caller may proceed to process the body.
 */
export type MetaSignatureResult = "ok" | "not_configured" | "invalid";

const PREFIX = "sha256=";

/**
 * Verify a Meta `X-Hub-Signature-256` header against the raw request body.
 *
 * Fails CLOSED: a missing/empty secret yields `not_configured` (never `ok`).
 * The provided signature must be `sha256=<hex>` with a hex digest whose byte
 * length matches the computed HMAC before a constant-time comparison is run.
 */
export function verifyMetaSignature(
  rawBody: string,
  signatureHeader: string | null | undefined,
  secret: string | null | undefined
): MetaSignatureResult {
  // 1) No secret → cannot authenticate the sender. Fail closed.
  if (!secret) return "not_configured";

  // 2) Header must be present and use the documented `sha256=` scheme.
  if (!signatureHeader || !signatureHeader.startsWith(PREFIX)) return "invalid";

  // 3) The digest must be a non-empty, even-length lowercase/uppercase hex
  //    string. Reject anything else before touching Buffer (which would
  //    silently drop invalid nibbles).
  const provided = signatureHeader.slice(PREFIX.length);
  if (provided.length === 0 || provided.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(provided)) {
    return "invalid";
  }

  // 4) Compute the expected HMAC and compare in constant time, but only after
  //    confirming the buffers are the same length (timingSafeEqual throws
  //    otherwise, and a length check is itself a cheap early reject).
  const expected = crypto.createHmac("sha256", secret).update(rawBody, "utf8").digest();
  const providedBuf = Buffer.from(provided, "hex");
  if (providedBuf.length !== expected.length) return "invalid";

  try {
    return crypto.timingSafeEqual(providedBuf, expected) ? "ok" : "invalid";
  } catch {
    return "invalid";
  }
}

/**
 * GET subscription verification (`hub.mode=subscribe`). Returns the challenge
 * string to echo back with 200, or `null` when the request should be rejected
 * (403). Behaviour is unchanged from the original inline check; extracted only
 * so it can be unit-tested. NOTE: this uses `META_VERIFY_TOKEN`, which is a
 * DIFFERENT secret from `META_APP_SECRET` used for POST signatures.
 */
export function resolveSubscriptionChallenge(
  mode: string | null | undefined,
  verifyTokenParam: string | null | undefined,
  challenge: string | null | undefined,
  expectedVerifyToken: string | null | undefined
): string | null {
  if (mode === "subscribe" && expectedVerifyToken && verifyTokenParam === expectedVerifyToken) {
    return challenge ?? "";
  }
  return null;
}
