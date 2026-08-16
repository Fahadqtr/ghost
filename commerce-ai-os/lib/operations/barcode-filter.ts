// OPS.7 — Barcode Completion deep-link filter (PURE).
//
// Lets Operations deep-link into barcode completion pre-filtered by SKU and/or
// status. This is READ-ONLY view filtering only — it narrows which already-
// scanned rows are shown; it changes NO barcode business logic, no scan, no
// apply. Unknown params resolve to null so the page shows every row (safe
// default). node:test loads it directly (pure, relative import only).

import { sanitizeSkuParam } from "./channels/deep-link.ts";

/** The barcode statuses a deep-link may pre-select (mirror of BarcodeStatus). An
 *  unknown value is ignored (→ no status filter), so drift is harmless. */
export const BARCODE_FILTER_STATUSES = [
  "AUTO_COMPLETABLE",
  "NEEDS_REVIEW",
  "CONFLICT",
  "DUPLICATE_INTERNAL",
  "INVALID_SOURCE_BARCODE",
  "UNCHANGED",
  "NOT_FOUND",
] as const;

export interface BarcodeFilter {
  sku: string | null;
  status: string | null;
}

const one = (v: unknown): string | null => {
  const x = Array.isArray(v) ? v[0] : v;
  return typeof x === "string" && x.trim() !== "" ? x.trim() : null;
};

/** Parse + validate the barcode deep-link params. Never forwards raw URL text. */
export function parseBarcodeFilter(
  params: { sku?: unknown; status?: unknown } | null | undefined,
): BarcodeFilter {
  const sku = sanitizeSkuParam(params?.sku);
  const rawStatus = one(params?.status);
  const status = rawStatus && (BARCODE_FILTER_STATUSES as readonly string[]).includes(rawStatus) ? rawStatus : null;
  return { sku, status };
}

export function hasBarcodeFilter(f: BarcodeFilter | null | undefined): boolean {
  return !!(f && (f.sku || f.status));
}

/** Display-only narrowing of scanned rows by SKU substring + exact status. */
export function filterBarcodeRows<T extends { sku: string | null; status: string }>(
  rows: readonly T[],
  filter: BarcodeFilter,
): T[] {
  const skuQ = filter.sku ? filter.sku.toLowerCase() : null;
  return (Array.isArray(rows) ? rows : []).filter((r) => {
    if (filter.status && r.status !== filter.status) return false;
    if (skuQ && !(r.sku ?? "").toLowerCase().includes(skuQ)) return false;
    return true;
  });
}
