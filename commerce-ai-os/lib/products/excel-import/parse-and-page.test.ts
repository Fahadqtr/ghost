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

// ── Malikas platform export (Snoonu AllExportData) — real-file fixture ──────

import { detectCatalogColumns, validateCatalogMapping } from "./core.ts";

const MALIKAS_HEADERS = [
  "SPI(UniqueIdentifier)",
  "Product Name (En)(ReadOnly)",
  "Product Name (Ar)(ReadOnly)",
  "Product Description (En)(ReadOnly)",
  "Product Description (Ar)(ReadOnly)",
  "Price Global(Update)",
  "Availability for Malikas Universe Beauty Al Aziziyah Building 13, first floor, Apartment 3(Update)",
  "Stock for Malikas Universe Beauty Al Aziziyah Building 13, first floor, Apartment 3(Update)",
  "Preparation Time(Update)",
  "Product Name (En)(Update)",
  "Product Name (Ar)(Update)",
  "Product Description (En)(Update)",
  "Product Description (Ar)(Update)",
  "SKU(Update)",
  "Barcode(Update)",
  "SKU(ReadOnly)",
  "Barcode(ReadOnly)",
  "", // trailing empty header, exactly as exported
];

function malikasRow(i: number, withIds: boolean): unknown[] {
  const sku = withIds ? `mk${900 + i}` : "";
  const bc = withIds ? 6291041500900 + i : "";
  return [
    `spi-${i}`, `Old ${i}`, `قديم ${i}`, "old d", "قديم و",
    25 + i, "TRUE", 10, "15", `Cream ${i}`, `كريم ${i}`, "desc", "وصف",
    sku, bc, sku, bc, null,
  ];
}

function malikasWorkbook(): { buf: Buffer; sheet: Record<string, unknown> } {
  const aoa = [MALIKAS_HEADERS, malikasRow(1, true), malikasRow(2, true), malikasRow(3, true), malikasRow(4, false), malikasRow(5, false)];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
  return { buf: XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer, sheet: ws as unknown as Record<string, unknown> };
}

test("malikas fixture: the export reaches mapping — real row count, ok extraction, valid auto-mapping", async () => {
  const { buf } = malikasWorkbook();
  assert.ok(looksLikeXlsx(buf));

  const inspected = await inspectWorkbook(buf, X);
  assert.equal(inspected.status, "ok");
  if (inspected.status !== "ok") return;
  assert.deepEqual(inspected.sheets, [{ name: "Sheet1", rows: 5 }], "REAL data rows, not the declared grid");

  const res = await extractSheetRows(buf, "Sheet1", X);
  assert.equal(res.status, "ok", "the export must never fail extraction");
  if (res.status !== "ok") return;
  assert.equal(res.rows.length, 5, "identifier-less rows are NOT dropped");
  assert.deepEqual(res.rowNums, [2, 3, 4, 5, 6], "true Excel row numbers");

  const det = detectCatalogColumns(res.headers);
  assert.deepEqual(validateCatalogMapping(det), { ok: true }, "auto-mapping is valid without manual work");
  const fields = det.filter((m) => m.field !== null).map((m) => m.field);
  assert.deepEqual(
    [...fields].sort(),
    ["barcode", "description_ar", "description_en", "name_ar", "name_en", "price", "sku"],
    "the seven (Update) columns and nothing else",
  );
});

test("inflated declared range (A1:R1048576): parsing stays O(data), never O(grid)", async () => {
  const { sheet } = malikasWorkbook();
  sheet["!ref"] = "A1:R1048576"; // what platform exporters write in the dimension record
  const fake = {
    read: () => ({ SheetNames: ["Sheet1"], Sheets: { Sheet1: sheet } }),
    utils: XLSX.utils,
  } as unknown as Parameters<typeof extractSheetRows>[2];

  const t0 = Date.now();
  const res = await extractSheetRows(Buffer.from("PK\x03\x04"), "Sheet1", fake);
  const elapsed = Date.now() - t0;
  assert.equal(res.status, "ok");
  if (res.status !== "ok") return;
  assert.equal(res.rows.length, 5, "all real rows survive an inflated range");
  assert.ok(elapsed < 2000, `sparse extraction must be fast (took ${elapsed}ms; the dense reader took ~14s)`);

  const ins = await inspectWorkbook(Buffer.from("PK\x03\x04"), fake);
  assert.equal(ins.status, "ok");
  if (ins.status !== "ok") return;
  assert.equal(ins.sheets[0].rows, 5, "the row count shown to the user is the REAL count");
});

