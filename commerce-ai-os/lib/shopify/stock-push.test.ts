// Tests for the unified Shopify inventory stock push. The decision core
// (syncStockBySku) is exercised with MOCKED deps only — no network, no real
// Shopify. Wiring is checked by scanning the inventory action + central client
// sources (they import `server-only`, so node:test can't import them directly).
// Run: node --conditions=react-server --experimental-strip-types --test lib/shopify/stock-push.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  syncStockBySku,
  summarizeStockSync,
  type ShopifyStockPushDeps,
} from "./stock-push.ts";

// ---- mock deps + call tracking ----------------------------------------------

interface Calls {
  configured: number;
  resolveLocationId: number;
  resolveInventoryItemId: string[]; // SKUs asked
  setQuantity: { locationId: string; inventoryItemId: string; quantity: number }[];
}

function mkDeps(over: {
  configured?: boolean;
  location?: { locationId?: string; error?: string };
  resolve?: (sku: string) => { inventoryItemId?: string; error?: string };
  set?: (inventoryItemId: string) => { ok: boolean; error?: string };
}): { deps: ShopifyStockPushDeps; calls: Calls } {
  const calls: Calls = { configured: 0, resolveLocationId: 0, resolveInventoryItemId: [], setQuantity: [] };
  const deps: ShopifyStockPushDeps = {
    configured: () => { calls.configured++; return over.configured ?? true; },
    resolveLocationId: async () => { calls.resolveLocationId++; return over.location ?? { locationId: "gid://shopify/Location/1" }; },
    resolveInventoryItemId: async (sku: string) => {
      calls.resolveInventoryItemId.push(sku);
      return over.resolve ? over.resolve(sku) : { inventoryItemId: `gid://shopify/InventoryItem/${sku}` };
    },
    setQuantity: async (locationId: string, inventoryItemId: string, quantity: number) => {
      calls.setQuantity.push({ locationId, inventoryItemId, quantity });
      return over.set ? over.set(inventoryItemId) : { ok: true };
    },
  };
  return { deps, calls };
}

// ---- 4. missing credentials → not_configured, NO external call --------------

test("not configured → not_configured and NO external call is attempted", async () => {
  const { deps, calls } = mkDeps({ configured: false });
  const r = await syncStockBySku([{ sku: "A", quantity: 0 }], deps);
  assert.deepEqual(r, { configured: false, attempted: 0, pushed: 0, failed: 0, missing: 0, reason: "not_configured", perItem: [] });
  assert.equal(calls.resolveLocationId, 0, "must not resolve a location");
  assert.equal(calls.resolveInventoryItemId.length, 0, "must not resolve any item");
  assert.equal(calls.setQuantity.length, 0, "must not set any quantity");
});

// ---- 5. missing location → missing_location ---------------------------------

test("no active location → missing_location, no item work", async () => {
  const { deps, calls } = mkDeps({ location: { error: "no locations" } });
  const r = await syncStockBySku([{ sku: "A", quantity: 0 }], deps);
  assert.equal(r.configured, true);
  assert.equal(r.reason, "missing_location");
  assert.equal(r.attempted, 0);
  assert.equal(calls.resolveInventoryItemId.length, 0);
  assert.equal(calls.setQuantity.length, 0);
});

test("location resolves but has empty id → missing_location", async () => {
  const { deps } = mkDeps({ location: { locationId: "" } });
  const r = await syncStockBySku([{ sku: "A", quantity: 0 }], deps);
  assert.equal(r.reason, "missing_location");
});

// ---- 6. missing inventory item → missing_inventory_item ----------------------

test("SKU with no Shopify inventory item → missing_inventory_item, not pushed", async () => {
  const { deps, calls } = mkDeps({ resolve: () => ({ inventoryItemId: "" }) });
  const r = await syncStockBySku([{ sku: "GHOST", quantity: 0 }], deps);
  assert.equal(r.missing, 1);
  assert.equal(r.pushed, 0);
  assert.deepEqual(r.perItem[0].result, { synced: false, reason: "missing_inventory_item" });
  assert.equal(calls.setQuantity.length, 0, "no set when the item is unknown");
});

// ---- 7. Shopify error → shopify_error ---------------------------------------

