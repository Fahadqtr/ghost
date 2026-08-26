// OPTIONS OVERVIEW sheet (PURE) — the third workbook sheet (owner clarity
// decision, FINAL OPTIONS CLARITY UPDATE).
//
// A dedicated human-review sheet containing ONLY the products that carry
// native options, one VISUAL BLOCK per parent product: a block header
// (PRODUCT: sku + names), meta rows (category / Rafeeq category / image /
// total options / option group / price type), then a small option table
// (# / names / FULL price / ROW TYPE). The sheet opens with the summary and
// the semantics statements: options are NOT independent products — every
// option belongs to its parent; the parent SKU/image/category identify the
// PRODUCT, the option name + option price identify the CHOICE.
//
// Clarity only: the audited "data" sheet import contract is untouched, and
// nothing here ever presents an option as an independent Rafeeq product.
// No I/O — node:test loads this directly. Styling is applied by the
// serializer from the per-row KIND tags this builder emits.

import { sanitizeSpreadsheetText, type AoaCell } from "../package-core.ts";
import { RAFEEQ_PRICE_ON_SELECTION } from "./native-template.ts";
import { mappedRafeeqCategoryName, referenceRowType } from "./reference.ts";
import type { RafeeqPreviewRow } from "./preview.ts";

export const OPTIONS_OVERVIEW_SHEET = "Options Overview";

/** Row kinds — the serializer maps each to a visual style. */
export type OptionsOverviewRowKind =
  | "title"
  | "summary"
  | "semantics"
  | "blockHeader"
  | "blockMeta"
  | "tableHead"
  | "option"
  | "optionAlt"
  | "blank";

export interface OptionsOverviewItem {
  row: RafeeqPreviewRow;
  /** the packaged parent image filename (e.g. "mk175.jpg"). */
  imageFilename: string;
}

export interface OptionsOverviewSheet {
  aoa: AoaCell[][];
  /** one kind per AoA row, same order. */
  rowKinds: OptionsOverviewRowKind[];
  /** parent products with options (blocks). */
  productCount: number;
  /** total option rows across all blocks. */
  optionCount: number;
}

const txt = (v: string | null | undefined): AoaCell => sanitizeSpreadsheetText(String(v ?? ""));

/** The human PRICE TYPE line for one option product. */
export function optionsPriceTypeText(row: RafeeqPreviewRow): string {
  if (row.priceOnSelection) return `${RAFEEQ_PRICE_ON_SELECTION} / السعر حسب الخيار`;
  const p = row.price === null ? "—" : String(row.price);
  return `UNIFORM PRICE ${p} QAR / سعر موحّد ${p} ر.ق`;
}

/** Build the Options Overview sheet from the packaged products (any input —
 *  simple products are filtered out here; ONLY option parents appear). */
export function buildOptionsOverviewSheet(items: readonly OptionsOverviewItem[]): OptionsOverviewSheet {
  const parents = items.filter((it) => it.row.hasOptions && it.row.options.length > 0);
  const optionCount = parents.reduce((acc, it) => acc + it.row.options.length, 0);

  const aoa: AoaCell[][] = [];
  const rowKinds: OptionsOverviewRowKind[] = [];
  const push = (kind: OptionsOverviewRowKind, cells: AoaCell[]) => {
    aoa.push(cells);
    rowKinds.push(kind);
  };
  const blank = () => push("blank", ["", "", "", "", "", ""]);

  // ── summary + semantics ────────────────────────────────────────────────────
  push("title", ["OPTIONS OVERVIEW — نظرة عامة على الخيارات", "", "", "", "", ""]);
  push("summary", ["PRODUCTS WITH OPTIONS", parents.length, "TOTAL OPTIONS", optionCount, "", ""]);
  push("semantics", [
    "Options are NOT independent products — every option belongs to its parent product. / الخيارات ليست منتجات مستقلة — كل خيار يتبع منتجه الأب.",
    "", "", "", "", "",
  ]);
  push("semantics", [
    "The parent SKU, image and category identify the PRODUCT; the option name + option price identify the CHOICE. / SKU الأب والصورة والفئة تحدّد المنتج؛ اسم الخيار وسعره يحدّدان الاختيار.",
    "", "", "", "", "",
  ]);
  blank();

  // ── one visual block per parent product ────────────────────────────────────
  for (const it of parents) {
    const r = it.row;
    const n = r.options.length;
    push("blockHeader", [`PRODUCT: ${r.sku}`, txt(r.title), txt(r.titleAr), "", "", "ONE PRODUCT / منتج واحد"]);
    push("blockMeta", ["CATEGORY", txt(r.category), "RAFEEQ CATEGORY", txt(mappedRafeeqCategoryName(r.category)), "IMAGE FILENAME", txt(it.imageFilename)]);
    push("blockMeta", ["TOTAL OPTIONS", n, "OPTION GROUP EN", txt(r.groupNameEn), "OPTION GROUP AR", txt(r.groupNameAr)]);
    push("blockMeta", ["PRICE TYPE", optionsPriceTypeText(r), "", "", "", ""]);
    push("tableHead", ["#", "OPTION NAME EN", "OPTION NAME AR", "OPTION PRICE", "ROW TYPE", ""]);
    r.options.forEach((o, i) => {
      // FULL price per option: differing prices show each option's effective
      // canonical price; a uniform price is repeated on every option row.
      const price: AoaCell = r.priceOnSelection ? (o.effectivePrice ?? "") : (r.price ?? "");
      push(i % 2 === 1 ? "optionAlt" : "option", [i + 1, txt(o.nameEn), txt(o.nameAr), price, referenceRowType(i + 1, n), ""]);
    });
    blank();
  }

  return { aoa, rowKinds, productCount: parents.length, optionCount };
}
