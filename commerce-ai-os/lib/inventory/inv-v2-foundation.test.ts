import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { INVENTORY_HUB_LINKS } from "./hub.ts";
import { canonicalRedirectTarget, legacyMigrationStatus, legacyRedirectPath } from "../v2/legacy-redirect.ts";

const ROOT = process.cwd();
const read = (path: string) => readFileSync(`${ROOT}/${path}`, "utf8");

test("Inventory Hub exposes every current inventory workflow without inventing destinations", () => {
  assert.deepEqual(INVENTORY_HUB_LINKS.map((item) => item.href), [
    "/v2/inventory", "/inventory/shelves", "/inventory/stocktake", "/inventory/movements",
    "/inventory/out-of-stock", "/inventory/reports", "/inventory/labels",
    "/inventory/shelves/labels", "/inventory/approvals",
  ]);
  assert.ok(INVENTORY_HUB_LINKS.every((item) => item.status === "REUSE"));
});

test("legacy inventory stays reachable and can never fall back to catalog", () => {
  for (const item of INVENTORY_HUB_LINKS.filter((item) => item.href.startsWith("/inventory"))) {
    assert.equal(legacyMigrationStatus(item.href), "NEEDS_MIGRATION");
    assert.equal(legacyRedirectPath(item.href), null);
    assert.equal(canonicalRedirectTarget(item.href), null);
  }
});

test("V2 quantities reuses the certified legacy surface instead of copying data or writers", () => {
  const page = read("app/(v2)/v2/inventory/page.tsx");
  assert.match(page, /LegacyInventoryPage/);
  for (const banned of ["createClient", "createAdminClient", "stock_quantity", ".rpc(", ".from("]) {
    assert.equal(page.includes(banned), false, `V2 surface must not duplicate ${banned}`);
  }
});

test("legacy quantities route remains NEEDS_MIGRATION and never redirects to catalog", () => {
  assert.equal(legacyMigrationStatus("/inventory"), "NEEDS_MIGRATION");
  assert.equal(legacyRedirectPath("/inventory"), null);
  assert.equal(canonicalRedirectTarget("/inventory"), null);
});

