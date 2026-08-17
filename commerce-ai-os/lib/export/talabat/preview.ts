// INT.2B — Talabat sellable-listing preview (PURE).
//
// Talabat has NO internal option/variant presentation, so the export grain is
// SELLABLE_LISTING: a simple product → exactly one row; a variant product → one
// independent row per variant and NO parent row (the P0 invariant, pinned in
// INT.2A + guard-tested here).
//
// Certified rules are REUSED, not reinvented (from lib/talabat/export.ts):
//   • title   → buildFlattenedName  ("{parent} — {option}", em dash, no repeat)
//   • sku     → normalizeExportedSku (the sellable SKU verbatim; NO parent fallback)
//   • barcode → normalizeBarcode     (the sellable barcode; NEVER the parent's)
//   • approval→ isApprovedForTalabat (approval === "Approved")
// Image FILENAME uses the INT.2A canonical SKU-based naming (what the future
// package will contain, §6/§15). Lifecycle eligibility reuses OPS.8
// resolveLifecycleState. Duplicate SKU/barcode are checked across the FINAL
// flattened dataset (§10). No I/O — framework-free, node:test-loadable.

import { buildFlattenedName, normalizeExportedSku, normalizeBarcode, isApprovedForTalabat } from "../../talabat/export.ts";
import { resolveLifecycleState, type LifecycleState } from "../../lifecycle/state.ts";
import { primaryImageName, variantImageName, extensionFromUrl } from "../image-naming.ts";
import { summarizeValidation, type ExportItemStatus, type ExportReason, type ExportValidationItem, type ExportValidationSummary } from "../validation.ts";
import { type ExportPreview, type ExportPreviewItem } from "../preview.ts";

const DESTINATION = "talabat:malikas";
const BARCODE_RE = /^[0-9]{6,14}$/; // reused from readiness (UI.6 barcode floor)

export interface TalabatPreviewVariant {
  id: string | null;
  sku: string | null;
  barcode: string | null;
  /** variant_name_en / variant_name */
  nameEn: string | null;
  nameAr: string | null;
  price: number | null;
}

export interface TalabatPreviewProduct {
  id: string;
  sku: string | null;
  barcode: string | null;
  nameEn: string | null;
  nameAr: string | null;
  price: number | null;
  discountPrice: number | null;
  category: string | null;
  /** product long-form descriptions (product-level; variants inherit these). */
  descriptionEn?: string | null;
  descriptionAr?: string | null;
  imageUrl: string | null;
  imageFilename: string | null;
  /**
   * Additional (non-primary) product image URLs in deterministic order. Used
   * ONLY to package extra images for a SIMPLE product (§5). Variants never
   * inherit a gallery — INT.2B only inherits the parent PRIMARY image.
   */
  galleryImageUrls?: readonly string[];
  /** product image count (image_url + gallery). Variants inherit these. */
  imageCount: number;
  /** platform_status(platform='talabat').approval === "Approved" */
  approved: boolean;
  /** stored lifecycle_state (or legacy fallback) — resolved by the caller shape */
  lifecycleState?: unknown;
  platformStatus?: unknown;
  variants: readonly TalabatPreviewVariant[];
}

/** Talabat identity evidence for one sellable row (from ECL — never fabricated). */
export interface TalabatMappingEvidence {
  status: "resolved" | "needs_review" | "unmapped";
  externalId: string | null;
  exportedSku: string | null;
}
const UNMAPPED: TalabatMappingEvidence = { status: "unmapped", externalId: null, exportedSku: null };

export interface TalabatPreviewInput {
  products: readonly TalabatPreviewProduct[];
  /** mapping evidence keyed by lower(sellable sku); missing ⇒ unmapped (no fake id). */
  mappingBySku?: Readonly<Record<string, TalabatMappingEvidence>>;
}

export interface TalabatPreviewRow {
  internalProductId: string;
  variantId: string | null;
  grain: "SELLABLE_LISTING";
  isVariant: boolean;
  sku: string; // normalized; "" when missing
  barcode: string | null;
  title: string; // flattened English listing name
  /** flattened Arabic listing name (same flattening as `title`). */
  titleAr: string;
  descriptionEn: string;
  descriptionAr: string;
  price: number | null;
  category: string | null;
  hasImage: boolean;
  imageCount: number;
  /** SKU-based export image filename (INT.2A canonical); null when SKU missing. */
  imageExportName: string | null;
  /** the retrievable PRIMARY image source URL (variant inherits the parent's); null when none. */
  primaryImageUrl: string | null;
  /** additional (non-primary) image source URLs — SIMPLE products only (never variants). */
  galleryImageUrls: readonly string[];
  /** variant inherits the parent image (no per-variant image column exists). */
  inheritedParentImage: boolean;
  lifecycleState: LifecycleState;
  approved: boolean;
  mapping: TalabatMappingEvidence;
  status: ExportItemStatus;
  reasons: ExportReason[];
}

