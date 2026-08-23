import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { INVENTORY_HUB_LINKS } from "./hub.ts";
import { canonicalRedirectTarget, legacyMigrationStatus, legacyRedirectPath, movedRoutePath } from "../v2/legacy-redirect.ts";

const ROOT = process.cwd();
const read = (path: string) => readFileSync(`${ROOT}/${path}`, "utf8");

test("Inventory Hub exposes every inventory workflow on CANONICAL /v2 routes only (INV.V2.3)", () => {
  assert.deepEqual(INVENTORY_HUB_LINKS.map((item) => item.href), [
    "/v2/inventory", "/v2/inventory/movements", "/v2/inventory/stocktake", "/v2/inventory/shelves",
    "/v2/inventory/out-of-stock", "/v2/inventory/approvals", "/v2/inventory/reports",
    "/v2/inventory/labels", "/v2/inventory/shelves/labels",
  ]);
  assert.ok(INVENTORY_HUB_LINKS.every((item) => item.status === "REUSE"), "nothing reimplemented — every surface is a reuse wrapper");
  assert.ok(INVENTORY_HUB_LINKS.every((item) => item.href.startsWith("/v2/inventory")), "no legacy /inventory href remains in the hub");
});

test("legacy inventory URLs are RELOCATED to V2 (sub-path preserved) — never funneled to catalog", () => {
  // INV.V2.3: /inventory left NEEDS_MIGRATION and became a moved prefix.
  for (const [legacy, v2] of [
    ["/inventory", "/v2/inventory"],
    ["/inventory/movements", "/v2/inventory/movements"],
    ["/inventory/stocktake", "/v2/inventory/stocktake"],
    ["/inventory/shelves", "/v2/inventory/shelves"],
    ["/inventory/shelves/labels", "/v2/inventory/shelves/labels"],
    ["/inventory/out-of-stock", "/v2/inventory/out-of-stock"],
    ["/inventory/approvals", "/v2/inventory/approvals"],
    ["/inventory/reports", "/v2/inventory/reports"],
    ["/inventory/labels", "/v2/inventory/labels"],
  ] as const) {
    assert.equal(movedRoutePath(legacy), v2, legacy);
    assert.equal(legacyRedirectPath(legacy), null, `${legacy} never falls into the catalog funnel`);
    assert.equal(canonicalRedirectTarget(legacy), null, `${legacy} uses the moved-prefix path (query preserved)`);
    assert.equal(legacyMigrationStatus(legacy), null, `${legacy} is no longer NEEDS_MIGRATION`);
  }
  // a V2 path can never loop back through the moved map
  assert.equal(movedRoutePath("/v2/inventory"), null);
});

test("V2 quantities reuses the certified legacy surface instead of copying data or writers", () => {
  const page = read("app/(v2)/v2/inventory/page.tsx");
  assert.match(page, /LegacyInventoryPage/);
  for (const banned of ["createClient", "createAdminClient", "stock_quantity", ".rpc(", ".from("]) {
    assert.equal(page.includes(banned), false, `V2 surface must not duplicate ${banned}`);
  }
  // INV.V2.3 — the hub page renders the quick links from the ONE hub model.
  assert.match(page, /INVENTORY_HUB_LINKS/);
});
