// CH.3b — writer-allow-list convergence guard (source scan).
//
// Pins the single authorization boundary for service-role CATALOG mutations:
// every listed mutation action must gate on requireMalakWriter(); the read-only
// siblings on the same surfaces must NOT (reads/downloads stay at signed-in).
// A future edit that drops the writer gate — or over-gates a read — fails here.
//
// PURE — source scan only. Run:
// node --conditions=react-server --experimental-strip-types --test lib/security/ch3b-writer-allowlist-guard.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

/** Body of an exported function: from its declaration to the next top-level `export ` (or EOF). */
function fnBody(src: string, name: string): string {
  const start = src.indexOf(`export async function ${name}`);
  assert.ok(start >= 0, `located ${name}`);
  const after = src.indexOf("\nexport ", start + 1);
  return src.slice(start, after < 0 ? src.length : after);
}

// file → service-role catalog MUTATIONS that must require the writer allow-list.
const WRITER_REQUIRED: Record<string, string[]> = {
  "app/(app)/import-export/snoonu-actions.ts": ["applySnoonuUpdates", "addSnoonuNewProducts"],
  "app/(app)/import-export/pure-seoul-actions.ts": ["setPureSeoulIds", "addPureSeoulNewProducts"],
  "app/(app)/import-export/talabat-actions.ts": ["markTalabatSent", "verifyCatalogEntries"],
  "app/(app)/import-export/shopify-actions.ts": [
    "applyShopifyPrices", "applyShopifyContent", "syncShopifyInventory",
    "pushProductsToShopify", "importShopifyProducts", "pushShopifyImages",
  ],
  "app/(v2)/v2/catalog/new/actions.ts": ["createAiProduct"],
  "app/(v2)/v2/catalog/[id]/edit/actions.ts": ["saveProductEdit"],
  "app/(v2)/v2/catalog/import/actions.ts": ["applyCatalogUpdates", "applyCatalogCreates"],
  "app/(v2)/v2/catalog/media-actions.ts": [
    "uploadProductMedia", "removeProductMedia", "setPrimaryProductMedia", "reorderProductMedia",
  ],
  "app/(app)/products/image-actions.ts": ["uploadProductImage", "applyCatalogImageBySku", "removeProductImage"],
  // NOTE: archive/restore were hardened to OWNER-only in OPS.8C (stricter than the
  // writer allow-list) — their owner gate is asserted in the OPS.8C lifecycle guard.
};

// file → read-only siblings that must STAY open (signed-in), never writer-gated.
const READ_ONLY_OPEN: Record<string, string[]> = {
  "app/(app)/import-export/snoonu-actions.ts": ["snoonuFillCodes", "computeSnoonuDiff"],
  "app/(app)/import-export/shopify-actions.ts": ["computeShopifyDiff", "listShopifyMissingImages"],
  "app/(app)/import-export/talabat-actions.ts": ["listTalabatQueue", "computeTalabatDiff", "buildTalabatPackage"],
  "app/(v2)/v2/catalog/import/actions.ts": ["inspectCatalogImport", "readSheetHeaders", "previewCatalogImport"],
  "app/(app)/products/archive/actions.ts": ["matchProductsForArchive", "listArchive"],
};

for (const [file, fns] of Object.entries(WRITER_REQUIRED)) {
  test(`${file}: every service-role catalog mutation requires the writer allow-list`, () => {
    const src = read(file);
    assert.ok(/requireMalakWriter/.test(src), `${file} imports/uses requireMalakWriter`);
    for (const fn of fns) {
      assert.ok(/requireMalakWriter\s*\(/.test(fnBody(src, fn)), `${fn} must gate on requireMalakWriter()`);
    }
  });
}

for (const [file, fns] of Object.entries(READ_ONLY_OPEN)) {
  test(`${file}: read-only siblings stay open (not writer-gated)`, () => {
    const src = read(file);
    for (const fn of fns) {
      assert.equal(/requireMalakWriter\s*\(/.test(fnBody(src, fn)), false, `${fn} is read-only and must NOT require the writer allow-list`);
    }
  });
}

test("Talabat package route: mapping persistence requires the writer allow-list", () => {
  // INT.2F.2 — the legacy CSV route is fully retired (410); channel_variant_mappings
  // persistence is re-homed to the certified package route, which enforces the
  // writer gate BEFORE triggering the catalog mapping sync.
  const src = read("app/api/export/talabat/package/route.ts");
  assert.ok(/requireMalakWriter/.test(src), "package route imports requireMalakWriter");
  const gateIdx = src.indexOf("requireMalakWriter(");
  const syncIdx = src.indexOf("syncTalabatMappingsFromCatalog(");
  assert.ok(gateIdx > -1 && syncIdx > -1, "route gates and triggers mapping persistence");
  assert.ok(gateIdx < syncIdx, "the writer gate runs before mappings are persisted");
});
