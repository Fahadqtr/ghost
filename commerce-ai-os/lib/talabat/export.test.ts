// Tests for the pure Talabat flattened-variant export builder. Fixtures only —
// NO Supabase, NO Talabat, NO network. Route/other-channel guarantees are
// verified by scanning sources.
// Run: node --conditions=react-server --experimental-strip-types --test lib/talabat/export.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  buildTalabatExport,
  buildFlattenedName,
  talabatResultToCsv,
  summarizeTalabatExport,
  planMappingWrite,
  isApprovedForTalabat,
  resolveExactChannelId,
  decideExportGate,
  type ExportProductInput,
  type ExportVariantInput,
  type TalabatMappingCandidate,
} from "./export.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

function prod(over: Partial<ExportProductInput> = {}): ExportProductInput {
  return {
    id: "p1", sku: "mk100", barcode: "6291000000017",
    name_en: "TIRTIR Mask Fit Red Cushion", name_ar: "تيرتير ماسك فت ريد كوشن",
    price: 100, discount_price: null, main_category: "Makeup",
    description_en: "desc en", description_ar: "وصف",
    image_filename: "mk100.jpg", image_url: null,
    approved: true, // explicit Talabat approval; override to test exclusion
    stock_status: "In Stock", // INV.2D explicit availability; override to test OOS
    ...over,
  };
}
function variant(over: Partial<ExportVariantInput> = {}): ExportVariantInput {
  return {
    parent_product_id: "p1", sku: "mk100-1", barcode: "1110000000010",
    variant_name: "21N آيفوري", variant_name_en: "21N Ivory",
    price: 0, stock_quantity: 5,
    ...over,
  };
}

test("1: a no-variant product yields one row + one mapping with masterVariantSku=null", () => {
  const r = buildTalabatExport([prod()], []);
  assert.equal(r.rows.length, 1);
  assert.equal(r.mappings.length, 1);
  assert.equal(r.mappings[0].masterVariantSku, null);
  assert.equal(r.mappings[0].exportedSku, "mk100");
  assert.equal(r.blocked.length, 0);
});

test("2: a product with three variants yields three rows + three mappings", () => {
  const vs = [
    variant({ sku: "mk100-1", barcode: "111", variant_name_en: "21N Ivory", variant_name: "21N آيفوري" }),
    variant({ sku: "mk100-2", barcode: "222", variant_name_en: "23N Sand", variant_name: "23N ساند" }),
    variant({ sku: "mk100-3", barcode: "333", variant_name_en: "24N Latte", variant_name: "24N لاتيه" }),
  ];
  const r = buildTalabatExport([prod()], vs);
  assert.equal(r.rows.length, 3);
  assert.equal(r.mappings.length, 3);
  assert.equal(r.blocked.length, 0);
});

test("3: the variant SKU is the durable mapping key", () => {
  const vs = [variant({ sku: "mk100-2", barcode: "222" })];
  const r = buildTalabatExport([prod()], vs);
  assert.equal(r.mappings[0].masterVariantSku, "mk100-2");
  assert.equal(r.mappings[0].exportedSku, "mk100-2");
});

test("4: no variant id appears anywhere in the mapping", () => {
  const r = buildTalabatExport([prod()], [variant()]);
  const keys = Object.keys(r.mappings[0]);
  assert.ok(!keys.some((k) => /variant_?id/i.test(k)));
  assert.ok(!/"variant_?id"/i.test(JSON.stringify(r.mappings)));
});

test("5: a variant with no SKU is blocked, not exported", () => {
  const r = buildTalabatExport([prod()], [variant({ sku: "   " })]);
  assert.equal(r.rows.length, 0);
  assert.equal(r.mappings.length, 0);
  assert.equal(r.blocked[0].reason, "missing_sku");
});

test("6: a variant with no barcode is blocked", () => {
  const r = buildTalabatExport([prod()], [variant({ barcode: null })]);
  assert.equal(r.rows.length, 0);
  assert.equal(r.blocked[0].reason, "missing_barcode");
});

