// Malikas V2 Operations — Product Readiness Engine (Phase UI.7.1).
//
// PURE: computes, never stores. No database, no fetch, no storage, no API,
// no clock. Input is an OperationsProduct snapshot; output is ProductReadiness.
// Only `import type` is allowed here so node:test loads this file directly.
//
// Semantics follow the house rules established by earlier phases:
// - identifiers: main-product SKU is `mk<number>` (lowercase, UI.5), barcode
//   is 6–14 digits (UI.6 matcher floor; EAN-13 generation stays in UI.5's lib)
// - price: a usable price is a finite number > 0 (catalog-v2 hasValidPrice)
// - approval: "Approved" (isApproved), "SentAI" = waiting for review,
//   "Rejected", "" = never reviewed
// - new product: never approved AND never pushed to a platform (UI.5/UI.6
//   create products with approval="" and platform_status="")

import type {
  OperationsProduct,
  ProductReadiness,
  ReadinessCheck,
  ReadinessReason,
  ReadinessReasonCode,
  ReadinessStatus,
} from "../shared/models";

export const MAIN_SKU_RE = /^mk[0-9]+$/;
export const BARCODE_RE = /^[0-9]{6,14}$/;

/** Fixed Arabic reasons — never raw data, never parser/DB text. */
export const READINESS_MESSAGES: Record<ReadinessReasonCode, string> = {
  missing_name: "لا يوجد اسم للمنتج.",
  missing_image: "لا توجد صورة.",
  missing_sku: "لا يوجد SKU.",
  invalid_sku: "صيغة SKU غير صالحة.",
  missing_barcode: "لا يوجد باركود.",
  invalid_barcode: "صيغة الباركود غير صالحة.",
  missing_price: "لا يوجد سعر صالح.",
  missing_category: "لا توجد فئة.",
  missing_variants: "المنتج يتطلب خيارات ولا توجد خيارات.",
  missing_description: "لا يوجد وصف.",
  missing_brand: "لا يوجد براند.",
  pending_review: "بانتظار المراجعة.",
  rejected: "المنتج مرفوض — يحتاج مراجعة.",
  not_approved: "غير معتمد بعد.",
};

function hasText(v: string | null | undefined): boolean {
  return typeof v === "string" && v.trim() !== "";
}

function normalized(v: string | null | undefined): string {
  return typeof v === "string" ? v.trim().toLowerCase() : "";
}

/** House approval reading (same normalization as catalog-v2 isApproved). */
export function isApproved(p: OperationsProduct): boolean {
  return normalized(p.approval) === "approved";
}

export function isPendingReview(p: OperationsProduct): boolean {
  return normalized(p.approval) === "sentai";
}

export function isRejected(p: OperationsProduct): boolean {
  return normalized(p.approval) === "rejected";
}

/** New = never reviewed AND never pushed to any platform (house creation state). */
export function isNewProduct(p: OperationsProduct): boolean {
  return !hasText(p.approval) && !hasText(p.platformStatus);
}

/**
 * Compute the full readiness picture for one product. Never throws on odd
 * input — absent/blank fields simply fail their checks.
 */
export function computeProductReadiness(p: OperationsProduct): ProductReadiness {
  const reasons: ReadinessReason[] = [];
  const push = (code: ReadinessReasonCode) => reasons.push({ code, message: READINESS_MESSAGES[code] });

  const sku = normalized(p.sku);
  const skuPresent = sku !== "";
  const skuValid = MAIN_SKU_RE.test(sku);
  const barcode = typeof p.barcode === "string" ? p.barcode.trim() : "";
  const barcodePresent = barcode !== "";
  const barcodeValid = BARCODE_RE.test(barcode);

  const checks: ReadinessCheck[] = [
    { code: "name", required: true, passed: hasText(p.nameAr) || hasText(p.nameEn) },
    { code: "image", required: true, passed: hasText(p.imageUrl) },
    { code: "sku", required: true, passed: skuValid },
    { code: "barcode", required: true, passed: barcodeValid },
    {
      code: "price",
      required: true,
      passed: typeof p.price === "number" && Number.isFinite(p.price) && p.price > 0,
    },
    { code: "category", required: true, passed: hasText(p.category) },
    // Variants rule: the check only exists when we TRUST that variants are
    // expected (expectsVariants === true from the reading layer) or when the
    // product visibly has variants (their presence confirms a multi-variant
    // product). expectsVariants undefined = unknown — and the absence of
    // variant rows alone NEVER counts against readiness.
    ...(p.expectsVariants === true || p.variantCount > 0
      ? [{ code: "variants" as const, required: true, passed: p.variantCount > 0 }]
      : []),
    { code: "description", required: false, passed: hasText(p.descriptionAr) || hasText(p.descriptionEn) },
    { code: "brand", required: false, passed: hasText(p.brandId) },
  ];

  for (const c of checks) {
    if (c.passed) continue;
    if (c.code === "name") push("missing_name");
    else if (c.code === "image") push("missing_image");
    else if (c.code === "sku") push(skuPresent ? "invalid_sku" : "missing_sku");
    else if (c.code === "barcode") push(barcodePresent ? "invalid_barcode" : "missing_barcode");
    else if (c.code === "price") push("missing_price");
    else if (c.code === "category") push("missing_category");
    else if (c.code === "variants") push("missing_variants");
    else if (c.code === "description") push("missing_description");
    else if (c.code === "brand") push("missing_brand");
  }

  const passed = checks.filter((c) => c.passed).length;
  const percent = Math.round((passed / checks.length) * 100);
  const requiredOk = checks.every((c) => !c.required || c.passed);

  // Malformed identifiers and explicit review states need a human, always.
  const identityConflict = (skuPresent && !skuValid) || (barcodePresent && !barcodeValid);
  let status: ReadinessStatus;
  if (isPendingReview(p) || isRejected(p) || identityConflict) {
    status = "needs_review";
    if (isPendingReview(p)) push("pending_review");
    if (isRejected(p)) push("rejected");
  } else if (requiredOk && isApproved(p)) {
    status = "ready";
  } else if (requiredOk) {
    status = "almost_ready";
    push("not_approved");
  } else {
    status = "incomplete";
  }

  return {
    productId: p.id,
    percent,
    status,
    reasons,
    checks,
    isNew: isNewProduct(p),
    readyToPublish: status === "ready",
  };
}
