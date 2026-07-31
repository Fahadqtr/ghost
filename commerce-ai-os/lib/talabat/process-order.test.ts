// Behavioral tests for the server-only Talabat processor. Uses the REAL pure
// Phase 2A.3A layers + a fake admin client and fake loaders. NO Supabase, NO
// network, NO stock writes.
// Run: node --conditions=react-server --experimental-strip-types --test lib/talabat/process-order.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { processStoredTalabatOrder } from "./process-order.ts";
import { parseTalabatOrderLines, buildTalabatDedupKey } from "./order-lines.ts";
import { resolveTalabatOrder } from "./order-resolver.ts";
import { buildTalabatDeductionPlan, sanitizeResolution } from "./deduction-plan.ts";
import { evaluateDeductGate } from "./event-gate.ts";

// ---- fixtures ---------------------------------------------------------------
const CTX_OK = {
  status: "ok" as const, channelId: "cT",
  context: {
    mappings: [{ channelProductId: "CP1", exportedSku: "V-SKU", exportedBarcode: "V-BC", masterProductId: "p2", masterVariantSku: "V-SKU", mappingStatus: "active" }],
    products: [{ id: "p2", sku: null, barcode: null, title: "Prod Two" }, { id: "p1", sku: "PSKU", barcode: "PBC", title: "Prod One" }],
    variants: [{ parentProductId: "p2", sku: "V-SKU", barcode: "V-BC" }],
  },
};
const SNAP_OK = { status: "ok" as const, snapshots: [{ kind: "variant", masterProductId: "p2", masterVariantSku: "V-SKU", variantId: "v1", variantStock: 10, shelves: [] }] as any };

// A well-formed order: strong identity + one line resolvable to the active variant.
const RAW_OK = { order: { code: "OC-1", customer: { name: "Fatima", phone: "+97455512345", address: "Doha" }, items: [{ sku: "V-SKU", quantity: 1, name: "Widget", price: 5 }] } };

function makeAdmin(order: any, rpc?: any, existingTasks: any[] = []) {
  const state: any = { order: order ? { ...order } : null, updates: [], rpcCalls: [], tasks: [], existingTasks, rpc };
  const admin: any = {
    _state: state,
    from(table: string) {
      let mode = "select"; let patch: any = null; const filters: Record<string, unknown> = {};
      const b: any = {
        select() { return b; },
        update(p: any) { mode = "update"; patch = p; return b; },
        insert(row: any) {
          if (table === "staff_tasks") { state.tasks.push(row); return Promise.resolve({ error: null }); }
          return Promise.resolve({ error: null });
        },
        eq(c: string, v: unknown) { filters[c] = v; return b; },
        neq() { return b; },
        limit() { return Promise.resolve({ data: state.existingTasks, error: null }); },
        single() {
          if (table === "talabat_orders") return Promise.resolve({ data: state.order ? { ...state.order } : null, error: state.order ? null : { message: "nf" } });
          return Promise.resolve({ data: null, error: null });
        },
        then(resolve: (v: any) => void) {
          if (mode === "update" && table === "talabat_orders" && state.order) {
            const gateOk = !("processing_status" in filters) || state.order.processing_status === filters.processing_status;
            if (gateOk) { state.updates.push(patch); Object.assign(state.order, patch); return resolve({ data: [{ id: state.order.id }], error: null }); }
            return resolve({ data: [], error: null });
          }
          return resolve({ data: [], error: null });
        },
      };
      return b;
    },
    rpc(name: string, params: any) {
      state.rpcCalls.push({ name, params });
      if (typeof state.rpc === "function") return state.rpc(params, state);
      return Promise.resolve(state.rpc ?? { data: { status: "processed" }, error: null });
    },
  };
  return admin;
}

function deps(over: any = {}) {
  return {
    enabledFlag: "true", allowlistRaw: "order.placed",
    parseLines: parseTalabatOrderLines, buildDedupKey: buildTalabatDedupKey,
    resolveOrder: resolveTalabatOrder, buildPlan: buildTalabatDeductionPlan,
    sanitize: sanitizeResolution, evaluateGate: evaluateDeductGate,
    loadContext: async () => CTX_OK, loadSnapshots: async () => SNAP_OK,
    nowIso: () => "2026-07-31T00:00:00.000Z",
    ...over,
  };
}
const order = (over: any = {}) => ({ id: "ord-1", processing_status: "pending", raw: RAW_OK, event: "order.placed", order_code: "OC-1", ...over });

// ---- tests ------------------------------------------------------------------

test("ready plan → RPC invoked exactly once; processed → no manual task", async () => {
  const admin = makeAdmin(order());
  const r = await processStoredTalabatOrder(admin, "ord-1", deps());
  assert.equal(r.outcome, "processed");
  assert.equal(admin._state.rpcCalls.length, 1);
  assert.equal(admin._state.tasks.length, 0);
});

