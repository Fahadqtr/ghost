// Tests for the TRANSACTIONAL, fail-closed Shopify order → inventory contract.
// Run: node --conditions=react-server --experimental-strip-types --test lib/shopify/order-ledger.test.ts
//
// Security invariants locked down here:
//   • inventory is deducted ONLY when the single-transaction RPC reports success;
//   • an order with any unmatched positive-qty line is NOT sent to the RPC, NOT
//     recorded, and blocks the run (no partial deduction);
//   • ANY non-fully-settled run (RPC error, missing migration, null/empty/unknown
//     response, unmatched order, truncated orders or line items) sets complete=false
//     → syncCanPush() is false → the caller performs NO Shopify stock push;
//   • committed counts stay truthful even when the run is blocked.
//
// The SQL side (uuid typing, invalid-uuid rollback, duplicate aggregation in the
// function, clamping, least privilege) is covered by
// supabase/shopify_synced_orders_deduction.test.sql against a real Postgres.

import test from "node:test";
import assert from "node:assert/strict";

import {
  claimAndDeduct,
  syncCanPush,
  isMissingDeductionMigration,
  type ClaimDeductPorts,
  type ClaimDeductPlanners,
  type RpcResult,
  type DeductionRpcArgs,
} from "./order-ledger.ts";
import { planOrderDeductions, type CatalogRowLite, type OrderForDeduction } from "./order-deduct-compute.ts";
import { classifyShopifyOrderChannel } from "./orders-compute.ts";

// INV.5: the planner is grain-aware (orders, catalog, variants, seen). These
// ledger tests use simple products only, so variants = [].
const PLANNERS: ClaimDeductPlanners = {
  plan: (o, c, seen) => planOrderDeductions(o, c, [], seen),
  classifyChannel: classifyShopifyOrderChannel,
};

const CATALOG: CatalogRowLite[] = [
  { id: "p1", sku: "MK-1", name_en: "Rose Serum" },
  { id: "p2", sku: "MK-2", name_en: "Gold Mask" },
];

const order = (over: Partial<OrderForDeduction>): OrderForDeduction => ({
  id: "gid://1",
  name: "#1001",
  financial: "PAID",
  cancelledAt: null,
  items: [{ title: "Rose Serum", qty: 1, sku: "MK-1" }],
  ...over,
});

const ok = (data: unknown): RpcResult => ({ data, error: null });
// INV.5 canonical result: deductedUnits + products[] + variants[].
const processed = (deductedUnits: number, products: any[] = [], variants: any[] = []): RpcResult =>
  ok({ status: "processed", deductedUnits, products, variants });
const saleError = (reason: string): RpcResult => ok({ status: "error", reason });

interface HarnessOpts {
  rpc?: RpcResult[];
  rpcFor?: (args: DeductionRpcArgs) => RpcResult;
}
function harness(opts: HarnessOpts = {}) {
  const calls: { args: DeductionRpcArgs }[] = [];
  const transitions: { products: any[]; variants: any[] }[] = [];
  const queue = [...(opts.rpc ?? [])];
  const ports: ClaimDeductPorts = {
    callDeduction: async (args) => {
      calls.push({ args });
      if (opts.rpcFor) return opts.rpcFor(args);
      return queue.shift() ?? processed(1);
    },
    logTransitions: async (a) => {
      transitions.push(a);
    },
  };
  return { ports, calls, transitions };
}

// ── isMissingDeductionMigration + syncCanPush ──────────────────────────────

test("isMissingDeductionMigration: only a genuinely-absent RPC/migration matches", () => {
  assert.equal(isMissingDeductionMigration({ code: "42883" }), true);
  assert.equal(isMissingDeductionMigration({ code: "PGRST202" }), true);
  assert.equal(isMissingDeductionMigration({ code: "42P01" }), true);
  assert.equal(isMissingDeductionMigration({ message: "Could not find the function process_shopify_order_deduction in the schema cache" }), true);
  assert.equal(isMissingDeductionMigration({ message: "column deduction_result does not exist" }), true);
  assert.equal(isMissingDeductionMigration({ code: "42501", message: "permission denied for function" }), false);
  assert.equal(isMissingDeductionMigration({ code: "23505", message: "duplicate key" }), false);
  assert.equal(isMissingDeductionMigration({ message: "connection reset" }), false);
  assert.equal(isMissingDeductionMigration(null), false);
});