test("resolve error (e.g. non-2xx / GraphQL error) → shopify_error", async () => {
  const { deps, calls } = mkDeps({ resolve: () => ({ error: "Shopify HTTP 500" }) });
  const r = await syncStockBySku([{ sku: "A", quantity: 0 }], deps);
  assert.equal(r.failed, 1);
  assert.equal(r.pushed, 0);
  assert.deepEqual(r.perItem[0].result, { synced: false, reason: "shopify_error" });
  assert.equal(calls.setQuantity.length, 0);
});

test("setQuantity failure (userErrors / HTTP error) → shopify_error", async () => {
  const { deps } = mkDeps({ set: () => ({ ok: false, error: "userError" }) });
  const r = await syncStockBySku([{ sku: "A", quantity: 0 }], deps);
  assert.equal(r.failed, 1);
  assert.equal(r.pushed, 0);
  assert.deepEqual(r.perItem[0].result, { synced: false, reason: "shopify_error" });
});

// ---- 2 + 8. OAuth/configured happy path → synced:true -----------------------

test("configured + resolves + sets → synced:true with correct location/item/qty", async () => {
  const { deps, calls } = mkDeps({});
  const r = await syncStockBySku([{ sku: "SKU1", quantity: 3 }], deps);
  assert.equal(r.configured, true);
  assert.equal(r.pushed, 1);
  assert.equal(r.failed, 0);
  assert.equal(r.missing, 0);
  assert.deepEqual(r.perItem[0].result, { synced: true });
  assert.deepEqual(calls.setQuantity, [
    { locationId: "gid://shopify/Location/1", inventoryItemId: "gid://shopify/InventoryItem/SKU1", quantity: 3 },
  ]);
});

// ---- 9. no silent success: every synced:true had a real setQuantity call -----

test("mixed batch: each synced:true corresponds to a setQuantity call; failures don't", async () => {
  const { deps, calls } = mkDeps({
    resolve: (sku) => (sku === "MISS" ? { inventoryItemId: "" } : { inventoryItemId: `ii-${sku}` }),
    set: (id) => ({ ok: id !== "ii-BAD" }),
  });
  const r = await syncStockBySku(
    [{ sku: "OK", quantity: 1 }, { sku: "MISS", quantity: 0 }, { sku: "BAD", quantity: 2 }],
    deps,
  );
  assert.equal(r.pushed, 1);
  assert.equal(r.missing, 1);
  assert.equal(r.failed, 1);
  // Exactly one synced:true, and setQuantity was called once per RESOLVED item (OK, BAD) — never for MISS.
  const syncedCount = r.perItem.filter((p) => p.result.synced).length;
  assert.equal(syncedCount, 1);
  assert.equal(calls.setQuantity.length, 2, "set attempted only for resolved items");
  assert.ok(!calls.setQuantity.some((c) => c.inventoryItemId === ""), "never set an empty item id");
});

test("summarizeStockSync: synced only when connected, attempted>0, and nothing failed/missing", () => {
  assert.deepEqual(
    summarizeStockSync({ configured: true, attempted: 2, pushed: 2, failed: 0, missing: 0, perItem: [] }),
    { configured: true, synced: true, pushed: 2, failed: 0, missing: 0 },
  );
  // any failure ⇒ not synced
  assert.equal(summarizeStockSync({ configured: true, attempted: 2, pushed: 1, failed: 1, missing: 0, perItem: [] }).synced, false);
  // any missing ⇒ not synced
  assert.equal(summarizeStockSync({ configured: true, attempted: 1, pushed: 0, failed: 0, missing: 1, perItem: [] }).synced, false);
  // not configured ⇒ not synced, carries reason
  assert.deepEqual(
    summarizeStockSync({ configured: false, attempted: 0, pushed: 0, failed: 0, missing: 0, reason: "not_configured", perItem: [] }),
    { configured: false, synced: false, pushed: 0, failed: 0, missing: 0, reason: "not_configured" },
  );
  // missing_location ⇒ not synced, carries reason
  assert.equal(summarizeStockSync({ configured: true, attempted: 0, pushed: 0, failed: 0, missing: 0, reason: "missing_location", perItem: [] }).synced, false);
  // nothing attempted (empty batch) ⇒ not synced
  assert.equal(summarizeStockSync({ configured: true, attempted: 0, pushed: 0, failed: 0, missing: 0, perItem: [] }).synced, false);
});