test("RPC receives NO raw payload or customer PII", async () => {
  const admin = makeAdmin(order());
  await processStoredTalabatOrder(admin, "ord-1", deps());
  const params = admin._state.rpcCalls[0].params;
  const blob = JSON.stringify(params);
  assert.ok(!/Fatima|55512345|Doha|phone|address|customer|_unparsed/i.test(blob), blob);
  assert.equal(params.p_order_id, "ord-1");
  assert.equal(params.p_dedup_key, "talabat:oc-1"); // dedup key, not the token
});

test("feature flag false → gate store_only, no RPC, no status change", async () => {
  const admin = makeAdmin(order());
  const r = await processStoredTalabatOrder(admin, "ord-1", deps({ enabledFlag: "false" }));
  assert.equal(r.outcome, "store_only");
  assert.equal(admin._state.rpcCalls.length, 0);
  assert.equal(admin._state.updates.length, 0);
});

test("flag true + empty allowlist → manual_review auto_deduct_misconfigured, no RPC, one task", async () => {
  const admin = makeAdmin(order());
  const r = await processStoredTalabatOrder(admin, "ord-1", deps({ allowlistRaw: "" }));
  assert.equal(r.outcome, "manual_review:auto_deduct_misconfigured");
  assert.equal(admin._state.rpcCalls.length, 0);
  assert.equal(admin._state.order.processing_status, "manual_review");
  assert.equal(admin._state.tasks.length, 1);
});

test("event not in allowlist → event_not_allowed, no RPC", async () => {
  const admin = makeAdmin(order({ event: "order.cancelled" }));
  const r = await processStoredTalabatOrder(admin, "ord-1", deps());
  assert.equal(r.outcome, "manual_review:event_not_allowed");
  assert.equal(admin._state.rpcCalls.length, 0);
});

test("weak identity → resolver weak_order_identity, no RPC", async () => {
  const admin = makeAdmin(order({ raw: { items: [{ sku: "V-SKU", quantity: 1 }] }, order_code: null }));
  const r = await processStoredTalabatOrder(admin, "ord-1", deps());
  assert.equal(r.outcome, "manual_review:weak_order_identity");
  assert.equal(admin._state.rpcCalls.length, 0);
});

test("empty order → no RPC", async () => {
  const admin = makeAdmin(order({ raw: { order: { code: "OC-2", items: [] } } }));
  const r = await processStoredTalabatOrder(admin, "ord-1", deps());
  assert.equal(r.outcome, "manual_review:empty_order");
  assert.equal(admin._state.rpcCalls.length, 0);
});

test("inactive mapping → no RPC", async () => {
  const ctx = { status: "ok", channelId: "cT", context: { ...CTX_OK.context, mappings: [{ ...CTX_OK.context.mappings[0], mappingStatus: "archived" }] } };
  const admin = makeAdmin(order());
  const r = await processStoredTalabatOrder(admin, "ord-1", deps({ loadContext: async () => ctx }));
  assert.equal(r.outcome, "manual_review:inactive_mapping");
  assert.equal(admin._state.rpcCalls.length, 0);
});

test("ambiguous mapping (parent SKU on a product with variants) → no RPC", async () => {
  // Line hits a product-level SKU whose product HAS variants → ambiguous_match.
  const ctx = { status: "ok", channelId: "cT", context: {
    mappings: [],
    products: [{ id: "p3", sku: "P3SKU", barcode: "P3BC", title: "Prod Three" }],
    variants: [{ parentProductId: "p3", sku: "P3-V1", barcode: "P3-V1-BC" }],
  } };
  const admin = makeAdmin(order({ raw: { order: { code: "OC-3", items: [{ sku: "P3SKU", quantity: 1 }] } } }));
  const r = await processStoredTalabatOrder(admin, "ord-1", deps({ loadContext: async () => ctx }));
  assert.equal(r.outcome, "manual_review:ambiguous_match");
  assert.equal(admin._state.rpcCalls.length, 0);
});

test("title-only match → no RPC", async () => {
  const admin = makeAdmin(order({ raw: { order: { code: "OC-4", items: [{ title: "Prod One", quantity: 1 }] } } }));
  const r = await processStoredTalabatOrder(admin, "ord-1", deps());
  assert.equal(r.outcome, "manual_review:title_only_match");
  assert.equal(admin._state.rpcCalls.length, 0);
});

test("insufficient stock → planner stops it, no RPC", async () => {
  const admin = makeAdmin(order());
  const snap = { status: "ok", snapshots: [{ kind: "variant", masterProductId: "p2", masterVariantSku: "V-SKU", variantId: "v1", variantStock: 0, shelves: [] }] };
  const r = await processStoredTalabatOrder(admin, "ord-1", deps({ loadSnapshots: async () => snap }));
  assert.equal(r.outcome, "manual_review:insufficient_stock");
  assert.equal(admin._state.rpcCalls.length, 0);
});