test("7: the parent barcode is never copied onto a variant", () => {
  // A variant missing a barcode is blocked (not given the parent's)...
  const blockedR = buildTalabatExport([prod({ barcode: "PARENT-BC" })], [variant({ barcode: null })]);
  assert.equal(blockedR.rows.length, 0);
  assert.equal(blockedR.blocked[0].reason, "missing_barcode");
  // ...and a variant with its own barcode ships that one, not the parent's.
  const okR = buildTalabatExport([prod({ barcode: "PARENT-BC" })], [variant({ barcode: "VARIANT-BC" })]);
  assert.equal(okR.rows[0].barcode, "VARIANT-BC");
  assert.notEqual(okR.rows[0].barcode, "PARENT-BC");
});

test("8: a duplicate exported SKU blocks the conflicting rows", () => {
  const vs = [variant({ sku: "dup", barcode: "111" }), variant({ sku: "dup", barcode: "222" })];
  const r = buildTalabatExport([prod()], vs);
  assert.equal(r.rows.length, 0);
  assert.equal(r.blocked.filter((b) => b.reason === "duplicate_sku").length, 2);
});

test("9: a duplicate exported barcode blocks the conflicting rows", () => {
  const vs = [variant({ sku: "mk100-1", barcode: "same" }), variant({ sku: "mk100-2", barcode: "same" })];
  const r = buildTalabatExport([prod()], vs);
  assert.equal(r.rows.length, 0);
  assert.equal(r.blocked.filter((b) => b.reason === "duplicate_barcode").length, 2);
});

test("10: a variant with no own image inherits the parent image + a warning", () => {
  const r = buildTalabatExport([prod({ image_filename: "mk100.jpg" })], [variant()]);
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0].imageFilename, "mk100.jpg");
  assert.ok(r.warnings.some((w) => w.kind === "no_variant_image"));
});

test("11: no valid parent image blocks the row", () => {
  const noImg = prod({ image_filename: "", image_url: null });
  assert.equal(buildTalabatExport([noImg], []).blocked[0].reason, "missing_image");
  assert.equal(buildTalabatExport([noImg], [variant()]).blocked[0].reason, "missing_image");
});

test("12: a variant price overrides the parent price", () => {
  const r = buildTalabatExport([prod({ price: 100 })], [variant({ price: 50 })]);
  assert.equal(r.rows[0].priceQar, "50");
});

test("13: the parent discount applies to a no-variant product", () => {
  const r = buildTalabatExport([prod({ price: 100, discount_price: 80 })], []);
  assert.equal(r.rows[0].priceQar, "80");
});

test("14: EN and AR names are built independently", () => {
  const r = buildTalabatExport([prod()], [variant({ variant_name_en: "23N Sand", variant_name: "23N ساند" })]);
  assert.equal(r.rows[0].nameEn, "TIRTIR Mask Fit Red Cushion — 23N Sand");
  assert.equal(r.rows[0].nameAr, "تيرتير ماسك فت ريد كوشن — 23N ساند");
});

test("15: the option is not repeated when the parent name already contains it", () => {
  assert.equal(buildFlattenedName("TIRTIR 21N Ivory Cushion", "21N Ivory"), "TIRTIR 21N Ivory Cushion");
  assert.equal(buildFlattenedName("TIRTIR Cushion", "21N Ivory"), "TIRTIR Cushion — 21N Ivory");
});

test("16: an archived product produces no active row", () => {
  const r = buildTalabatExport([prod({ archived: true })], [variant()]);
  assert.equal(r.rows.length, 0);
  assert.equal(r.mappings.length, 0);
  assert.ok(r.warnings.some((w) => w.kind === "excluded_archived"));
});

test("16b: a not-approved product is excluded", () => {
  const r = buildTalabatExport([prod({ approved: false })], []);
  assert.equal(r.rows.length, 0);
  assert.ok(r.warnings.some((w) => w.kind === "excluded_not_approved"));
});

