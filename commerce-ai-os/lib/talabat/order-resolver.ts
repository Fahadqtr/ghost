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
  | "empty_order"
  | "weak_order_identity"
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

interface IdentifierMatch {
  targets: ResolvedTarget[];   // distinct targets resolved from ACTIVE mappings / catalog
  inactiveBlocked: boolean;    // a matching mapping exists but none is active
  parentBlocked: boolean;      // matched a product SKU/barcode whose product HAS variants
}

/**
 * Resolve one identifier value. A matching mapping (any status) is authoritative
 * for that identifier: if it is active → its target; if only non-active mappings
 * match → inactiveBlocked (the master catalogue is NOT used to bypass it). The
 * master catalogue is consulted ONLY when NO mapping matches the identifier —
 * and a product-level SKU/barcode hit on a product that HAS variants is refused
 * (parentBlocked), never resolved to masterVariantSku = null.
 */
function matchIdentifier(
  ctx: ResolveContext,
  kind: "cpid" | "sku" | "barcode",
  value: string,
  productHasVariants: (id: string) => boolean,
): IdentifierMatch {
  const v = norm(value);
  const mapField = (m: MappingSnapshot) =>
    kind === "cpid" ? m.channelProductId : kind === "sku" ? m.exportedSku : m.exportedBarcode;

  const mappingMatches = ctx.mappings.filter((m) => mapField(m) != null && norm(mapField(m)) === v);
  if (mappingMatches.length > 0) {
    const active = mappingMatches.filter((m) => m.mappingStatus === "active");
    if (active.length === 0) return { targets: [], inactiveBlocked: true, parentBlocked: false };
    return {
      targets: uniqueTargets(active.map((m) => ({ masterProductId: m.masterProductId, masterVariantSku: m.masterVariantSku }))),
      inactiveBlocked: false,
      parentBlocked: false,
    };
  }

  // No mapping for this identifier → master-catalogue fallback (cpid never falls
  // back — it is a channel identifier only).
  if (kind === "cpid") return { targets: [], inactiveBlocked: false, parentBlocked: false };

  const targets: ResolvedTarget[] = [];
  let parentBlocked = false;
  for (const variant of ctx.variants) {
    const field = kind === "sku" ? variant.sku : variant.barcode;
    if (field != null && norm(field) === v) targets.push({ masterProductId: variant.parentProductId, masterVariantSku: variant.sku });
  }
  for (const product of ctx.products) {
    const field = kind === "sku" ? product.sku : product.barcode;
    if (field != null && norm(field) === v) {
      if (productHasVariants(product.id)) parentBlocked = true; // never deduct the generic parent
      else targets.push({ masterProductId: product.id, masterVariantSku: null });
    }
  }
  return { targets: uniqueTargets(targets), inactiveBlocked: false, parentBlocked };
}

/**
 * Resolve one line through the ladder:
 *   1. channel_product_id (active mappings only)
 *   2. SKU (active mapping exported_sku / variant SKU / product SKU)
 *   3. barcode (active mapping exported_barcode / variant barcode / product barcode)
 *   4. exact normalized title → NEVER auto-matches (title_only_match → review)
 */
export function resolveLine(line: ResolverLine, ctx: ResolveContext): LineResolution {
  if (line.invalidQuantity || !Number.isInteger(line.quantity) || line.quantity <= 0) {
    return { lineKey: line.lineKey, status: "manual_review", reason: "invalid_quantity" };
  }

  const variantParents = new Set(ctx.variants.map((v) => v.parentProductId));
  const productHasVariants = (id: string) => variantParents.has(id);

  const present: { via: MatchVia; kind: "cpid" | "sku" | "barcode"; value: string }[] = [];
  if (line.channelProductId != null) present.push({ via: "channel_product_id", kind: "cpid", value: line.channelProductId });
  if (line.sku != null) present.push({ via: "sku", kind: "sku", value: line.sku });
  if (line.barcode != null) present.push({ via: "barcode", kind: "barcode", value: line.barcode });

  const levelTargets: { via: MatchVia; targets: ResolvedTarget[] }[] = [];
  let inactive = false;
  let parentBlocked = false;
  let ambiguous = false;

  for (const p of present) {
    const m = matchIdentifier(ctx, p.kind, p.value, productHasVariants);
    if (m.inactiveBlocked) inactive = true;
    if (m.parentBlocked) parentBlocked = true;
    if (m.targets.length > 1) ambiguous = true;
    if (m.targets.length >= 1) levelTargets.push({ via: p.via, targets: m.targets });
  }

  // Precedence: a non-active mapping blocks first (can't be bypassed), then a
  // parent-with-variants / per-level ambiguity, then cross-level conflicts.
  if (inactive) return { lineKey: line.lineKey, status: "manual_review", reason: "inactive_mapping" };
  if (ambiguous || parentBlocked) return { lineKey: line.lineKey, status: "manual_review", reason: "ambiguous_match" };

  const union = uniqueTargets(levelTargets.map((l) => l.targets[0]));
  if (union.length === 1) return { lineKey: line.lineKey, status: "matched", via: levelTargets[0].via, target: union[0], quantity: line.quantity };
  if (union.length > 1) return { lineKey: line.lineKey, status: "manual_review", reason: "conflicting_identifiers" };

  // No id match. Title NEVER auto-matches.
  if (line.title != null) {
    const t = norm(line.title);
    if (ctx.products.some((p) => p.title != null && norm(p.title) === t)) {
      return { lineKey: line.lineKey, status: "manual_review", reason: "title_only_match" };
    }
  }
  return { lineKey: line.lineKey, status: "manual_review", reason: "unmatched" };
}

export interface ResolveOrderOptions {
  /** From buildTalabatDedupKey — a "weak" identity can never auto-deduct. */
  dedupConfidence?: "strong" | "weak";
}

/**
 * Resolve a whole order. An empty order, a weak dedup identity, or ANY line in
 * manual_review makes the WHOLE order manual_review (all-or-nothing). Matched
 * lines resolving to the same (product, variant SKU) are aggregated — quantities
 * summed, original lineKeys kept — so a target is never deducted twice.
 */
export function resolveTalabatOrder(lines: ResolverLine[], ctx: ResolveContext, opts: ResolveOrderOptions = {}): OrderResolution {
  if (!Array.isArray(lines) || lines.length === 0) {
    return { status: "manual_review", reason: "empty_order", resolution: { reason: "empty_order" } };
  }
  if (opts.dedupConfidence === "weak") {
    return { status: "manual_review", reason: "weak_order_identity", resolution: { reason: "weak_order_identity" } };
  }

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
