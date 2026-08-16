// CH.6F — deterministic matching (§4). PURE. No `@/` imports, no server-only.
//
// Evidence hierarchy (strongest first):
//   1. ecl_active   — an active ECL identity already links internal↔external
//   2. external_id  — exact stable external id (SPI / GID / rafeeq id) observed
//                     for exactly one internal product
//   3. sku          — exact internal SKU
//   4. barcode      — exact valid internal barcode
//   5. variant_sku  — exact internal variant SKU (Talabat sellable grain, §8)
//
// NEVER fuzzy / name / AI / brand-approx / visual. There is no similarity score
// in this module — confidence is DETERMINISTIC or nothing.

import {
  type Grain,
  type MatchEvidenceKind,
  type Confidence,
} from "./discovery-model.ts";

export interface InternalTarget {
  productId: string;
  variantId: string | null;
  grain: Grain;
  sku: string | null;
  barcode: string | null;
}

export function normalizeSku(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim().toLowerCase();
  return t === "" ? null : t;
}

export function normalizeBarcode(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.replace(/\s+/g, "").trim();
  return t === "" ? null : t;
}

/** A barcode is "valid" (usable as deterministic evidence) if it is 8–14 digits. */
export function isValidBarcode(v: unknown): boolean {
  const t = normalizeBarcode(v);
  return t != null && /^\d{8,14}$/.test(t);
}

// ── internal index ───────────────────────────────────────────────────────────
export interface InternalIndex {
  /** external id (SPI/GID/rafeeq id) → internal targets, from snapshot/ECL evidence */
  byExternalId: Map<string, InternalTarget[]>;
  bySku: Map<string, InternalTarget[]>;
  byBarcode: Map<string, InternalTarget[]>;
}

function push(map: Map<string, InternalTarget[]>, key: string | null, t: InternalTarget): void {
  if (!key) return;
  const arr = map.get(key);
  if (arr) arr.push(t);
  else map.set(key, [t]);
}

/**
 * Build the deterministic lookup indexes.
 * @param targets internal products/variants
 * @param externalIdLinks known externalId→internal links (from ECL + snapshots),
 *        used ONLY to resolve the external_id evidence tier.
 */
export function buildInternalIndex(
  targets: readonly InternalTarget[],
  externalIdLinks: readonly { externalId: string; target: InternalTarget }[] = [],
): InternalIndex {
  const bySku = new Map<string, InternalTarget[]>();
  const byBarcode = new Map<string, InternalTarget[]>();
  const byExternalId = new Map<string, InternalTarget[]>();
  for (const t of targets) {
    push(bySku, normalizeSku(t.sku), t);
    if (isValidBarcode(t.barcode)) push(byBarcode, normalizeBarcode(t.barcode), t);
  }
  for (const link of externalIdLinks) {
    const id = typeof link.externalId === "string" ? link.externalId.trim() : "";
    if (id) push(byExternalId, id, link.target);
  }
  return { byExternalId, bySku, byBarcode };
}

// ── external listing evidence ────────────────────────────────────────────────
export interface ExternalListing {
  externalId: string | null;
  sku: string | null;
  barcode: string | null;
  grain: Grain;
}

export interface MatchResult {
  /** distinct internal products at the strongest tier that produced a hit */
  targets: InternalTarget[];
  evidence: MatchEvidenceKind;
  confidence: Confidence;
  /** true when the strongest tier resolves to more than one distinct product */
  ambiguous: boolean;
}

function distinctByProduct(targets: readonly InternalTarget[]): InternalTarget[] {
  const seen = new Set<string>();
  const out: InternalTarget[] = [];
  for (const t of targets) {
    const key = `${t.productId}::${t.variantId ?? ""}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(t);
    }
  }
  return out;
}

function distinctProductCount(targets: readonly InternalTarget[]): number {
  return new Set(targets.map((t) => t.productId)).size;
}

const MISS: MatchResult = { targets: [], evidence: "none", confidence: "NONE", ambiguous: false };

/**
 * Resolve an external listing to internal target(s) using the strongest available
 * deterministic tier. Stops at the first tier that produces any hit.
 */
export function matchExternalToInternal(listing: ExternalListing, index: InternalIndex): MatchResult {
  // tier 2 — exact external id
  const idKey = typeof listing.externalId === "string" ? listing.externalId.trim() : "";
  if (idKey) {
    const hits = index.byExternalId.get(idKey);
    if (hits && hits.length > 0) return finalize(hits, "external_id");
  }
  // tier 3 — exact SKU (variant-grain hit is reported as variant_sku)
  const skuKey = normalizeSku(listing.sku);
  if (skuKey) {
    const hits = index.bySku.get(skuKey);
    if (hits && hits.length > 0) {
      const allVariant = hits.every((t) => t.grain === "variant");
      return finalize(hits, allVariant ? "variant_sku" : "sku");
    }
  }
  // tier 4 — exact valid barcode
  if (isValidBarcode(listing.barcode)) {
    const bcKey = normalizeBarcode(listing.barcode);
    const hits = bcKey ? index.byBarcode.get(bcKey) : undefined;
    if (hits && hits.length > 0) return finalize(hits, "barcode");
  }
  return MISS;
}

function finalize(hits: readonly InternalTarget[], evidence: MatchEvidenceKind): MatchResult {
  const targets = distinctByProduct(hits);
  const ambiguous = distinctProductCount(hits) > 1;
  return { targets, evidence, confidence: "DETERMINISTIC", ambiguous };
}
