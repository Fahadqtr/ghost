// Tests for the TRANSACTIONAL Shopify order → inventory deduction contract.
// Run: node --conditions=react-server --experimental-strip-types --test lib/shopify/order-ledger.test.ts
//
// These lock down the security invariant behind PR #492: inventory is deducted
// ONLY when the single-transaction RPC explicitly reports success, the same order
// can never be deducted twice, and every non-success result (null / empty /
// unknown / DB error / missing migration) fails CLOSED — nothing is deducted.

import test from "node:test";
import assert from "node:assert/strict";

import {
  claimAndDeduct,
  isMissingDeductionMigration,
  type ClaimDeductPorts,
  type ClaimDeductPlanners,
  type RpcResult,
  type DeductionRpcArgs,
} from "./order-ledger.ts";
import { planOrderDeductions, type CatalogRowLite, type OrderForDeduction } from "./order-deduct-compute.ts";
import { classifyShopifyOrderChannel } from "./orders-compute.ts";

const PLANNERS: ClaimDeductPlanners = {
  plan: planOrderDeductions,
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
const processed = (deducted: number, products: any[] = []): RpcResult => ok({ status: "processed", deducted, products });

interface HarnessOpts {
  /** RPC response per call, in order. Falls back to a generic processed:1 result. */
  rpc?: RpcResult[];
  /** Or a function keyed by the RPC args. */
  rpcFor?: (args: DeductionRpcArgs) => RpcResult;
}

function harness(opts: HarnessOpts = {}) {
  const calls: { op: "rpc"; args: DeductionRpcArgs }[] = [];
  const logs: { productId: string; before: number; after: number }[] = [];
  const queue = [...(opts.rpc ?? [])];
  const ports: ClaimDeductPorts = {
    callDeduction: async (args) => {
      calls.push({ op: "rpc", args });
      if (opts.rpcFor) return opts.rpcFor(args);
      return queue.shift() ?? processed(1);
    },
    logStock: async (a) => {
      logs.push(a);
    },
  };
  return { ports, calls, logs };
}

// ── isMissingDeductionMigration ────────────────────────────────────────────

test("isMissingDeductionMigration: only a genuinely-absent RPC/migration matches", () => {
  assert.equal(isMissingDeductionMigration({ code: "42883" }), true); // undefined_function
  assert.equal(isMissingDeductionMigration({ code: "PGRST202" }), true); // PostgREST fn not in schema cache
  assert.equal(isMissingDeductionMigration({ code: "42P01" }), true); // undefined_table
  assert.equal(
    isMissingDeductionMigration({ message: "Could not find the function public.process_shopify_order_deduction in the schema cache" }),
    true,
  );
  assert.equal(isMissingDeductionMigration({ message: "column deduction_result does not exist" }), true);
  // NOT a missing migration.
  assert.equal(isMissingDeductionMigration({ code: "42501", message: "permission denied for function" }), false);
  assert.equal(isMissingDeductionMigration({ code: "23505", message: "duplicate key" }), false);
  assert.equal(isMissingDeductionMigration({ message: "connection reset" }), false);
  assert.equal(isMissingDeductionMigration(null), false);
});

// ── Blocker 1: fail closed on null / empty RPC data ────────────────────────

test("data=null → no deduction (fail closed)", async () => {
  const { ports, calls } = harness({ rpc: [ok(null)] });
  const res = await claimAndDeduct([order({})], CATALOG, new Set(), false, new Map(), ports, PLANNERS);
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.deducted, 0);
  assert.equal(res.recorded, 0);
  assert.equal(res.skipped, 1);
  assert.equal(calls.length, 1); // the RPC was attempted, but nothing counted as done
});

test("empty RETURNING array → no deduction (fail closed)", async () => {
  const { ports } = harness({ rpc: [ok([])] });
  const res = await claimAndDeduct([order({})], CATALOG, new Set(), false, new Map(), ports, PLANNERS);
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.deducted, 0);
  assert.equal(res.skipped, 1);
});

