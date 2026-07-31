// Tests for the Shopify order → inventory CLAIM-BEFORE-DEDUCT ledger contract.
// Run: node --conditions=react-server --experimental-strip-types --test lib/shopify/order-ledger.test.ts
//
// These lock down the security invariant behind PR #492: inventory is never
// deducted for an order that was not first durably recorded, the same order can
// never be deducted twice, and no unexpected DB error is ever hidden behind a
// false success.

import test from "node:test";
import assert from "node:assert/strict";

import {
  claimAndDeduct,
  isMissingColumnError,
  type ClaimDeductPorts,
  type ClaimDeductPlanners,
  type DbError,
} from "./order-ledger.ts";
import { planOrderDeductions, spreadDeduction, type CatalogRowLite, type OrderForDeduction } from "./order-deduct-compute.ts";
import { classifyShopifyOrderChannel } from "./orders-compute.ts";

const PLANNERS: ClaimDeductPlanners = {
  plan: planOrderDeductions,
  spread: spreadDeduction,
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

type Call =
  | { op: "upsert"; rows: any[] }
  | { op: "read"; productId: string }
  | { op: "write"; rowKey: string | number; stock: number }
  | { op: "setDeducted"; orderIds: string[]; deducted: number }
  | { op: "log"; productId: string };

interface HarnessOpts {
  /** Queued responses for successive upsertLedger calls (rich then base). */
  upsertResponses?: { data: { order_id: string }[] | null; error: DbError | null }[];
  /** Inventory rows keyed by product_id. */
  inventory?: Record<string, { id: string | number; stock_quantity: number | null }[]>;
  /** product_ids whose inventory READ should error. */
  readErrorFor?: string[];
  /** row keys whose inventory WRITE should error. */
  writeErrorFor?: (string | number)[];
}

function harness(opts: HarnessOpts = {}) {
  const calls: Call[] = [];
  const upsertResponses = [...(opts.upsertResponses ?? [])];
  const ports: ClaimDeductPorts = {
    upsertLedger: async (rows) => {
      calls.push({ op: "upsert", rows });
      const queued = upsertResponses.shift();
      if (queued) return queued;
      // default: every submitted row is won (fresh insert)
      return { data: rows.map((r) => ({ order_id: r.order_id })), error: null };
    },
    readInventory: async (productId) => {
      calls.push({ op: "read", productId });
      if (opts.readErrorFor?.includes(productId)) return { data: null, error: { message: "read fail" } };
      return { data: opts.inventory?.[productId] ?? [], error: null };
    },
    writeInventory: async (rowKey, stock) => {
      calls.push({ op: "write", rowKey, stock });
      if (opts.writeErrorFor?.includes(rowKey)) return { error: { message: "write fail" } };
      return { error: null };
    },
    setLedgerDeducted: async (orderIds, deducted) => {
      calls.push({ op: "setDeducted", orderIds, deducted });
    },
    logStock: async (a) => {
      calls.push({ op: "log", productId: a.productId });
    },
  };
  return { ports, calls };
}

// ── isMissingColumnError ───────────────────────────────────────────────────

test("isMissingColumnError: only genuine missing-column errors match", () => {
  assert.equal(isMissingColumnError({ code: "42703" }), true); // undefined_column
  assert.equal(isMissingColumnError({ code: "PGRST204" }), true); // PostgREST schema-cache miss
  assert.equal(isMissingColumnError({ message: "Could not find the 'channel' column in the schema cache" }), true);
  assert.equal(isMissingColumnError({ message: "column payment_gateway_names does not exist" }), true);
  // NOT a missing column — must never be treated as one.
  assert.equal(isMissingColumnError({ code: "42501", message: "permission denied for table shopify_synced_orders" }), false);
  assert.equal(isMissingColumnError({ code: "23505", message: "duplicate key value violates unique constraint" }), false);
  assert.equal(isMissingColumnError({ message: "connection refused" }), false);
  assert.equal(isMissingColumnError({ message: "some other column blew up" }), false); // says "column" but not our columns
  assert.equal(isMissingColumnError(null), false);
  assert.equal(isMissingColumnError(undefined), false);
});

// ── migration columns available (rich path) ────────────────────────────────

test("migration columns available: records WITH channel, then deducts", async () => {
  const { ports, calls } = harness({ inventory: { p1: [{ id: "r1", stock_quantity: 5 }] } });
  const res = await claimAndDeduct([order({ paymentGatewayNames: ["Talabat"] })], CATALOG, new Set(), false, new Map(), ports, PLANNERS);

  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.deducted, 1);
  assert.equal(res.ordersProcessed, 1);
  // exactly one upsert (rich) — no fallback needed
  const upserts = calls.filter((c) => c.op === "upsert");
  assert.equal(upserts.length, 1);
  const row = (upserts[0] as any).rows[0];
  assert.equal(row.channel, "talabat");
  assert.deepEqual(row.payment_gateway_names, ["Talabat"]);
});

