// TALABAT.DELTA — compare the OFFICIAL Talabat baseline workbook against our
// certified Talabat projection, and classify every product (PURE).
//
// WHY THIS EXISTS
// The full certified package is 1454 rows / 2501 images / 538 MB. Re-sending it
// to change a handful of prices is wasteful and risks Talabat re-processing the
// whole menu. This module produces the two DELTAS the owner actually sends:
// updates to products Talabat already lists, and additions for products it does
// not.
//
// THE BASELINE IS TALABAT'S OWN SPREADSHEET, AND ITS SHAPE IS NOT OURS.
// Verified against the real file (992 data rows, sheet "Products", 13 columns):
//
//   • `barcode 1` is ZERO-PADDED to 14 characters — our canonical 13-digit
//     8860504651481 appears there as 08860504651481. 984 of 991 non-empty
//     values start with "0". A string comparison would report ~every row as a
//     barcode difference; comparison is therefore NUMERIC (leading zeros are
//     not part of the identity).
//   • `category 1` carries a Talabat-side "All " prefix — our "Face Care" is
//     their "All Face Care", consistently across all 13 categories present.
//     Comparison strips that prefix; without it every row is a false positive.
//   • `price` is a STRING ("79"), so comparison is numeric.
//   • the sheet holds SIMPLE SKUs ONLY — zero rows contain "-", so none of our
//     162 variant/option rows exist there at all.
//
// Each of those would have produced a delta of "everything changed". They are
// normalisation, NOT tolerance: a genuine difference in the digits, the
// category, or the number still reports.
//
// WHAT THIS MODULE DOES NOT DO
// It never re-derives pricing, category, barcode or master scope — it consumes
// the already-certified TalabatPackageRow/TalabatPreviewRow values produced by
// the same builders the full package uses. There is exactly one implementation
// of those rules and it is not here.

import type { TalabatPreviewRow } from "./preview.ts";

// ── the baseline workbook ────────────────────────────────────────────────────

/** The sheet the official Talabat export uses. */
export const TALABAT_BASELINE_SHEET = "Products";

/** The 13 columns of the official Talabat export, in order. */
export const TALABAT_BASELINE_COLUMNS = [
  "sku", "name", "price", "active", "maximumSalesQuantity", "isWeighted",
  "baseWeight", "baseWeightUnit", "pricePerBaseUnit",
  "barcode 1", "barcode 2", "barcode 3", "category 1",
] as const;

/**
 * Columns Talabat owns that we have NO authoritative equivalent for. They are
 * read and reported, never compared and never written — manufacturing a
 * "desired value" for a field we do not own would be a fabricated instruction
 * to a marketplace. In the real baseline all five are empty on every row.
 */
export const TALABAT_UNOWNED_COLUMNS = [
  "maximumSalesQuantity", "isWeighted", "baseWeight", "baseWeightUnit", "pricePerBaseUnit",
] as const;

export interface TalabatBaselineRow {
  sku: string;
  name: string;
  price: string | number | null;
  active: boolean | null;
  barcode1: string | null;
  barcode2: string | null;
  barcode3: string | null;
  category1: string | null;
  /** 1-based row number in the sheet (header is row 1) — for owner traceability. */
  sheetRow: number;
}

export interface TalabatBaselineParse {
  ok: boolean;
  sheetName: string;
  headers: string[];
  rows: TalabatBaselineRow[];
  /** headers present in the file that this module does not know about. */
  unexpectedHeaders: string[];
  /** known headers missing from the file. */
  missingHeaders: string[];
}

const cell = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
};

/**
 * Parse the baseline sheet from an array-of-arrays. Header names are matched
 * EXACTLY (after trimming) — a renamed column surfaces in missingHeaders rather
 * than silently comparing nothing.
 */