test("snapshot load error → inventory_inconsistent, no RPC", async () => {
  const admin = makeAdmin(order());
  const r = await processStoredTalabatOrder(admin, "ord-1", deps({ loadSnapshots: async () => ({ status: "error" }) }));
  assert.equal(r.outcome, "manual_review:inventory_inconsistent");
  assert.equal(admin._state.rpcCalls.length, 0);
});

test("context error → manual_review context_unavailable, no RPC (fail closed)", async () => {
  const admin = makeAdmin(order());
  const r = await processStoredTalabatOrder(admin, "ord-1", deps({ loadContext: async () => ({ status: "error" }) }));
  assert.equal(r.outcome, "manual_review:context_unavailable");
  assert.equal(admin._state.rpcCalls.length, 0);
});

test("exactly one Talabat channel required — unresolved → manual_review, no RPC", async () => {
  const admin = makeAdmin(order());
  const r = await processStoredTalabatOrder(admin, "ord-1", deps({ loadContext: async () => ({ status: "manual_review", reason: "talabat_channel_unresolved" }) }));
  assert.equal(r.outcome, "manual_review:talabat_channel_unresolved");
  assert.equal(admin._state.rpcCalls.length, 0);
});

test("manual_review RPC result → exactly one safe review task", async () => {
  const admin = makeAdmin(order(), { data: { status: "manual_review", reason: "duplicate_order" }, error: null });
  const r = await processStoredTalabatOrder(admin, "ord-1", deps());
  assert.equal(r.outcome, "manual_review:duplicate_order");
  assert.equal(admin._state.tasks.length, 1);
  const blob = JSON.stringify(admin._state.tasks[0]);
  assert.ok(!/Fatima|55512345|Doha|phone|address|_unparsed/i.test(blob), blob);
  assert.equal(admin._state.tasks[0].payload.orderId, "ord-1");
});

test("duplicate_order RPC result → no task, no failure", async () => {
  const admin = makeAdmin(order(), { data: { status: "duplicate_order" }, error: null });
  const r = await processStoredTalabatOrder(admin, "ord-1", deps());
  assert.equal(r.outcome, "duplicate_order");
  assert.equal(admin._state.tasks.length, 0);
});

test("RPC error but DB already says processed → reconcile, do NOT mark failed", async () => {
  const admin = makeAdmin(order(), (_params: any, state: any) => { state.order.processing_status = "processed"; return Promise.resolve({ data: null, error: { message: "network blip" } }); });
  const r = await processStoredTalabatOrder(admin, "ord-1", deps());
  assert.equal(r.outcome, "reconciled_processed");
  assert.equal(admin._state.order.processing_status, "processed"); // untouched
  assert.ok(!admin._state.updates.some((u: any) => u.processing_status === "failed"));
});

test("RPC error and order still pending → failed with safe reason rpc_failed + task", async () => {
  const admin = makeAdmin(order(), { data: null, error: { message: "SQLSTATE boom" } });
  const r = await processStoredTalabatOrder(admin, "ord-1", deps());
  assert.equal(r.outcome, "failed:rpc_failed");
  assert.equal(admin._state.order.processing_status, "failed");
  const blob = JSON.stringify(admin._state.updates);
  assert.ok(!/SQLSTATE|boom/i.test(blob), blob); // no raw DB error stored
  assert.equal(admin._state.tasks.length, 1);
});

test("RPC throws → treated as ambiguous → reread → failed when still pending", async () => {
  const admin = makeAdmin(order(), () => { throw new Error("thrown"); });
  const r = await processStoredTalabatOrder(admin, "ord-1", deps());
  assert.equal(r.outcome, "failed:rpc_failed");
  assert.equal(admin._state.order.processing_status, "failed");
});

test("duplicate callback on an already-processed order → no-op, no RPC", async () => {
  const admin = makeAdmin(order({ processing_status: "processed" }));
  const r = await processStoredTalabatOrder(admin, "ord-1", deps());
  assert.equal(r.outcome, "noop_processed");
  assert.equal(admin._state.rpcCalls.length, 0);
  assert.equal(admin._state.updates.length, 0);
});

test("a failed order is not auto-processed at this stage → no-op, no RPC", async () => {
  const admin = makeAdmin(order({ processing_status: "failed" }));
  const r = await processStoredTalabatOrder(admin, "ord-1", deps());
  assert.equal(r.outcome, "noop_failed");
  assert.equal(admin._state.rpcCalls.length, 0);
});

test("manual-review task is deduped per internal order id (no duplicate task)", async () => {
  const admin = makeAdmin(order({ event: "order.cancelled" }), undefined, [{ id: "t1", payload: { orderId: "ord-1" } }]);
  await processStoredTalabatOrder(admin, "ord-1", deps());
  assert.equal(admin._state.tasks.length, 0); // existing open task for this order → skip
});
