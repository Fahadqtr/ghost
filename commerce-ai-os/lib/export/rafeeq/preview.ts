// INT.2D — Rafeeq export preview (PURE).
//
// Rafeeq lists at PRODUCT grain (one row per product — the existing Rafeeq
// contract in lib/exporters.ts is product-grain; no variant flattening). This
// module builds the validated preview for the single Rafeeq storefront
// (rafeeq:malikas).
//
// Identity is ECL-first and storefront-scoped: the Rafeeq Product ID is the ECL
// external_product_id read for storefront_key = "rafeeq:malikas" only. This
// module NEVER reads the legacy per-store id column on products, never invents
// an id, and never guesses identity by product name. A product with no active ECL row is
// UNMAPPED (new). A contested mapping (ECL mapping_status = needs_review) is a
// P0 BLOCK — it is displayed as "Rafeeq Identity Conflict — Needs Owner Review"
// and is NEVER auto-resolved. Certified SKU/barcode normalizers + the INT.2A
// image-naming + validation contracts are REUSED. No I/O — node:test loads it.

import { normalizeExportedSku, normalizeBarcode } from "../../talabat/export.ts";
import { storefrontByKey } from "../../channels/storefronts.ts";
import { resolveLifecycleState, type LifecycleState } from "../../lifecycle/state.ts";
import { primaryImageName, extensionFromUrl } from "../image-naming.ts";
import { summarizeValidation, type ExportItemStatus, type ExportReason, type ExportValidationItem, type ExportValidationSummary } from "../validation.ts";
import { type ExportPreview, type ExportPreviewItem } from "../preview.ts";

export const RAFEEQ_STOREFRONT_KEY = "rafeeq:malikas" as const;
export type RafeeqStorefrontKey = typeof RAFEEQ_STOREFRONT_KEY;

// The ECL identity-type discriminator comes from the certified storefront
// registry (single source of truth) — never hardcoded here, and never the legacy
// products column.
const RAFEEQ_IDENTITY_TYPE = storefrontByKey(RAFEEQ_STOREFRONT_KEY)?.identityType ?? null;

const BARCODE_RE = /^[0-9]{6,14}$/;

export interface RafeeqPreviewProduct {
  id: string;
  sku: string | null;
  barcode: string | null;
  nameEn: string | null;
  nameAr: string | null;
  category: string | null;       // products.main_category
  price: number | null;
  discountPrice: number | null;
  descriptionEn: string | null;
  descriptionAr: string | null;
  imageUrl: string | null;
  imageFilename: string | null;
  galleryImageUrls?: readonly string[];
  imageCount: number;
  lifecycleState?: unknown;
  platformStatus?: unknown;
}

/**
 * Storefront-scoped ECL identity evidence for rafeeq:malikas.
 * `productId` is the ECL row's internal product (to detect a cross-product
 * conflict). `status` mirrors ECL mapping_status. A missing entry ⇒ unmapped.
 */
export interface RafeeqMappingEvidence {
  status: "resolved" | "needs_review" | "unmapped";
  externalId: string | null; // Rafeeq Product ID (ECL external_product_id)
  exportedSku: string | null;
  productId: string | null;
}
const UNMAPPED: RafeeqMappingEvidence = { status: "unmapped", externalId: null, exportedSku: null, productId: null };

export interface RafeeqPreviewInput {
  products: readonly RafeeqPreviewProduct[];
  /** ECL evidence for rafeeq:malikas only, keyed by lower(exported sku). */
  mappingBySku?: Readonly<Record<string, RafeeqMappingEvidence>>;
}

export interface RafeeqPreviewRow {
  storefrontKey: RafeeqStorefrontKey;
  internalProductId: string;
  grain: "PRODUCT";
  sku: string;
  barcode: string | null;
  title: string;
  titleAr: string;
  category: string | null;
  /** Rafeeq's own Arabic category name (from RAFEEQ_CATEGORIES) — filled by caller projection. */
  price: number | null;
  descriptionEn: string;
  descriptionAr: string;
  hasImage: boolean;
  imageCount: number;
  imageExportName: string | null; // SKU-based
  primaryImageUrl: string | null;
  galleryImageUrls: readonly string[];
  /** Rafeeq Product ID from ECL (null ⇒ new/unmapped — never invented). */
  rafeeqId: string | null;
  mapping: RafeeqMappingEvidence;
  /** true when this row is a contested ECL mapping (needs_review) — blocked. */
  needsOwnerReview: boolean;
  lifecycleState: LifecycleState;
  status: ExportItemStatus;
  reasons: ExportReason[];
}