test("17: a mapping update never clears channel_product_id", () => {
  const cand: TalabatMappingCandidate = buildTalabatExport([prod()], [])!.mappings[0];
  const plan = planMappingWrite("chan-1", cand, { id: "row-1", channel_product_id: "TLB-EXISTING" }, "2026-07-30T00:00:00.000Z");
  assert.equal(plan.op, "update");
  if (plan.op === "update") {
    assert.ok(!("channel_product_id" in plan.patch), "update patch must not touch channel_product_id");
    assert.equal(plan.patch.exported_sku, "mk100");
  }
  // Insert (no existing) sets it to null.
  const ins = planMappingWrite("chan-1", cand, null, "2026-07-30T00:00:00.000Z");
  assert.equal(ins.op, "insert");
  if (ins.op === "insert") assert.equal(ins.row.channel_product_id, null);
});

test("18: a complete variant mapping (inherits parent image) is active, warning remains", () => {
  const r = buildTalabatExport([prod()], [variant()]);
  assert.equal(r.mappings[0].mappingStatus, "active"); // inheriting the parent image does NOT force needs_review
  assert.ok(r.warnings.some((w) => w.kind === "no_variant_image"));
});

test("19: a complete no-variant mapping is active", () => {
  const r = buildTalabatExport([prod()], []);
  assert.equal(r.mappings[0].mappingStatus, "active");
});

test("20: no channel_stock is ever produced (module + persistence)", () => {
  assert.ok(!/channel_stock/i.test(read("lib/talabat/export.ts")));
  assert.ok(!/channel_stock/i.test(read("lib/talabat/persist-mappings.ts")));
  const r = buildTalabatExport([prod()], [variant()]);
  assert.ok(!/channel_stock/i.test(JSON.stringify(r)));
});

test("21: other channels' exports are unchanged in the route", () => {
  const route = read("app/api/export/[channel]/route.ts");
  assert.match(route, /buildShopifyCsv/);
  assert.match(route, /buildSnoonuCsv/);
  assert.match(route, /buildRafeeqAoa/);
  assert.match(route, /buildTalabatExport/, "talabat branch uses the new builder");
});