// ── migration columns unavailable (base fallback) ──────────────────────────

test("migration columns unavailable: falls back to base columns and still deducts", async () => {
  const { ports, calls } = harness({
    upsertResponses: [
      { data: null, error: { code: "PGRST204", message: "Could not find the 'channel' column" } }, // rich fails
      { data: [{ order_id: "gid://1" }], error: null }, // base succeeds
    ],
    inventory: { p1: [{ id: "r1", stock_quantity: 5 }] },
  });
  const res = await claimAndDeduct([order({ paymentGatewayNames: ["Talabat"] })], CATALOG, new Set(), false, new Map(), ports, PLANNERS);

  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.deducted, 1);
  const upserts = calls.filter((c) => c.op === "upsert") as any[];
  assert.equal(upserts.length, 2); // rich then base
  assert.equal("channel" in upserts[0].rows[0], true); // first was the rich attempt
  assert.equal("channel" in upserts[1].rows[0], false); // fallback used base columns only
});

// ── unexpected DB error on claim → NEVER deduct, NEVER false success ────────

test("unexpected DB error on the rich claim: no fallback, no deduction, ok:false", async () => {
  const { ports, calls } = harness({
    upsertResponses: [{ data: null, error: { code: "42501", message: "permission denied" } }],
    inventory: { p1: [{ id: "r1", stock_quantity: 5 }] },
  });
  const res = await claimAndDeduct([order({})], CATALOG, new Set(), false, new Map(), ports, PLANNERS);

  assert.equal(res.ok, false);
  assert.equal(res.deducted, 0);
  assert.equal(res.ordersProcessed, 0);
  // aborted before touching inventory, and did NOT retry with base columns
  assert.equal(calls.filter((c) => c.op === "upsert").length, 1);
  assert.equal(calls.some((c) => c.op === "read" || c.op === "write"), false);
});

test("base-column claim ALSO fails: error is surfaced, nothing deducted", async () => {
  const { ports, calls } = harness({
    upsertResponses: [
      { data: null, error: { code: "PGRST204", message: "Could not find the 'channel' column" } }, // rich → missing col
      { data: null, error: { message: "connection reset" } }, // base → real failure
    ],
    inventory: { p1: [{ id: "r1", stock_quantity: 5 }] },
  });
  const res = await claimAndDeduct([order({})], CATALOG, new Set(), false, new Map(), ports, PLANNERS);

  assert.equal(res.ok, false);
  assert.equal(res.deducted, 0);
  assert.equal(calls.filter((c) => c.op === "upsert").length, 2);
  assert.equal(calls.some((c) => c.op === "read" || c.op === "write"), false); // never deducted
});

// ── claim happens BEFORE any deduction ─────────────────────────────────────

test("claim-before-deduct: the ledger write precedes every inventory read/write", async () => {
  const { ports, calls } = harness({ inventory: { p1: [{ id: "r1", stock_quantity: 5 }] } });
  await claimAndDeduct([order({})], CATALOG, new Set(), false, new Map(), ports, PLANNERS);

  const firstUpsert = calls.findIndex((c) => c.op === "upsert");
  const firstTouch = calls.findIndex((c) => c.op === "read" || c.op === "write");
  assert.equal(firstUpsert, 0);
  assert.ok(firstTouch > firstUpsert);
});

// ── the same order can never be deducted twice ─────────────────────────────

test("already-synced order is neither recorded again nor deducted", async () => {
  const { ports, calls } = harness({ inventory: { p1: [{ id: "r1", stock_quantity: 5 }] } });
  const res = await claimAndDeduct([order({})], CATALOG, new Set(["gid://1"]), false, new Map(), ports, PLANNERS);

  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.deducted, 0);
  assert.equal(res.ordersProcessed, 0);
  assert.equal(calls.length, 0); // nothing considered → no DB traffic at all
});

