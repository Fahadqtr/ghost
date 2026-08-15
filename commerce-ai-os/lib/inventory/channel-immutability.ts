// INV.5 — pure channel-sale immutability rule (DB-free, no imports).
//
// A sale written by the canonical sale primitive (Shopify / Talabat) carries
// details.immutable=true AND details.source in ('talabat','shopify'). Such a
// malak_audit row is an authoritative sale ledger entry: it must NEVER be
// hand-edited, deleted, reversed, or approved through the manual movement
// endpoints (reversing a sale would need the original shelf distribution, which
// the ledger does not carry). Manual staff/admin/malak movements (no immutable
// flag, no channel source) stay editable.
//
// PURE so node:test can import it directly (movements.ts pulls in next/cache and
// @/ aliases, which do not resolve under the raw test runner).

export const CHANNEL_SALE_LOCKED_MSG =
  "هذه حركة منصة بيع تلقائية ولا يمكن تعديلها أو حذفها يدويًا.";

export function isChannelSaleAudit(row: { details?: unknown } | null | undefined): boolean {
  const d = (row && (row as { details?: Record<string, unknown> }).details) || {};
  if ((d as { immutable?: unknown }).immutable === true) return true;
  const src = String((d as { source?: unknown }).source ?? "");
  return src === "talabat" || src === "shopify";
}