test("22: the export module is pure — no network/Supabase", () => {
  const src = read("lib/talabat/export.ts").replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  assert.ok(!/supabase/i.test(src));
  assert.ok(!/\bfetch\(/.test(src));
  assert.ok(!/from ["']server-only["']/.test(src));
  assert.ok(!/https?:\/\//.test(src));
});

// ---- format + summary -------------------------------------------------------

test("CSV has the 10-column header and one data row per valid row", () => {
  const r = buildTalabatExport([prod()], []);
  const csv = talabatResultToCsv(r.rows);
  const lines = csv.trimEnd().split("\r\n");
  assert.equal(lines[0], "SKU,Barcode,Price (QAR),Discount,Product Name EN,Product Name AR,Category,Description EN,Description AR,New Image Filename");
  assert.equal(lines.length, 2);
  assert.ok(lines[1].startsWith("mk100,6291000000017,100,,"));
});

// ---- Review fix 1: explicit Talabat approval ---------------------------------

test("R1: only explicit \"Approved\" counts; undefined/other are not approved", () => {
  assert.equal(isApprovedForTalabat("Approved"), true);
  for (const v of [undefined, null, "", "Not Listed", "Pending", "SentAI", "Rejected", "approved", "APPROVED"]) {
    assert.equal(isApprovedForTalabat(v as string | null | undefined), false, `"${String(v)}" must not be approved`);
  }
});

test("R1: a product with no Talabat approval (undefined) is excluded", () => {
  const r = buildTalabatExport([prod({ approved: undefined })], []);
  assert.equal(r.rows.length, 0);
  assert.ok(r.warnings.some((w) => w.kind === "excluded_not_approved"));
});

test("R1: Not Listed / Pending / Rejected are excluded; only explicit approval enters", () => {
  for (const status of [undefined, null, "", "Not Listed", "Pending", "Rejected", "SentAI"]) {
    const approved = isApprovedForTalabat(status as string | null | undefined);
    const r = buildTalabatExport([prod({ approved })], []);
    assert.equal(r.rows.length, 0, `status "${String(status)}" must be excluded`);
  }
  const ok = buildTalabatExport([prod({ approved: isApprovedForTalabat("Approved") })], []);
  assert.equal(ok.rows.length, 1);
});

// ---- Review fix 2: unambiguous Talabat channel -------------------------------

test("R2: resolve exactly one Talabat channel (missing / ok / ambiguous)", () => {
  assert.deepEqual(resolveExactChannelId([], "talabat"), { status: "missing" });
  assert.deepEqual(resolveExactChannelId([{ id: "c1", name: "Talabat" }], "talabat"), { status: "ok", id: "c1" });
  // Never picks the first of several exact matches.
  assert.deepEqual(resolveExactChannelId([{ id: "c1", name: "Talabat" }, { id: "c2", name: "talabat" }], "talabat"), { status: "ambiguous" });
  // A "%talabat%"-style partial match is NOT an exact channel.
  assert.deepEqual(resolveExactChannelId([{ id: "c9", name: "Talabat QA" }], "talabat"), { status: "missing" });
});

// ---- Review fix 4: fail-closed export gate -----------------------------------

test("R4: zero valid rows is allowed (no mappings, no channel needed)", () => {
  assert.deepEqual(decideExportGate(0, { status: "missing" }, null), { ok: true });
});

test("R4: valid rows with a missing/ambiguous channel block the download (safe 503)", () => {
  const miss = decideExportGate(3, { status: "missing" }, null);
  const amb = decideExportGate(3, { status: "ambiguous" }, null);
  for (const g of [miss, amb]) {
    assert.equal(g.ok, false);
    if (!g.ok) {
      assert.equal(g.httpStatus, 503);
      assert.equal(g.message, "Talabat export configuration is unavailable");
    }
  }
});

test("R4: persistence failure (failed>0 or null) blocks the download", () => {
  const nullPersist = decideExportGate(3, { status: "ok", id: "c1" }, null);
  const failed = decideExportGate(3, { status: "ok", id: "c1" }, { inserted: 2, updated: 0, failed: 1 });
  for (const g of [nullPersist, failed]) {
    assert.equal(g.ok, false);
    if (!g.ok) {
      assert.equal(g.httpStatus, 503);
      assert.equal(g.message, "Talabat export could not be completed. Please try again.");
    }
  }
});

test("R4: full persistence success permits the download", () => {
  assert.deepEqual(decideExportGate(3, { status: "ok", id: "c1" }, { inserted: 3, updated: 0, failed: 0 }), { ok: true });
});

test("R4: gate messages never leak ids/barcodes/DB errors", () => {
  for (const g of [decideExportGate(1, { status: "missing" }, null), decideExportGate(1, { status: "ok", id: "c1" }, { inserted: 0, updated: 0, failed: 1 })]) {
    if (!g.ok) assert.ok(!/c1|barcode|error|supabase|sql/i.test(g.message), `message leaks: ${g.message}`);
  }
});

// ---- INV.2D: availability from explicit product stock_status ----------------

test("INV.2D: an Out-of-Stock PRODUCT stays active with OutOfStock in the snapshot (variant qty ignored)", () => {
  // Variant carries stock 5, but the product is explicitly Out of Stock — the
  // export honors the product-level availability, not the variant quantity.
  const r = buildTalabatExport([prod({ stock_status: "Out of Stock" })], [variant({ stock_quantity: 5 })]);
  assert.equal(r.rows.length, 1);
  assert.equal(r.mappings[0].mappingStatus, "active");
  assert.equal(r.mappings[0].exportSnapshot.availability, "OutOfStock");
  assert.ok(r.warnings.some((w) => w.kind === "out_of_stock"));
});

test("INV.2D: an In-Stock product exports InStock even when a variant quantity is 0", () => {
  const r = buildTalabatExport([prod({ stock_status: "In Stock" })], [variant({ stock_quantity: 0 })]);
  assert.equal(r.mappings[0].exportSnapshot.availability, "InStock");
  assert.equal(r.warnings.some((w) => w.kind === "out_of_stock"), false);
});

// ---- Review: route wiring (source scan) --------------------------------------

test("R: the route uses explicit approval + exact channel + fail-closed gate", () => {
  const route = read("app/api/export/[channel]/route.ts");
  assert.match(route, /isApprovedForTalabat/);
  assert.ok(!/!==\s*"Not Listed"/.test(route), "must not gate approval by channel_status !== Not Listed");
  assert.match(route, /platform_status/);
  assert.match(route, /resolveExactChannelId/);
  assert.ok(!/chanIds\[0\]/.test(route), "must not pick chanIds[0]");
  assert.match(route, /decideExportGate/);
  assert.match(route, /status:\s*gate\.httpStatus/);
  // Other channels untouched.
  assert.match(route, /buildShopifyCsv/);
  assert.match(route, /buildSnoonuCsv/);
  assert.match(route, /buildRafeeqAoa/);
});

// ---- Final review: exact channel pricing + redacted errors ------------------

test("F1: the exact resolver ignores a 'Talabat Archive' sibling (archive never selected)", () => {
  const res = resolveExactChannelId([{ id: "t", name: "Talabat" }, { id: "arc", name: "Talabat Archive" }], "talabat");
  assert.deepEqual(res, { status: "ok", id: "t" });
  // Two channels literally named "Talabat" is still ambiguous → blocks.
  assert.deepEqual(resolveExactChannelId([{ id: "t1", name: "Talabat" }, { id: "t2", name: "Talabat" }], "talabat"), { status: "ambiguous" });
});

test("F1: route loads price + mappings from the EXACT Talabat channel only", () => {
  const route = read("app/api/export/[channel]/route.ts");
  assert.match(route, /channel !== "talabat"/, "generic fuzzy channel_products load is skipped for talabat");
  assert.match(route, /\.eq\("channel_id", channelRes\.id\)/, "talabat price loads by the exact channel id");
  assert.match(route, /talabatPrice\[p\.id\]/, "productInputs use the exact-channel price map");
  assert.ok(!/channel_price:\s*priceOverride/.test(route), "talabat must not use the fuzzy priceOverride");
  assert.ok(!/\.in\("channel_id", chanIds\)[\s\S]{0,120}channel_price/.test(route), "no fuzzy channel_price load");
});

test("F2: Talabat errors are redacted to a static safe 503 (no raw error / no CSV)", () => {
  const route = read("app/api/export/[channel]/route.ts");
  assert.match(route, /Talabat export is temporarily unavailable/);
  const catchIdx = route.lastIndexOf("catch (e)");
  assert.ok(catchIdx >= 0);
  const guardIdx = route.indexOf('if (channel === "talabat")', catchIdx);
  const staticIdx = route.indexOf("Talabat export is temporarily unavailable", catchIdx);
  const rawIdx = route.indexOf("Export failed:", catchIdx);
  assert.ok(guardIdx > catchIdx, "catch has a talabat guard");
  assert.ok(staticIdx > guardIdx && staticIdx < rawIdx, "talabat returns the static 503 before the raw path");
  // The safe 503 body carries no error interpolation.
  assert.ok(!/Talabat export is temporarily unavailable[^"]*\$\{/.test(route), "static message has no interpolation");
});

test("summary reports counts for preview / dry-run", () => {
  const vs = [variant({ sku: "a", barcode: "1" }), variant({ sku: "b", barcode: null })];
  const r = buildTalabatExport([prod()], vs);
  const s = summarizeTalabatExport(r, { baseProducts: 1, variants: 2 });
  assert.equal(s.baseProducts, 1);
  assert.equal(s.variants, 2);
  assert.equal(s.validRows, 1);
  assert.equal(s.blockedRows, 1);
  assert.equal(s.missingBarcode, 1);
  assert.equal(s.noVariantImage, 1);
});
