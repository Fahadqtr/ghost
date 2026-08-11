// UX.3A — Import/Export hub cleanup: source scans.
// PURE tests only — no database, no network, no rendering.
//
// Run: node --conditions=react-server --experimental-strip-types --test "app/(app)/import-export/hub-cleanup.test.ts"

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

const HUB = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");
const IMAGES = readFileSync(new URL("./images/page.tsx", import.meta.url), "utf8");
const EXPORTS = readFileSync(new URL("./export/page.tsx", import.meta.url), "utf8");

const HEAVY = ["ExcelImport", "ImageHealth", "ImageUpload", "CatalogImageBySku", "ExportButtons", "TalabatExport"];

// ── Hub is now a light landing page ─────────────────────────────────────────

test("hub renders NO heavy component (import or JSX)", () => {
  for (const c of HEAVY) {
    assert.equal(HUB.includes(c), false, `hub must not reference ${c}`);
  }
});

test("hub runs NO product data reads on load (queries moved to sub-routes)", () => {
  for (const bad of ["limit(1000)", "main_category", "image_filename", "Imported from Snoonu sync", "count: \"exact\""]) {
    assert.equal(HUB.includes(bad), false, `hub must not run the on-load query fragment: ${bad}`);
  }
  // The hub only reads the locale (no supabase product access).
  assert.equal(/\.from\(\s*["']products["']\s*\)/.test(HUB), false, "hub does not query products");
});

test("hub ships no client bundle of its own", () => {
  assert.equal(HUB.includes('"use client"'), false);
  assert.equal(HUB.includes("xlsx"), false, "no XLSX on the hub");
});

test("hub links to every tool (existing URLs unchanged) + the new sub-routes", () => {
  const links = [
    "/v2/catalog/import", // new importer (replaces legacy Excel Import card)
    "/import-export/availability",
    "/import-export/shopify-sync",
    "/import-export/talabat-sync",
    "/import-export/pure-seoul",
    "/import-export/snoonu-sync",
    "/import-export/images", // new
    "/import-export/export", // new
    "/import-export/talabat-orders",
  ];
  for (const href of links) {
    assert.ok(HUB.includes(`"${href}"`), `hub links ${href}`);
  }
});

// ── New wrapper pages render the SAME components (logic not moved) ───────────

test("images workspace renders the three image components unchanged", () => {
  for (const c of ["ImageHealth", "ImageUpload", "CatalogImageBySku"]) {
    assert.ok(IMAGES.includes(`<${c}`), `images page renders <${c}>`);
    assert.ok(IMAGES.includes(`components/${c}`), `images page imports ${c} from its existing module`);
  }
  // the product-list read moved here (not the hub).
  assert.ok(IMAGES.includes("limit(1000)"), "product-list read now lives on the images page");
});

test("exports workspace renders the export components unchanged", () => {
  for (const c of ["ExportButtons", "TalabatExport"]) {
    assert.ok(EXPORTS.includes(`<${c}`), `exports page renders <${c}>`);
    assert.ok(EXPORTS.includes(`components/${c}`), `exports page imports ${c} from its existing module`);
  }
  // the category scan + counts moved here (not the hub).
  assert.ok(EXPORTS.includes("main_category"), "category scan now lives on the exports page");
  assert.ok(EXPORTS.includes("image_filename"), "image count now lives on the exports page");
  assert.ok(EXPORTS.includes("Imported from Snoonu sync"), "new-products count now lives on the exports page");
});

// ── Nothing deleted / no broken routes ──────────────────────────────────────

test("legacy Excel Import component is NOT deleted (only removed from the hub)", () => {
  assert.ok(existsSync(new URL("../../../components/ExcelImport.tsx", import.meta.url)), "ExcelImport.tsx still exists");
});

test("every heavy component file still exists", () => {
  for (const c of HEAVY) {
    assert.ok(existsSync(new URL(`../../../components/${c}.tsx`, import.meta.url)), `${c}.tsx still exists`);
  }
});

test("every route the hub links to resolves to a real page (no broken links)", () => {
  const routePages = [
    "./availability/page.tsx",
    "./shopify-sync/page.tsx",
    "./talabat-sync/page.tsx",
    "./pure-seoul/page.tsx",
    "./snoonu-sync/page.tsx",
    "./talabat-orders/page.tsx",
    "./images/page.tsx",
    "./export/page.tsx",
  ];
  for (const p of routePages) {
    assert.ok(existsSync(new URL(p, import.meta.url)), `${p} exists`);
  }
  // the V2 importer target exists too.
  assert.ok(existsSync(new URL("../../(v2)/v2/catalog/import/page.tsx", import.meta.url)), "/v2/catalog/import exists");
});