test("wizard: file summary step, explicit analyze button, Malikas loading text, and no-silence failure codes", () => {
  for (const required of [
    "تحليل ملف Excel",
    "جاري قراءة ملف Malikas...",
    "تم اختيار",
    "ملخص الملف",
    "تغيير الملف",
    'e.target.value = ""', // same-file re-pick after a failure must work
    "IMPORT-UI-01",
    "IMPORT-UI-02",
    "IMPORT-UI-03",
    "IMPORT-UI-04",
    "IMPORT-UI-05",
  ]) {
    assert.ok(WIZARD_SRC.includes(required), `wizard must contain ${required}`);
  }
});

test("actions: every action has a fixed-Arabic safety net with an internal code — no raw errors, no silence", () => {
  const MESSAGES_SRC = readFileSync(new URL("./messages.ts", import.meta.url), "utf8");
  for (const code of ["IMPORT-SRV-01", "IMPORT-SRV-02", "IMPORT-SRV-03"]) {
    assert.ok(MESSAGES_SRC.includes(code), `messages must carry ${code}`);
  }
  for (const used of ["unexpected_inspect", "unexpected_preview", "unexpected_apply"]) {
    assert.ok(ACTIONS_SRC.includes(`IMPORT_MESSAGES.${used}`), `actions must use ${used}`);
  }
  assert.ok(ACTIONS_SRC.includes("too_many_columns"), "column cap surfaces as a fixed message");
});

// ── "use server" module-loading regression ──────────────────────────────────
// Next.js refuses to evaluate a "use server" module whose runtime exports are
// not exclusively async functions. Exporting IMPORT_MESSAGES (a plain object)
// from the import actions file made EVERY action POST return 500 before any
// code ran ("A \"use server\" file can only export async functions, found
// object.") — the UI could only show IMPORT-UI-01. These checks fail the
// build-time tests if anyone reintroduces a non-async runtime export.

/** Every runtime export must be an async function; types/interfaces are fine. */
function assertOnlyAsyncFunctionExports(src: string, name: string): void {
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!/^export\s/.test(line)) continue;
    const ok =
      /^export async function\s/.test(line) ||
      /^export (type|interface)\s/.test(line);
    assert.ok(
      ok,
      `${name}:${i + 1} — a "use server" file may only export async functions ` +
        `(types/interfaces are erased). Offending line: ${line.trim()}`,
    );
  }
}

test('"use server" files export ONLY async functions — module evaluation can never 500 again', () => {
  const files: [string, string][] = [
    ["app/(v2)/v2/catalog/import/actions.ts", ACTIONS_SRC],
    [
      "app/(v2)/v2/catalog/new/actions.ts",
      readFileSync(new URL("../../../app/(v2)/v2/catalog/new/actions.ts", import.meta.url), "utf8"),
    ],
    [
      "app/(v2)/v2/catalog/[id]/edit/actions.ts",
      readFileSync(new URL("../../../app/(v2)/v2/catalog/[id]/edit/actions.ts", import.meta.url), "utf8"),
    ],
  ];
  for (const [name, src] of files) {
    assert.ok(src.startsWith('"use server"'), `${name} must be a server-actions file`);
    assertOnlyAsyncFunctionExports(src, name);
  }
  // the sentinel that caused the production outage must never come back
  assert.ok(!ACTIONS_SRC.includes("export const IMPORT_MESSAGES"), "IMPORT_MESSAGES must live outside the use-server file");
  // and the guard itself must catch the original offending shape
  assert.throws(() => assertOnlyAsyncFunctionExports('"use server";\nexport const SOMETHING = {};\n', "self-check"));
});
