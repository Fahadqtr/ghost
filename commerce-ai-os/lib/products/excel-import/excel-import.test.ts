// Tests for the catalog Excel import pure cores (Phase UI.6): columns,
// normalization, matching, planning, new-record classification + grouping,
// and the formula-safe report. PURE — no database, no network.
// Run: node --conditions=react-server --experimental-strip-types --test lib/products/excel-import/excel-import.test.ts

import test from "node:test";
import assert from "node:assert/strict";

import {
  buildIdentityIndexes,
  buildRowUpdatePlan,
  detectCatalogColumns,
  detectNewCatalogRecord,
  findFileDuplicates,
  fingerprintRecord,
  groupNewProductRows,
  mappingByField,
  matchCatalogRow,
  normalizeCatalogExcelRow,
  ROW_MESSAGES,
  toCellText,
  validateCatalogMapping,
  valuesEqual,
  type NewRowClassification,
  type NormalizedRow,
} from "./core.ts";
import { buildCatalogImportReport, csvCell, reportToCsv, type ImportRecordResult } from "./report.ts";
import type { IdentityRow } from "../duplicate-detect.ts";

// ── columns ──────────────────────────────────────────────────────────────────

test("column detection: aliases auto-map, loose names need confirmation, banned headers are ignored", () => {
  const m = detectCatalogColumns(["SKU", "Bar Code", "Name EN", "name", "Image URL", "Stock", "غامض"]);
  assert.deepEqual(m.map((x) => [x.field, x.status]), [
    ["sku", "auto"],
    ["barcode", "auto"],
    ["name_en", "auto"],
    ["name_en", "needs_confirm"],
    [null, "ignored"], // image url: never imported in v1
    [null, "ignored"], // stock: forbidden
    [null, "unknown"],
  ]);
});

test("mapping validation: duplicate field / missing identifier / forbidden field all rejected", () => {
  const base = detectCatalogColumns(["SKU", "Price"]);
  assert.ok(validateCatalogMapping(base).ok);
  const dup = [
    { index: 0, header: "a", field: "price" as const, status: "auto" as const },
    { index: 1, header: "b", field: "price" as const, status: "auto" as const },
    { index: 2, header: "c", field: "sku" as const, status: "auto" as const },
  ];
  assert.deepEqual(validateCatalogMapping(dup), { ok: false, error: "duplicate_field" });
  const noId = [{ index: 0, header: "a", field: "price" as const, status: "auto" as const }];
  assert.deepEqual(validateCatalogMapping(noId), { ok: false, error: "no_identifier" });
  const forbidden = [
    { index: 0, header: "a", field: "sku" as const, status: "auto" as const },
    { index: 1, header: "b", field: "stock_quantity" as unknown as "sku", status: "auto" as const },
  ];
  assert.deepEqual(validateCatalogMapping(forbidden), { ok: false, error: "forbidden_field" });
});

// ── cell text (identifiers as TEXT, always) ──────────────────────────────────

test("toCellText: leading zeros preserved, big numbers never scientific, Arabic digits unified", () => {
  assert.equal(toCellText("0012345678905"), "0012345678905");
  assert.equal(toCellText(4006381333931), "4006381333931");
  assert.equal(toCellText("٤٠٠٦٣٨"), "400638");
  assert.equal(toCellText("  mk123  "), "mk123");
  assert.equal(toCellText(null), "");
});

// ── row normalization ────────────────────────────────────────────────────────

const MAPPING = detectCatalogColumns(["SKU", "Barcode", "Name AR", "Price", "Discount Price", "Description AR"]);
const BY_FIELD = mappingByField(MAPPING);

function normRow(cells: unknown[], rowNum = 2): NormalizedRow {
  return normalizeCatalogExcelRow(rowNum, cells, BY_FIELD);
}

test("normalization: MK123 -> mk123 product, MK123-1 -> variant with parent; bad shapes are errors", () => {
  const p = normRow(["MK123", null, "اسم", null, null, null]);
  assert.equal(p.kind, "product");
  assert.equal(p.sku, "mk123");
  const v = normRow(["MK123-1", null, null, null, null, null]);
  assert.equal(v.kind, "variant");
  assert.equal(v.sku, "mk123-1");
  assert.equal(v.parentSku, "mk123");
  for (const bad of ["mk123-01", "mk123-A", "mk123 blue", "mk-123", "PRD9"]) {
    const r = normRow([bad, null, null, null, null, null]);
    assert.ok(r.errors.includes(ROW_MESSAGES.invalid_sku), bad);
  }
});

