// INT.2E — Shopify validation + publish preview (PURE, READ-ONLY).
//
// Shopify lists at PRODUCT grain, but a product with variants is compared in a
// VARIANT-AWARE way (§2): every internal variant is aligned to a live Shopify
// variant and its own SKU / barcode / price / variant GID are diffed — a
// variant-level difference is NEVER hidden behind the parent.
//
// Identity is ECL-first and storefront-scoped (§1): the canonical identity is the
// Shopify Product GID + Variant GID read from external_channel_listings for
// storefront_key = "shopify:malikas" only. This module NEVER invents a GID, and
// NEVER accepts an approximate name/title match as identity. SKU is used ONLY to
// align variants WITHIN a product that is already identity-matched by GID, and as
// contradiction evidence for the CONFLICT rules (§10) — never as cross-product
// identity on its own.
//
// This is a preview only. It classifies each product as MATCH / NEW /
// UPDATE_REQUIRED / CONFLICT / BLOCKED / UNKNOWN (§4), produces field- and
// variant-level diffs proven from reliable data, and emits a deterministic future
// mutation plan (§12: CREATE_PRODUCT / UPDATE_PRODUCT / UPDATE_VARIANT /
// UPDATE_PRICE / UPDATE_MEDIA / NOOP / BLOCKED). It performs NO I/O and NO
// mutation, and it plans NO auto-publish and NO raw inventory write (§6, §13).
// Framework-free and dependency-light — node:test loads it directly (no @/ paths).

import { normalizeExportedSku, normalizeBarcode } from "../../talabat/export.ts";
import { storefrontByKey } from "../../channels/storefronts.ts";
import { resolveLifecycleState, type LifecycleState } from "../../lifecycle/state.ts";
import {
  summarizeValidation,
  type ExportItemStatus,
  type ExportReason,
  type ExportReasonCode,
  type ExportValidationItem,
  type ExportValidationSummary,
} from "../validation.ts";
import { type ExportPreview, type ExportPreviewItem } from "../preview.ts";

export const SHOPIFY_STOREFRONT_KEY = "shopify:malikas" as const;
export type ShopifyStorefrontKey = typeof SHOPIFY_STOREFRONT_KEY;

// ECL identity-type discriminator from the certified storefront registry (single
// source of truth) — never hardcoded, never a legacy products column.
const SHOPIFY_IDENTITY_TYPE = storefrontByKey(SHOPIFY_STOREFRONT_KEY)?.identityType ?? null;

const BARCODE_RE = /^[0-9]{6,14}$/;
const PRICE_EPSILON = 0.005; // money compared to the cent — anything finer is noise

// ── Shopify-specific classification (richer than the shared 4-state status) ─────
export type ShopifyPreviewStatus = "MATCH" | "NEW" | "UPDATE_REQUIRED" | "CONFLICT" | "BLOCKED" | "UNKNOWN";

// Future mutation plan op types (§12) — READ-ONLY here; nothing executes them.
export type ShopifyPlanOpType =
  | "CREATE_PRODUCT"
  | "UPDATE_PRODUCT"
  | "UPDATE_VARIANT"
  | "UPDATE_PRICE"
  | "UPDATE_MEDIA"
  | "NOOP"
  | "BLOCKED";

export const SHOPIFY_PLAN_OP_TYPES: readonly ShopifyPlanOpType[] = [
  "CREATE_PRODUCT",
  "UPDATE_PRODUCT",
  "UPDATE_VARIANT",
  "UPDATE_PRICE",
  "UPDATE_MEDIA",
  "NOOP",
  "BLOCKED",
];

export interface ShopifyPlanOp {
  type: ShopifyPlanOpType;
  target: "product" | "variant" | "media";
  /** Fields this op would change (deterministic, for review only). */
  fields: readonly string[];
  /** Internal variant id (variant-scoped ops only). */
  variantId?: string | null;
  /** Live Shopify variant GID (variant-scoped ops only; null ⇒ would create). */
  variantGid?: string | null;
  /** Fixed reason for a BLOCKED op (never raw DB text). */
  reason?: string;
}

