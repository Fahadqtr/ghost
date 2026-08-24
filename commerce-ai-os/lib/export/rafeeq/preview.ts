// INT.2D + RAFEEQ.FULLSYNC.2 — Rafeeq export preview (PURE).
//
// Rafeeq lists at SELLABLE-LISTING flattening (RAFEEQ.FULLSYNC.2):
//   • a SIMPLE product (no variants)   → exactly ONE row (grain PRODUCT);
//   • a product WITH variants          → ONE row PER legitimate variant (grain
//     VARIANT) and NO parent row — the parent is never exported as an extra
//     sellable listing (the P0 no-double-export invariant, mirrored from the
//     certified Talabat flattening).
// Variant rows use the variant's OWN sku as the sellable identity (image
// naming, ECL keying, dedup), the certified flattened title (buildFlattenedName
// — the proven Talabat projection, reused not reinvented), the parent's
// category/descriptions/canonical images, and the canonical variant sell price:
//   positive(variant.price) ?? positive(parent.discountPrice) ?? positive(parent.price)
//
// RAFEEQ TEMPLATE BARCODE RULE (owner decision, 2026-08-24): the Rafeeq BARCODE
// column carries the canonical PARENT product SKU for EVERY row — the real
// EAN/product barcode is NEVER exported to Rafeeq, and a variant's own
// sku/barcode is NEVER written to the BARCODE column (they stay internal).
// Option rows deliberately REPEAT the parent SKU so Rafeeq groups them as ONE
// product with options — never as separate products. The only blocking
// duplicate is the same barcode value claimed by MORE THAN ONE internal
// product (a corrupted grouping key). Canonical DB sku/barcode data is
// untouched — this is an export projection only.
//
// Identity is ECL-first and storefront-scoped: the Rafeeq Product ID is the ECL
// external_product_id read for storefront_key = "rafeeq:malikas" only, keyed by
// the EXPORTED (sellable) sku. This module NEVER reads the legacy per-store id
// column on products, never invents an id, and never guesses identity by product name.
// A row with no active ECL row is UNMAPPED (new). A contested mapping (ECL
// mapping_status = needs_review) is a P0 BLOCK — displayed as "Rafeeq Identity
// Conflict — Needs Owner Review" and NEVER auto-resolved. Certified SKU/barcode
// normalizers + the INT.2A image-naming + validation contracts are REUSED.
// Duplicate SKU/barcode/image-filename are checked across the FINAL flattened
// dataset. No I/O — node:test loads it.

import { buildFlattenedName, normalizeExportedSku } from "../../talabat/export.ts";
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

/** One legitimate product option/variant (from product_variants). The variant
 *  barcode is canonical INTERNAL data — it is never exported to Rafeeq. */
export interface RafeeqPreviewVariant {
  id: string | null;
  sku: string | null;
  barcode: string | null;
  /** variant_name_en / variant_name */
  nameEn: string | null;
  nameAr: string | null;
  price: number | null;
}

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
  /** Legitimate variants — a non-empty list flattens this product to variant rows. */
  variants?: readonly RafeeqPreviewVariant[];
}

/**
 * Storefront-scoped ECL identity evidence for rafeeq:malikas, keyed by the
 * EXPORTED (sellable) sku. `productId` is the ECL row's internal product (to
 * detect a cross-product conflict); `variantId` is the variant-grain identity
 * when present. `status` mirrors ECL mapping_status. A missing entry ⇒ unmapped.
 */
export interface RafeeqMappingEvidence {
  status: "resolved" | "needs_review" | "unmapped";
  externalId: string | null; // Rafeeq Product ID (ECL external_product_id)
  exportedSku: string | null;
  productId: string | null;
  variantId?: string | null;
}
const UNMAPPED: RafeeqMappingEvidence = { status: "unmapped", externalId: null, exportedSku: null, productId: null, variantId: null };

