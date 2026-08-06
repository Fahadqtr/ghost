// Phase UI.6 — workbook parsing with REAL xlsx files (built in-memory with
// the same SheetJS the server uses, injected into the parser) + page/action/
// wizard safety scans.
// Run: node --conditions=react-server --experimental-strip-types --test lib/products/excel-import/parse-and-page.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as XLSX from "xlsx";

import { extractSheetRows, inspectWorkbook, looksLikeXlsx, MAX_IMPORT_ROWS } from "./parse.ts";

const X = XLSX as unknown as Parameters<typeof inspectWorkbook>[1];

function wbBuffer(build: (wb: XLSX.WorkBook) => void): Buffer {
  const wb = XLSX.utils.book_new();
  build(wb);
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

const ACTIONS_SRC = readFileSync(new URL("../../../app/(v2)/v2/catalog/import/actions.ts", import.meta.url), "utf8");
const PAGE_SRC = readFileSync(new URL("../../../app/(v2)/v2/catalog/import/page.tsx", import.meta.url), "utf8");
const WIZARD_SRC = readFileSync(new URL("../../../components/v2/catalog/CatalogExcelImport.tsx", import.meta.url), "utf8");
const MASTER_SRC = readFileSync(new URL("../../../components/v2/catalog/MasterCatalog.tsx", import.meta.url), "utf8");

// ── real-file parsing ────────────────────────────────────────────────────────

test("magic bytes: xlsx accepted, xls/junk rejected before any parsing", () => {
  const xlsx = wbBuffer((wb) => XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["SKU"], ["mk1"]]), "S"));
  assert.ok(looksLikeXlsx(xlsx));
  assert.ok(!looksLikeXlsx(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0, 0])), ".xls CFB rejected");
  assert.ok(!looksLikeXlsx(Buffer.from("plain text")));
});

test("inspect: sheet names + approximate row counts; multi-sheet workbooks list every sheet", async () => {
  const buf = wbBuffer((wb) => {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["SKU"], ["mk1"], ["mk2"]]), "الأولى");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["SKU"]]), "الثانية");
  });
  const res = await inspectWorkbook(buf, X);
  assert.equal(res.status, "ok");
  if (res.status !== "ok") return;
  assert.deepEqual(res.sheets.map((s) => s.name), ["الأولى", "الثانية"]);
  assert.equal(res.sheets[0].rows, 2);
});

test("extract: raw values (leading zeros kept, numbers exact), empty rows dropped, header split out", async () => {
  const buf = wbBuffer((wb) => {
    const ws = XLSX.utils.aoa_to_sheet([
      ["SKU", "Barcode", "Price"],
      ["mk1", "0012345678905", 10],
      [null, null, null], // fully empty row → dropped
      ["mk2", 4006381333931, ""],
    ]);
    XLSX.utils.book_append_sheet(wb, ws, "S");
  });
  const res = await extractSheetRows(buf, "S", X);
  assert.equal(res.status, "ok");
  if (res.status !== "ok") return;
  assert.deepEqual(res.headers, ["SKU", "Barcode", "Price"]);
  assert.equal(res.rows.length, 2, "empty row dropped");
  assert.equal(res.rows[0][1], "0012345678905", "text barcode keeps leading zeros");
  assert.equal(res.rows[1][1], 4006381333931, "numeric barcode stays a raw exact number");
});

test("extract: formula cells are counted (values only, never executed) and empty sheets error", async () => {
  const buf = wbBuffer((wb) => {
    const ws = XLSX.utils.aoa_to_sheet([["SKU", "Price"], ["mk1", 0]]);
    ws.B2 = { t: "n", v: 42, f: "SUM(1,41)" };
    XLSX.utils.book_append_sheet(wb, ws, "S");
  });
  const res = await extractSheetRows(buf, "S", X);
  assert.equal(res.status, "ok");
  if (res.status !== "ok") return;
  assert.equal(res.formulaCells, 1);
  assert.equal(res.rows[0][1], 42, "the cached value is used");

  const empty = wbBuffer((wb) => XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["SKU"]]), "S"));
  assert.equal((await extractSheetRows(empty, "S", X)).status, "error");
  assert.equal((await extractSheetRows(buf, "لا وجود", X)).status, "error");
});

test("extract: more rows than the cap is a hard rejection, not a silent truncation", async () => {
  const rows: unknown[][] = [["SKU"]];
  for (let i = 0; i < MAX_IMPORT_ROWS + 1; i++) rows.push([`mk${i + 1}`]);
  const buf = wbBuffer((wb) => XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), "S"));
  const res = await extractSheetRows(buf, "S", X);
  assert.deepEqual(res, { status: "error", code: "too_many_rows" });
});