// ── Inputs ─────────────────────────────────────────────────────────────────────
export interface ShopifyInternalVariant {
  id: string;
  sku: string | null;
  barcode: string | null;
  variantName: string | null;
  price: number | null;
}

export interface ShopifyInternalProduct {
  id: string;
  sku: string | null;
  barcode: string | null;
  nameEn: string | null;
  nameAr: string | null;
  descriptionEn: string | null;
  descriptionAr: string | null;
  price: number | null;
  discountPrice: number | null;
  imageUrl: string | null;
  imageFilename: string | null;
  imageCount: number;
  variants?: readonly ShopifyInternalVariant[];
  lifecycleState?: unknown;
  platformStatus?: unknown;
}

/**
 * Live Shopify snapshot (mirrors lib/shopify/admin's read shape but declared
 * locally so this pure module never imports the live Admin client).
 */
export interface ShopifyLiveVariant {
  id: string; // gid://shopify/ProductVariant/…
  sku: string;
  barcode: string;
  price: string;
  compareAtPrice: string | null;
  inventoryQuantity: number | null;
}
export interface ShopifyLiveProduct {
  id: string; // gid://shopify/Product/…
  title: string;
  status: string; // ACTIVE | DRAFT | ARCHIVED
  descriptionHtml: string;
  imageUrl: string; // featured image ("" when none)
  variants: readonly ShopifyLiveVariant[];
}

/**
 * Storefront-scoped ECL identity evidence for shopify:malikas, keyed by internal
 * product id. `status` mirrors ECL mapping_status. A missing entry ⇒ unmapped.
 * `productGid` is the ECL external_product_id (Shopify Product GID).
 * `variantGidByVariantId` maps an internal variant id → its ECL external_variant_id.
 * `hasConflictingProductGids` ⇒ the ECL rows for this internal product disagree on
 * the product GID (one-internal → many-GID, §10) — never auto-resolved.
 * `eclProductIdForGid` is used to detect one-GID → many-internal at the caller.
 */
export interface ShopifyIdentityEvidence {
  status: "active" | "needs_review";
  productGid: string | null;
  variantGidByVariantId: Readonly<Record<string, string>>;
  hasConflictingProductGids?: boolean;
}

export interface ShopifyPreviewInput {
  products: readonly ShopifyInternalProduct[];
  /** Live store snapshot; `null` ⇒ Shopify unconfigured or unreadable ⇒ UNKNOWN. */
  live: readonly ShopifyLiveProduct[] | null;
  /** ECL evidence for shopify:malikas only, keyed by internal product id. */
  mappingByProductId?: Readonly<Record<string, ShopifyIdentityEvidence>>;
}

// ── Diff descriptors ────────────────────────────────────────────────────────────
export type ShopifyDiffField = "title" | "description" | "status" | "image";

export interface ShopifyFieldDiff {
  field: ShopifyDiffField;
  changed: boolean;
  /** true ⇒ provable from reliable data AND safe to plan (§4). */
  actionable: boolean;
}

export type ShopifyVariantAlignment = "GID" | "SKU" | "BARCODE" | "UNMATCHED_INTERNAL" | "EXTRA_ON_SHOPIFY";

export interface ShopifyVariantDiff {
  variantId: string | null; // internal variant id (null for EXTRA_ON_SHOPIFY)
  variantGid: string | null; // live Shopify variant GID (null when unmatched)
  alignment: ShopifyVariantAlignment;
  sku: string | null;
  skuChanged: boolean;
  barcodeChanged: boolean;
  priceChanged: boolean;
  compareAtChanged: boolean;
}