test("syncCanPush is true ONLY for a complete step", () => {
  assert.equal(syncCanPush({ complete: true }), true);
  assert.equal(syncCanPush({ complete: false }), false);
  assert.equal(syncCanPush({}), false);
  assert.equal(syncCanPush(null), false);
});

// ── fully matched complete run → push allowed ──────────────────────────────

test("fully matched complete run → complete=true, push allowed", async () => {
  const { ports, calls } = harness({ rpc: [processed(1)] });
  const res = await claimAndDeduct([order({})], CATALOG, new Set(), false, new Map(), ports, PLANNERS);
  assert.equal(res.complete, true);
  assert.equal(syncCanPush(res), true);
  assert.equal(res.processed, 1);
  assert.equal(res.deducted, 1);
  assert.equal(res.skipped, 0);
  assert.equal(calls.length, 1);
});

// ── Blocker 3: all-or-nothing matching ─────────────────────────────────────

test("unmatched line → RPC not called, order not recorded, run incomplete (no push)", async () => {
  const { ports, calls } = harness();
  const res = await claimAndDeduct(
    [order({ items: [{ title: "Unknown Thing", qty: 2 }] })],
    CATALOG,
    new Set(),
    false,
    new Map(),
    ports,
    PLANNERS,
  );
  assert.equal(res.complete, false);
  assert.equal(syncCanPush(res), false);
  assert.equal(res.blockedReason, "unmatched_order");
  assert.equal(res.processed, 0);
  assert.equal(res.deducted, 0);
  assert.equal(calls.length, 0); // RPC never called for the unmatched order
});

test("mixed matched + unmatched lines in one order → no partial deduction", async () => {
  const { ports, calls } = harness();
  const res = await claimAndDeduct(
    [order({ items: [{ title: "Rose Serum", qty: 1, sku: "MK-1" }, { title: "Mystery", qty: 1 }] })],
    CATALOG,
    new Set(),
    false,
    new Map(),
    ports,
    PLANNERS,
  );
  assert.equal(res.complete, false);
  assert.equal(res.blockedReason, "unmatched_order");
  assert.equal(res.deducted, 0);
  assert.equal(calls.length, 0); // the matched subset is NOT deducted
});

// ── Blocker 4: truncated Shopify data ──────────────────────────────────────

test("orders pagination incomplete (ordersComplete=false) → complete=false, no push", async () => {
  const { ports } = harness({ rpc: [processed(1)] });
  const res = await claimAndDeduct([order({})], CATALOG, new Set(), false, new Map(), ports, PLANNERS, /* ordersComplete */ false);
  assert.equal(res.complete, false);
  assert.equal(res.blockedReason, "orders_truncated");
  assert.equal(syncCanPush(res), false);
});

test("line items truncated for an order → that order not processed, no push", async () => {
  const { ports, calls } = harness();
  const res = await claimAndDeduct([order({ itemsTruncated: true })], CATALOG, new Set(), false, new Map(), ports, PLANNERS);
  assert.equal(res.complete, false);
  assert.equal(res.blockedReason, "line_items_truncated");
  assert.equal(res.processed, 0);
  assert.equal(calls.length, 0); // never sent to the RPC
});

// ── Blocker 2: any non-settled order blocks the push ───────────────────────

test("RPC error → complete=false (Shopify push blocked), nothing deducted", async () => {
  const { ports } = harness({ rpc: [{ data: null, error: { code: "40001", message: "serialization failure" } }] });
  const res = await claimAndDeduct([order({})], CATALOG, new Set(), false, new Map(), ports, PLANNERS);
  assert.equal(res.complete, false);
  assert.equal(res.blockedReason, "db_error");
  assert.equal(syncCanPush(res), false);
  assert.equal(res.deducted, 0);
});

