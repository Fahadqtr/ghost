// CHANNEL IDENTITY — the one rule that decides which SKU a listing row matches on.
//
// PURE — no I/O, no framework imports. node:test loads this directly.
//
// WHY THIS EXISTS. Every channel preview keyed its mapping evidence by
// `external_channel_listings.exported_sku` and skipped the row when that column
// was empty. In production the column is populated only for Shopify, so the
// Rafeeq, Snoonu, Pure Seoul and Talabat previews were building an EMPTY
// evidence index: 4096 listing rows — including all 1339 live Rafeeq bindings —
// were invisible to the code that decides whether a product is already mapped.
// A Rafeeq package generated in that state emits a blank product_id for products
// that are in fact bound, which on the marketplace means a duplicate listing.
//
// THE RULE. `exported_sku` is the channel's own record of what it was sent; the
// canonical SKU is what the catalogue says today. The effective identity is:
//
//     effectiveSku = non-empty exported_sku  ??  canonical SKU
//
//   • The canonical SKU is VARIANT-SPECIFIC where the row is variant-grain —
//     a variant row resolves against product_variants.sku, never the parent's,
//     so a variant can never borrow its parent's identity.
//   • A barcode is NEVER a fallback. Identity is SKU; barcode is corroboration.
//   • No SKU is invented. A row with neither value resolves to nothing and is
//     left out of the index rather than guessed at.
//   • When BOTH are present and disagree, the row is NOT silently resolved to
//     either one. It is reported as a conflict and the caller marks that record
//     contested so package generation refuses it.
//
// Case: matching has always been case-insensitive (`lower(sku)` keys), so two
// values differing only in case are the SAME identity, not a conflict. The
// value is carried through with its original case; only surrounding whitespace
// is trimmed, which mirrors the existing `s()` readers.

export type EffectiveSkuResolution =
  | { ok: true; sku: string; source: "exported" | "canonical" }
  | { ok: false; reason: "no_identity" | "conflict"; exportedSku: string | null; canonicalSku: string | null };

/** Trim-only normalization. Empty and non-string collapse to null. */
function text(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t === "" ? null : t;
}

/** The index key. Case-insensitive, matching every existing `lower(sku)` lookup. */
export function identityIndexKey(sku: string): string {
  return sku.trim().toLowerCase();
}

/** Apply the rule to one row's two candidate values. */
export function resolveEffectiveSku(exportedSku: unknown, canonicalSku: unknown): EffectiveSkuResolution {
  const exported = text(exportedSku);
  const canonical = text(canonicalSku);

  if (exported !== null && canonical !== null) {
    if (identityIndexKey(exported) !== identityIndexKey(canonical)) {
      return { ok: false, reason: "conflict", exportedSku: exported, canonicalSku: canonical };
    }
    return { ok: true, sku: exported, source: "exported" };
  }
  if (exported !== null) return { ok: true, sku: exported, source: "exported" };
  if (canonical !== null) return { ok: true, sku: canonical, source: "canonical" };
  return { ok: false, reason: "no_identity", exportedSku: null, canonicalSku: null };
}

// ── shared index builder ─────────────────────────────────────────────────────

export interface ChannelIdentityConflict {
  productId: string | null;
  variantId: string | null;
  exportedSku: string;
  canonicalSku: string;
}

export interface ChannelIdentityStats {
  /** rows in scope for this storefront after grain filtering. */
  considered: number;
  /** rows indexed from their own exported_sku. */
  fromExported: number;
  /** rows RECOVERED — indexed from the canonical SKU because exported_sku was empty. */
  fromCanonical: number;
  /** rows dropped: no exported_sku and no canonical SKU. */
  noIdentity: number;
  /** rows indexed but marked contested (exported_sku disagrees with canonical). */
  conflicts: number;
}

export interface ChannelIdentityResult<E> {
  index: Record<string, E>;
  conflicts: ChannelIdentityConflict[];
  stats: ChannelIdentityStats;
}

export interface ChannelIdentityInput<E> {
  rows: readonly Record<string, unknown>[];
  /** hard storefront scope — rows for any other storefront are ignored. */
  storefrontKey: string;
  /** true ⇒ variant-grain rows are skipped entirely (Rafeeq's product-grain identity). */
  productGrainOnly?: boolean;
  /** the canonical SKU for this row — variant-specific when the row is variant-grain. */
  canonicalSkuForRow: (row: Record<string, unknown>) => string | null;
  /** build the channel's own evidence shape. `contested` ⇒ the identity disagreed. */
  toEvidence: (row: Record<string, unknown>, resolved: { sku: string; contested: boolean }) => E;
}

/**
 * Build one channel's identity index under the shared rule.
 *
 * A CONTESTED row is still indexed — under its CANONICAL SKU, which is what the
 * catalogue believes — so the product is found rather than silently treated as
 * new. `contested` is passed to `toEvidence` so the channel can mark it the way
 * it already marks a contested identity (every current caller maps it to
 * `needs_review`, which its preview already treats as blocking). That keeps a
 * disagreement from quietly producing an export.
 */
export function buildChannelIdentityIndex<E>(input: ChannelIdentityInput<E>): ChannelIdentityResult<E> {
  const index: Record<string, E> = {};
  const conflicts: ChannelIdentityConflict[] = [];
  const stats: ChannelIdentityStats = { considered: 0, fromExported: 0, fromCanonical: 0, noIdentity: 0, conflicts: 0 };

  for (const row of Array.isArray(input.rows) ? input.rows : []) {
    if (text(row.storefront_key) !== input.storefrontKey) continue;
    const variantId = text(row.variant_id);
    if (input.productGrainOnly === true && variantId !== null) continue;
    stats.considered += 1;

    const resolved = resolveEffectiveSku(row.exported_sku, input.canonicalSkuForRow(row));

    if (!resolved.ok) {
      if (resolved.reason === "conflict") {
        stats.conflicts += 1;
        conflicts.push({
          productId: text(row.product_id), variantId,
          exportedSku: resolved.exportedSku as string, canonicalSku: resolved.canonicalSku as string,
        });
        // Indexed under what the catalogue says, and flagged contested.
        index[identityIndexKey(resolved.canonicalSku as string)] =
          input.toEvidence(row, { sku: resolved.canonicalSku as string, contested: true });
      } else {
        stats.noIdentity += 1;
      }
      continue;
    }

    if (resolved.source === "exported") stats.fromExported += 1;
    else stats.fromCanonical += 1;
    index[identityIndexKey(resolved.sku)] = input.toEvidence(row, { sku: resolved.sku, contested: false });
  }

  return { index, conflicts, stats };
}