export interface RafeeqPreviewInput {
  products: readonly RafeeqPreviewProduct[];
  /** ECL evidence for rafeeq:malikas only, keyed by lower(exported sku). */
  mappingBySku?: Readonly<Record<string, RafeeqMappingEvidence>>;
}

export interface RafeeqPreviewRow {
  storefrontKey: RafeeqStorefrontKey;
  internalProductId: string;
  /** the sellable variant behind this row; null for a simple product row. */
  variantId: string | null;
  /** stable per-row key: product id for simple rows, product::variant for variant rows. */
  rowKey: string;
  grain: "PRODUCT" | "VARIANT";
  isVariant: boolean;
  sku: string;
  /** Rafeeq BARCODE column value = the canonical PARENT product SKU (owner
   *  template rule) — never the real EAN, never the variant's sku/barcode. */
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
  imageExportName: string | null; // SKU-based (the SELLABLE sku)
  primaryImageUrl: string | null;
  galleryImageUrls: readonly string[];
  /** true when a variant row ships the parent's canonical image (no variant media model yet). */
  inheritedParentImage: boolean;
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
  counts: {
    productCount: number;
    /** total sellable rows (simple + variant). */
    sellableRowCount: number;
    simpleRowCount: number;
    variantRowCount: number;
    productsWithVariants: number;
    mappedCount: number;
    unmappedCount: number;
    needsReviewCount: number;
  };
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

interface StagedRow {
  product: RafeeqPreviewProduct;
  variant: RafeeqPreviewVariant | null;
}

/** Flatten products → sellable rows: variants ⇒ one row each, NO parent row. */
function stage(products: readonly RafeeqPreviewProduct[]): StagedRow[] {
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

/** Stable per-row key (simple ⇒ product id; variant ⇒ product::variant). */
export function sellableRowKey(productId: string, variantId: string | null | undefined): string {
  return variantId ? `${productId}::${variantId}` : productId;
}

/** Build the validated Rafeeq preview. Pure + deterministic. */
export function buildRafeeqPreview(input: RafeeqPreviewInput): RafeeqPreviewResult {
  const products = Array.isArray(input?.products) ? input.products : [];
  const mappingBySku = input?.mappingBySku ?? {};
  const staged = stage(products);

  // First pass — resolve every SELLABLE identity for dataset-wide duplicate checks.
  const skuLower: string[] = [];
  const imageNames: string[] = [];
  // Rafeeq BARCODE column = canonical PARENT product SKU (owner template rule).
  // Sibling option rows deliberately REPEAT it, so the only duplicate that can
  // block is the same value claimed by MORE THAN ONE distinct internal product.
  const barcodeOwners = new Map<string, Set<string>>();
  for (const s of staged) {
    const sku = normalizeExportedSku(s.variant ? s.variant.sku : s.product.sku);
    skuLower.push(sku.toLowerCase());
    const parentSku = normalizeExportedSku(s.product.sku);
    if (parentSku !== "") {
      const owners = barcodeOwners.get(parentSku.toLowerCase()) ?? new Set<string>();
      owners.add(s.product.id);
      barcodeOwners.set(parentSku.toLowerCase(), owners);
    }
    // sanitized primary filename base (SELLABLE sku) for collision detection
    const p = s.product;
    imageNames.push(sku ? primaryImageName(sku, extensionFromUrl(p.imageFilename || p.imageUrl)).toLowerCase() : "");
  }
  const skuCounts = tally(skuLower);
  const imageNameCounts = tally(imageNames);

  let variantRowCount = 0;
  const withVariants = new Set<string>();
  const rows: RafeeqPreviewRow[] = staged.map((s, i) => {
    if (s.variant) {
      variantRowCount++;
      withVariants.add(s.product.id);
    }
    return buildRow(s, skuCounts, barcodeOwners, imageNameCounts, imageNames[i], mappingBySku);
  });

  const items: ExportValidationItem[] = rows.map((r) => ({ entityId: r.variantId ?? r.internalProductId, destination: RAFEEQ_STOREFRONT_KEY, status: r.status, reasons: r.reasons }));
  const summary = summarizeValidation(items);
  const previewItems: ExportPreviewItem[] = rows.map((r) => ({
    internalProductId: r.internalProductId,
    variantId: r.variantId,
    sku: r.sku || null,
    barcode: r.barcode,
    title: r.title,
    destination: RAFEEQ_STOREFRONT_KEY,
    storefront: RAFEEQ_STOREFRONT_KEY,
    grain: r.grain,
    status: r.status,
    warnings: r.reasons.filter((x) => !x.blocking),
    blockingReasons: r.reasons.filter((x) => x.blocking),
    imageCount: r.imageCount,
    primaryImage: r.imageExportName,
    externalIdentity: { storefrontKey: RAFEEQ_STOREFRONT_KEY, externalProductId: r.rafeeqId, externalVariantId: null, exportedSku: r.mapping.exportedSku ?? (r.sku || null), identityType: RAFEEQ_IDENTITY_TYPE },
    metadata: { mappingStatus: r.mapping.status, needsOwnerReview: r.needsOwnerReview, inheritedParentImage: r.inheritedParentImage },
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
    preview: { destination: RAFEEQ_STOREFRONT_KEY, grain: "SELLABLE_LISTING", items: previewItems, placeholder: false },
    counts: {
      productCount: products.length,
      sellableRowCount: rows.length,
      simpleRowCount: rows.length - variantRowCount,
      variantRowCount,
      productsWithVariants: withVariants.size,
      mappedCount,
      unmappedCount: rows.length - mappedCount,
      needsReviewCount,
    },
  };
}

function buildRow(
  s: StagedRow,
  skuCounts: Map<string, number>,
  barcodeOwners: Map<string, Set<string>>,
  imageNameCounts: Map<string, number>,
  imageNameLower: string,
  mappingBySku: Readonly<Record<string, RafeeqMappingEvidence>>,
): RafeeqPreviewRow {
  const { product: p, variant: v } = s;
  const isVariant = v !== null;
  // Sellable identity: the variant's OWN sku — NEVER the parent's.
  const sku = normalizeExportedSku(isVariant ? v!.sku : p.sku);
  // Rafeeq BARCODE column (owner template rule): the canonical PARENT product
  // SKU for EVERY row. The real EAN and the variant's own sku/barcode are
  // NEVER written here — option rows REPEAT the parent SKU so Rafeeq groups
  // them as ONE product with options, never as separate products.
  const barcode = normalizeExportedSku(p.sku) || null;
  // Certified flattened listing names ("{parent} — {option}", no repeat) — the
  // proven Talabat projection, reused for both languages.
  const title = isVariant
    ? buildFlattenedName(clean(p.nameEn) || clean(p.nameAr), clean(v!.nameEn) || clean(v!.nameAr))
    : clean(p.nameEn) || clean(p.nameAr);
  const titleAr = isVariant
    ? buildFlattenedName(clean(p.nameAr) || clean(p.nameEn), clean(v!.nameAr) || clean(v!.nameEn))
    : clean(p.nameAr) || clean(p.nameEn);
  const category = clean(p.category) || null;
  // Canonical sell price: an explicit positive variant price ALWAYS beats the
  // parent's; otherwise the variant inherits parent discount → parent price.
  const price = isVariant
    ? positive(v!.price) ?? positive(p.discountPrice) ?? positive(p.price)
    : positive(p.discountPrice) ?? positive(p.price);
  const hasImage = p.imageCount > 0 || clean(p.imageUrl) !== "" || clean(p.imageFilename) !== "";
  const inheritedParentImage = isVariant && hasImage; // no variant media model yet
  const ext = extensionFromUrl(p.imageFilename || p.imageUrl);
  const imageExportName = sku ? primaryImageName(sku, ext) : null;
  // Variants inherit the parent's canonical primary + gallery sources; the
  // package repackages them under the VARIANT sku filename so every Excel row
  // has a direct matching image (deliberate byte duplication across siblings).
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

  // SKU (P0) — a variant with no OWN sku is not sellable (no parent fallback).
  if (sku === "") {
    block("MISSING_SKU");
    if (isVariant) block("VARIANT_NOT_READY", "المتغيّر بدون SKU خاص — لا يورَّث SKU المنتج الأب.");
  } else if ((skuCounts.get(sku.toLowerCase()) ?? 0) > 1) {
    block("DUPLICATE_SKU");
  }

  // BARCODE column (P0) — the parent product SKU is the Rafeeq grouping key:
  // missing means the column cannot be filled; the same value claimed by MORE
  // THAN ONE internal product is a corrupted grouping key. Sibling option rows
  // repeating it is BY DESIGN and never flagged. The real EAN is not exported,
  // so its format/absence plays no part in Rafeeq validation.
  if (barcode === null) {
    block("MISSING_BARCODE", "عمود الباركود في رفيق يتطلب SKU المنتج الأب — وهو مفقود.");
  } else if ((barcodeOwners.get(barcode.toLowerCase())?.size ?? 0) > 1) {
    block("DUPLICATE_BARCODE", "نفس SKU الأب مستخدم من أكثر من منتج — مفتاح تجميع رفيق متعارض.");
  }

  if (!hasImage) block("MISSING_IMAGE");
  // Disclosed, never blocking: the variant ships the product-level image until a
  // variant media model exists (mirrors the certified Talabat disclosure).
  else if (inheritedParentImage) warn("IMAGE_SHARED_FROM_PRODUCT", "الصورة مشتركة من المنتج (لا يوجد نموذج صور للمتغيّرات بعد).");

  if (title === "") block("MISSING_TITLE");
  if (price === null) warn("MISSING_PRICE");
  if (category === null) warn("MISSING_CATEGORY");

  // Identity — P0. A cross-product ECL mapping blocks; a needs_review mapping is a
  // contested identity that MUST be blocked and sent for owner review (no
  // auto-resolution, no id fabrication).
  if (mapping.productId && mapping.productId !== p.id) block("IDENTITY_CONFLICT", "تعارض هوية: نفس الـ SKU مربوط بمنتج آخر في رفيق.");
  if (needsOwnerReview) block("IDENTITY_NEEDS_REVIEW", "تعارض هوية رفيق — بحاجة لمراجعة المالك.");

  // Deterministic filename collision across the FINAL dataset (two distinct
  // sellable SKUs whose sanitized primary filename is identical) — blocked
  // BEFORE package generation.
  if (sku !== "" && hasImage && imageNameLower !== "" && (imageNameCounts.get(imageNameLower) ?? 0) > 1) {
    block("IDENTITY_CONFLICT", "تعارض اسم ملف الصورة بعد التنقية — تصادم بين صفّين.");
  }

  const blocking = reasons.some((r) => r.blocking);
  const status: ExportItemStatus = blocking ? "BLOCKED" : reasons.length > 0 ? "WARNING" : "READY";

  const variantId = isVariant ? v!.id : null;
  // A variant row without a DB id still needs a UNIQUE row key — fall back to
  // the sellable sku (never silently collapse onto the parent's key).
  const rowKey = isVariant
    ? sellableRowKey(p.id, variantId ?? `sku:${sku || "missing"}`)
    : sellableRowKey(p.id, null);
  return {
    storefrontKey: RAFEEQ_STOREFRONT_KEY,
    internalProductId: p.id,
    variantId,
    rowKey,
    grain: isVariant ? "VARIANT" : "PRODUCT",
    isVariant,
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
    inheritedParentImage,
    rafeeqId,
    mapping,
    needsOwnerReview,
    lifecycleState: state,
    status,
    reasons,
  };
}
