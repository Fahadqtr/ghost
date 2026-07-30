// Pure, deterministic Talabat order → master-catalogue resolver. NO Supabase,
// NO network, NO DB writes — self-contained (its inputs are plain snapshots) so
// node:test imports it directly.
//
// The durable identity is ALWAYS (masterProductId, masterVariantSku) — never
// product_variants.id, never array order/index. A no-variant product resolves
// with masterVariantSku = null.

export interface ResolverLine {
  lineKey: string;
  channelProductId: string | null;
  sku: string | null;
  barcode: string | null;
  title: string | null;
  quantity: number;
  invalidQuantity?: boolean;
}

/** channel_variant_mappings snapshot row (any status; only "active" auto-deducts). */
export interface MappingSnapshot {
  channelProductId: string | null;
  exportedSku: string | null;
  exportedBarcode: string | null;
  masterProductId: string;
  masterVariantSku: string | null;
  mappingStatus: string; // "active" | "needs_review" | "archived" | ...
}
export interface ProductSnapshot { id: string; sku: string | null; barcode: string | null; title: string | null; }
export interface VariantSnapshot { parentProductId: string; sku: string | null; barcode: string | null; }

export interface ResolveContext {
  mappings: MappingSnapshot[];
  products: ProductSnapshot[];
  variants: VariantSnapshot[];
}

export interface ResolvedTarget { masterProductId: string; masterVariantSku: string | null; }

export type MatchVia = "channel_product_id" | "sku" | "barcode";

export type LineResolution =
  | { lineKey: string; status: "matched"; via: MatchVia; target: ResolvedTarget; quantity: number }
  | { lineKey: string; status: "manual_review"; reason: ManualReviewReason };

export type ManualReviewReason =
  | "invalid_quantity"
  | "unmatched"
  | "ambiguous_match"
  | "conflicting_identifiers"
  | "title_only_match"
  | "inactive_mapping";

export interface AggregatedDeduction {
  masterProductId: string;
  masterVariantSku: string | null;
  quantity: number;
  lineKeys: string[];
}

export type OrderResolution =
  | { status: "resolved"; targets: AggregatedDeduction[]; resolution: Record<string, unknown> }
  | { status: "manual_review"; reason: ManualReviewReason; resolution: Record<string, unknown> };

const norm = (v: string | null | undefined): string =>
  String(v ?? "").toLowerCase().normalize("NFKC").replace(/\s+/g, " ").trim();
const targetKey = (t: ResolvedTarget): string => `${t.masterProductId}||${t.masterVariantSku ?? ""}`;

function uniqueTargets(targets: ResolvedTarget[]): ResolvedTarget[] {
  const seen = new Map<string, ResolvedTarget>();
  for (const t of targets) seen.set(targetKey(t), t);
  return [...seen.values()];
}

/**
 * Resolve one line through the ladder:
 *   1. channel_product_id (active mappings only)
 *   2. SKU (active mapping exported_sku / variant SKU / product SKU)
 *   3. barcode (active mapping exported_barcode / variant barcode / product barcode)
 *   4. exact normalized title → NEVER auto-matches (title_only_match → review)
 *
 * A level with >1 distinct target ⇒ ambiguous_match. Different levels pointing
 * at different targets ⇒ conflicting_identifiers. A match found only via a
 * non-active mapping ⇒ inactive_mapping. No id/title hit ⇒ unmatched.
 */
