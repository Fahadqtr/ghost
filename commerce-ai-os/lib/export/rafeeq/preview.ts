// RAFEEQ NATIVE-OPTION PREVIEW (PURE) — the audited real Rafeeq model.
//
// Rafeeq does NOT model our variants as separate products. The audited real
// workbook (native-template.ts) proves:
//   • a SIMPLE product        → ONE product identity, one physical row;
//   • a product WITH variants → ONE product identity whose variants are OPTIONS
//     inside ONE native option group. The physical file repeats the parent row
//     once per option (identical parent fields; only option cells vary), but
//     those repeated rows are ONE Rafeeq product — never separate listings.
//
// This preview is PRODUCT-grain: one row per canonical product, carrying its
// full ordered option set. The parent title is NEVER flattened with the option
// label — option labels live ONLY in the option name fields.
//
// RAFEEQ TEMPLATE BARCODE RULE (owner decision, kept from PR #677): the
// exported BARCODE carries the canonical PARENT product SKU on every physical
// row. The real EAN and the variant's own sku/barcode are NEVER exported —
// they stay internal to Malikas AI.
//
// PRICING (audited contract limit): every numeric-priced workbook product has
// option_price = 0 — options included in the parent price. Our encoding:
//   • options all at ONE effective price → product_price = that price,
//     option_price = 0 (the parent's own stale price column is NOT trusted over
//     the uniform option price);
//   • options at DIFFERING effective prices → the workbook does not prove the
//     encoding for a numeric parent price ⇒ OPTION_PRICE_UNRESOLVED (blocking,
//     surfaced to the owner — never guessed).
// Effective option price = positive(variant.price) ?? parent sell price
// (positive(discount) ?? positive(price)).
//
// Identity is ECL-first at PRODUCT grain, storefront-scoped (rafeeq:malikas),
// keyed by the parent exported sku. Contested mappings (needs_review) BLOCK and
// are never auto-resolved. Images are PRODUCT-level only (the audited template
// has no option-image column): one packaged image set per product, named by the
// parent SKU, shared by every repeated option row. No I/O — node:test loads it.

import { normalizeExportedSku } from "../../talabat/export.ts";
import { storefrontByKey } from "../../channels/storefronts.ts";
import { resolveLifecycleState, type LifecycleState } from "../../lifecycle/state.ts";
import { primaryImageName, extensionFromUrl } from "../image-naming.ts";
import { summarizeValidation, type ExportItemStatus, type ExportReason, type ExportValidationItem, type ExportValidationSummary } from "../validation.ts";
import { type ExportPreview, type ExportPreviewItem } from "../preview.ts";
import { RAFEEQ_DEFAULT_GROUP_NAME_AR, RAFEEQ_DEFAULT_GROUP_NAME_EN, RAFEEQ_NATIVE_CATEGORIES } from "./native-template.ts";

export const RAFEEQ_STOREFRONT_KEY = "rafeeq:malikas" as const;
export type RafeeqStorefrontKey = typeof RAFEEQ_STOREFRONT_KEY;

// The ECL identity-type discriminator comes from the certified storefront
// registry (single source of truth) — never hardcoded here, and never the legacy
// products column.
const RAFEEQ_IDENTITY_TYPE = storefrontByKey(RAFEEQ_STOREFRONT_KEY)?.identityType ?? null;

/** One legitimate product option/variant (from product_variants). The variant
 *  sku/barcode are canonical INTERNAL data — never exported to Rafeeq. */
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
  /** Legitimate variants — projected as native OPTIONS of this one product. */
  variants?: readonly RafeeqPreviewVariant[];
}

/**
 * Storefront-scoped ECL identity evidence for rafeeq:malikas at PRODUCT grain,
 * keyed by lower(parent exported sku). A missing entry ⇒ unmapped.
 */
export interface RafeeqMappingEvidence {
  status: "resolved" | "needs_review" | "unmapped";
  externalId: string | null; // Rafeeq product_id (ECL external_product_id)
  exportedSku: string | null;
  productId: string | null;
}
const UNMAPPED: RafeeqMappingEvidence = { status: "unmapped", externalId: null, exportedSku: null, productId: null };

export interface RafeeqPreviewInput {
  products: readonly RafeeqPreviewProduct[];
  /** ECL evidence for rafeeq:malikas only, keyed by lower(parent exported sku). */
  mappingBySku?: Readonly<Record<string, RafeeqMappingEvidence>>;
}