test("unknown / error RPC status → no deduction (fail closed)", async () => {
  const { ports } = harness({ rpc: [ok({ status: "error", reason: "whatever" })] });
  const res = await claimAndDeduct([order({})], CATALOG, new Set(), false, new Map(), ports, PLANNERS);
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.deducted, 0);
  assert.equal(res.recorded, 0);
  assert.equal(res.skipped, 1);
});

// ── concurrent duplicate → exactly one winner ──────────────────────────────

test("concurrent duplicate: the loser gets already_processed and deducts nothing", async () => {
  // Two DIFFERENT orders; the second was already claimed by a concurrent run.
  const orders = [
    order({ id: "gid://1", items: [{ title: "Rose Serum", qty: 2, sku: "MK-1" }] }),
    order({ id: "gid://2", items: [{ title: "Gold Mask", qty: 3, sku: "MK-2" }] }),
  ];
  const { ports } = harness({
    rpcFor: (a) => (a.p_order_id === "gid://1" ? processed(1) : ok({ status: "already_processed", deducted: 0 })),
  });
  const res = await claimAndDeduct(orders, CATALOG, new Set(), false, new Map(), ports, PLANNERS);
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.deducted, 1); // only gid://1
  assert.equal(res.recorded, 2); // both are in the ledger (one by us, one by the other run)
  assert.equal(res.skipped, 0);
});

test("RPC already_processed → recorded but not deducted", async () => {
  const { ports } = harness({ rpc: [ok({ status: "already_processed", deducted: 0 })] });
  const res = await claimAndDeduct([order({})], CATALOG, new Set(), false, new Map(), ports, PLANNERS);
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.deducted, 0);
  assert.equal(res.recorded, 1);
});

// ── migration missing / DB error → safe skip ───────────────────────────────

test("RPC migration missing → safe skip, ok:false, migration note, nothing deducted", async () => {
  const { ports, logs } = harness({
    rpc: [{ data: null, error: { code: "PGRST202", message: "Could not find the function process_shopify_order_deduction" } }],
  });
  const res = await claimAndDeduct([order({})], CATALOG, new Set(), false, new Map(), ports, PLANNERS);
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.deducted, 0);
  assert.equal(res.ordersProcessed, 0);
  assert.match(res.note, /migration/i);
  assert.equal(logs.length, 0);
});

test("RPC database error → safe skip (not a false success)", async () => {
  const { ports } = harness({ rpc: [{ data: null, error: { code: "40001", message: "serialization failure" } }] });
  const res = await claimAndDeduct([order({})], CATALOG, new Set(), false, new Map(), ports, PLANNERS);
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.deducted, 0);
  assert.equal(res.recorded, 0);
  assert.equal(res.skipped, 1);
});

// ── partial failure reported → no success ──────────────────────────────────

test("partial failure reported by the RPC → that order is not counted as deducted", async () => {
  // One order errors mid-transaction (rolled back server-side), one succeeds.
  const orders = [
    order({ id: "gid://1", items: [{ title: "Rose Serum", qty: 2, sku: "MK-1" }] }),
    order({ id: "gid://2", items: [{ title: "Gold Mask", qty: 3, sku: "MK-2" }] }),
  ];
  const { ports } = harness({
    rpcFor: (a) =>
      a.p_order_id === "gid://1" ? { data: null, error: { code: "XX000", message: "internal error" } } : processed(1),
  });
  const res = await claimAndDeduct(orders, CATALOG, new Set(), false, new Map(), ports, PLANNERS);
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.deducted, 1); // only gid://2 counted
  assert.equal(res.recorded, 1);
  assert.equal(res.skipped, 1); // gid://1 safely skipped, will retry next run
});

// ── baseline records without deduction ─────────────────────────────────────

test("baseline → recorded without deduction (RPC gets p_baseline=true)", async () => {
  const { ports, calls } = harness({ rpc: [ok({ status: "baseline_recorded", deducted: 0 })] });
  const res = await claimAndDeduct([order({})], CATALOG, new Set(), true, new Map(), ports, PLANNERS);
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.deducted, 0);
  assert.equal(res.recorded, 1);
  assert.equal(res.baseline, true);
  assert.equal(calls[0].args.p_baseline, true);
});