export interface RafeeqPreviewResult {
  storefrontKey: RafeeqStorefrontKey;
  rows: RafeeqPreviewRow[];
  items: ExportValidationItem[];
  summary: ExportValidationSummary;
  preview: ExportPreview;
  counts: { productCount: number; mappedCount: number; unmappedCount: number; needsReviewCount: number };
}

function clean(v: string | null | undefined): string {
  return typeof v === "string" ? v.trim() : "";
}
function positive(v: number | null | undefined): number | null {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;
}
function tally(values: readonly string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const v of values) if (v !== "") m.set(v, (m.get(v) ?? 0) + 1);
  return m;
}

/** Build the validated Rafeeq preview. Pure + deterministic. */
export function buildRafeeqPreview(input: RafeeqPreviewInput): RafeeqPreviewResult {
  const products = Array.isArray(input?.products) ? input.products : [];
  const mappingBySku = input?.mappingBySku ?? {};

  const skuLower: string[] = [];
  const barcodes: string[] = [];
  const imageNames: string[] = [];
  for (const p of products) {
    const sku = normalizeExportedSku(p.sku);
    skuLower.push(sku.toLowerCase());
    barcodes.push(normalizeBarcode(p.barcode) ?? "");
    // sanitized primary filename base for collision detection across the dataset
    imageNames.push(sku ? primaryImageName(sku, extensionFromUrl(p.imageFilename || p.imageUrl)).toLowerCase() : "");
  }
  const skuCounts = tally(skuLower);
  const barcodeCounts = tally(barcodes);
  const imageNameCounts = tally(imageNames);

  const rows: RafeeqPreviewRow[] = products.map((p, i) => buildRow(p, skuCounts, barcodeCounts, imageNameCounts, imageNames[i], mappingBySku));

  const items: ExportValidationItem[] = rows.map((r) => ({ entityId: r.internalProductId, destination: RAFEEQ_STOREFRONT_KEY, status: r.status, reasons: r.reasons }));
  const summary = summarizeValidation(items);
  const previewItems: ExportPreviewItem[] = rows.map((r) => ({
    internalProductId: r.internalProductId,
    variantId: null,
    sku: r.sku || null,
    barcode: r.barcode,
    title: r.title,
    destination: RAFEEQ_STOREFRONT_KEY,
    storefront: RAFEEQ_STOREFRONT_KEY,
    grain: "PRODUCT",
    status: r.status,
    warnings: r.reasons.filter((x) => !x.blocking),
    blockingReasons: r.reasons.filter((x) => x.blocking),
    imageCount: r.imageCount,
    primaryImage: r.imageExportName,
    externalIdentity: { storefrontKey: RAFEEQ_STOREFRONT_KEY, externalProductId: r.rafeeqId, externalVariantId: null, exportedSku: r.mapping.exportedSku ?? (r.sku || null), identityType: RAFEEQ_IDENTITY_TYPE },
    metadata: { mappingStatus: r.mapping.status, needsOwnerReview: r.needsOwnerReview },
  }));

  let mappedCount = 0;
  let needsReviewCount = 0;
  for (const r of rows) {
    if (r.rafeeqId !== null) mappedCount++;
    if (r.needsOwnerReview) needsReviewCount++;
  }

  return {
    storefrontKey: RAFEEQ_STOREFRONT_KEY,
    rows,
    items,
    summary,
    preview: { destination: RAFEEQ_STOREFRONT_KEY, grain: "PRODUCT", items: previewItems, placeholder: false },
    counts: { productCount: products.length, mappedCount, unmappedCount: products.length - mappedCount, needsReviewCount },
  };
}