export interface ShopifyPreviewRow {
  storefrontKey: ShopifyStorefrontKey;
  internalProductId: string;
  grain: "PRODUCT";
  hasVariants: boolean;
  sku: string; // product-level SKU (simple products) or "" when variant-grained
  barcode: string | null;
  title: string;
  price: number | null; // desired selling price (discount ?? price)
  compareAtPrice: number | null; // desired compare-at (original price when discounted)
  hasImage: boolean;
  imageCount: number;
  /** Shopify Product GID from ECL (null ⇒ NEW/unmapped — never invented). */
  shopifyProductGid: string | null;
  mappingStatus: "active" | "needs_review" | "unmapped";
  variantCount: number;
  variantMatchedCount: number;
  fieldDiffs: ShopifyFieldDiff[];
  variantDiffs: ShopifyVariantDiff[];
  /** Compact list of changed+actionable field names (for the UI "Changes" column). */
  changedFields: string[];
  status: ShopifyPreviewStatus;
  reasons: ExportReason[];
  plannedOps: ShopifyPlanOp[];
  lifecycleState: LifecycleState;
}

export interface ShopifyCounts {
  total: number;
  matched: number;
  new: number;
  updateRequired: number;
  conflict: number;
  blocked: number;
  unknown: number;
  plannedOps: Record<ShopifyPlanOpType, number>;
}

export interface ShopifyPreviewResult {
  storefrontKey: ShopifyStorefrontKey;
  shopifyAvailable: boolean;
  rows: ShopifyPreviewRow[];
  items: ExportValidationItem[];
  summary: ExportValidationSummary;
  preview: ExportPreview;
  counts: ShopifyCounts;
  /** §14 — read cost reported honestly (products seen in the single live batch). */
  apiStats: { shopifyProductsRead: number };
}

// ── Small pure helpers ───────────────────────────────────────────────────────────
function clean(v: string | null | undefined): string {
  return typeof v === "string" ? v.trim() : "";
}
function positive(v: number | null | undefined): number | null {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;
}
function parseMoney(v: string | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(String(v).trim());
  return Number.isFinite(n) ? n : null;
}
function moneyEqual(a: number | null, b: number | null): boolean {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  return Math.abs(a - b) < PRICE_EPSILON;
}
/** Reliable plain-text of a description for a provable diff (strip tags + collapse). */
function plainText(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}
function tally(values: readonly string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const v of values) if (v !== "") m.set(v, (m.get(v) ?? 0) + 1);
  return m;
}

/** Sellable units of an internal product: its variants, or one synthetic unit. */
interface Unit {
  id: string; // internal variant id, or the product id for a simple product
  sku: string;
  barcode: string | null;
  name: string | null;
  price: number | null;
  synthetic: boolean; // true ⇒ the product's own row (simple product)
}
function unitsOf(p: ShopifyInternalProduct): Unit[] {
  const vs = Array.isArray(p.variants) ? p.variants : [];
  if (vs.length > 0) {
    return vs.map((v) => ({
      id: v.id,
      sku: normalizeExportedSku(v.sku),
      barcode: normalizeBarcode(v.barcode),
      name: clean(v.variantName) || null,
      price: positive(v.price),
      synthetic: false,
    }));
  }
  return [{
    id: p.id,
    sku: normalizeExportedSku(p.sku),
    barcode: normalizeBarcode(p.barcode),
    name: null,
    price: positive(p.discountPrice) ?? positive(p.price),
    synthetic: true,
  }];
}

