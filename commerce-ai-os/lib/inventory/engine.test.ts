// INV.3D — Inventory Engine facade tests. DB-free (injected fake clients).
// Run: node --conditions=react-server --experimental-strip-types --test lib/inventory/engine.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  adjustVariant, setVariantAbsolute, adjustVariantMovement, setAbsolute,
  placeOnShelf, removeShelf, replaceShelfDistribution, assignFullShelf, moveShelf, reconcile,
  adjust, sell, receive, reverseMovement,
  InventoryEngineNotImplementedError, NOT_IMPLEMENTED_OPS,
} from "./engine.ts";

// A fake whose rpc returns a configured {data,error}. Its `from` THROWS — so any
// direct-table fallback would blow up the test instead of silently succeeding.
function rpcClient(result: { data?: unknown; error?: unknown }) {
  const calls: { name: string; params: unknown }[] = [];
  return {
    calls,
    rpc(name: string, params: unknown) { calls.push({ name, params }); return Promise.resolve(result); },
    from() { throw new Error("DIRECT_WRITE_FORBIDDEN: engine must call an RPC, never a table write"); },
  };
}
const applied = (extra: Record<string, unknown>) => ({ data: { status: "applied", ...extra }, error: null });

// ── supported wrappers call the right RPC with the right params ────────────────

test("adjustVariant calls inv_adjust_variant with mapped params", async () => {
  const c = rpcClient(applied({ before: 4, after: 7, parentStock: 12 }));
  const r = await adjustVariant(c, "v1", 3);
  assert.equal(r.ok, true);
  assert.deepEqual(c.calls, [{ name: "inv_adjust_variant", params: { p_variant_id: "v1", p_delta: 3 } }]);
  if (r.ok) assert.equal(r.data.after, 7);
});

test("setVariantAbsolute calls inv_set_variant_absolute with mapped params", async () => {
  const c = rpcClient(applied({ before: 2, after: 6, parentStock: 6 }));
  const r = await setVariantAbsolute(c, "v1", 6);
  assert.equal(r.ok, true);
  assert.deepEqual(c.calls, [{ name: "inv_set_variant_absolute", params: { p_variant_id: "v1", p_quantity: 6 } }]);
});

test("setVariantAbsolute derives parentBefore = parentStock − (after − before)", async () => {
  // parent AFTER 6, this variant went 2 → 5 (+3) ⇒ parent BEFORE = 6 − 3 = 3.
  const c = rpcClient(applied({ before: 2, after: 5, parentStock: 6 }));
  const r = await setVariantAbsolute(c, "v1", 5);
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.data.parentBefore, 3);
  // a decrease: variant 9 → 4 (−5), parent AFTER 10 ⇒ parent BEFORE = 15.
  const d = rpcClient(applied({ before: 9, after: 4, parentStock: 10 }));
  const r2 = await setVariantAbsolute(d, "v1", 4);
  if (r2.ok) assert.equal(r2.data.parentBefore, 15);
});

// ── adjustVariantMovement (INV.4B) — atomic variant stock + rollup + sold ──────

const movementApplied = (extra: Record<string, unknown>) => applied({
  variantId: "v1", productId: "p1", before: 5, after: 3,
  parentBefore: 12, parentStock: 10, soldBefore: 0, soldAfter: 0, ...extra,
});

test("adjustVariantMovement calls inv_adjust_variant_movement with mapped params (IN)", async () => {
  const c = rpcClient(movementApplied({ before: 5, after: 8, parentBefore: 10, parentStock: 13 }));
  const r = await adjustVariantMovement(c, { variantId: "v1", delta: 3, soldDelta: 0 });
  assert.equal(r.ok, true);
  assert.deepEqual(c.calls, [{ name: "inv_adjust_variant_movement", params: { p_variant_id: "v1", p_delta: 3, p_sold_delta: 0 } }]);
  if (r.ok) { assert.equal(r.data.after, 8); assert.equal(r.data.parentBefore, 10); assert.equal(r.data.parentStock, 13); }
});

test("adjustVariantMovement (OUT valid) maps a negative delta", async () => {
  const c = rpcClient(movementApplied({}));
  const r = await adjustVariantMovement(c, { variantId: "v1", delta: -2, soldDelta: 0 });
  assert.equal(r.ok, true);
  assert.deepEqual(c.calls[0].params, { p_variant_id: "v1", p_delta: -2, p_sold_delta: 0 });
});