function buildRow(
  p: RafeeqPreviewProduct,
  skuCounts: Map<string, number>,
  barcodeCounts: Map<string, number>,
  imageNameCounts: Map<string, number>,
  imageNameLower: string,
  mappingBySku: Readonly<Record<string, RafeeqMappingEvidence>>,
): RafeeqPreviewRow {
  const sku = normalizeExportedSku(p.sku);
  const barcode = normalizeBarcode(p.barcode);
  const title = clean(p.nameEn) || clean(p.nameAr);
  const titleAr = clean(p.nameAr) || clean(p.nameEn);
  const category = clean(p.category) || null;
  const price = positive(p.discountPrice) ?? positive(p.price);
  const hasImage = p.imageCount > 0 || clean(p.imageUrl) !== "" || clean(p.imageFilename) !== "";
  const ext = extensionFromUrl(p.imageFilename || p.imageUrl);
  const imageExportName = sku ? primaryImageName(sku, ext) : null;
  const primaryImageUrl = clean(p.imageUrl) !== "" ? p.imageUrl : null;
  const galleryImageUrls = Array.isArray(p.galleryImageUrls) ? p.galleryImageUrls.filter((u) => clean(u) !== "") : [];
  const state = resolveLifecycleState({ lifecycle_state: p.lifecycleState, platform_status: p.platformStatus });
  const mapping = sku ? (mappingBySku[sku.toLowerCase()] ?? UNMAPPED) : UNMAPPED;
  // needs_review is a P0 contested mapping — it blocks (never auto-resolved).
  const needsOwnerReview = mapping.status === "needs_review";
  // A needs_review row has an unstable identity, so its Rafeeq ID is NOT surfaced
  // as a usable id (it is blocked below and shown as "Needs Owner Review").
  const rafeeqId = mapping.status === "resolved" ? mapping.externalId : null;

  const reasons: ExportReason[] = [];
  const block = (code: ExportReason["code"], message?: string) => reasons.push({ code, blocking: true, message });
  const warn = (code: ExportReason["code"], message?: string) => reasons.push({ code, blocking: false, message });

  if (state === "STOPPED") block("LIFECYCLE_NOT_ELIGIBLE", "المنتج موقوف — غير مؤهّل للتصدير.");

  if (sku === "") block("MISSING_SKU");
  else if ((skuCounts.get(sku.toLowerCase()) ?? 0) > 1) block("DUPLICATE_SKU");

  if (barcode === null) warn("MISSING_BARCODE");
  else if ((barcodeCounts.get(barcode) ?? 0) > 1) block("DUPLICATE_BARCODE");
  else if (!BARCODE_RE.test(barcode)) warn("INVALID_BARCODE", "صيغة الباركود غير قياسية.");

  if (!hasImage) block("MISSING_IMAGE");
  if (title === "") block("MISSING_TITLE");
  if (price === null) warn("MISSING_PRICE");
  if (category === null) warn("MISSING_CATEGORY");

  // Identity — P0. A cross-product ECL mapping blocks; a needs_review mapping is a
  // contested identity that MUST be blocked and sent for owner review (no
  // auto-resolution, no name guessing, no id fabrication).
  if (mapping.productId && mapping.productId !== p.id) block("IDENTITY_CONFLICT", "تعارض هوية: نفس الـ SKU مربوط بمنتج آخر في رفيق.");
  if (needsOwnerReview) block("IDENTITY_NEEDS_REVIEW", "تعارض هوية رفيق — بحاجة لمراجعة المالك.");

  // Deterministic filename collision across the dataset (two distinct SKUs whose
  // sanitized primary filename is identical) — blocked BEFORE package generation.
  if (sku !== "" && hasImage && imageNameLower !== "" && (imageNameCounts.get(imageNameLower) ?? 0) > 1) {
    block("IDENTITY_CONFLICT", "تعارض اسم ملف الصورة بعد التنقية — تصادم بين منتجين.");
  }

  const blocking = reasons.some((r) => r.blocking);
  const status: ExportItemStatus = blocking ? "BLOCKED" : reasons.length > 0 ? "WARNING" : "READY";

  return {
    storefrontKey: RAFEEQ_STOREFRONT_KEY,
    internalProductId: p.id,
    grain: "PRODUCT",
    sku,
    barcode,
    title,
    titleAr,
    category,
    price,
    descriptionEn: clean(p.descriptionEn),
    descriptionAr: clean(p.descriptionAr),
    hasImage,
    imageCount: p.imageCount,
    imageExportName,
    primaryImageUrl,
    galleryImageUrls,
    rafeeqId,
    mapping,
    needsOwnerReview,
    lifecycleState: state,
    status,
    reasons,
  };
}