// ── channel comes ONLY from paymentGatewayNames ────────────────────────────

test("Talabat payment → RPC receives channel 'talabat'", async () => {
  const { ports, calls } = harness();
  await claimAndDeduct([order({ paymentGatewayNames: ["Talabat"] })], CATALOG, new Set(), false, new Map(), ports, PLANNERS);
  assert.equal(calls[0].args.p_channel, "talabat");
  assert.deepEqual(calls[0].args.p_payment_gateway_names, ["Talabat"]);
});

test("other payment → RPC receives channel 'shopify'", async () => {
  const { ports, calls } = harness();
  await claimAndDeduct([order({ paymentGatewayNames: ["Cash"] })], CATALOG, new Set(), false, new Map(), ports, PLANNERS);
  assert.equal(calls[0].args.p_channel, "shopify");
});

// ── the same order can never be deducted twice ─────────────────────────────

test("same order id across two runs → exactly one deduction", async () => {
  // Run 1: fresh order → RPC processes it (deduct 1).
  const h1 = harness({ rpc: [processed(1)] });
  const r1 = await claimAndDeduct([order({})], CATALOG, new Set(), false, new Map(), h1.ports, PLANNERS);
  assert.equal(r1.ok, true);
  if (!r1.ok) return;
  assert.equal(r1.deducted, 1);

  // Run 2: the order is now in the ledger (alreadySynced) → excluded up front,
  // the RPC is never even called for it.
  const h2 = harness();
  const r2 = await claimAndDeduct([order({})], CATALOG, new Set(["gid://1"]), false, new Map(), h2.ports, PLANNERS);
  assert.equal(r2.ok, true);
  if (!r2.ok) return;
  assert.equal(r2.deducted, 0);
  assert.equal(h2.calls.length, 0);
});

// ── matching logic feeds the RPC (quantities unchanged) ────────────────────

test("per-order deductions are computed with the existing matching and passed to the RPC", async () => {
  const { ports, calls } = harness();
  await claimAndDeduct(
    [order({ items: [{ title: "Rose Serum", qty: 2, sku: "MK-1" }, { title: "Gold Mask", qty: 3 }] })],
    CATALOG,
    new Set(),
    false,
    new Map(),
    ports,
    PLANNERS,
  );
  const ded = [...calls[0].args.p_deductions].sort((a, b) => a.product_id.localeCompare(b.product_id));
  assert.deepEqual(ded, [
    { product_id: "p1", quantity: 2 },
    { product_id: "p2", quantity: 3 },
  ]);
});

test("a refunded order is sent to the RPC to be recorded, with no deductions", async () => {
  const { ports, calls } = harness({ rpc: [processed(0)] });
  const res = await claimAndDeduct([order({ financial: "REFUNDED" })], CATALOG, new Set(), false, new Map(), ports, PLANNERS);
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.deepEqual(calls[0].args.p_deductions, []); // void → nothing to deduct
  assert.equal(res.recorded, 1); // still recorded for idempotency
});

// ── OOS task hook fires from the RPC's reported before/after ────────────────

test("processed order logs stock transitions from the RPC-reported product deltas", async () => {
  const { ports, logs } = harness({ rpc: [processed(1, [{ product_id: "p1", before: 3, after: 0 }])] });
  await claimAndDeduct([order({})], CATALOG, new Set(), false, new Map(), ports, PLANNERS);
  assert.deepEqual(logs, [{ productId: "p1", before: 3, after: 0 }]);
});

test("nothing considered → no RPC calls at all", async () => {
  const { ports, calls } = harness();
  const res = await claimAndDeduct([order({})], CATALOG, new Set(["gid://1"]), false, new Map(), ports, PLANNERS);
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.ordersProcessed, 0);
  assert.equal(calls.length, 0);
});