// ---- 11. the core never logs tokens / Authorization headers ------------------

test("the stock-push core logs nothing and references no token/header/URL", () => {
  const src = readSource("lib/shopify/stock-push.ts");
  assert.doesNotMatch(src, /console\./, "pure core must not log");
  for (const secret of ["Authorization", "X-Shopify-Access-Token", "access_token", "Bearer", "admin/api/"]) {
    assert.equal(src.includes(secret), false, `core must not reference ${secret}`);
  }
});

// ---- source-scan wiring (1, 3, 10, 12) --------------------------------------

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
function readSource(rel: string): string { return readFileSync(path.join(ROOT, rel), "utf8"); }

const INVENTORY = readSource("app/(app)/inventory/actions.ts");
const ADMIN = readSource("lib/shopify/admin.ts");

test("1: inventory uses the central helper, not a legacy direct fetch/env", () => {
  assert.match(INVENTORY, /pushInventoryStockToShopify/, "must call the central push helper");
  assert.match(INVENTORY, /from "@\/lib\/shopify\/admin"/, "must import from the central client");
  // No second Shopify client inside inventory: no raw admin endpoint, no legacy envs.
  assert.doesNotMatch(INVENTORY, /admin\/api\//, "no hand-rolled Shopify endpoint in inventory");
  assert.doesNotMatch(INVENTORY, /X-Shopify-Access-Token/, "no hand-rolled Shopify auth header in inventory");
  for (const legacy of ["SHOPIFY_SHOP", "SHOPIFY_LOCATION_ID", "SHOPIFY_API_VERSION"]) {
    assert.equal(INVENTORY.includes(legacy), false, `legacy env ${legacy} must be gone from inventory`);
  }
  // No hardcoded location id anywhere in inventory.
  assert.doesNotMatch(INVENTORY, /gid:\/\/shopify\/Location\//, "no hardcoded location id");
});

test("3: legacy env fallback survives ONLY in the central credential resolver", () => {
  // The central client keeps the SHOPIFY_ADMIN_TOKEN custom-app fallback...
  assert.match(ADMIN, /SHOPIFY_ADMIN_TOKEN/);
  // ...and inventory reads NO Shopify credential directly.
  assert.doesNotMatch(INVENTORY, /SHOPIFY_ADMIN_TOKEN/, "inventory must not read the token directly");
  assert.doesNotMatch(INVENTORY, /process\.env\.SHOPIFY/, "inventory must not read any SHOPIFY_* env");
});

test("central client exposes the unified helpers and one API version", () => {
  assert.match(ADMIN, /export async function pushInventoryStockToShopify/);
  assert.match(ADMIN, /export async function resolveInventoryItemIdBySku/);
  // Single API version constant (declared once).
  const versions = ADMIN.match(/API_VERSION = "/g) ?? [];
  assert.equal(versions.length, 1, "exactly one API_VERSION source of truth");
});

test("10 + 12: out-of-stock paths write local stock first, then best-effort central push", () => {
  for (const fn of ["markOutOfStockByNames", "matchChannelsToMalika"]) {
    const at = INVENTORY.indexOf(`export async function ${fn}`);
    assert.notEqual(at, -1, `${fn} exists`);
    const body = INVENTORY.slice(at, INVENTORY.indexOf("\nexport ", at + 1) === -1 ? undefined : INVENTORY.indexOf("\nexport ", at + 1));
    const push = body.indexOf("pushStockToShopify");
    assert.notEqual(push, -1, `${fn} must sync via the central pushStockToShopify`);
    // The local DB write (channel/stock update) precedes the Shopify push — the
    // external sync is best-effort and never gates the local change.
    const localWrite = Math.min(
      ...[".update(", "channel_status", "stock_quantity"].map((k) => { const i = body.indexOf(k); return i === -1 ? Number.MAX_SAFE_INTEGER : i; }),
    );
    assert.ok(localWrite < push, `${fn}: local stock/channel write must come before the Shopify push`);
  }
});
