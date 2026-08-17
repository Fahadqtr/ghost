// INT.2C — Snoonu multi-store export preview (PURE).
//
// Snoonu lists at PRODUCT grain (one row per product — NOT the Talabat sellable
// grain). This module builds the validated preview for ONE Snoonu storefront at a
// time (snoonu:malikas OR snoonu:pure_seoul) and is called once per storefront,
// so the two storefronts NEVER share state or identity.
//
// Identity is ECL-first and STOREFRONT-SCOPED: the Snoonu SPI is the ECL
// external_product_id read for THIS storefront_key only. The same internal
// product can therefore carry a different SPI in each store, and a product with
// no ECL row for this storefront is UNMAPPED (new) — its SPI is never guessed,
// name-matched, or borrowed from the legacy per-store identity columns on
// products (this module never reads those). Certified SKU/barcode normalizers
// and the INT.2A image-naming + validation contracts are REUSED.
// No I/O — node:test loads it directly.

import { normalizeExportedSku, normalizeBarcode } from "../../talabat/export.ts";
import { resolveLifecycleState, type LifecycleState } from "../../lifecycle/state.ts";
import { primaryImageName, extensionFromUrl } from "../image-naming.ts";
import { summarizeValidation, type ExportItemStatus, type ExportReason, type ExportValidationItem, type ExportValidationSummary } from "../validation.ts";
import { type ExportPreview, type ExportPreviewItem } from "../preview.ts";

const BARCODE_RE = /^[0-9]{6,14}$/; // reused readiness barcode floor (UI.6)

/** The two Snoonu storefronts. Passed in so identity stays storefront-scoped. */
export type SnoonuStorefrontKey = "snoonu:malikas" | "snoonu:pure_seoul";

export interface SnoonuPreviewProduct {
  id: string;
  sku: string | null;
  barcode: string | null;
  nameEn: string | null;
  nameAr: string | null;
  category: string | null;      // products.main_category
  subCategory: string | null;   // products.sub_category
  price: number | null;
  discountPrice: number | null;
  descriptionEn: string | null;
  descriptionAr: string | null;
  keywordsEn: string | null;
  keywordsAr: string | null;
  imageUrl: string | null;
  imageFilename: string | null;
  galleryImageUrls?: readonly string[];
  imageCount: number;
  lifecycleState?: unknown;
  platformStatus?: unknown;
}

/**
 * Storefront-scoped identity evidence from ECL for one product's exported SKU.
 * `productId` is the ECL row's internal product — used to detect an identity
 * CONFLICT (same exported SKU mapped to a DIFFERENT product on this storefront).
 * A missing entry ⇒ unmapped (no fabricated SPI).
 */
export interface SnoonuMappingEvidence {
  status: "resolved" | "needs_review" | "unmapped";
  externalId: string | null; // Snoonu SPI (ECL external_product_id), storefront-scoped
  exportedSku: string | null;
  productId: string | null;
}
const UNMAPPED: SnoonuMappingEvidence = { status: "unmapped", externalId: null, exportedSku: null, productId: null };

export interface SnoonuPreviewInput {
  storefrontKey: SnoonuStorefrontKey;
  products: readonly SnoonuPreviewProduct[];
  /** ECL evidence for THIS storefront only, keyed by lower(exported sku). */
  mappingBySku?: Readonly<Record<string, SnoonuMappingEvidence>>;
}

export interface SnoonuPreviewRow {
  storefrontKey: SnoonuStorefrontKey;
  internalProductId: string;
  grain: "PRODUCT";
  sku: string;              // normalized; "" when missing
  barcode: string | null;
  title: string;
  titleAr: string;
  category: string | null;
  subCategory: string | null;
  price: number | null;
  discountPrice: number | null;
  descriptionEn: string;
  descriptionAr: string;
  keywordsEn: string;
  keywordsAr: string;
  hasImage: boolean;
  imageCount: number;
  /** SKU-based export image filename (INT.2A canonical); null when SKU missing. */
  imageExportName: string | null;
  primaryImageUrl: string | null;
  galleryImageUrls: readonly string[];
  /** storefront-scoped Snoonu SPI from ECL (null ⇒ new/unmapped — never invented). */
  spi: string | null;
  mapping: SnoonuMappingEvidence;
  /** derived listing status for the Snoonu template's status column. */
  snoonuStatus: "Listed" | "Not Listed" | "Needs Review";
  lifecycleState: LifecycleState;
  status: ExportItemStatus;
  reasons: ExportReason[];
}

