// INT.2F — lib/exporters.ts is now CERTIFIED TEMPLATE DATA only. The legacy
// per-channel CSV/AoA builders + their legacy-identity ExportProduct shape were
// removed (the Export Center is the sole export platform). These tests pin the
// retained templates and prove the legacy builders/identity are gone.
// Run: node --conditions=react-server --experimental-strip-types --test lib/exporters.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import * as exporters from "./exporters.ts";
import { SNOONU_HEADERS, RAFEEQ_HEADERS, RAFEEQ_CATEGORIES, RAFEEQ_COL_WIDTHS } from "./exporters.ts";

test("retained certified templates have the expected shape", () => {
  assert.equal(SNOONU_HEADERS[0], "Snoonu ID");
  assert.equal(SNOONU_HEADERS.length, 16);
  assert.deepEqual(RAFEEQ_HEADERS, [
    "CATEGORY - ENGLISH", "CATEGORY - ARABIC",
    "PRODUCT NAME - ENGLISH", "PRODUCT NAME - ARABIC", "PRICE",
    "DESCRIPTION - ENGLISH", "DESCRIPTION - ARABIC", "IMAGE NAME", "BARCODE", "RAFEEQ ID",
  ]);
  assert.equal(RAFEEQ_COL_WIDTHS.length, RAFEEQ_HEADERS.length);
  assert.equal(RAFEEQ_CATEGORIES["Masks"].ar, "الأقنعة");
});

test("legacy per-channel builders and legacy-identity shape are removed (INT.2F)", () => {
  for (const gone of ["buildShopifyCsv", "buildSnoonuCsv", "buildRafeeqAoa", "buildRafeeqCsv", "toCsv", "CHANNEL_KEYS", "CHANNEL_NAME", "SHOPIFY_HEADERS"]) {
    assert.equal((exporters as Record<string, unknown>)[gone], undefined, `${gone} must be removed`);
  }
  // no legacy identity columns anywhere in the module source
  const src = readFileSync(fileURLToPath(new URL("./exporters.ts", import.meta.url)), "utf8");
  assert.equal(/snoonu_id|rafeeq_product_id|pure_seoul_id/.test(src), false, "no legacy identity columns");
  assert.equal(/buildShopifyCsv|buildSnoonuCsv|buildRafeeqAoa|toCsv\(/.test(src), false, "no legacy builders");
});