test("normalization: empty cell = no change; __CLEAR__ only on clearable fields; price junk is an error, never 0", () => {
  const r = normRow(["mk9", null, "", "", "__CLEAR__", "__CLEAR__"]);
  assert.ok(!r.values.some((v) => v.field === "name_ar"), "empty name cell produces no change");
  assert.ok(!r.values.some((v) => v.field === "price"), "empty price cell produces no change");
  assert.ok(r.values.some((v) => v.field === "discount_price" && v.clear), "discount is clearable");
  assert.ok(r.values.some((v) => v.field === "description_ar" && v.clear), "description is clearable");

  const notClearable = normRow(["mk9", null, "__CLEAR__", null, null, null]);
  assert.ok(notClearable.errors.includes(ROW_MESSAGES.clear_not_allowed), "name cannot be cleared");

  const junk = normRow(["mk9", null, null, "abc", null, null]);
  assert.ok(junk.errors.includes(ROW_MESSAGES.invalid_price));
  assert.ok(!junk.values.some((v) => v.field === "price"), "junk price never becomes a value");
  const neg = normRow(["mk9", null, null, "-5", null, null]);
  assert.ok(neg.errors.includes(ROW_MESSAGES.negative_price));
  const zero = normRow(["mk9", null, null, 0, null, null]);
  assert.ok(zero.values.some((v) => v.field === "price" && v.value === "0"), "zero is a real value");
});

// ── matching ─────────────────────────────────────────────────────────────────

function idRow(over: Partial<IdentityRow> = {}): IdentityRow {
  return {
    id: "p1", kind: "product", productId: "p1", sku: "mk10", barcode: "111111",
    nameEn: "A", nameAr: "أ", size: null, color: null, ...over,
  };
}

test("matching order: sku, barcode, both-same-record; different records = conflict; name never matches", () => {
  const rows = [idRow(), idRow({ id: "p2", productId: "p2", sku: "mk11", barcode: "222222", nameEn: "Same Name" })];
  const idx = buildIdentityIndexes(rows);
  const none = new Set<number>();

  const bySku = matchCatalogRow(normRow(["mk10", null, null, null, null, null]), idx, none);
  assert.equal(bySku.status, "matched_sku");
  const byBarcode = matchCatalogRow(normRow([null, "222222", null, null, null, null]), idx, none);
  assert.equal(byBarcode.status, "matched_barcode");
  assert.equal(byBarcode.record?.id, "p2");
  const both = matchCatalogRow(normRow(["mk10", "111111", null, null, null, null]), idx, none);
  assert.equal(both.status, "matched_both");
  const conflict = matchCatalogRow(normRow(["mk10", "222222", null, null, null, null]), idx, none);
  assert.equal(conflict.status, "conflict");
  assert.equal(conflict.record, null);
  // a row with only a matching NAME has no identifiers → invalid/not_found, never matched
  const nameOnly = matchCatalogRow(normRow([null, null, "Same Name", null, null, null]), idx, none);
  assert.equal(nameOnly.status, "not_found");
});

test("matching: duplicates inside the file and inside the db are both flagged", () => {
  const rows = [idRow(), idRow({ id: "p2", productId: "p2" })]; // same sku+barcode twice in db
  const idx = buildIdentityIndexes(rows);
  const dbDup = matchCatalogRow(normRow(["mk10", null, null, null, null, null]), idx, new Set());
  assert.equal(dbDup.status, "dup_in_db");

  const fileRows = [normRow(["mk50", null, null, null, null, null], 2), normRow(["MK50", null, null, null, null, null], 3)];
  const dups = findFileDuplicates(fileRows);
  assert.ok(dups.has(2) && dups.has(3), "case-insensitive sku dup inside the file");
});

// ── planning ─────────────────────────────────────────────────────────────────

const PLAN_OPTS = {
  categories: ["Korean Skincare"],
  brandResolver: (n: string) => (n === "Cosrx" ? "b1" : null),
  selectedFields: new Set(["name_ar", "price", "discount_price", "main_category", "brand"] as const) as Set<never>,
};

test("plan: equal-after-normalization is no-change; changed selected fields become updates; unselected skip", () => {
  const row = normRow(["mk10", null, "اسم  جديد", "120", null, null]);
  const plan = buildRowUpdatePlan(row, "p1", "product", { name_ar: "اسم جديد", price: "120" }, PLAN_OPTS as never);
  const name = plan.changes.find((c) => c.field === "name_ar")!;
  assert.ok(name.equal, "whitespace-normalized equality");
  assert.equal(name.decision, "skip");
  const row2 = normRow(["mk10", null, "اسم مختلف", "150", null, null]);
  const plan2 = buildRowUpdatePlan(row2, "p1", "product", { name_ar: "اسم جديد", price: "120" }, PLAN_OPTS as never);
  assert.equal(plan2.changes.find((c) => c.field === "name_ar")?.decision, "update");
  assert.equal(plan2.changes.find((c) => c.field === "price")?.decision, "update");
  assert.equal(plan2.changedCount, 2);
});

test("plan: unknown category is an error (skip); unknown brand is a warning (skip); price equality is numeric", () => {
  assert.ok(valuesEqual("price", "120", "120.0"));
  const m2 = detectCatalogColumns(["SKU", "Category", "Brand"]);
  const bf = mappingByField(m2);
  const row = normalizeCatalogExcelRow(2, ["mk10", "Weapons", "Nope"], bf);
  const plan = buildRowUpdatePlan(row, "p1", "product", {}, PLAN_OPTS as never);
  const cat = plan.changes.find((c) => c.field === "main_category")!;
  assert.ok(cat.error, "unknown category errors");
  assert.equal(cat.decision, "skip");
  const brand = plan.changes.find((c) => c.field === "brand")!;
  assert.ok(brand.warning, "unknown brand warns");
  assert.equal(brand.decision, "skip");
});

