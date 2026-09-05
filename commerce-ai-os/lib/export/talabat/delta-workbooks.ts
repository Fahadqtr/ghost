// TALABAT.DELTA — the three owner-facing workbooks built from a delta (PURE).
//
//   1. UPDATE AUDIT     — one row per changed field, so the owner can see
//                         exactly what would change and why before sending.
//   2. UPDATE (Talabat) — the real Talabat schema, changed products only.
//   3. NEW PRODUCTS     — the real Talabat schema, absent products only.
//
// Every desired value comes from the already-certified projection. Nothing here
// re-derives a price, a category or a barcode, and nothing here invents a value
// for a Talabat-owned column we have no authority over (maximumSalesQuantity,
// isWeighted, baseWeight, baseWeightUnit, pricePerBaseUnit) — those are emitted
// blank, exactly as they are in the baseline today.

import {
  TALABAT_BASELINE_COLUMNS, normalizeBarcodeForCompare,
  type TalabatDeltaRow, type TalabatDeltaResult,
  updateDeltaRows, newDeltaRows, ambiguousDeltaRows,
} from "./baseline-delta.ts";

/** `talabat-<kind>-YYYY-MM-DD.xlsx` from an ISO instant. */
export function deltaWorkbookName(kind: "products-needing-update" | "products-update" | "new-products", iso: string): string {
  const d = new Date(iso);
  const day = Number.isNaN(d.getTime()) ? "unknown" : d.toISOString().slice(0, 10);
  return `talabat-${kind}-${day}.xlsx`;
}

/** `talabat-new-products-images-YYYY-MM-DD.zip`. */
export function newProductsImagesZipName(iso: string): string {
  const d = new Date(iso);
  const day = Number.isNaN(d.getTime()) ? "unknown" : d.toISOString().slice(0, 10);
  return `talabat-new-products-images-${day}.zip`;
}

export type Cell = string | number;

// ── 1. update AUDIT workbook (owner review) ──────────────────────────────────

export const UPDATE_AUDIT_COLUMNS = [
  "SKU", "OUR_BARCODE", "FIELD_CHANGED", "TALABAT_CURRENT_VALUE", "OUR_CURRENT_VALUE", "CHANGE_TYPE",
  "TALABAT_BARCODE_1", "TALABAT_BARCODE_2", "TALABAT_BARCODE_3", "OUR_AUTHORITATIVE_BARCODE",
  // Evidence for the barcode decision — see buildUpdateAuditAoa.
  "BARCODE_EVIDENCE",
] as const;

/**
 * EAN-13 / UPC-A check digit. Used ONLY as owner-facing evidence on barcode
 * rows: it never changes a desired value and never suppresses a difference.
 */
export function hasValidEanCheckDigit(code: string): boolean {
  const s = String(code).trim();
  if (!/^\d{8}$|^\d{12,14}$/.test(s)) return false;
  const body = s.slice(0, -1);
  const check = Number(s.slice(-1));
  let sum = 0;
  const rev = body.split("").reverse();
  for (let i = 0; i < rev.length; i++) sum += Number(rev[i]) * (i % 2 === 0 ? 3 : 1);
  return (10 - (sum % 10)) % 10 === check;
}

/**
 * Why BARCODE_EVIDENCE exists.
 *
 * The owner's rule is that OUR barcode is the desired value. On the real data
 * that rule would rewrite 270 of Talabat's barcodes, and a check-digit test on
 * those 270 says Talabat's value is a valid EAN 61% of the time while ours is
 * valid 14% of the time — i.e. on those rows Talabat is very likely holding the
 * REAL manufacturer barcode and we are holding a synthetic placeholder.
 *
 * The rule is still applied exactly as instructed; this column simply makes the
 * risky subset visible so the owner can decide per row instead of discovering
 * it after a marketplace scan fails. It is evidence, never an override.
 */
export function barcodeEvidence(ourBarcode: string, talabatBarcode: string | null): string {
  const ours = hasValidEanCheckDigit(ourBarcode);
  const pad = (v: string | null) => {
    const n = normalizeBarcodeForCompare(v);
    return n === null ? null : n.length === 12 ? `0${n}` : n;
  };
  const t = pad(talabatBarcode);
  const theirs = t === null ? false : hasValidEanCheckDigit(t);
  if (ours && !theirs) return "OURS_VALID_THEIRS_INVALID — safe to correct";
  if (!ours && theirs) return "THEIRS_VALID_OURS_INVALID — REVIEW: replacing a valid barcode with ours";
  if (ours && theirs) return "BOTH_VALID — two different real barcodes; confirm which is the product";
  return "NEITHER_VALID — neither passes the EAN check digit";
}