test("missing migration → complete=false (push blocked), migration reason", async () => {
  const { ports, transitions } = harness({
    rpc: [{ data: null, error: { code: "PGRST202", message: "Could not find the function process_shopify_order_deduction" } }],
  });
  const res = await claimAndDeduct([order({})], CATALOG, new Set(), false, new Map(), ports, PLANNERS);
  assert.equal(res.complete, false);
  assert.equal(res.blockedReason, "migration_required");
  assert.equal(syncCanPush(res), false);
  assert.equal(res.deducted, 0);
  assert.equal(transitions.length, 0);
});

test("null RPC response → complete=false (push blocked), fail closed", async () => {
  const { ports } = harness({ rpc: [ok(null)] });
  const res = await claimAndDeduct([order({})], CATALOG, new Set(), false, new Map(), ports, PLANNERS);
  assert.equal(res.complete, false);
  assert.equal(res.blockedReason, "unknown_response");
  assert.equal(res.deducted, 0);
});

test("empty-array RPC response → complete=false (push blocked)", async () => {
  const { ports } = harness({ rpc: [ok([])] });
  const res = await claimAndDeduct([order({})], CATALOG, new Set(), false, new Map(), ports, PLANNERS);
  assert.equal(res.complete, false);
  assert.equal(res.deducted, 0);
});

test("unknown status → complete=false (push blocked)", async () => {
  const { ports } = harness({ rpc: [ok({ status: "weird" })] });
  const res = await claimAndDeduct([order({})], CATALOG, new Set(), false, new Map(), ports, PLANNERS);
  assert.equal(res.complete, false);
  assert.equal(res.blockedReason, "unknown_response");
});

// ── truthful committed counts on a mixed run ───────────────────────────────

test("one processed order then one failed order → truthful counts + push blocked", async () => {
  const orders = [
    order({ id: "gid://1", items: [{ title: "Rose Serum", qty: 2, sku: "MK-1" }] }),
    order({ id: "gid://2", items: [{ title: "Gold Mask", qty: 3, sku: "MK-2" }] }),
  ];
  const { ports } = harness({
    rpcFor: (a) => (a.p_order_id === "gid://1" ? processed(1) : { data: null, error: { code: "XX000", message: "boom" } }),
  });
  const res = await claimAndDeduct(orders, CATALOG, new Set(), false, new Map(), ports, PLANNERS);
  assert.equal(res.processed, 1); // gid://1 really committed
  assert.equal(res.deducted, 1); // truthful — NOT reset to 0
  assert.equal(res.skipped, 1); // gid://2 safely skipped
  assert.equal(res.complete, false); // …but the run is incomplete → no push
  assert.equal(syncCanPush(res), false);
});

// ── concurrency / idempotency ──────────────────────────────────────────────

test("concurrent duplicate: loser returns already_processed and deducts nothing", async () => {
  const orders = [
    order({ id: "gid://1", items: [{ title: "Rose Serum", qty: 2, sku: "MK-1" }] }),
    order({ id: "gid://2", items: [{ title: "Gold Mask", qty: 3, sku: "MK-2" }] }),
  ];
  const { ports } = harness({
    rpcFor: (a) => (a.p_order_id === "gid://1" ? processed(1) : ok({ status: "already_processed", deducted: 0 })),
  });
  const res = await claimAndDeduct(orders, CATALOG, new Set(), false, new Map(), ports, PLANNERS);
  assert.equal(res.complete, true); // both settled (one processed, one already recorded)
  assert.equal(res.processed, 2);
  assert.equal(res.deducted, 1);
});

test("same order id across two runs → exactly one deduction", async () => {
  const h1 = harness({ rpc: [processed(1)] });
  const r1 = await claimAndDeduct([order({})], CATALOG, new Set(), false, new Map(), h1.ports, PLANNERS);
  assert.equal(r1.deducted, 1);

  const h2 = harness();
  const r2 = await claimAndDeduct([order({})], CATALOG, new Set(["gid://1"]), false, new Map(), h2.ports, PLANNERS);
  assert.equal(r2.complete, true); // nothing considered → complete
  assert.equal(r2.deducted, 0);
  assert.equal(h2.calls.length, 0); // RPC never called for the already-synced order
});

// ── duplicate product ids aggregated before the RPC ────────────────────────

