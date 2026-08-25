// MALIKAS REFERENCE sheet (PURE) — the human-readable second worksheet.
//
// Owner clarity requirement: the workbook carries TWO sheets —
//   • "data"              — the audited native Rafeeq import sheet (authoritative,
//                            machine-import, untouched by this module);
//   • "Malikas Reference" — an EXPLANATORY sheet for Rafeeq staff. It repeats
//     one row per option (parent SKU/name/category/image identical across a
//     product's option rows; only option fields vary) and a single row for a
//     simple product.
//
// The REAL BARCODE column here is the canonical EAN — REFERENCE-ONLY. It never
// changes the approved `data.barcode = parent SKU` contract and never appears
// on the data sheet. Variant SKUs/barcodes stay internal — they are NOT shown
// here (option rows are identified by their option names). OPTION PRICE shows
// each option's FULL effective canonical price (what the customer pays), while
// PRODUCT PRICE mirrors the data sheet's product_price cell (a number, or the
// literal "PRICE ON SELECTION"). NOTES flags NEW PRODUCT / EXISTING PRODUCT /
// OPTION UPDATE / CATEGORY REVIEW. No I/O — node:test loads this directly.

import { sanitizeSpreadsheetText, type AoaCell } from "../package-core.ts";
import { RAFEEQ_PRICE_ON_SELECTION, rafeeqCategoryKeyByName } from "./native-template.ts";
import type { RafeeqPreviewRow } from "./preview.ts";
import type { RafeeqPendingKind } from "./fullsync.ts";

export const MALIKAS_REFERENCE_SHEET = "Malikas Reference";

/** The exact reference columns (owner-specified). */
export const MALIKAS_REFERENCE_HEADERS = [
  "SKU",
  "REAL BARCODE",
  "PRODUCT NAME EN",
  "PRODUCT NAME AR",
  "CATEGORY",
  "RAFEEQ CATEGORY",
  "IMAGE FILENAME",
  "PRODUCT PRICE",
  "HAS OPTIONS",
  "OPTION GROUP EN",
  "OPTION GROUP AR",
  "OPTION NAME EN",
  "OPTION NAME AR",
  "OPTION PRICE",
  "RAFEEQ PRODUCT ID",
  "NOTES",
] as const;

export const REFERENCE_COL = {
  sku: 0,
  realBarcode: 1,
  nameEn: 2,
  nameAr: 3,
  category: 4,
  rafeeqCategory: 5,
  imageFilename: 6,
  productPrice: 7,
  hasOptions: 8,
  groupEn: 9,
  groupAr: 10,
  optionEn: 11,
  optionAr: 12,
  optionPrice: 13,
  rafeeqProductId: 14,
  notes: 15,
} as const;

/** One product entering the reference sheet. */
export interface ReferenceItem {
  row: RafeeqPreviewRow;
  /** the packaged parent image filename (e.g. "mk175.jpg"). */
  imageFilename: string;
  /** the data sheet's product_id cell ("" = new record). */
  productIdCell: string;
  /** NEW-package pending kind, when known (drives the OPTION UPDATE note). */
  kind?: RafeeqPendingKind;
}

/** The mapped live Rafeeq category name for a canonical category (or null) —
 *  the resolved registry key, so an approved alias shows its LIVE Rafeeq name
 *  (e.g. "Summer And Camping Supplies" → "Summer Essentials"). */
export function mappedRafeeqCategoryName(category: string | null): string | null {
  return rafeeqCategoryKeyByName(category) ?? null;
}

/** Human note flags for one product. */
export function referenceNotes(item: Pick<ReferenceItem, "row" | "productIdCell" | "kind">): string {
  const flags: string[] = [];
  if (item.kind === "OPTION_UPDATE") flags.push("OPTION UPDATE");
  else if (item.productIdCell !== "") flags.push("EXISTING PRODUCT");
  else flags.push("NEW PRODUCT");
  if (!mappedRafeeqCategoryName(item.row.category)) flags.push("CATEGORY REVIEW");
  return flags.join(" / ");
}

const txt = (v: string | null | undefined): AoaCell => sanitizeSpreadsheetText(String(v ?? ""));

/** Build the "Malikas Reference" AoA: header + one row per option (or one per
 *  simple product), parent fields repeated identically across option rows. */
export function buildMalikasReferenceAoa(items: readonly ReferenceItem[]): AoaCell[][] {
  const out: AoaCell[][] = [MALIKAS_REFERENCE_HEADERS.slice()];
  for (const item of items) {
    const r = item.row;
    const productPrice = r.priceOnSelection
      ? RAFEEQ_PRICE_ON_SELECTION
      : r.price === null ? "" : String(r.price);
    const notes = referenceNotes(item);
    const base: AoaCell[] = new Array(MALIKAS_REFERENCE_HEADERS.length).fill("");
    base[REFERENCE_COL.sku] = txt(r.sku);
    base[REFERENCE_COL.realBarcode] = txt(r.internalBarcode);   // reference-only EAN
    base[REFERENCE_COL.nameEn] = txt(r.title);
    base[REFERENCE_COL.nameAr] = txt(r.titleAr);
    base[REFERENCE_COL.category] = txt(r.category);
    base[REFERENCE_COL.rafeeqCategory] = txt(mappedRafeeqCategoryName(r.category));
    base[REFERENCE_COL.imageFilename] = txt(item.imageFilename);
    base[REFERENCE_COL.productPrice] = productPrice;
    base[REFERENCE_COL.hasOptions] = r.hasOptions ? "YES" : "NO";
    base[REFERENCE_COL.rafeeqProductId] = txt(item.productIdCell);
    base[REFERENCE_COL.notes] = notes;

    if (!r.hasOptions) {
      out.push(base);
      continue;
    }
    for (const o of r.options) {
      const cells = base.slice();
      cells[REFERENCE_COL.groupEn] = txt(r.groupNameEn);
      cells[REFERENCE_COL.groupAr] = txt(r.groupNameAr);
      cells[REFERENCE_COL.optionEn] = txt(o.nameEn);
      cells[REFERENCE_COL.optionAr] = txt(o.nameAr);
      // FULL effective canonical price — what the customer pays for this option.
      cells[REFERENCE_COL.optionPrice] = o.effectivePrice ?? "";
      out.push(cells);
    }
  }
  return out;
}