/** Build the validated Shopify preview. Pure + deterministic. */
export function buildShopifyPreview(input: ShopifyPreviewInput): ShopifyPreviewResult {
  const products = Array.isArray(input?.products) ? input.products : [];
  const live = Array.isArray(input?.live) ? input.live : null;
  const shopifyAvailable = live !== null;
  const mappingByProductId = input?.mappingByProductId ?? {};

  // Live indices (built once — §14, no per-variant lookups against the network).
  const liveByGid = new Map<string, ShopifyLiveProduct>();
  const liveSkuToGid = new Map<string, string>(); // lower(sku) → owning product GID
  const liveVariantBySku = new Map<string, { product: ShopifyLiveProduct; variant: ShopifyLiveVariant }>();
  const liveVariantByGid = new Map<string, { product: ShopifyLiveProduct; variant: ShopifyLiveVariant }>();
  for (const lp of live ?? []) {
    if (lp.id) liveByGid.set(lp.id, lp);
    for (const lv of lp.variants ?? []) {
      const sk = clean(lv.sku).toLowerCase();
      if (sk !== "" && !liveVariantBySku.has(sk)) {
        liveVariantBySku.set(sk, { product: lp, variant: lv });
        liveSkuToGid.set(sk, lp.id);
      }
      if (lv.id) liveVariantByGid.set(lv.id, { product: lp, variant: lv });
    }
  }

  // One-GID → many-internal detection (§10): tally the product GID each internal
  // product claims through its (non-contested) ECL mapping.
  const gidClaimants = new Map<string, Set<string>>();
  for (const p of products) {
    const ev = mappingByProductId[p.id];
    if (ev && ev.status === "active" && ev.productGid) {
      const set = gidClaimants.get(ev.productGid) ?? new Set<string>();
      set.add(p.id);
      gidClaimants.set(ev.productGid, set);
    }
  }

  // Cross-dataset SKU / barcode duplicate detection (internal units).
  const allSkus: string[] = [];
  const allBarcodes: string[] = [];
  for (const p of products) {
    for (const u of unitsOf(p)) {
      allSkus.push(u.sku.toLowerCase());
      if (u.barcode) allBarcodes.push(u.barcode);
    }
  }
  const skuCounts = tally(allSkus);
  const barcodeCounts = tally(allBarcodes);

  const rows = products.map((p) =>
    buildRow(p, {
      shopifyAvailable,
      liveByGid,
      liveSkuToGid,
      liveVariantBySku,
      liveVariantByGid,
      gidClaimants,
      skuCounts,
      barcodeCounts,
      evidence: mappingByProductId[p.id] ?? null,
    }),
  );

  const items: ExportValidationItem[] = rows.map((r) => ({
    entityId: r.internalProductId,
    destination: SHOPIFY_STOREFRONT_KEY,
    status: toSharedStatus(r.status),
    reasons: r.reasons,
  }));
  const summary = summarizeValidation(items);

  const previewItems: ExportPreviewItem[] = rows.map((r) => ({
    internalProductId: r.internalProductId,
    variantId: null,
    sku: r.sku || null,
    barcode: r.barcode,
    title: r.title,
    destination: SHOPIFY_STOREFRONT_KEY,
    storefront: SHOPIFY_STOREFRONT_KEY,
    grain: "PRODUCT",
    status: toSharedStatus(r.status),
    warnings: r.reasons.filter((x) => !x.blocking),
    blockingReasons: r.reasons.filter((x) => x.blocking),
    imageCount: r.imageCount,
    primaryImage: null,
    externalIdentity: {
      storefrontKey: SHOPIFY_STOREFRONT_KEY,
      externalProductId: r.shopifyProductGid,
      externalVariantId: null,
      exportedSku: r.sku || null,
      identityType: SHOPIFY_IDENTITY_TYPE,
    },
    metadata: {
      shopifyStatus: r.status,
      mappingStatus: r.mappingStatus,
      changedFields: r.changedFields,
      plannedOps: r.plannedOps.map((o) => o.type),
    },
  }));

  const counts = countRows(rows);

  return {
    storefrontKey: SHOPIFY_STOREFRONT_KEY,
    shopifyAvailable,
    rows,
    items,
    summary,
    preview: { destination: SHOPIFY_STOREFRONT_KEY, grain: "PRODUCT", items: previewItems, placeholder: !shopifyAvailable },
    counts,
    apiStats: { shopifyProductsRead: (live ?? []).length },
  };
}

interface RowCtx {
  shopifyAvailable: boolean;
  liveByGid: Map<string, ShopifyLiveProduct>;
  liveSkuToGid: Map<string, string>;
  liveVariantBySku: Map<string, { product: ShopifyLiveProduct; variant: ShopifyLiveVariant }>;
  liveVariantByGid: Map<string, { product: ShopifyLiveProduct; variant: ShopifyLiveVariant }>;
  gidClaimants: Map<string, Set<string>>;
  skuCounts: Map<string, number>;
  barcodeCounts: Map<string, number>;
  evidence: ShopifyIdentityEvidence | null;
}