export function parseTalabatBaseline(aoa: readonly (readonly unknown[])[], sheetName: string): TalabatBaselineParse {
  const headers = (aoa[0] ?? []).map((h) => String(h ?? "").trim());
  const idx = (name: string) => headers.indexOf(name);
  const known = new Set<string>(TALABAT_BASELINE_COLUMNS);
  const rows: TalabatBaselineRow[] = [];
  const iSku = idx("sku"), iName = idx("name"), iPrice = idx("price"), iActive = idx("active");
  const iB1 = idx("barcode 1"), iB2 = idx("barcode 2"), iB3 = idx("barcode 3"), iCat = idx("category 1");

  for (let r = 1; r < aoa.length; r++) {
    const row = aoa[r] ?? [];
    if (!row.some((c) => c !== null && c !== undefined && String(c).trim() !== "")) continue;
    const sku = iSku >= 0 ? cell(row[iSku]) : null;
    if (sku === null) continue; // a row without a SKU is not a product row
    const activeRaw = iActive >= 0 ? row[iActive] : null;
    rows.push({
      sku,
      name: (iName >= 0 ? cell(row[iName]) : null) ?? "",
      price: iPrice >= 0 ? (row[iPrice] as string | number | null) ?? null : null,
      active: typeof activeRaw === "boolean" ? activeRaw
        : typeof activeRaw === "string" ? activeRaw.trim().toLowerCase() === "true"
        : null,
      barcode1: iB1 >= 0 ? cell(row[iB1]) : null,
      barcode2: iB2 >= 0 ? cell(row[iB2]) : null,
      barcode3: iB3 >= 0 ? cell(row[iB3]) : null,
      category1: iCat >= 0 ? cell(row[iCat]) : null,
      sheetRow: r + 1,
    });
  }
  return {
    ok: iSku >= 0 && rows.length > 0,
    sheetName,
    headers,
    rows,
    unexpectedHeaders: headers.filter((h) => h !== "" && !known.has(h)),
    missingHeaders: TALABAT_BASELINE_COLUMNS.filter((c) => !headers.includes(c)),
  };
}

// ── normalisation (see the header note — none of these hide a real diff) ─────

/**
 * Barcode identity. Talabat zero-pads to 14; the leading zeros are padding, not
 * identity, so both sides are compared as digits with leading zeros removed.
 * Anything non-numeric returns null and can never match.
 */
export function normalizeBarcodeForCompare(v: string | null | undefined): string | null {
  const digits = String(v ?? "").trim();
  if (digits === "" || !/^\d+$/.test(digits)) return null;
  const stripped = digits.replace(/^0+/, "");
  return stripped === "" ? null : stripped;
}

/** The Talabat menu prefix on their category column ("All Face Care"). */
export const TALABAT_CATEGORY_MENU_PREFIX = "All ";

/** Strip Talabat's menu prefix so their category can be compared to ours. */
export function normalizeBaselineCategory(v: string | null | undefined): string | null {
  const s = String(v ?? "").trim();
  if (s === "") return null;
  return s.startsWith(TALABAT_CATEGORY_MENU_PREFIX) ? s.slice(TALABAT_CATEGORY_MENU_PREFIX.length).trim() : s;
}

/** Numeric price from either a number or Talabat's string form. */
export function normalizePriceForCompare(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v.trim()) : NaN;
  return Number.isFinite(n) ? n : null;
}

/**
 * Name comparison key. Case- and whitespace-insensitive, and dash-insensitive
 * (Talabat stores "–" where we store "-"). Used to DETECT a name difference;
 * the owner-facing report always shows the raw values, never the key.
 */