export function resolveLine(line: ResolverLine, ctx: ResolveContext): LineResolution {
  if (line.invalidQuantity || !Number.isInteger(line.quantity) || line.quantity <= 0) {
    return { lineKey: line.lineKey, status: "manual_review", reason: "invalid_quantity" };
  }

  const active = ctx.mappings.filter((m) => m.mappingStatus === "active");
  let sawInactiveOnly = false;

  // Each level returns the distinct targets it resolves to (from active sources).
  const levelTargets: { via: MatchVia; targets: ResolvedTarget[] }[] = [];

  // 1) channel_product_id — mappings only.
  if (line.channelProductId != null) {
    const id = norm(line.channelProductId);
    const hits = active.filter((m) => m.channelProductId != null && norm(m.channelProductId) === id)
      .map((m) => ({ masterProductId: m.masterProductId, masterVariantSku: m.masterVariantSku }));
    const uniq = uniqueTargets(hits);
    if (uniq.length > 0) levelTargets.push({ via: "channel_product_id", targets: uniq });
    else if (ctx.mappings.some((m) => m.channelProductId != null && norm(m.channelProductId) === id)) sawInactiveOnly = true;
  }

  // 2) SKU — active mapping exported_sku, variant SKU, product SKU.
  if (line.sku != null) {
    const sku = norm(line.sku);
    const hits: ResolvedTarget[] = [];
    for (const m of active) if (m.exportedSku != null && norm(m.exportedSku) === sku) hits.push({ masterProductId: m.masterProductId, masterVariantSku: m.masterVariantSku });
    for (const v of ctx.variants) if (v.sku != null && norm(v.sku) === sku) hits.push({ masterProductId: v.parentProductId, masterVariantSku: v.sku });
    for (const p of ctx.products) if (p.sku != null && norm(p.sku) === sku) hits.push({ masterProductId: p.id, masterVariantSku: null });
    const uniq = uniqueTargets(hits);
    if (uniq.length > 0) levelTargets.push({ via: "sku", targets: uniq });
    else if (ctx.mappings.some((m) => m.exportedSku != null && norm(m.exportedSku) === sku)) sawInactiveOnly = true;
  }

  // 3) barcode — active mapping exported_barcode, variant barcode, product barcode.
  if (line.barcode != null) {
    const bc = norm(line.barcode);
    const hits: ResolvedTarget[] = [];
    for (const m of active) if (m.exportedBarcode != null && norm(m.exportedBarcode) === bc) hits.push({ masterProductId: m.masterProductId, masterVariantSku: m.masterVariantSku });
    for (const v of ctx.variants) if (v.barcode != null && norm(v.barcode) === bc) hits.push({ masterProductId: v.parentProductId, masterVariantSku: v.sku });
    for (const p of ctx.products) if (p.barcode != null && norm(p.barcode) === bc) hits.push({ masterProductId: p.id, masterVariantSku: null });
    const uniq = uniqueTargets(hits);
    if (uniq.length > 0) levelTargets.push({ via: "barcode", targets: uniq });
    else if (ctx.mappings.some((m) => m.exportedBarcode != null && norm(m.exportedBarcode) === bc)) sawInactiveOnly = true;
  }

  // Any level ambiguous → ambiguous_match.
  if (levelTargets.some((l) => l.targets.length > 1)) {
    return { lineKey: line.lineKey, status: "manual_review", reason: "ambiguous_match" };
  }

  // Union across levels — each level here has exactly one target.
  const union = uniqueTargets(levelTargets.map((l) => l.targets[0]));
  if (union.length === 1) {
    return { lineKey: line.lineKey, status: "matched", via: levelTargets[0].via, target: union[0], quantity: line.quantity };
  }
  if (union.length > 1) {
    return { lineKey: line.lineKey, status: "manual_review", reason: "conflicting_identifiers" };
  }

  // No id match. Title NEVER auto-matches.
  if (line.title != null) {
    const t = norm(line.title);
    const titleHit =
      ctx.products.some((p) => p.title != null && norm(p.title) === t);
    if (titleHit) return { lineKey: line.lineKey, status: "manual_review", reason: "title_only_match" };
  }
  if (sawInactiveOnly) return { lineKey: line.lineKey, status: "manual_review", reason: "inactive_mapping" };
  return { lineKey: line.lineKey, status: "manual_review", reason: "unmatched" };
}

/**
 * Resolve a whole order. ANY line that lands in manual_review makes the WHOLE
 * order manual_review (all-or-nothing). Matched lines resolving to the same
 * (product, variant SKU) are aggregated — quantities summed, original lineKeys
 * kept — so a target is never deducted twice.
 */
export function resolveTalabatOrder(lines: ResolverLine[], ctx: ResolveContext): OrderResolution {
  const perLine = lines.map((l) => resolveLine(l, ctx));
  const reviewed = perLine.filter((r): r is Extract<LineResolution, { status: "manual_review" }> => r.status === "manual_review");

  const lineDetail = perLine.map((r) =>
    r.status === "matched"
      ? { lineKey: r.lineKey, status: r.status, via: r.via, target: r.target, quantity: r.quantity }
      : { lineKey: r.lineKey, status: r.status, reason: r.reason });

  if (reviewed.length > 0) {
    return { status: "manual_review", reason: reviewed[0].reason, resolution: { lines: lineDetail, reasons: reviewed.map((r) => ({ lineKey: r.lineKey, reason: r.reason })) } };
  }

  const byTarget = new Map<string, AggregatedDeduction>();
  for (const r of perLine) {
    if (r.status !== "matched") continue;
    const k = targetKey(r.target);
    const agg = byTarget.get(k) ?? { masterProductId: r.target.masterProductId, masterVariantSku: r.target.masterVariantSku, quantity: 0, lineKeys: [] };
    agg.quantity += r.quantity;
    agg.lineKeys.push(r.lineKey);
    byTarget.set(k, agg);
  }
  const targets = [...byTarget.values()];
  return { status: "resolved", targets, resolution: { lines: lineDetail, targets } };
}