export interface TalabatPreviewResult {
  destination: string;
  rows: TalabatPreviewRow[];
  items: ExportValidationItem[];
  summary: ExportValidationSummary;
  preview: ExportPreview;
  counts: { productCount: number; variantCount: number; sellableRowCount: number };
}

function positive(v: number | null | undefined): number | null {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;
}
function clean(v: string | null | undefined): string {
  return typeof v === "string" ? v.trim() : "";
}

interface StagedRow {
  product: TalabatPreviewProduct;
  variant: TalabatPreviewVariant | null;
}

/** Flatten products → sellable rows: variant ⇒ one row each (NO parent row). */
function stage(products: readonly TalabatPreviewProduct[]): StagedRow[] {
  const staged: StagedRow[] = [];
  for (const p of products) {
    const variants = Array.isArray(p.variants) ? p.variants : [];
    if (variants.length === 0) {
      staged.push({ product: p, variant: null });
    } else {
      for (const v of variants) staged.push({ product: p, variant: v }); // no parent row
    }
  }
  return staged;
}

/** Build the full Talabat sellable preview. Pure + deterministic. */
export function buildTalabatPreview(input: TalabatPreviewInput): TalabatPreviewResult {
  const products = Array.isArray(input?.products) ? input.products : [];
  const mappingBySku = input?.mappingBySku ?? {};
  const staged = stage(products);

  // First pass — resolve the sellable identity of every row (for dataset-wide dup checks).
  const skuLower: string[] = [];
  const barcodes: string[] = [];
  for (const s of staged) {
    const sku = normalizeExportedSku(s.variant ? s.variant.sku : s.product.sku);
    const barcode = normalizeBarcode(s.variant ? s.variant.barcode : s.product.barcode);
    skuLower.push(sku.toLowerCase());
    barcodes.push(barcode ?? "");
  }
  const skuCounts = tally(skuLower);
  const barcodeCounts = tally(barcodes);

  let variantCount = 0;
  const rows: TalabatPreviewRow[] = staged.map((s, i) => {
    if (s.variant) variantCount++;
    return buildRow(s, i, skuCounts, barcodeCounts, mappingBySku);
  });

  const items: ExportValidationItem[] = rows.map((r) => ({
    entityId: r.variantId ?? r.internalProductId,
    destination: DESTINATION,
    status: r.status,
    reasons: r.reasons,
  }));
  const summary = summarizeValidation(items);
  const previewItems: ExportPreviewItem[] = rows.map((r) => ({
    internalProductId: r.internalProductId,
    variantId: r.variantId,
    sku: r.sku || null,
    barcode: r.barcode,
    title: r.title,
    destination: DESTINATION,
    storefront: DESTINATION,
    grain: "SELLABLE_LISTING",
    status: r.status,
    warnings: r.reasons.filter((x) => !x.blocking),
    blockingReasons: r.reasons.filter((x) => x.blocking),
    imageCount: r.imageCount,
    primaryImage: r.imageExportName,
    externalIdentity: {
      storefrontKey: DESTINATION,
      externalProductId: r.mapping.externalId,
      externalVariantId: null,
      exportedSku: r.mapping.exportedSku ?? (r.sku || null),
      identityType: "talabat_sku",
    },
    metadata: { mappingStatus: r.mapping.status, inheritedParentImage: r.inheritedParentImage },
  }));

  return {
    destination: DESTINATION,
    rows,
    items,
    summary,
    preview: { destination: DESTINATION, grain: "SELLABLE_LISTING", items: previewItems, placeholder: false },
    counts: { productCount: products.length, variantCount, sellableRowCount: rows.length },
  };
}

function tally(values: readonly string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const v of values) if (v !== "") m.set(v, (m.get(v) ?? 0) + 1);
  return m;
}