test("adjustVariantMovement (sale OUT) forwards the sold delta", async () => {
  const c = rpcClient(movementApplied({ soldBefore: 4, soldAfter: 6 }));
  const r = await adjustVariantMovement(c, { variantId: "v1", delta: -2, soldDelta: 2 });
  assert.equal(r.ok, true);
  assert.deepEqual(c.calls[0].params, { p_variant_id: "v1", p_delta: -2, p_sold_delta: 2 });
  if (r.ok) { assert.equal(r.data.soldBefore, 4); assert.equal(r.data.soldAfter, 6); }
});

test("adjustVariantMovement arg validation rejects before any RPC call (no fallback)", async () => {
  const bad: Array<{ variantId: string; delta: number; soldDelta: number }> = [
    { variantId: "", delta: -1, soldDelta: 0 },     // missing variant
    { variantId: "v", delta: 0, soldDelta: 0 },      // zero delta
    { variantId: "v", delta: 1.5, soldDelta: 0 },    // non-integer delta
    { variantId: "v", delta: -1, soldDelta: -1 },    // negative sold
    { variantId: "v", delta: -1, soldDelta: 0.5 },   // non-integer sold
    { variantId: "v", delta: 2, soldDelta: 2 },      // sold on a stock-IN → mismatch
    { variantId: "v", delta: -2, soldDelta: 1 },     // sold ≠ |delta| out → mismatch
  ];
  for (const args of bad) {
    const c = rpcClient(movementApplied({}));
    const r = await adjustVariantMovement(c, args);
    assert.equal(r.ok, false, `rejected ${JSON.stringify(args)}`);
    assert.equal(c.calls.length, 0, `no RPC call for ${JSON.stringify(args)}`);
  }
});

test("adjustVariantMovement is fail-closed on every non-applied outcome", async () => {
  // transport error
  const te = await adjustVariantMovement(rpcClient({ data: null, error: { message: "boom" } }), { variantId: "v1", delta: 1, soldDelta: 0 });
  assert.equal(te.ok, false); if (!te.ok) assert.equal(te.reason, "rpc_transport_error");
  // status:error surfaced verbatim
  const se = await adjustVariantMovement(rpcClient({ data: { status: "error", reason: "insufficient_stock" }, error: null }), { variantId: "v1", delta: -9, soldDelta: 0 });
  assert.equal(se.ok, false); if (!se.ok) assert.equal(se.reason, "insufficient_stock");
  // malformed
  for (const data of [null, [1], "applied", 7]) {
    const r = await adjustVariantMovement(rpcClient({ data, error: null }), { variantId: "v1", delta: 1, soldDelta: 0 });
    assert.equal(r.ok, false);
  }
  // applied but missing a required derived field (soldAfter) → fail-closed
  const miss = await adjustVariantMovement(rpcClient(applied({ variantId: "v1", productId: "p1", before: 5, after: 3, parentBefore: 12, parentStock: 10, soldBefore: 0 })), { variantId: "v1", delta: -2, soldDelta: 0 });
  assert.equal(miss.ok, false); if (!miss.ok) assert.equal(miss.reason, "missing_result_field");
});

test("setAbsolute (INV.4A) calls inv_set_absolute_product with mapped params", async () => {
  const c = rpcClient(applied({ inventoryId: "inv1", productId: "p1", before: 3, after: 8 }));
  const r = await setAbsolute(c, "inv1", 8);
  assert.equal(r.ok, true);
  assert.deepEqual(c.calls, [{ name: "inv_set_absolute_product", params: { p_inventory_id: "inv1", p_quantity: 8 } }]);
  if (r.ok) { assert.equal(r.data.before, 3); assert.equal(r.data.after, 8); assert.equal(r.data.productId, "p1"); }
});

test("setAbsolute is fail-closed: rejects bad args, requires before/after/productId, surfaces status:error", async () => {
  // arg validation — no RPC call
  const c1 = rpcClient(applied({})); assert.equal((await setAbsolute(c1, "", 1)).ok, false); assert.equal(c1.calls.length, 0);
  const c2 = rpcClient(applied({})); assert.equal((await setAbsolute(c2, "inv1", -1)).ok, false); assert.equal(c2.calls.length, 0);
  const c3 = rpcClient(applied({})); assert.equal((await setAbsolute(c3, "inv1", 1.5)).ok, false); assert.equal(c3.calls.length, 0);
  // applied but missing productId → fail-closed
  const miss = await setAbsolute(rpcClient(applied({ before: 1, after: 2 })), "inv1", 2);
  assert.equal(miss.ok, false); if (!miss.ok) assert.equal(miss.reason, "missing_result_field");
  // RPC rejects a variant product → surfaced verbatim, no fallback (from() would throw)
  const rej = await setAbsolute(rpcClient({ data: { status: "error", reason: "product_has_variants" }, error: null }), "inv1", 2);
  assert.equal(rej.ok, false); if (!rej.ok) assert.equal(rej.reason, "product_has_variants");
  // transport error → failure
  const te = await setAbsolute(rpcClient({ data: null, error: { message: "x" } }), "inv1", 2);
  assert.equal(te.ok, false); if (!te.ok) assert.equal(te.reason, "rpc_transport_error");
});

