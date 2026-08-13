// UX.4E-9B — legacy v1 product import path retired: source scans.
// PURE tests only — no database, no network, no rendering.
//
// /v2/catalog/import is the ONLY product import flow. The dead v1 runtime
// (components/ExcelImport.tsx + the legacy importProducts server action) is
// deleted; these guards keep it deleted and prove every remaining import
// entry point resolves to the V2 importer, with the V2 import code untouched.
//
// Run: node --conditions=react-server --experimental-strip-types --test "app/(app)/import-export/legacy-import-retired.test.ts"

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

// ── The dead v1 files stay deleted ───────────────────────────────────────────

test("components/ExcelImport.tsx no longer exists", () => {
  assert.equal(existsSync(join(ROOT, "components/ExcelImport.tsx")), false);
});

test("legacy import-export/actions.ts (importProducts) no longer exists", () => {
  assert.equal(existsSync(join(ROOT, "app/(app)/import-export/actions.ts")), false);
});

// ── No active source references the legacy importer ─────────────────────────
//
// Scan every non-test .ts/.tsx under app/, components/, lib/. Test files are
// excluded because the guards themselves must name the forbidden symbols.

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      sourceFiles(p, out);
    } else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) {
      out.push(p);
    }
  }
  return out;
}

const SOURCES = ["app", "components", "lib"].flatMap((d) => sourceFiles(join(ROOT, d)));

test("no active source imports the legacy importer module", () => {
  for (const f of SOURCES) {
    const src = readFileSync(f, "utf8");
    assert.equal(src.includes("components/ExcelImport"), false, `${f} references components/ExcelImport`);
    assert.equal(src.includes('app/(app)/import-export/actions"'), false, `${f} imports the deleted legacy actions module`);
  }
});

test("the legacy ExcelImport component and importProducts action are referenced nowhere", () => {
  for (const f of SOURCES) {
    // "CatalogExcelImport" (the V2 wizard) legitimately contains "ExcelImport"
    // as a substring — strip it before checking for the legacy name.
    const src = readFileSync(f, "utf8").replaceAll("CatalogExcelImport", "");
    assert.equal(src.includes("ExcelImport"), false, `${f} references the legacy ExcelImport component`);
    assert.equal(src.includes("importProducts"), false, `${f} references the legacy importProducts action`);
  }
});

// ── Every import entry point resolves to /v2/catalog/import ─────────────────

test("the import-export hub's import card points at /v2/catalog/import", () => {
  const hub = read("app/(app)/import-export/page.tsx");
  assert.ok(hub.includes('"/v2/catalog/import"'), "hub links the V2 importer");
  assert.equal(hub.includes("ExcelImport"), false, "hub renders no legacy importer");
});

test("the V2 catalog's import button points at /v2/catalog/import", () => {
  const catalog = read("components/v2/catalog/MasterCatalog.tsx");
  assert.ok(catalog.includes('"/v2/catalog/import"'), "MasterCatalog links the V2 importer");
});

test("the sidebar import entry goes to the hub (which resolves to V2) — no direct legacy importer route", () => {
  const constants = read("lib/constants.ts");
  assert.ok(constants.includes('"/import-export"'), "nav keeps the hub entry");
  assert.equal(constants.includes("ExcelImport"), false);
});

test("no legacy import UI can render at runtime (no page imports a legacy importer)", () => {
  const pages = SOURCES.filter((f) => /[\\/]page\.tsx$/.test(f));
  assert.ok(pages.length > 0, "page scan found route pages");
  for (const p of pages) {
    const src = readFileSync(p, "utf8").replaceAll("CatalogExcelImport", "");
    assert.equal(src.includes("ExcelImport"), false, `${p} renders the legacy importer`);
  }
});

// ── V2 import flow is intact (this PR deletes, it does not touch V2) ─────────

test("V2 import route + wizard + pure cores all still exist", () => {
  for (const rel of [
    "app/(v2)/v2/catalog/import/page.tsx",
    "app/(v2)/v2/catalog/import/actions.ts",
    "app/(v2)/v2/catalog/import/loading.tsx",
    "components/v2/catalog/CatalogExcelImport.tsx",
    "lib/products/excel-import/core.ts",
    "lib/products/excel-import/parse.ts",
    "lib/products/excel-import/report.ts",
    "lib/products/excel-import/messages.ts",
  ]) {
    assert.ok(existsSync(join(ROOT, rel)), `${rel} exists`);
  }
});

test("V2 import page renders the V2 wizard and the V2 actions keep their API", () => {
  const page = read("app/(v2)/v2/catalog/import/page.tsx");
  assert.ok(page.includes("CatalogExcelImport"));
  const actions = read("app/(v2)/v2/catalog/import/actions.ts");
  for (const fn of ["inspectCatalogImport", "readSheetHeaders", "previewCatalogImport", "applyCatalogUpdates"]) {
    assert.ok(actions.includes(`export async function ${fn}`), `V2 action ${fn} untouched`);
  }
});