function buildRow(p: ShopifyInternalProduct, ctx: RowCtx): ShopifyPreviewRow {
  const units = unitsOf(p);
  const hasVariants = Array.isArray(p.variants) && p.variants.length > 0;
  const title = clean(p.nameEn) || clean(p.nameAr);
  const barcode = normalizeBarcode(p.barcode);
  const productSku = hasVariants ? "" : units[0]?.sku ?? "";
  const price = positive(p.discountPrice) ?? positive(p.price);
  const compareAtPrice = positive(p.discountPrice) !== null ? positive(p.price) : null;
  const hasImage = p.imageCount > 0 || clean(p.imageUrl) !== "" || clean(p.imageFilename) !== "";
  const state = resolveLifecycleState({ lifecycle_state: p.lifecycleState, platform_status: p.platformStatus });

  const reasons: ExportReason[] = [];
  const block = (code: ExportReasonCode, message?: string) => reasons.push({ code, blocking: true, message });
  const warn = (code: ExportReasonCode, message?: string) => reasons.push({ code, blocking: false, message });

  // ── Internal validation (§5) — provable regardless of the live store ──────────
  if (state === "STOPPED") block("LIFECYCLE_NOT_ELIGIBLE", "المنتج موقوف — غير مؤهّل للنشر.");
  if (title === "") block("MISSING_TITLE");
  if (!hasImage) block("MISSING_IMAGE");
  if (price === null) warn("MISSING_PRICE");

  const withSku = units.filter((u) => u.sku !== "");
  if (withSku.length === 0) block("MISSING_SKU");
  else if (hasVariants && withSku.length < units.length) block("VARIANT_NOT_READY", "بعض المتغيّرات بدون SKU.");
  for (const u of units) {
    if (u.sku !== "" && (ctx.skuCounts.get(u.sku.toLowerCase()) ?? 0) > 1) { block("DUPLICATE_SKU"); break; }
  }
  let anyBarcode = false;
  for (const u of units) {
    if (u.barcode === null) continue;
    anyBarcode = true;
    if ((ctx.barcodeCounts.get(u.barcode) ?? 0) > 1) { block("DUPLICATE_BARCODE"); break; }
    if (!BARCODE_RE.test(u.barcode)) { warn("INVALID_BARCODE", "صيغة الباركود غير قياسية."); break; }
  }
  if (!anyBarcode) warn("MISSING_BARCODE");

  // ── Identity resolution (§1, §10) — ECL-first; GID only; no name guessing ─────
  const ev = ctx.evidence;
  const mappingStatus: ShopifyPreviewRow["mappingStatus"] = ev ? ev.status : "unmapped";
  let identityConflict = false;
  let shopifyProductGid: string | null = null;
  let liveProduct: ShopifyLiveProduct | null = null;

  if (ev && ev.status === "needs_review") {
    identityConflict = true;
    block("IDENTITY_NEEDS_REVIEW", "هوية شوبي فاي متنازع عليها — بحاجة لمراجعة المالك.");
  } else if (ev && ev.hasConflictingProductGids) {
    identityConflict = true;
    block("IDENTITY_CONFLICT", "سجلّات ECL لهذا المنتج تشير إلى أكثر من مُعرّف شوبي فاي.");
  } else if (ev && ev.status === "active" && ev.productGid) {
    // One GID claimed by more than one internal product (§10) → conflict for all.
    if ((ctx.gidClaimants.get(ev.productGid)?.size ?? 0) > 1) {
      identityConflict = true;
      block("IDENTITY_CONFLICT", "مُعرّف شوبي فاي نفسه مربوط بأكثر من منتج داخلي.");
    } else if (ctx.shopifyAvailable) {
      liveProduct = ctx.liveByGid.get(ev.productGid) ?? null;
      if (!liveProduct) {
        // ECL points to a GID that is absent from the live store — cannot prove.
        identityConflict = true;
        block("IDENTITY_CONFLICT", "مُعرّف شوبي فاي في ECL غير موجود في المتجر الحالي.");
      } else {
        shopifyProductGid = ev.productGid;
      }
    } else {
      // Mapped, but the live store is unreadable — surface the id, stay UNKNOWN.
      shopifyProductGid = ev.productGid;
    }
  } else if (!ev && ctx.shopifyAvailable) {
    // Unmapped: an existing Shopify variant already carrying one of our SKUs is an
    // UNLINKED DUPLICATE risk — never NEW (§10). SKU here is contradiction evidence,
    // not accepted identity.
    for (const u of units) {
      if (u.sku !== "" && ctx.liveSkuToGid.has(u.sku.toLowerCase())) {
        identityConflict = true;
        block("IDENTITY_CONFLICT", "SKU موجود مسبقاً في شوبي فاي دون ربط في ECL — خطر تكرار.");
        break;
      }
    }
  }

  // ── Diffs (only when identity-matched against a real live product) ────────────
  const fieldDiffs: ShopifyFieldDiff[] = [];
  const variantDiffs: ShopifyVariantDiff[] = [];
  let variantMatchedCount = 0;

  if (liveProduct) {
    // Field-level (§4). title/status reliable; description actionable only when
    // Shopify has none (HTML↔plain-text equality is otherwise not reliable);
    // image actionable only when Shopify has none but we do.
    const titleChanged = title !== "" && clean(liveProduct.title) !== title;
    fieldDiffs.push({ field: "title", changed: titleChanged, actionable: titleChanged });

    const internalDesc = clean(p.descriptionEn);
    const shopifyDesc = plainText(clean(liveProduct.descriptionHtml));
    const descChanged = internalDesc !== "" && internalDesc !== shopifyDesc;
    fieldDiffs.push({ field: "description", changed: descChanged, actionable: internalDesc !== "" && shopifyDesc === "" });

    // Status difference is INFORMATIONAL only — no auto-publish is ever planned (§6).
    const desiredStatus = state === "ACTIVE" ? "ACTIVE" : "DRAFT";
    const statusChanged = clean(liveProduct.status).toUpperCase() !== desiredStatus;
    fieldDiffs.push({ field: "status", changed: statusChanged, actionable: false });

    // Media (§7): only the provable case — Shopify has no image and we do.
    const shopifyMissingImage = clean(liveProduct.imageUrl) === "";
    const imageChanged = shopifyMissingImage && hasImage;
    fieldDiffs.push({ field: "image", changed: imageChanged, actionable: imageChanged });

    // Variant-aware alignment (§2): GID → SKU → barcode, within this product only.
    const usedLiveGids = new Set<string>();
    for (const u of units) {
      let match: { product: ShopifyLiveProduct; variant: ShopifyLiveVariant } | null = null;
      let alignment: ShopifyVariantAlignment = "UNMATCHED_INTERNAL";
      const gid = ev?.variantGidByVariantId?.[u.id] ?? null;
      if (gid) {
        const byGid = ctx.liveVariantByGid.get(gid);
        if (byGid && byGid.product.id === liveProduct.id) { match = byGid; alignment = "GID"; }
      }
      if (!match && u.sku !== "") {
        const bySku = ctx.liveVariantBySku.get(u.sku.toLowerCase());
        if (bySku && bySku.product.id === liveProduct.id) { match = bySku; alignment = "SKU"; }
      }
      if (!match && u.barcode) {
        const byBarcode = (liveProduct.variants ?? []).find((lv) => clean(lv.barcode) === u.barcode);
        if (byBarcode) { match = { product: liveProduct, variant: byBarcode }; alignment = "BARCODE"; }
      }
      if (match) {
        variantMatchedCount++;
        usedLiveGids.add(match.variant.id);
        const desiredPrice = u.price;
        const desiredCompareAt = compareAtPrice; // product-level compare-at semantics
        const livePrice = parseMoney(match.variant.price);
        const liveCompareAt = parseMoney(match.variant.compareAtPrice);
        variantDiffs.push({
          variantId: u.id,
          variantGid: match.variant.id,
          alignment,
          sku: u.sku || null,
          skuChanged: u.sku !== "" && clean(match.variant.sku) !== u.sku,
          barcodeChanged: u.barcode !== null && clean(match.variant.barcode) !== u.barcode,
          priceChanged: desiredPrice !== null && !moneyEqual(desiredPrice, livePrice),
          compareAtChanged: !moneyEqual(desiredCompareAt, liveCompareAt),
        });
      } else {
        variantDiffs.push({
          variantId: u.id,
          variantGid: null,
          alignment: "UNMATCHED_INTERNAL",
          sku: u.sku || null,
          skuChanged: false,
          barcodeChanged: false,
          priceChanged: false,
          compareAtChanged: false,
        });
      }
    }
    // Live variants we never matched are extra on Shopify (informational — never
    // planned for deletion).
    for (const lv of liveProduct.variants ?? []) {
      if (!usedLiveGids.has(lv.id)) {
        variantDiffs.push({
          variantId: null,
          variantGid: lv.id,
          alignment: "EXTRA_ON_SHOPIFY",
          sku: clean(lv.sku) || null,
          skuChanged: false,
          barcodeChanged: false,
          priceChanged: false,
          compareAtChanged: false,
        });
      }
    }
  }

  // ── Classify (§4) ────────────────────────────────────────────────────────────
  const hasValidationBlock = reasons.some((r) => r.blocking && r.code !== "IDENTITY_CONFLICT" && r.code !== "IDENTITY_NEEDS_REVIEW");
  const changedFields = collectChangedFields(fieldDiffs, variantDiffs);

  let status: ShopifyPreviewStatus;
  if (!ctx.shopifyAvailable) status = "UNKNOWN";
  else if (hasValidationBlock) status = "BLOCKED";
  else if (identityConflict) status = "CONFLICT";
  else if (liveProduct) status = changedFields.length > 0 ? "UPDATE_REQUIRED" : "MATCH";
  else status = "NEW";

  const plannedOps = planOps(status, changedFields, fieldDiffs, variantDiffs, reasons);

  return {
    storefrontKey: SHOPIFY_STOREFRONT_KEY,
    internalProductId: p.id,
    grain: "PRODUCT",
    hasVariants,
    sku: productSku,
    barcode,
    title,
    price,
    compareAtPrice,
    hasImage,
    imageCount: p.imageCount,
    shopifyProductGid,
    mappingStatus,
    variantCount: units.length,
    variantMatchedCount,
    fieldDiffs,
    variantDiffs,
    changedFields,
    status,
    reasons,
    plannedOps,
    lifecycleState: state,
  };
}