function buildRow(
  s: StagedRow,
  index: number,
  skuCounts: Map<string, number>,
  barcodeCounts: Map<string, number>,
  mappingBySku: Readonly<Record<string, TalabatMappingEvidence>>,
): TalabatPreviewRow {
  const { product: p, variant: v } = s;
  const isVariant = v !== null;
  const sku = normalizeExportedSku(isVariant ? v!.sku : p.sku);
  const barcode = normalizeBarcode(isVariant ? v!.barcode : p.barcode);
  const title = buildFlattenedName(p.nameEn ?? p.nameAr, isVariant ? (v!.nameEn ?? v!.nameAr) : "");
  // Arabic listing name uses the SAME certified flattening (no second algorithm).
  const titleAr = buildFlattenedName(p.nameAr ?? p.nameEn, isVariant ? (v!.nameAr ?? v!.nameEn) : "");
  // Descriptions are product-level (variants inherit them) — mirrors the legacy export.
  const descriptionEn = clean(p.descriptionEn);
  const descriptionAr = clean(p.descriptionAr);
  const price = isVariant ? positive(v!.price) ?? positive(p.discountPrice) ?? positive(p.price)
    : positive(p.discountPrice) ?? positive(p.price);
  const category = clean(p.category) || null;
  const hasImage = p.imageCount > 0 || clean(p.imageUrl) !== "" || clean(p.imageFilename) !== "";
  const inheritedParentImage = isVariant && hasImage; // no per-variant image column exists
  const ext = extensionFromUrl(p.imageFilename || p.imageUrl);
  const imageExportName = sku ? (isVariant ? variantImageName(sku, ext) : primaryImageName(sku, ext)) : null;
  // The retrievable PRIMARY source URL (variant inherits the parent primary — the
  // exact documented INT.2B behavior; no new fallback). Gallery extras are for
  // SIMPLE products only; a variant never inherits a gallery.
  const primaryImageUrl = clean(p.imageUrl) !== "" ? p.imageUrl : null;
  const galleryImageUrls = isVariant ? [] : (Array.isArray(p.galleryImageUrls) ? p.galleryImageUrls.filter((u) => clean(u) !== "") : []);
  const state = resolveLifecycleState({ lifecycle_state: p.lifecycleState, platform_status: p.platformStatus });
  const mapping = sku ? (mappingBySku[sku.toLowerCase()] ?? UNMAPPED) : UNMAPPED;

  const reasons: ExportReason[] = [];
  const block = (code: ExportReason["code"], message?: string) => reasons.push({ code, blocking: true, message });
  const warn = (code: ExportReason["code"], message?: string) => reasons.push({ code, blocking: false, message });

  // Lifecycle + approval eligibility (existing approved export semantics + OPS.8).
  if (state === "STOPPED") block("LIFECYCLE_NOT_ELIGIBLE", "المنتج موقوف — غير مؤهّل للتصدير.");
  if (!isApprovedForTalabat(p.approved ? "Approved" : "")) block("LIFECYCLE_NOT_ELIGIBLE", "المنتج غير معتمد للتصدير.");

  // SKU (P0) — no fallback from a missing variant SKU to the parent SKU.
  if (sku === "") {
    block("MISSING_SKU");
    if (isVariant) block("VARIANT_NOT_READY", "المتغيّر بدون SKU خاص — لا يورَّث SKU المنتج الأب.");
  } else if ((skuCounts.get(sku.toLowerCase()) ?? 0) > 1) {
    block("DUPLICATE_SKU");
  }

  // Barcode — missing blocks (certified); invalid format is a WARNING (certified does not block on format).
  if (barcode === null) block("MISSING_BARCODE");
  else if ((barcodeCounts.get(barcode) ?? 0) > 1) block("DUPLICATE_BARCODE");
  else if (!BARCODE_RE.test(barcode)) warn("INVALID_BARCODE", "صيغة الباركود غير قياسية.");

  // Image (P0) — a row with no product image at all is blocked (certified missing_image).
  if (!hasImage) block("MISSING_IMAGE");

  // Title / price / category.
  if (clean(title) === "") block("MISSING_TITLE");
  if (price === null) warn("MISSING_PRICE");
  if (category === null) warn("MISSING_CATEGORY");

  const blocking = reasons.some((r) => r.blocking);
  const status: ExportItemStatus = blocking ? "BLOCKED" : reasons.length > 0 ? "WARNING" : "READY";

  return {
    internalProductId: p.id,
    variantId: isVariant ? v!.id : null,
    grain: "SELLABLE_LISTING",
    isVariant,
    sku,
    barcode,
    title,
    titleAr,
    descriptionEn,
    descriptionAr,
    price,
    category,
    hasImage,
    imageCount: p.imageCount,
    imageExportName,
    primaryImageUrl,
    galleryImageUrls,
    inheritedParentImage,
    lifecycleState: state,
    approved: p.approved,
    mapping,
    status,
    reasons,
  };
}