test("placeOnShelf (product) calls inv_place_shelf and requires stockBefore/stock/shelfSum", async () => {
  const c = rpcClient(applied({ scope: "product", stockBefore: 20, stock: 30, shelfSum: 30, primaryLocation: "A1" }));
  const r = await placeOnShelf(c, { scope: "product", targetId: "inv1", location: "A1", quantity: 30 });
  assert.equal(r.ok, true);
  assert.deepEqual(c.calls, [{ name: "inv_place_shelf", params: { p_scope: "product", p_target_id: "inv1", p_location: "A1", p_quantity: 30 } }]);
  if (r.ok) { assert.equal(r.data.stockBefore, 20); assert.equal(r.data.stock, 30); }
  // applied but missing stockBefore → fail-closed
  const bad = await placeOnShelf(rpcClient(applied({ scope: "product", stock: 30, shelfSum: 30 })), { scope: "product", targetId: "inv1", location: "A1", quantity: 30 });
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.equal(bad.reason, "missing_result_field");
});

test("placeOnShelf (variant) requires variantBefore/variantStock/parentBefore/parentStock", async () => {
  const ok = await placeOnShelf(rpcClient(applied({ scope: "variant", variantBefore: 4, variantStock: 10, parentBefore: 4, parentStock: 10 })), { scope: "variant", targetId: "v1", location: "A1", quantity: 10 });
  assert.equal(ok.ok, true);
  // applied but missing the derived fields → fail-closed
  const bad = await placeOnShelf(rpcClient(applied({ scope: "variant", variantStock: 10 })), { scope: "variant", targetId: "v1", location: "A1", quantity: 10 });
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.equal(bad.reason, "missing_result_field");
});

// ── INV.4C shelf wrappers ─────────────────────────────────────────────────────

test("removeShelf is placeOnShelf(quantity:0)", async () => {
  const c = rpcClient(applied({ scope: "product", stockBefore: 5, stock: 0, shelfSum: 0, primaryLocation: null }));
  const r = await removeShelf(c, { scope: "product", targetId: "inv1", location: "A1" });
  assert.equal(r.ok, true);
  assert.deepEqual(c.calls, [{ name: "inv_place_shelf", params: { p_scope: "product", p_target_id: "inv1", p_location: "A1", p_quantity: 0 } }]);
});

test("replaceShelfDistribution (product) maps rows and requires stock fields", async () => {
  const c = rpcClient(applied({ scope: "product", productId: "p1", stockBefore: 0, stock: 8, shelfSum: 8, primaryLocation: "A1", untracked: false }));
  const rows = [{ location: "A1", quantity: 5 }, { location: "B2", quantity: 3 }];
  const r = await replaceShelfDistribution(c, { scope: "product", targetId: "inv1", rows });
  assert.equal(r.ok, true);
  assert.deepEqual(c.calls, [{ name: "inv_replace_shelf_distribution", params: { p_scope: "product", p_target_id: "inv1", p_rows: rows } }]);
  // non-array rows rejected before any RPC call
  const c2 = rpcClient(applied({}));
  assert.equal((await replaceShelfDistribution(c2, { scope: "product", targetId: "inv1", rows: null as any })).ok, false);
  assert.equal(c2.calls.length, 0);
});

test("replaceShelfDistribution (variant) requires variant/parent fields", async () => {
  const r = await replaceShelfDistribution(rpcClient(applied({ scope: "variant", variantBefore: 0, variantStock: 6, parentBefore: 0, parentStock: 6 })), { scope: "variant", targetId: "v1", rows: [] });
  assert.equal(r.ok, true);
});