function collectChangedFields(fieldDiffs: readonly ShopifyFieldDiff[], variantDiffs: readonly ShopifyVariantDiff[]): string[] {
  const out: string[] = [];
  for (const f of fieldDiffs) if (f.changed && f.actionable) out.push(f.field);
  let vSku = false, vBarcode = false, vPrice = false, vCompareAt = false, vMissing = false;
  for (const v of variantDiffs) {
    if (v.alignment === "UNMATCHED_INTERNAL") vMissing = true;
    if (v.skuChanged) vSku = true;
    if (v.barcodeChanged) vBarcode = true;
    if (v.priceChanged) vPrice = true;
    if (v.compareAtChanged) vCompareAt = true;
  }
  if (vPrice) out.push("price");
  if (vCompareAt) out.push("compareAt");
  if (vSku) out.push("variantSku");
  if (vBarcode) out.push("variantBarcode");
  if (vMissing) out.push("variantMissing");
  return out;
}

function planOps(
  status: ShopifyPreviewStatus,
  changedFields: readonly string[],
  fieldDiffs: readonly ShopifyFieldDiff[],
  variantDiffs: readonly ShopifyVariantDiff[],
  reasons: readonly ExportReason[],
): ShopifyPlanOp[] {
  if (status === "BLOCKED" || status === "CONFLICT") {
    const firstBlock = reasons.find((r) => r.blocking);
    return [{ type: "BLOCKED", target: "product", fields: [], reason: firstBlock?.code }];
  }
  if (status === "UNKNOWN") {
    return [{ type: "BLOCKED", target: "product", fields: [], reason: "SHOPIFY_UNREADABLE" }];
  }
  if (status === "NEW") {
    return [{ type: "CREATE_PRODUCT", target: "product", fields: ["title", "description", "price", "sku", "media"] }];
  }
  if (status === "MATCH") {
    return [{ type: "NOOP", target: "product", fields: [] }];
  }

  // UPDATE_REQUIRED → deterministic, granular ops (§12). No status/publish op (§6).
  const ops: ShopifyPlanOp[] = [];
  const productFields = fieldDiffs.filter((f) => f.changed && f.actionable && (f.field === "title" || f.field === "description")).map((f) => f.field);
  if (productFields.length > 0) ops.push({ type: "UPDATE_PRODUCT", target: "product", fields: productFields });
  if (changedFields.includes("image")) ops.push({ type: "UPDATE_MEDIA", target: "media", fields: ["image"] });

  for (const v of variantDiffs) {
    if (v.alignment === "EXTRA_ON_SHOPIFY" || v.alignment === "UNMATCHED_INTERNAL") continue;
    const priceish: string[] = [];
    if (v.priceChanged) priceish.push("price");
    if (v.compareAtChanged) priceish.push("compareAt");
    if (priceish.length > 0) ops.push({ type: "UPDATE_PRICE", target: "variant", variantId: v.variantId, variantGid: v.variantGid, fields: priceish });
    const other: string[] = [];
    if (v.skuChanged) other.push("sku");
    if (v.barcodeChanged) other.push("barcode");
    if (other.length > 0) ops.push({ type: "UPDATE_VARIANT", target: "variant", variantId: v.variantId, variantGid: v.variantGid, fields: other });
  }
  // An internal variant missing on Shopify is an actionable product update.
  if (changedFields.includes("variantMissing")) ops.push({ type: "UPDATE_PRODUCT", target: "product", fields: ["variants"] });

  return ops.length > 0 ? ops : [{ type: "NOOP", target: "product", fields: [] }];
}