export interface SnoonuPreviewResult {
  storefrontKey: SnoonuStorefrontKey;
  rows: SnoonuPreviewRow[];
  items: ExportValidationItem[];
  summary: ExportValidationSummary;
  preview: ExportPreview;
  counts: { productCount: number; mappedCount: number; unmappedCount: number };
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

/** Build the validated Snoonu preview for ONE storefront. Pure + deterministic. */
export function buildSnoonuPreview(input: SnoonuPreviewInput): SnoonuPreviewResult {
  const storefrontKey = input?.storefrontKey;
  const products = Array.isArray(input?.products) ? input.products : [];
  const mappingBySku = input?.mappingBySku ?? {};

  // First pass — resolve identity for dataset-wide duplicate detection.
  const skuLower: string[] = [];
  const barcodes: string[] = [];
  for (const p of products) {
    skuLower.push(normalizeExportedSku(p.sku).toLowerCase());
    barcodes.push(normalizeBarcode(p.barcode) ?? "");
  }
  const skuCounts = tally(skuLower);
  const barcodeCounts = tally(barcodes);

  const rows: SnoonuPreviewRow[] = products.map((p) => buildRow(p, storefrontKey, skuCounts, barcodeCounts, mappingBySku));

  const items: ExportValidationItem[] = rows.map((r) => ({
    entityId: r.internalProductId,
    destination: storefrontKey,
    status: r.status,
    reasons: r.reasons,
  }));
  const summary = summarizeValidation(items);
  const previewItems: ExportPreviewItem[] = rows.map((r) => ({
    internalProductId: r.internalProductId,
    variantId: null,
    sku: r.sku || null,
    barcode: r.barcode,
    title: r.title,
    destination: storefrontKey,
    storefront: storefrontKey,
    grain: "PRODUCT",
    status: r.status,
    warnings: r.reasons.filter((x) => !x.blocking),
    blockingReasons: r.reasons.filter((x) => x.blocking),
    imageCount: r.imageCount,
    primaryImage: r.imageExportName,
    externalIdentity: {
      storefrontKey,
      externalProductId: r.spi,
      externalVariantId: null,
      exportedSku: r.mapping.exportedSku ?? (r.sku || null),
      identityType: "snoonu_spi",
    },
    metadata: { mappingStatus: r.mapping.status, snoonuStatus: r.snoonuStatus },
  }));

  let mappedCount = 0;
  for (const r of rows) if (r.spi !== null) mappedCount++;

  return {
    storefrontKey,
    rows,
    items,
    summary,
    preview: { destination: storefrontKey, grain: "PRODUCT", items: previewItems, placeholder: false },
    counts: { productCount: products.length, mappedCount, unmappedCount: products.length - mappedCount },
  };
}

function buildRow(
  p: SnoonuPreviewProduct,
  storefrontKey: SnoonuStorefrontKey,
  skuCounts: Map<string, number>,
  barcodeCounts: Map<string, number>,
  mappingBySku: Readonly<Record<string, SnoonuMappingEvidence>>,
): SnoonuPreviewRow {
  const sku = normalizeExportedSku(p.sku);
  const barcode = normalizeBarcode(p.barcode);
  const title = clean(p.nameEn) || clean(p.nameAr);
  const titleAr = clean(p.nameAr) || clean(p.nameEn);
  const category = clean(p.category) || null;
  const subCategory = clean(p.subCategory) || null;
  const price = positive(p.discountPrice) ?? positive(p.price);
  const hasImage = p.imageCount > 0 || clean(p.imageUrl) !== "" || clean(p.imageFilename) !== "";
  const ext = extensionFromUrl(p.imageFilename || p.imageUrl);
  const imageExportName = sku ? primaryImageName(sku, ext) : null;
  const primaryImageUrl = clean(p.imageUrl) !== "" ? p.imageUrl : null;
  const galleryImageUrls = Array.isArray(p.galleryImageUrls) ? p.galleryImageUrls.filter((u) => clean(u) !== "") : [];
  const state = resolveLifecycleState({ lifecycle_state: p.lifecycleState, platform_status: p.platformStatus });
  const mapping = sku ? (mappingBySku[sku.toLowerCase()] ?? UNMAPPED) : UNMAPPED;
  const spi = mapping.externalId;
  const snoonuStatus: SnoonuPreviewRow["snoonuStatus"] =
    mapping.status === "resolved" ? "Listed" : mapping.status === "needs_review" ? "Needs Review" : "Not Listed";

  const reasons: ExportReason[] = [];
  const block = (code: ExportReason["code"], message?: string) => reasons.push({ code, blocking: true, message });
  const warn = (code: ExportReason["code"], message?: string) => reasons.push({ code, blocking: false, message });

  // Lifecycle eligibility (reuses OPS.8 — STOPPED products are not exportable).
  if (state === "STOPPED") block("LIFECYCLE_NOT_ELIGIBLE", "المنتج موقوف — غير مؤهّل للتصدير.");

  // SKU (identity key). No fabrication; dataset-wide duplicate blocks.
  if (sku === "") block("MISSING_SKU");
  else if ((skuCounts.get(sku.toLowerCase()) ?? 0) > 1) block("DUPLICATE_SKU");

  // Barcode — Snoonu onboarding accepts items pending a barcode, so MISSING is a
  // WARNING; a DUPLICATE barcode within the export still BLOCKS (data integrity);
  // a non-standard format is a warning.
  if (barcode === null) warn("MISSING_BARCODE");
  else if ((barcodeCounts.get(barcode) ?? 0) > 1) block("DUPLICATE_BARCODE");
  else if (!BARCODE_RE.test(barcode)) warn("INVALID_BARCODE", "صيغة الباركود غير قياسية.");

  // Image (a row with no product image cannot enter the image package).
  if (!hasImage) block("MISSING_IMAGE");

  // Title / price / category.
  if (title === "") block("MISSING_TITLE");
  if (price === null) warn("MISSING_PRICE");
  if (category === null) warn("MISSING_CATEGORY");

  // Identity — a conflicting ECL mapping (same exported SKU → a DIFFERENT product
  // on this storefront) blocks; a needs_review mapping is a non-blocking flag.
  if (mapping.productId && mapping.productId !== p.id) block("IDENTITY_CONFLICT", "تعارض هوية: نفس الـ SKU مربوط بمنتج آخر في هذا المتجر.");
  if (mapping.status === "needs_review") warn("IDENTITY_NEEDS_REVIEW", "ربط بحاجة لمراجعة في ECL.");

  const blocking = reasons.some((r) => r.blocking);
  const status: ExportItemStatus = blocking ? "BLOCKED" : reasons.length > 0 ? "WARNING" : "READY";

  return {
    storefrontKey,
    internalProductId: p.id,
    grain: "PRODUCT",
    sku,
    barcode,
    title,
    titleAr,
    category,
    subCategory,
    price,
    discountPrice: positive(p.discountPrice),
    descriptionEn: clean(p.descriptionEn),
    descriptionAr: clean(p.descriptionAr),
    keywordsEn: clean(p.keywordsEn),
    keywordsAr: clean(p.keywordsAr),
    hasImage,
    imageCount: p.imageCount,
    imageExportName,
    primaryImageUrl,
    galleryImageUrls,
    spi,
    mapping,
    snoonuStatus,
    lifecycleState: state,
    status,
    reasons,
  };
}