export function normalizeNameForCompare(v: string | null | undefined): string {
  return String(v ?? "")
    .replace(/[‐-―]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** SKU identity — exact after trim, case-insensitive. */
export function normalizeSkuForCompare(v: string | null | undefined): string {
  return String(v ?? "").trim().toLowerCase();
}

// ── classification ───────────────────────────────────────────────────────────

export type TalabatDeltaChangeType =
  | "NAME_DIFF" | "PRICE_DIFF" | "ACTIVE_STATUS_DIFF" | "BARCODE_DIFF" | "CATEGORY_DIFF";

export type TalabatMatchKind = "MATCHED_BY_SKU" | "MATCHED_BY_BARCODE" | "AMBIGUOUS" | "NEW_PRODUCT";

export interface TalabatFieldDiff {
  field: TalabatDeltaChangeType;
  /** what Talabat has today (raw, as it appears in their sheet). */
  talabatValue: string;
  /** what our certified projection says it should be. */
  ourValue: string;
}

export interface TalabatDeltaRow {
  /** our certified row (the single source of every desired value). */
  our: TalabatPreviewRow;
  match: TalabatMatchKind;
  baseline: TalabatBaselineRow | null;
  diffs: TalabatFieldDiff[];
  /** set only for AMBIGUOUS — why the identity could not be trusted. */
  ambiguityReason: string | null;
}

export interface TalabatDeltaResult {
  rows: TalabatDeltaRow[];
  /** baseline rows no certified row claimed. */
  unmatchedBaseline: TalabatBaselineRow[];
  counts: {
    ourRows: number;
    baselineRows: number;
    matched: number;
    matchedBySku: number;
    matchedByBarcode: number;
    ambiguous: number;
    noChange: number;
    needsUpdate: number;
    newRows: number;
    unmatchedBaseline: number;
    nameDiffs: number;
    priceDiffs: number;
    activeStatusDiffs: number;
    barcodeDiffs: number;
    categoryDiffs: number;
  };
}

/**
 * Options for fields we do not universally own.
 *
 * `ourActiveFor` is deliberately injected and defaults to "we have no
 * authoritative equivalent". Talabat's `active` flag is theirs; until its
 * meaning is established we do not manufacture a desired value for it, so by
 * default ACTIVE_STATUS_DIFF is never raised. Passing a resolver opts in.
 */
export interface TalabatDeltaOptions {
  ourActiveFor?: (row: TalabatPreviewRow) => boolean | null;
}

/**
 * Compare our certified rows against the baseline.
 *
 * Identity, in strict order (§3): exact SKU first; then our ONE authoritative
 * barcode against any of Talabat's three barcode columns. A name is NEVER an
 * identity — it is diagnostic only, because two different products can share a
 * name and a renamed product is still the same product.
 *
 * Anything whose identity is contested is AMBIGUOUS and is never auto-updated.
 */
export function compareTalabatBaseline(
  ourRows: readonly TalabatPreviewRow[],
  baseline: readonly TalabatBaselineRow[],
  options: TalabatDeltaOptions = {},
): TalabatDeltaResult {
  // baseline indexes
  const bySku = new Map<string, TalabatBaselineRow[]>();
  const byBarcode = new Map<string, TalabatBaselineRow[]>();
  for (const b of baseline) {
    const k = normalizeSkuForCompare(b.sku);
    bySku.set(k, [...(bySku.get(k) ?? []), b]);
    for (const raw of [b.barcode1, b.barcode2, b.barcode3]) {
      const n = normalizeBarcodeForCompare(raw);
      if (n === null) continue;
      byBarcode.set(n, [...(byBarcode.get(n) ?? []), b]);
    }
  }

  const claimed = new Set<TalabatBaselineRow>();
  const rows: TalabatDeltaRow[] = [];

  for (const our of ourRows) {
    const skuKey = normalizeSkuForCompare(our.sku);
    const ourBarcode = normalizeBarcodeForCompare(our.talabatBarcode);

    const skuHits = bySku.get(skuKey) ?? [];
    let match: TalabatMatchKind = "NEW_PRODUCT";
    let base: TalabatBaselineRow | null = null;
    let ambiguityReason: string | null = null;

    if (skuHits.length === 1) {
      match = "MATCHED_BY_SKU";
      base = skuHits[0];
    } else if (skuHits.length > 1) {
      match = "AMBIGUOUS";
      ambiguityReason = `SKU appears ${skuHits.length}x in the Talabat baseline`;
    } else if (ourBarcode !== null) {
      const bcHits = (byBarcode.get(ourBarcode) ?? []).filter((b) => normalizeSkuForCompare(b.sku) !== skuKey);
      const distinct = [...new Set(bcHits)];
      if (distinct.length === 1) {
        // A barcode match whose SKU disagrees is a real identity conflict, not
        // a silent rename: the owner decides, we never auto-update it.
        match = "AMBIGUOUS";
        base = distinct[0];
        ambiguityReason = `barcode matches Talabat SKU "${distinct[0].sku}" but our SKU is "${our.sku}"`;
      } else if (distinct.length > 1) {
        match = "AMBIGUOUS";
        ambiguityReason = `our barcode matches ${distinct.length} different Talabat rows`;
      }
    }

    if (base !== null) claimed.add(base);

    const diffs: TalabatFieldDiff[] = [];
    if (match === "MATCHED_BY_SKU" && base !== null) {
      // NAME
      if (normalizeNameForCompare(base.name) !== normalizeNameForCompare(our.title)) {
        diffs.push({ field: "NAME_DIFF", talabatValue: base.name, ourValue: our.title });
      }
      // PRICE
      const tPrice = normalizePriceForCompare(base.price);
      const oPrice = normalizePriceForCompare(our.price);
      if (oPrice !== null && (tPrice === null || Math.abs(tPrice - oPrice) > 1e-9)) {
        diffs.push({ field: "PRICE_DIFF", talabatValue: tPrice === null ? "" : String(tPrice), ourValue: String(oPrice) });
      }
      // BARCODE — our ONE authoritative value against all three of their columns
      const theirs = [base.barcode1, base.barcode2, base.barcode3].map(normalizeBarcodeForCompare).filter((x): x is string => x !== null);
      if (ourBarcode !== null && theirs[0] !== ourBarcode) {
        diffs.push({
          field: "BARCODE_DIFF",
          talabatValue: [base.barcode1, base.barcode2, base.barcode3].filter((x) => x != null).join(" | "),
          ourValue: our.talabatBarcode ?? "",
        });
      }
      // CATEGORY
      const tCat = normalizeBaselineCategory(base.category1);
      const oCat = our.talabatCategory ?? null;
      if (oCat !== null && tCat !== oCat) {
        diffs.push({ field: "CATEGORY_DIFF", talabatValue: base.category1 ?? "", ourValue: oCat });
      }
      // ACTIVE — only when a resolver was supplied (see TalabatDeltaOptions)
      const ourActive = options.ourActiveFor ? options.ourActiveFor(our) : null;
      if (ourActive !== null && base.active !== null && base.active !== ourActive) {
        diffs.push({ field: "ACTIVE_STATUS_DIFF", talabatValue: String(base.active), ourValue: String(ourActive) });
      }
    }

    rows.push({ our, match, baseline: base, diffs, ambiguityReason });
  }

  const matchedBySku = rows.filter((r) => r.match === "MATCHED_BY_SKU").length;
  const matchedByBarcode = rows.filter((r) => r.match === "MATCHED_BY_BARCODE").length;
  const ambiguous = rows.filter((r) => r.match === "AMBIGUOUS").length;
  const matchedRows = rows.filter((r) => r.match === "MATCHED_BY_SKU" || r.match === "MATCHED_BY_BARCODE");
  const count = (f: TalabatDeltaChangeType) => rows.filter((r) => r.diffs.some((d) => d.field === f)).length;

  return {
    rows,
    unmatchedBaseline: baseline.filter((b) => !claimed.has(b)),
    counts: {
      ourRows: ourRows.length,
      baselineRows: baseline.length,
      matched: matchedRows.length,
      matchedBySku,
      matchedByBarcode,
      ambiguous,
      noChange: matchedRows.filter((r) => r.diffs.length === 0).length,
      needsUpdate: matchedRows.filter((r) => r.diffs.length > 0).length,
      newRows: rows.filter((r) => r.match === "NEW_PRODUCT").length,
      unmatchedBaseline: baseline.filter((b) => !claimed.has(b)).length,
      nameDiffs: count("NAME_DIFF"),
      priceDiffs: count("PRICE_DIFF"),
      activeStatusDiffs: count("ACTIVE_STATUS_DIFF"),
      barcodeDiffs: count("BARCODE_DIFF"),
      categoryDiffs: count("CATEGORY_DIFF"),
    },
  };
}

/** Rows for the UPDATE workbook: existing Talabat products that changed. */
export function updateDeltaRows(result: TalabatDeltaResult): TalabatDeltaRow[] {
  return result.rows.filter((r) => r.match === "MATCHED_BY_SKU" && r.diffs.length > 0);
}

/** Rows for the NEW-PRODUCTS workbook: absent from the baseline entirely. */
export function newDeltaRows(result: TalabatDeltaResult): TalabatDeltaRow[] {
  return result.rows.filter((r) => r.match === "NEW_PRODUCT");
}

/** Rows the owner must adjudicate — never auto-updated, never auto-added. */
export function ambiguousDeltaRows(result: TalabatDeltaResult): TalabatDeltaRow[] {
  return result.rows.filter((r) => r.match === "AMBIGUOUS");
}