// ── actions safety scan ──────────────────────────────────────────────────────

test("actions: auth on every step; nothing is written at upload/preview time", () => {
  assert.ok(ACTIONS_SRC.startsWith('"use server"'));
  assert.equal(ACTIONS_SRC.split("isSignedIn()").length - 1, 5, "all five actions gate on the session");
  // From the first exported step through the end of preview — imports excluded.
  const previewSection = ACTIONS_SRC.slice(
    ACTIONS_SRC.indexOf("export async function inspectCatalogImport"),
    ACTIONS_SRC.indexOf("export async function applyCatalogUpdates"),
  );
  for (const w of [".update(", ".insert(", ".delete(", "createProductCore(", "syncProductVariants("]) {
    assert.ok(!previewSection.includes(w), `inspect/preview must never write (${w})`);
  }
});

test("actions: session client + existing cores only — no admin, no rpc, no raw errors", () => {
  for (const banned of ["createAdminClient", "service_role", ".rpc(", "error.message", "console.log", "SQLSTATE"]) {
    assert.ok(!ACTIONS_SRC.includes(banned), `actions must not contain ${banned}`);
  }
  assert.ok(ACTIONS_SRC.includes("createProductCore"), "creates go through the shared core");
  assert.ok(ACTIONS_SRC.includes("syncProductVariants(supabase"), "variant appends go through the existing sync path");
  assert.ok(ACTIONS_SRC.includes("loadProductForEdit"), "the FULL current variant list is loaded before appending");
  assert.ok(ACTIONS_SRC.includes('approval: ""'), "new products forced un-approved");
  assert.ok(ACTIONS_SRC.includes('platform_status: ""'), "no platform status -> no sync pickup");
});

test("actions: server re-derives everything at apply — mapping, matching, fingerprints", () => {
  assert.ok(ACTIONS_SRC.includes("runPipeline"), "apply re-runs the same pipeline as preview");
  const applySection = ACTIONS_SRC.slice(ACTIONS_SRC.indexOf("applyCatalogUpdates"));
  assert.ok(applySection.includes("validateCatalogMapping") || ACTIONS_SRC.includes("validateCatalogMapping"), "mapping re-validated");
  assert.ok(applySection.includes("changed_after_preview"), "optimistic concurrency outcome exists");
  assert.ok(applySection.includes("fieldColumn("), "writes go through the column allowlist only");
  assert.ok(ACTIONS_SRC.includes("looksLikeXlsx"), "content sniffing, not extension trust");
});

// ── page + wizard scans ──────────────────────────────────────────────────────

test("page: force-dynamic V2 shell; wizard drives everything", () => {
  assert.ok(PAGE_SRC.includes('export const dynamic = "force-dynamic"'));
  assert.ok(PAGE_SRC.includes("CatalogExcelImport"));
  assert.ok(!PAGE_SRC.includes("createAdminClient"));
});

test("wizard: full step contract — tabs, filters, search, field picker, separate confirmations, progress, csv", () => {
  for (const required of [
    '"use client"',
    "inspectCatalogImport",
    "readSheetHeaders",
    "previewCatalogImport",
    "applyCatalogUpdates",
    "applyCatalogCreates",
    "تحديثات المنتجات",
    "منتجات جديدة",
    "تعارضات وأخطاء",
    "بدون تغيير",
    "تطبيق تحديثات المنتجات المحددة",
    "إنشاء المنتجات الجديدة المحددة",
    "تأكيد تحديث المنتجات",
    "تأكيد إنشاء المنتجات الجديدة",
    "تنزيل تقرير CSV",
    "SimilarProducts",       // similar products render as the shared cards
    "reportToCsv",
    "بحث (SKU أو باركود أو اسم)",
    "القيمة الحالية",        // old/new comparison table
    "قيمة Excel",
    "progress",
  ]) {
    assert.ok(WIZARD_SRC.includes(required), `wizard must contain ${required}`);
  }
});

test("wizard: no direct db/ai access, no admin, no alerts, batches bounded", () => {
  for (const banned of ["@supabase/", "@/lib/supabase", "createAdminClient", "window.alert", "Anthropic", ".rpc("]) {
    assert.ok(!WIZARD_SRC.includes(banned), `wizard must not contain ${banned}`);
  }
  assert.ok(WIZARD_SRC.includes("UPDATE_BATCH = 50"), "updates batched at 50");
});

test("catalog page links to the importer", () => {
  assert.ok(MASTER_SRC.includes('href="/v2/catalog/import"'));
  assert.ok(MASTER_SRC.includes("تحديث الكتالوج من Excel"));
});
