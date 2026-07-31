// Pure feature-flag + event-allowlist gate for Talabat auto-deduction. CLOSED BY
// DEFAULT: automatic stock deduction runs ONLY when the flag is exactly "true"
// AND the normalized event EXACTLY matches an entry in the allowlist. No default
// events, no substring/fuzzy matching. Self-contained (no imports) so node:test
// imports it directly.

export type DeductGateDecision =
  | { action: "store_only" } //                        flag off/absent → store, no processing/RPC
  | { action: "manual_review"; reason: "auto_deduct_misconfigured" | "event_not_allowed" }
  | { action: "deduct" };

/** Deterministic event normalization: trim, collapse inner whitespace, lowercase. */
export function normalizeEvent(raw: unknown): string {
  return String(raw ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

/** Parse a comma-separated allowlist into normalized, de-duplicated, non-empty entries. */
export function parseEventAllowlist(raw: unknown): string[] {
  const seen = new Set<string>();
  for (const part of String(raw ?? "").split(",")) {
    const e = normalizeEvent(part);
    if (e) seen.add(e);
  }
  return [...seen];
}

/** The flag is ON only when its value is EXACTLY the string "true" (after trim). */
export function isAutoDeductEnabled(flag: unknown): boolean {
  return String(flag ?? "").trim() === "true";
}

/**
 * Decide whether a stored order may auto-deduct.
 *   - flag not exactly "true"              → store_only (never call the processor/RPC)
 *   - flag true, allowlist empty/invalid   → manual_review auto_deduct_misconfigured
 *   - flag true, event missing/not EXACT   → manual_review event_not_allowed
 *   - flag true, event EXACTLY in allowlist → deduct
 * Matching is EXACT against a normalized entry — never a substring or prefix.
 */
export function evaluateDeductGate(args: {
  enabledFlag: unknown;
  allowlistRaw: unknown;
  event: unknown;
}): DeductGateDecision {
  if (!isAutoDeductEnabled(args.enabledFlag)) return { action: "store_only" };
  const allow = parseEventAllowlist(args.allowlistRaw);
  if (allow.length === 0) return { action: "manual_review", reason: "auto_deduct_misconfigured" };
  const ev = normalizeEvent(args.event);
  if (ev.length === 0 || !allow.includes(ev)) return { action: "manual_review", reason: "event_not_allowed" };
  return { action: "deduct" };
}