/** One native option of a product (deterministically ordered). */
export interface RafeeqPreviewOption {
  variantId: string | null;
  /** canonical internal variant sku — internal only, NEVER exported. */
  internalSku: string | null;
  nameEn: string;
  nameAr: string;
  /** canonical effective price (variant price ?? parent sell price). */
  effectivePrice: number | null;
  /** deterministic 1..N ordering (internal sku natural order, then name). */
  sortOrder: number;
}

/** ONE canonical product = ONE Rafeeq product identity. */
export interface RafeeqPreviewRow {
  storefrontKey: RafeeqStorefrontKey;
  internalProductId: string;
  /** stable row key = the product id (product-grain). */
  rowKey: string;
  /** canonical parent product SKU. */
  sku: string;
  /** Rafeeq BARCODE cell = the canonical PARENT product SKU (owner template
   *  rule) — never the real EAN, never a variant sku/barcode. */
  barcode: string | null;
  /** PARENT title only — never flattened with an option label. */
  title: string;
  titleAr: string;
  category: string | null;
  /** the product_price cell value (uniform option price, or parent sell price). */
  price: number | null;
  descriptionEn: string;
  descriptionAr: string;
  hasImage: boolean;
  imageCount: number;
  /** packaged parent image filename (parent-SKU-based), shared by option rows. */
  imageExportName: string | null;
  primaryImageUrl: string | null;
  galleryImageUrls: readonly string[];
  /** deterministic native option set (empty = simple product). */
  options: RafeeqPreviewOption[];
  hasOptions: boolean;
  optionCount: number;
  /** physical spreadsheet rows this product occupies (1 or optionCount). */
  physicalRowCount: number;
  groupNameEn: string;
  groupNameAr: string;
  /** true when options carry DIFFERING effective prices — encoding unproven by
   *  the audited workbook ⇒ blocked until the owner resolves the contract. */
  optionPriceUnresolved: boolean;
  /** Rafeeq product_id from ECL (null ⇒ new/unmapped — never invented). */
  rafeeqId: string | null;
  mapping: RafeeqMappingEvidence;
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
    /** canonical Rafeeq PRODUCT identities (the business count — never rows). */
    productCount: number;
    productsWithOptions: number;
    optionCount: number;
    /** physical spreadsheet data rows (a product repeats once per option). */
    physicalRowCount: number;
    mappedCount: number;
    unmappedCount: number;
    needsReviewCount: number;
    optionPriceUnresolvedCount: number;
  };
}

function clean(v: string | null | undefined): string {
  return typeof v === "string" ? v.trim() : "";
}
function positive(v: number | null | undefined): number | null {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;
}

/** product-grain delivery/row key. */
export function productRowKey(productId: string): string {
  return productId;
}

/** Deterministic option ordering: internal sku natural order, then name, then id. */
function orderOptions(variants: readonly RafeeqPreviewVariant[], parentSell: number | null): RafeeqPreviewOption[] {
  const opts = variants.map((v) => ({
    variantId: v.id ?? null,
    internalSku: clean(v.sku) || null,
    nameEn: clean(v.nameEn) || clean(v.nameAr),
    nameAr: clean(v.nameAr) || clean(v.nameEn),
    effectivePrice: positive(v.price) ?? parentSell,
    sortOrder: 0,
  }));
  opts.sort((a, b) =>
    (a.internalSku ?? "").localeCompare(b.internalSku ?? "", "en", { numeric: true, sensitivity: "base" }) ||
    a.nameEn.localeCompare(b.nameEn, "en", { sensitivity: "base" }) ||
    (a.variantId ?? "").localeCompare(b.variantId ?? ""));
  opts.forEach((o, i) => { o.sortOrder = i + 1; });
  return opts;
}

