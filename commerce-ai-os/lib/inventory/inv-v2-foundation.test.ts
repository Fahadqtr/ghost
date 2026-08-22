import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { INVENTORY_HUB_LINKS } from "./hub.ts";
import { canonicalRedirectTarget, legacyMigrationStatus, legacyRedirectPath } from "../v2/legacy-redirect.ts";

const ROOT = process.cwd();
const read = (path: string) => readFileSync(`${ROOT}/${path}`, "utf8");

test("Inventory Hub exposes every current inventory workflow without inventing destinations", () => {
  assert.deepEqual(INVENTORY_HUB_LINKS.map((item) => item.href), [
    "/inventory", "/inventory/shelves", "/inventory/stocktake", "/inventory/movements",
    "/inventory/out-of-stock", "/inventory/reports", "/inventory/labels",
    "/inventory/shelves/labels", "/inventory/approvals",
  ]);
  assert.ok(INVENTORY_HUB_LINKS.every((item) => item.status === "REUSE"));
});

test("legacy inventory stays reachable and can never fall back to catalog", () => {
  for (const item of INVENTORY_HUB_LINKS) {
    assert.equal(legacyMigrationStatus(item.href), "NEEDS_MIGRATION");
    assert.equal(legacyRedirectPath(item.href), null);
    assert.equal(canonicalRedirectTarget(item.href), null);
  }
});

test("foundation is navigation-only and does not import inventory writers", () => {
  const page = read("app/(v2)/v2/inventory/page.tsx");
  for (const banned of ["createClient", "createAdminClient", "actions", "stock_quantity", ".rpc(", ".from("]) {
    assert.equal(page.includes(banned), false, `V2 hub must not contain ${banned}`);
  }
});