/** One audit row per CHANGED FIELD (a product with 2 diffs yields 2 rows). */
export function buildUpdateAuditAoa(result: TalabatDeltaResult): Cell[][] {
  const out: Cell[][] = [UPDATE_AUDIT_COLUMNS.slice() as unknown as Cell[]];
  for (const r of updateDeltaRows(result)) {
    const b = r.baseline;
    const ourBarcode = r.our.talabatBarcode ?? "";
    for (const d of r.diffs) {
      out.push([
        r.our.sku,
        ourBarcode,
        d.field.replace(/_DIFF$/, ""),
        d.talabatValue,
        d.ourValue,
        d.field,
        b?.barcode1 ?? "",
        b?.barcode2 ?? "",
        b?.barcode3 ?? "",
        ourBarcode,
        d.field === "BARCODE_DIFF" ? barcodeEvidence(ourBarcode, b?.barcode1 ?? null) : "",
      ]);
    }
  }
  return out;
}

// ── 2 & 3. Talabat-schema workbooks ──────────────────────────────────────────

/**
 * A row in Talabat's own schema. Unowned columns are emitted EMPTY: writing a
 * guess into maximumSalesQuantity or baseWeight would be an instruction to a
 * marketplace that no system of ours authorised.
 */
export function toTalabatSchemaRow(r: TalabatDeltaRow): Cell[] {
  const price = r.our.price;
  return [
    r.our.sku,
    r.our.title,
    typeof price === "number" && Number.isFinite(price) ? price : "",
    // `active` is Talabat's own listing flag and we hold no authoritative
    // equivalent (see TALABAT_ACTIVE_FIELD_SEMANTICS) — never overwritten.
    "",
    "", "", "", "", "",
    r.our.talabatBarcode ?? "",
    "", "",
    r.our.talabatCategory ?? "",
  ];
}

/** Talabat-schema workbook of EXISTING products that changed. */
export function buildTalabatUpdateAoa(result: TalabatDeltaResult): Cell[][] {
  return [TALABAT_BASELINE_COLUMNS.slice() as unknown as Cell[], ...updateDeltaRows(result).map(toTalabatSchemaRow)];
}

/** Talabat-schema workbook of products ABSENT from the baseline. */
export function buildTalabatNewProductsAoa(result: TalabatDeltaResult): Cell[][] {
  return [TALABAT_BASELINE_COLUMNS.slice() as unknown as Cell[], ...newDeltaRows(result).map(toTalabatSchemaRow)];
}

/** Owner-facing sheet of identities we refuse to act on automatically. */
export const AMBIGUOUS_COLUMNS = ["OUR_SKU", "OUR_BARCODE", "TALABAT_SKU", "REASON"] as const;

export function buildAmbiguousAoa(result: TalabatDeltaResult): Cell[][] {
  return [
    AMBIGUOUS_COLUMNS.slice() as unknown as Cell[],
    ...ambiguousDeltaRows(result).map((r) => [
      r.our.sku, r.our.talabatBarcode ?? "", r.baseline?.sku ?? "", r.ambiguityReason ?? "",
    ]),
  ];
}

/** Talabat rows our master no longer contains — reported, never auto-deleted. */
export const UNMATCHED_COLUMNS = ["TALABAT_SKU", "TALABAT_NAME", "TALABAT_ACTIVE", "SHEET_ROW"] as const;

export function buildUnmatchedBaselineAoa(result: TalabatDeltaResult): Cell[][] {
  return [
    UNMATCHED_COLUMNS.slice() as unknown as Cell[],
    ...result.unmatchedBaseline.map((b) => [b.sku, b.name, String(b.active), b.sheetRow]),
  ];
}

// ── new-product image scope ──────────────────────────────────────────────────

export interface NewProductImageScope {
  /** internal product ids of every product that is new to Talabat. */
  productIds: string[];
  /** certified sellable row keys (sku) that are new. */
  skus: string[];
  newRowCount: number;
  newSimpleRows: number;
  newVariantRows: number;
  newDistinctProducts: number;
  /** new rows that resolved no primary image — they cannot be packaged. */
  rowsMissingImage: number;
}

/**
 * The image scope for a NEW-PRODUCTS-ONLY package. Returned as a row/product
 * selection, not as a second packaging implementation: the certified job engine
 * consumes it exactly as it consumes the full set, so image resolution, naming,
 * dedupe and the integrity check stay in one place.
 */
export function newProductImageScope(result: TalabatDeltaResult): NewProductImageScope {
  const rows = newDeltaRows(result);
  return {
    productIds: [...new Set(rows.map((r) => r.our.internalProductId))],
    skus: rows.map((r) => r.our.sku),
    newRowCount: rows.length,
    newSimpleRows: rows.filter((r) => !r.our.isVariant).length,
    newVariantRows: rows.filter((r) => r.our.isVariant).length,
    newDistinctProducts: new Set(rows.map((r) => r.our.internalProductId)).size,
    rowsMissingImage: rows.filter((r) => !r.our.primaryImageUrl).length,
  };
}
