// Pure per-variant completeness / readiness layer (UX.4E-7).
//
// One shared, deterministic view of "how ready is this variant row" for BOTH the
// V2 Create wizard and the Edit form. It is EXPLANATORY / read-only: it never
// blocks Save, never mutates rows, never generates identity, never reads the
// catalog. variant-validate stays authoritative for actual save validation —
// this layer only reuses its primitives for SKU / barcode / numeric validity so
// no regex / EAN / number rule is duplicated here.
//
// Purity contract (enforced by the Node test runner): no React, no Supabase, no
// server/browser APIs, no clock, no randomness; every function is deterministic
// and returns fresh objects. Only fields that actually exist on VariantRowModel
// (= product_variants) are inspected — never cost/image/discount/platform.

import { activeVariantRows, type VariantRowModel } from "./variant-model.ts";
import {
  isBlankText,
  isBadNumber,
  isNegativeNumber,
  isValidEan13,
  isValidVariantMkSku,
} from "./variant-validate.ts";

/** Deterministic per-variant status. `removed` is internal-only (never mixed
 *  into the active summary). */
export type VariantCompletenessStatus = "complete" | "incomplete" | "invalid" | "removed";

/** The fields a variant row is scored on. The first five are required for
 *  readiness; the last three are optional/display only. */
export type VariantCheckKey =
  | "name"
  | "sku"
  | "barcode"
  | "price"
  | "stock"
  | "second_name"
  | "color"
  | "size";

/** Per-check outcome. `state` distinguishes a missing value from a present-but-
 *  invalid one so the UI can show the right chip. */
export interface VariantCompletenessCheck {
  key: VariantCheckKey;
  required: boolean;
  passed: boolean;
  state: "ok" | "missing" | "invalid";
}

export interface VariantCompleteness {
  /** required checks passed / required checks total, 0..100 (integer). */
  percent: number;
  status: VariantCompletenessStatus;
  checks: VariantCompletenessCheck[];
  /** required keys whose value is missing (blank). */
  missing: VariantCheckKey[];
  /** required keys whose present value fails validation. */
  invalid: VariantCheckKey[];
}

function numberState(value: string): "ok" | "missing" | "invalid" {
  if (isBlankText(value)) return "missing";
  return isBadNumber(value) || isNegativeNumber(value) ? "invalid" : "ok";
}

/**
 * Compute one variant row's completeness against `mainSku` (needed for the
 * variant-SKU grammar). A soft-removed row returns status "removed" with an
 * empty checklist — callers exclude it from active metrics.
 *
 * Required checks (readiness — stricter than Save, which allows blanks):
 * - name  : a meaningful name in either language
 * - sku   : present AND a valid `<main>-n` variant SKU
 * - barcode: present AND a valid EAN-13
 * - price : present AND a finite, non-negative number
 * - stock : present AND a finite, non-negative number
 *
 * Optional (display only — never affect percent/status): second name, color, size.
 */
export function computeVariantCompleteness(
  row: VariantRowModel,
  mainSku: string,
): VariantCompleteness {
  if (row.removed) {
    return { percent: 0, status: "removed", checks: [], missing: [], invalid: [] };
  }
  const f = row.fields;

  const nameState: "ok" | "missing" =
    !isBlankText(f.variant_name) || !isBlankText(f.variant_name_en) ? "ok" : "missing";

  const skuState: "ok" | "missing" | "invalid" = isBlankText(f.sku)
    ? "missing"
    : isValidVariantMkSku(f.sku, mainSku)
      ? "ok"
      : "invalid";

  const barcodeState: "ok" | "missing" | "invalid" = isBlankText(f.barcode)
    ? "missing"
    : isValidEan13(f.barcode)
      ? "ok"
      : "invalid";

  const checks: VariantCompletenessCheck[] = [
    { key: "name", required: true, state: nameState, passed: nameState === "ok" },
    { key: "sku", required: true, state: skuState, passed: skuState === "ok" },
    { key: "barcode", required: true, state: barcodeState, passed: barcodeState === "ok" },
    { key: "price", required: true, state: numberState(f.price), passed: numberState(f.price) === "ok" },
    { key: "stock", required: true, state: numberState(f.stock_quantity), passed: numberState(f.stock_quantity) === "ok" },
    // Optional / display — informational, never affect percent or status.
    {
      key: "second_name",
      required: false,
      state: !isBlankText(f.variant_name) && !isBlankText(f.variant_name_en) ? "ok" : "missing",
      passed: !isBlankText(f.variant_name) && !isBlankText(f.variant_name_en),
    },
    { key: "color", required: false, state: isBlankText(f.color) ? "missing" : "ok", passed: !isBlankText(f.color) },
    { key: "size", required: false, state: isBlankText(f.size) ? "missing" : "ok", passed: !isBlankText(f.size) },
  ];

  const required = checks.filter((c) => c.required);
  const passedCount = required.filter((c) => c.passed).length;
  const percent = Math.round((passedCount / required.length) * 100);

  const missing = required.filter((c) => c.state === "missing").map((c) => c.key);
  const invalid = required.filter((c) => c.state === "invalid").map((c) => c.key);

  const status: VariantCompletenessStatus =
    invalid.length > 0 ? "invalid" : missing.length > 0 ? "incomplete" : "complete";

  return { percent, status, checks, missing, invalid };
}

export interface VariantCompletenessSummary {
  activeCount: number;
  completeCount: number;
  incompleteCount: number;
  invalidCount: number;
  /** total required checks passed / total required checks, across ACTIVE rows,
   *  0..100 (integer). 100 when there are no active rows (nothing pending). */
  percent: number;
  /** true when any active row is not complete. */
  needsAttention: boolean;
}

/**
 * Aggregate completeness across the ACTIVE rows only (soft-removed rows are
 * excluded via activeVariantRows). No weighting — `percent` is the plain ratio
 * of required checks passed over required checks across every active row.
 */
export function summarizeVariantCompleteness(
  rows: readonly VariantRowModel[],
  mainSku: string,
): VariantCompletenessSummary {
  const active = activeVariantRows(rows);
  let completeCount = 0;
  let incompleteCount = 0;
  let invalidCount = 0;
  let requiredPassed = 0;
  let requiredTotal = 0;

  for (const row of active) {
    const c = computeVariantCompleteness(row, mainSku);
    if (c.status === "complete") completeCount += 1;
    else if (c.status === "invalid") invalidCount += 1;
    else if (c.status === "incomplete") incompleteCount += 1;
    for (const chk of c.checks) {
      if (!chk.required) continue;
      requiredTotal += 1;
      if (chk.passed) requiredPassed += 1;
    }
  }

  const percent = requiredTotal === 0 ? 100 : Math.round((requiredPassed / requiredTotal) * 100);

  return {
    activeCount: active.length,
    completeCount,
    incompleteCount,
    invalidCount,
    percent,
    needsAttention: incompleteCount + invalidCount > 0,
  };
}