test("assignFullShelf maps location + quantity (null when omitted)", async () => {
  const c = rpcClient(applied({ scope: "product", stockBefore: 7, stock: 7, primaryLocation: "A1", location: "A1" }));
  const r = await assignFullShelf(c, { scope: "product", targetId: "inv1", location: "A1" });
  assert.equal(r.ok, true);
  assert.deepEqual(c.calls, [{ name: "inv_assign_full_shelf", params: { p_scope: "product", p_target_id: "inv1", p_location: "A1", p_quantity: null } }]);
  // untrack: empty/blank location → sent as "" ; forced quantity forwarded
  const c2 = rpcClient(applied({ scope: "product", stockBefore: 7, stock: 7, primaryLocation: null }));
  await assignFullShelf(c2, { scope: "product", targetId: "inv1", location: null });
  assert.equal(c2.calls[0].params.p_location, "");
  const c3 = rpcClient(applied({ scope: "product", stockBefore: 7, stock: 4, primaryLocation: "A1" }));
  await assignFullShelf(c3, { scope: "product", targetId: "inv1", location: "A1", quantity: 4 });
  assert.equal(c3.calls[0].params.p_quantity, 4);
  // negative forced quantity rejected before the RPC
  const c4 = rpcClient(applied({}));
  assert.equal((await assignFullShelf(c4, { scope: "product", targetId: "inv1", location: "A1", quantity: -1 })).ok, false);
  assert.equal(c4.calls.length, 0);
});

test("moveShelf maps from/to and requires quantity + stock fields", async () => {
  const c = rpcClient(applied({ scope: "product", quantity: 3, stock: 12, primaryLocation: "B2" }));
  const r = await moveShelf(c, { scope: "product", targetId: "inv1", fromLocation: "A1", toLocation: "B2" });
  assert.equal(r.ok, true);
  assert.deepEqual(c.calls, [{ name: "inv_move_shelf", params: { p_scope: "product", p_target_id: "inv1", p_from_location: "A1", p_to_location: "B2" } }]);
  // missing to-location rejected before the RPC
  const c2 = rpcClient(applied({}));
  assert.equal((await moveShelf(c2, { scope: "product", targetId: "inv1", fromLocation: "A1", toLocation: "" })).ok, false);
  assert.equal(c2.calls.length, 0);
  // status:error surfaced (e.g. placement_not_found)
  const rej = await moveShelf(rpcClient({ data: { status: "error", reason: "placement_not_found" }, error: null }), { scope: "product", targetId: "inv1", fromLocation: "A1", toLocation: "B2" });
  assert.equal(rej.ok, false); if (!rej.ok) assert.equal(rej.reason, "placement_not_found");
});

// ── fail-closed on every non-applied outcome; NEVER a direct-write fallback ────

test("transport error → failure (no fallback)", async () => {
  const r = await adjustVariant(rpcClient({ data: null, error: { message: "boom" } }), "v1", 1);
  assert.equal(r.ok, false);
  if (!r.ok) { assert.equal(r.reason, "rpc_transport_error"); assert.equal(r.raw, "boom"); }
});

test("status:error → failure carrying the classified reason", async () => {
  const r = await adjustVariant(rpcClient({ data: { status: "error", reason: "insufficient_stock" }, error: null }), "v1", -9);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, "insufficient_stock");
});

test("malformed result → failure (null, array, non-object)", async () => {
  for (const data of [null, undefined, [1, 2], "applied", 7]) {
    const r = await adjustVariant(rpcClient({ data, error: null }), "v1", 1);
    assert.equal(r.ok, false, `malformed ${JSON.stringify(data)}`);
    if (!r.ok) assert.equal(r.reason, "malformed_result");
  }
});

test("applied but missing before/after → failure", async () => {
  const r = await adjustVariant(rpcClient(applied({ after: 7, parentStock: 12 })), "v1", 3); // no `before`
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, "missing_result_field");
});

test("arg validation rejects before any RPC call", async () => {
  const c1 = rpcClient(applied({})); assert.equal((await adjustVariant(c1, "", 1)).ok, false); assert.equal(c1.calls.length, 0);
  const c2 = rpcClient(applied({})); assert.equal((await adjustVariant(c2, "v", 1.5)).ok, false); assert.equal(c2.calls.length, 0);
  const c3 = rpcClient(applied({})); assert.equal((await setVariantAbsolute(c3, "v", -1)).ok, false); assert.equal(c3.calls.length, 0);
  const c4 = rpcClient(applied({})); assert.equal((await placeOnShelf(c4, { scope: "bogus" as any, targetId: "x", location: "A1", quantity: 1 })).ok, false); assert.equal(c4.calls.length, 0);
});

// ── reconcile delegates to the reconcile layer (read-only) ─────────────────────

test("reconcile delegates to the reconcile read layer", async () => {
  const readClient = { from() { return { select() { return { eq() { return Promise.resolve({ data: [], error: null }); }, in() { return Promise.resolve({ data: [], error: null }); } }; } }; } };
  const r = await reconcile(readClient, "p1");
  assert.equal(r.productId, "p1");
  assert.equal(r.status, "clean");
  assert.equal(r.kind, "simple");
});