test("two lines of the same product aggregate into one p_deductions entry", async () => {
  const { ports, calls } = harness();
  await claimAndDeduct(
    [order({ items: [{ title: "Rose Serum", qty: 2, sku: "MK-1" }, { title: "Rose Serum", qty: 3, sku: "MK-1" }] })],
    CATALOG,
    new Set(),
    false,
    new Map(),
    ports,
    PLANNERS,
  );
  assert.deepEqual(calls[0].args.p_deductions, [{ productId: "p1", variantId: null, quantity: 5 }]);
});

// ── classified sale failure → fail closed, nothing recorded, push blocked ─────

test("insufficient_stock RPC result → complete=false, retryable, no push", async () => {
  const { ports } = harness({ rpc: [saleError("insufficient_stock")] });
  const res = await claimAndDeduct([order({})], CATALOG, new Set(), false, new Map(), ports, PLANNERS);
  assert.equal(res.complete, false);
  assert.equal(res.blockedReason, "insufficient_stock");
  assert.equal(res.processed, 0);
  assert.equal(res.deducted, 0);
});

test("inventory_inconsistent RPC result → complete=false, no push", async () => {
  const { ports } = harness({ rpc: [saleError("inventory_inconsistent")] });
  const res = await claimAndDeduct([order({})], CATALOG, new Set(), false, new Map(), ports, PLANNERS);
  assert.equal(res.complete, false);
  assert.equal(res.blockedReason, "inventory_inconsistent");
  assert.equal(res.deducted, 0);
});

// ── channel from payment method only ───────────────────────────────────────

test("Talabat payment → RPC channel 'talabat'; other → 'shopify'", async () => {
  const t = harness();
  await claimAndDeduct([order({ paymentGatewayNames: ["Talabat"] })], CATALOG, new Set(), false, new Map(), t.ports, PLANNERS);
  assert.equal(t.calls[0].args.p_channel, "talabat");

  const s = harness();
  await claimAndDeduct([order({ paymentGatewayNames: ["Cash"] })], CATALOG, new Set(), false, new Map(), s.ports, PLANNERS);
  assert.equal(s.calls[0].args.p_channel, "shopify");
});

// ── baseline ───────────────────────────────────────────────────────────────

test("baseline → complete run, recorded, nothing deducted, push allowed", async () => {
  const { ports, calls } = harness({ rpc: [ok({ status: "baseline_recorded", deducted: 0 })] });
  const res = await claimAndDeduct([order({})], CATALOG, new Set(), true, new Map(), ports, PLANNERS);
  assert.equal(res.complete, true);
  assert.equal(syncCanPush(res), true);
  assert.equal(res.deducted, 0);
  assert.equal(res.processed, 1);
  assert.equal(calls[0].args.p_baseline, true);
});

// ── void orders + OOS logging ──────────────────────────────────────────────

test("refunded order → recorded via RPC with empty deductions, still complete", async () => {
  const { ports, calls } = harness({ rpc: [processed(0)] });
  const res = await claimAndDeduct([order({ financial: "REFUNDED" })], CATALOG, new Set(), false, new Map(), ports, PLANNERS);
  assert.equal(res.complete, true);
  assert.deepEqual(calls[0].args.p_deductions, []);
  assert.equal(res.processed, 1);
});

test("processed order fires authoritative transitions from the RPC's products/variants", async () => {
  const { ports, transitions } = harness({
    rpc: [processed(1, [{ productId: "p1", before: 3, after: 0 }], [{ productId: "p1", variantId: "v1", variantSku: "S", before: 2, after: 0 }])],
  });
  await claimAndDeduct([order({})], CATALOG, new Set(), false, new Map(), ports, PLANNERS);
  assert.equal(transitions.length, 1);
  assert.deepEqual(transitions[0].products, [{ productId: "p1", before: 3, after: 0 }]);
  assert.deepEqual(transitions[0].variants, [{ productId: "p1", variantId: "v1", variantSku: "S", before: 2, after: 0 }]);
});

test("nothing considered → complete run with no RPC calls", async () => {
  const { ports, calls } = harness();
  const res = await claimAndDeduct([order({})], CATALOG, new Set(["gid://1"]), false, new Map(), ports, PLANNERS);
  assert.equal(res.complete, true);
  assert.equal(res.processed, 0);
  assert.equal(calls.length, 0);
});