function toSharedStatus(s: ShopifyPreviewStatus): ExportItemStatus {
  switch (s) {
    case "MATCH": return "READY";
    case "NEW": return "READY";
    case "UPDATE_REQUIRED": return "WARNING";
    case "CONFLICT": return "BLOCKED";
    case "BLOCKED": return "BLOCKED";
    case "UNKNOWN": return "UNKNOWN";
  }
}

function countRows(rows: readonly ShopifyPreviewRow[]): ShopifyCounts {
  const plannedOps: Record<ShopifyPlanOpType, number> = {
    CREATE_PRODUCT: 0, UPDATE_PRODUCT: 0, UPDATE_VARIANT: 0, UPDATE_PRICE: 0, UPDATE_MEDIA: 0, NOOP: 0, BLOCKED: 0,
  };
  let matched = 0, isNew = 0, updateRequired = 0, conflict = 0, blocked = 0, unknown = 0;
  for (const r of rows) {
    if (r.status === "MATCH") matched++;
    else if (r.status === "NEW") isNew++;
    else if (r.status === "UPDATE_REQUIRED") updateRequired++;
    else if (r.status === "CONFLICT") conflict++;
    else if (r.status === "BLOCKED") blocked++;
    else unknown++;
    for (const op of r.plannedOps) plannedOps[op.type]++;
  }
  return { total: rows.length, matched, new: isNew, updateRequired, conflict, blocked, unknown, plannedOps };
}