test("fingerprint: stable for same values, different when a value changes", () => {
  const a = fingerprintRecord(["name_ar", "price"], { name_ar: "x", price: "1" });
  const b = fingerprintRecord(["price", "name_ar"], { price: "1", name_ar: "x" });
  const c = fingerprintRecord(["name_ar", "price"], { name_ar: "x", price: "2" });
  assert.equal(a, b, "field order does not matter");
  assert.notEqual(a, c);
});

// ── new-record classification + grouping ─────────────────────────────────────

test("new detection: every class lands where the spec says", () => {
  const exists = (sku: string) => sku === "mk123";
  const inFile = new Set(["mk2000"]);
  const mk = (cells: unknown[], n: number) => normRow(cells, n);

  assert.equal(detectNewCatalogRecord(mk(["mk2000", null, "منتج", null, null, null], 2), "not_found", exists, inFile).cls, "new_product");
  assert.equal(detectNewCatalogRecord(mk(["mk123-4", null, null, null, null, null], 3), "not_found", exists, inFile).cls, "new_variant_existing_parent");
  assert.equal(detectNewCatalogRecord(mk(["mk2000-1", null, null, null, null, null], 4), "not_found", exists, inFile).cls, "new_variant_parent_in_file");
  assert.equal(detectNewCatalogRecord(mk(["mk9999-1", null, null, null, null, null], 5), "not_found", exists, inFile).cls, "orphan_variant");
  assert.equal(detectNewCatalogRecord(mk([null, "4006381333931", null, null, null, null], 6), "not_found", exists, inFile).cls, "new_product_needs_sku");
  assert.equal(detectNewCatalogRecord(mk([null, null, "اسم فقط", null, null, null], 7), "not_found", exists, inFile).cls, "needs_review");
  assert.equal(detectNewCatalogRecord(mk(["mk1", "222222", null, null, null, null], 8), "conflict", exists, inFile).cls, "blocked");
});

test("grouping: mk2000 + mk2000-1..3 become ONE group, not four products", () => {
  const rows = new Map<number, NormalizedRow>();
  const cls: NewRowClassification[] = [];
  const push = (cells: unknown[], n: number, c: NewRowClassification["cls"]) => {
    const r = normRow(cells, n);
    rows.set(n, r);
    cls.push({ rowNum: n, cls: c, reason: null });
  };
  push(["mk2000", null, "منتج", null, null, null], 2, "new_product");
  push(["mk2000-1", null, null, null, null, null], 3, "new_variant_parent_in_file");
  push(["mk2000-2", null, null, null, null, null], 4, "new_variant_parent_in_file");
  push(["mk2000-3", null, null, null, null, null], 5, "new_variant_parent_in_file");
  push([null, "4006381333931", "بدون سكيو", null, null, null], 6, "new_product_needs_sku");

  const groups = groupNewProductRows(cls, rows);
  assert.equal(groups.length, 2);
  const main = groups.find((g) => g.mainSku === "mk2000")!;
  assert.deepEqual(main.variantRowNums, [3, 4, 5]);
  const loose = groups.find((g) => g.needsSku)!;
  assert.equal(loose.mainSku, null);
});

// ── report + formula injection ───────────────────────────────────────────────

test("report: created vs updated vs the rest are counted separately", () => {
  const mk = (status: ImportRecordResult["status"]): ImportRecordResult => ({
    rowNum: 2, recordKind: "product", recordId: "p", sku: "mk1", barcode: null, status, changedFields: [], message: "",
  });
  const s = buildCatalogImportReport([
    mk("product_updated"), mk("variant_updated"), mk("product_created"), mk("variant_created"),
    mk("skipped"), mk("conflict"), mk("failed"), mk("changed_after_preview"),
  ]);
  assert.equal(s.productUpdated, 1);
  assert.equal(s.productCreated, 1);
  assert.equal(s.variantCreated, 1);
  assert.equal(s.changedAfterPreview, 1);
});

test("csv: formula-leading values are escaped (= + - @), quotes/commas are quoted", () => {
  assert.equal(csvCell("=SUM(A1)"), "'=SUM(A1)");
  assert.equal(csvCell("+973"), "'+973");
  assert.equal(csvCell("-5"), "'-5");
  assert.equal(csvCell("@cmd"), "'@cmd");
  assert.equal(csvCell('a,"b'), '"a,""b"');
  const csv = reportToCsv([
    { rowNum: 2, recordKind: "product", recordId: "p", sku: "=HYPERLINK(1)", barcode: null, status: "failed", changedFields: [], message: "x" },
  ]);
  assert.ok(csv.includes("'=HYPERLINK(1)"), "sku escaped in the report");
});