test("concurrent run: an order won by ANOTHER run (not in RETURNING) is NOT deducted here", async () => {
  // Two fresh orders considered, but the ledger reports only gid://2 as inserted by
  // us — gid://1 was claimed by a concurrent run. We must deduct ONLY gid://2.
  const orders = [
    order({ id: "gid://1", items: [{ title: "Rose Serum", qty: 2, sku: "MK-1" }] }),
    order({ id: "gid://2", items: [{ title: "Gold Mask", qty: 3, sku: "MK-2" }] }),
  ];
  const { ports, calls } = harness({
    upsertResponses: [{ data: [{ order_id: "gid://2" }], error: null }],
    inventory: { p1: [{ id: "r1", stock_quantity: 9 }], p2: [{ id: "r2", stock_quantity: 9 }] },
  });
  const res = await claimAndDeduct(orders, CATALOG, new Set(), false, new Map(), ports, PLANNERS);

  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.wonCount, 1);
  const reads = calls.filter((c) => c.op === "read") as any[];
  assert.deepEqual(reads.map((r) => r.productId), ["p2"]); // p1 (gid://1) never touched
  const writes = calls.filter((c) => c.op === "write") as any[];
  assert.deepEqual(writes.map((w) => w.stock), [6]); // 9 - 3, only Gold Mask
});

test("re-run after a partial failure does not re-deduct: recorded orders are excluded", async () => {
  // Simulate the "next sync": the order is already in the ledger (alreadySynced),
  // so it is excluded up front — no matter what happened to its stock last run.
  const { ports } = harness({ inventory: { p1: [{ id: "r1", stock_quantity: 4 }] } });
  const res = await claimAndDeduct([order({})], CATALOG, new Set(["gid://1"]), false, new Map(), ports, PLANNERS);
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.deducted, 0);
});

// ── partial inventory-write failure ────────────────────────────────────────

test("partial inventory-write failure: order stays recorded, only successful writes count, no throw", async () => {
  const { ports, calls } = harness({
    inventory: { p1: [{ id: "r1", stock_quantity: 5 }, { id: "r2", stock_quantity: 5 }] },
    writeErrorFor: ["r1"], // biggest row write fails
  });
  // qty 7 spread across two rows of 5 → r1:5→0 (fails), r2:5→3 (ok)
  const res = await claimAndDeduct(
    [order({ items: [{ title: "Rose Serum", qty: 7, sku: "MK-1" }] })],
    CATALOG,
    new Set(),
    false,
    new Map(),
    ports,
    PLANNERS,
  );
  assert.equal(res.ok, true);
  if (!res.ok) return;
  // the ledger claim already happened (recorded) — so a re-run would skip it
  assert.equal(calls.filter((c) => c.op === "upsert").length, 1);
  assert.equal(res.deducted, 1); // only the successful row counted
});

// ── baseline first run records but never deducts ───────────────────────────

test("baseline first run: records the orders, deducts nothing", async () => {
  const { ports, calls } = harness({ inventory: { p1: [{ id: "r1", stock_quantity: 5 }] } });
  const res = await claimAndDeduct([order({})], CATALOG, new Set(), true, new Map(), ports, PLANNERS);

  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.deducted, 0);
  assert.equal(res.ordersProcessed, 1);
  assert.equal(calls.filter((c) => c.op === "upsert").length, 1); // recorded
  assert.equal(calls.some((c) => c.op === "read" || c.op === "write"), false); // no deduction
});

// ── representation unavailable degrades to claim-first over the considered set ──

test("ledger without RETURNING representation still deducts the considered set (claim-first)", async () => {
  const { ports, calls } = harness({
    upsertResponses: [{ data: null, error: null }], // success but no rows returned
    inventory: { p1: [{ id: "r1", stock_quantity: 5 }] },
  });
  const res = await claimAndDeduct([order({})], CATALOG, new Set(), false, new Map(), ports, PLANNERS);
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.deducted, 1); // fell back to considered set, still deducted once
  assert.equal(calls.filter((c) => c.op === "write").length, 1);
});

// ── void orders are recorded but never deducted ────────────────────────────

test("a refunded order is recorded (idempotency) but deducts nothing", async () => {
  const { ports, calls } = harness({ inventory: { p1: [{ id: "r1", stock_quantity: 5 }] } });
  const res = await claimAndDeduct([order({ financial: "REFUNDED" })], CATALOG, new Set(), false, new Map(), ports, PLANNERS);
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.ordersProcessed, 1);
  assert.equal(res.deducted, 0);
  assert.equal(calls.filter((c) => c.op === "upsert").length, 1); // recorded
  assert.equal(calls.some((c) => c.op === "write"), false);
});