// ── unimplemented ops throw; they can NEVER perform a mutation ─────────────────

// ── sell (INV.5) — canonical grain-aware sale via inv_sell ─────────────────────

const saleApplied = (extra: Record<string, unknown> = {}) =>
  ({ data: { status: "applied", deductedUnits: 3, products: [{ productId: "p1", before: 10, after: 7 }], variants: [], ...extra }, error: null });

test("sell(product) calls inv_sell with mapped params + fail-closed required fields", async () => {
  const c = rpcClient(saleApplied());
  const r = await sell(c, { scope: "product", targetId: "p1", quantity: 3, source: "shopify", externalId: "gid://o/1" });
  assert.equal(r.ok, true);
  assert.deepEqual(c.calls, [{ name: "inv_sell", params: {
    p_scope: "product", p_target_id: "p1", p_quantity: 3, p_source: "shopify", p_external_id: "gid://o/1" } }]);
  if (r.ok) { assert.equal(r.data.deductedUnits, 3); assert.ok(Array.isArray(r.data.products)); }
});

test("sell(variant) maps scope + passes null externalId when omitted", async () => {
  const c = rpcClient(saleApplied({ variants: [{ productId: "p1", variantId: "v1", variantSku: "S", before: 5, after: 3 }] }));
  const r = await sell(c, { scope: "variant", targetId: "v1", quantity: 2, source: "engine" });
  assert.equal(r.ok, true);
  assert.equal(c.calls[0].params && (c.calls[0].params as any).p_external_id, null);
});

test("sell rejects a non-positive / non-integer quantity and a bad scope BEFORE any RPC", async () => {
  const c = rpcClient(saleApplied());
  for (const q of [0, -1, 2.5]) {
    const r = await sell(c, { scope: "product", targetId: "p1", quantity: q, source: "shopify" });
    assert.equal(r.ok, false);
  }
  const bad = await sell(c, { scope: "warehouse" as any, targetId: "p1", quantity: 1, source: "shopify" });
  assert.equal(bad.ok, false);
  assert.equal(c.calls.length, 0, "no RPC on invalid input");
});

test("sell fails closed on transport error, classified status:error, and malformed body", async () => {
  const err = await sell(rpcClient({ data: null, error: { message: "boom" } }), { scope: "product", targetId: "p1", quantity: 1, source: "shopify" });
  assert.equal(err.ok, false);
  const cls = await sell(rpcClient({ data: { status: "error", reason: "insufficient_stock" }, error: null }), { scope: "product", targetId: "p1", quantity: 1, source: "shopify" });
  assert.equal(cls.ok, false);
  if (!cls.ok) assert.equal(cls.reason, "insufficient_stock");
  const mal = await sell(rpcClient({ data: { status: "applied" }, error: null }), { scope: "product", targetId: "p1", quantity: 1, source: "shopify" });
  assert.equal(mal.ok, false, "missing deductedUnits/products/variants → fail closed");
});

test("future ops throw; sell + shelf ops are implemented (INV.4C/INV.5)", () => {
  for (const fn of [adjust, receive, reverseMovement]) {
    assert.throws(() => (fn as () => never)(), InventoryEngineNotImplementedError);
  }
  assert.deepEqual([...NOT_IMPLEMENTED_OPS].sort(),
    ["adjust", "receive", "reverseMovement"]);
  for (const op of ["setAbsolute", "sell", "moveShelf", "removeShelf", "placeOnShelf", "assignFullShelf", "replaceShelfDistribution"]) {
    assert.equal([...NOT_IMPLEMENTED_OPS].includes(op as never), false, `${op} is implemented, not a stub`);
  }
});

// ── availability boundary + no legacy mirror write (engine source scan) ────────

test("engine.ts never writes availability, the products mirror, or a numeric table directly", () => {
  const src = readFileSync(fileURLToPath(new URL("./engine.ts", import.meta.url)), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1"); // strip comments
  assert.equal(/stock_status/.test(src), false, "no stock_status write/read (availability boundary)");
  assert.equal(/from\(["']products["']\)/.test(src), false, "no products table access (no stale mirror)");
  assert.equal(/\.from\(["'](inventory|product_variants|shelf_stock|variant_shelf_stock)["']\)\s*\.(update|insert|upsert|delete)/.test(src), false, "no direct numeric table write — RPCs only");
  assert.equal(/@\/lib\/availability|availability\//.test(src), false, "imports no availability module");
});