/** Build the validated PRODUCT-grain Rafeeq preview. Pure + deterministic. */
export function buildRafeeqPreview(input: RafeeqPreviewInput): RafeeqPreviewResult {
  const products = Array.isArray(input?.products) ? input.products : [];
  const mappingBySku = input?.mappingBySku ?? {};

  // Dataset-wide duplicate checks at PRODUCT grain: the parent SKU is both the
  // sku identity and the exported BARCODE (Rafeeq's grouping key), and the
  // parent image filename base must be unique post-sanitization.
  const skuOwners = new Map<string, Set<string>>();
  const imageNameOwners = new Map<string, Set<string>>();
  const imageNames: string[] = [];
  for (const p of products) {
    const sku = normalizeExportedSku(p.sku);
    if (sku !== "") {
      const owners = skuOwners.get(sku.toLowerCase()) ?? new Set<string>();
      owners.add(p.id);
      skuOwners.set(sku.toLowerCase(), owners);
    }
    const name = sku ? primaryImageName(sku, extensionFromUrl(p.imageFilename || p.imageUrl)).toLowerCase() : "";
    imageNames.push(name);
    if (name !== "") {
      const owners = imageNameOwners.get(name) ?? new Set<string>();
      owners.add(p.id);
      imageNameOwners.set(name, owners);
    }
  }

  const rows: RafeeqPreviewRow[] = products.map((p, i) => buildRow(p, skuOwners, imageNameOwners, imageNames[i], mappingBySku));

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
    metadata: { mappingStatus: r.mapping.status, needsOwnerReview: r.needsOwnerReview, optionCount: r.optionCount, optionPriceUnresolved: r.optionPriceUnresolved },
  }));

  let mappedCount = 0;
  let needsReviewCount = 0;
  let productsWithOptions = 0;
  let optionCount = 0;
  let physicalRowCount = 0;
  let optionPriceUnresolvedCount = 0;
  for (const r of rows) {
    if (r.rafeeqId !== null) mappedCount++;
    if (r.needsOwnerReview) needsReviewCount++;
    if (r.hasOptions) productsWithOptions++;
    optionCount += r.optionCount;
    physicalRowCount += r.physicalRowCount;
    if (r.optionPriceUnresolved) optionPriceUnresolvedCount++;
  }

  return {
    storefrontKey: RAFEEQ_STOREFRONT_KEY,
    rows,
    items,
    summary,
    preview: { destination: RAFEEQ_STOREFRONT_KEY, grain: "PRODUCT", items: previewItems, placeholder: false },
    counts: {
      productCount: products.length,
      productsWithOptions,
      optionCount,
      physicalRowCount,
      mappedCount,
      unmappedCount: rows.length - mappedCount,
      needsReviewCount,
      optionPriceUnresolvedCount,
    },
  };
}

function buildRow(
  p: RafeeqPreviewProduct,
  skuOwners: Map<string, Set<string>>,
  imageNameOwners: Map<string, Set<string>>,
  imageNameLower: string,
  mappingBySku: Readonly<Record<string, RafeeqMappingEvidence>>,
): RafeeqPreviewRow {
  const sku = normalizeExportedSku(p.sku);
  // Rafeeq BARCODE cell (owner template rule): the canonical PARENT product SKU
  // on EVERY physical row. The real EAN and any variant sku/barcode are NEVER
  // written here; repeated option rows share it as Rafeeq's grouping key.
  const barcode = sku || null;
  // PARENT titles only — option labels live ONLY in the option name cells.
  const title = clean(p.nameEn) || clean(p.nameAr);
  const titleAr = clean(p.nameAr) || clean(p.nameEn);
  const category = clean(p.category) || null;
  const parentSell = positive(p.discountPrice) ?? positive(p.price);

  const variants = Array.isArray(p.variants) ? p.variants : [];
  const options = orderOptions(variants, parentSell);
  const hasOptions = options.length > 0;

  // Audited pricing: a uniform effective option price IS the product price
  // (option_price 0). Differing effective prices are an unproven encoding for a
  // numeric parent price ⇒ surfaced, never guessed.
  let price = parentSell;
  let optionPriceUnresolved = false;
  if (hasOptions) {
    const prices = new Set(options.map((o) => o.effectivePrice ?? -1));
    if (prices.size === 1) {
      price = options[0].effectivePrice ?? parentSell;
    } else {
      optionPriceUnresolved = true;
    }
  }

  const hasImage = p.imageCount > 0 || clean(p.imageUrl) !== "" || clean(p.imageFilename) !== "";
  const ext = extensionFromUrl(p.imageFilename || p.imageUrl);
  const imageExportName = sku ? primaryImageName(sku, ext) : null;
  const primaryImageUrl = clean(p.imageUrl) !== "" ? p.imageUrl : null;
  const galleryImageUrls = Array.isArray(p.galleryImageUrls) ? p.galleryImageUrls.filter((u) => clean(u) !== "") : [];
  const state = resolveLifecycleState({ lifecycle_state: p.lifecycleState, platform_status: p.platformStatus });
  const mapping = sku ? (mappingBySku[sku.toLowerCase()] ?? UNMAPPED) : UNMAPPED;
  // needs_review is a P0 contested mapping — it blocks (never auto-resolved).
  const needsOwnerReview = mapping.status === "needs_review";
  const rafeeqId = mapping.status === "resolved" ? mapping.externalId : null;

  const reasons: ExportReason[] = [];
  const block = (code: ExportReason["code"], message?: string) => reasons.push({ code, blocking: true, message });
  const warn = (code: ExportReason["code"], message?: string) => reasons.push({ code, blocking: false, message });

  if (state === "STOPPED") block("LIFECYCLE_NOT_ELIGIBLE", "المنتج موقوف — غير مؤهّل للتصدير.");

  // Parent SKU (P0): it is the sku identity AND the exported barcode grouping key.
  if (sku === "") {
    block("MISSING_SKU");
    block("MISSING_BARCODE", "عمود الباركود في رفيق يتطلب SKU المنتج الأب — وهو مفقود.");
  } else if ((skuOwners.get(sku.toLowerCase())?.size ?? 0) > 1) {
    block("DUPLICATE_SKU");
    block("DUPLICATE_BARCODE", "نفس SKU الأب مستخدم من أكثر من منتج — مفتاح تجميع رفيق متعارض.");
  }

  if (!hasImage) block("MISSING_IMAGE");
  if (title === "") block("MISSING_TITLE");
  // A category outside the audited live Rafeeq registry exports blank category
  // cells (a Rafeeq category id is never invented) — disclosed as a warning.
  if (category === null) warn("MISSING_CATEGORY");
  else if (!RAFEEQ_NATIVE_CATEGORIES[category]) warn("MISSING_CATEGORY", "الفئة غير موجودة في سجلّ فئات رفيق المدقَّق — ستُصدَّر خلايا الفئة فارغة.");

  // Options: an option needs a display name (its labels are the ONLY thing that
  // distinguishes the repeated rows); missing names make the group unbuildable.
  if (hasOptions && options.some((o) => o.nameEn === "" && o.nameAr === "")) {
    block("VARIANT_NOT_READY", "خيار بدون اسم — لا يمكن بناء مجموعة الخيارات.");
  }

  if (optionPriceUnresolved) {
    block("OPTION_PRICE_UNRESOLVED",
      "أسعار الخيارات مختلفة — ترميز option_price غير مثبت في قالب رفيق؛ بانتظار قرار المالك.");
  } else if (price === null) {
    warn("MISSING_PRICE");
  }

  // Identity — P0. A cross-product ECL mapping blocks; a needs_review mapping is a
  // contested identity that MUST be blocked and sent for owner review.
  if (mapping.productId && mapping.productId !== p.id) block("IDENTITY_CONFLICT", "تعارض هوية: نفس الـ SKU مربوط بمنتج آخر في رفيق.");
  if (needsOwnerReview) block("IDENTITY_NEEDS_REVIEW", "تعارض هوية رفيق — بحاجة لمراجعة المالك.");

  // Deterministic post-sanitization image filename collision across products.
  if (sku !== "" && hasImage && imageNameLower !== "" && (imageNameOwners.get(imageNameLower)?.size ?? 0) > 1) {
    block("IDENTITY_CONFLICT", "تعارض اسم ملف الصورة بعد التنقية — تصادم بين منتجين.");
  }

  const blocking = reasons.some((r) => r.blocking);
  const status: ExportItemStatus = blocking ? "BLOCKED" : reasons.length > 0 ? "WARNING" : "READY";

  return {
    storefrontKey: RAFEEQ_STOREFRONT_KEY,
    internalProductId: p.id,
    rowKey: productRowKey(p.id),
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
    options,
    hasOptions,
    optionCount: options.length,
    physicalRowCount: Math.max(1, options.length),
    groupNameEn: RAFEEQ_DEFAULT_GROUP_NAME_EN,
    groupNameAr: RAFEEQ_DEFAULT_GROUP_NAME_AR,
    optionPriceUnresolved,
    rafeeqId,
    mapping,
    needsOwnerReview,
    lifecycleState: state,
    status,
    reasons,
  };
}
