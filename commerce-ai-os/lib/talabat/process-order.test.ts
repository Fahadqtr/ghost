// Behavioral tests for the server-only Talabat processor. Uses the REAL pure
// Phase 2A.3A layers + a fake admin client (strict staff_tasks schema that rejects
// unknown columns and enforces the id PRIMARY KEY) and fake loaders. NO Supabase,
// NO network, NO stock writes. Run under --conditions=react-server.
// Run: node --conditions=react-server --experimental-strip-types --test lib/talabat/process-order.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { processStoredTalabatOrder, handleScheduleFailure, handleUnexpectedProcessingFailure, normalizeTalabatProcessingReason } from "./process-order.ts";
import { parseTalabatOrderLines, buildTalabatDedupKey } from "./order-lines.ts";
import { resolveTalabatOrder } from "./order-resolver.ts";
import { buildTalabatDeductionPlan, sanitizeResolution } from "./deduction-plan.ts";
import { evaluateDeductGate } from "./event-gate.ts";

// The REAL staff_tasks columns a Talabat task may use (id is the PK == order id).
const REAL_STAFF_TASK_COLS = new Set(["id", "title", "description", "assigned_to", "assigned_name", "priority", "status", "created_by"]);

const CTX_OK = {
  status: "ok" as const, channelId: "cT",
  context: {
    mappings: [{ channelProductId: "CP1", exportedSku: "V-SKU", exportedBarcode: "V-BC", masterProductId: "p2", masterVariantSku: "V-SKU", mappingStatus: "active" }],
    products: [{ id: "p2", sku: null, barcode: null, title: "Prod Two" }, { id: "p1", sku: "PSKU", barcode: "PBC", title: "Prod One" }],
    variants: [{ parentProductId: "p2", sku: "V-SKU", barcode: "V-BC" }],
  },
};
const SNAP_OK = { status: "ok" as const, snapshots: [{ kind: "variant", masterProductId: "p2", masterVariantSku: "V-SKU", variantId: "v1", variantStock: 10, shelves: [] }] as any };
const RAW_OK = { order: { code: "OC-1", customer: { name: "Fatima", phone: "+97455512345", address: "Doha" }, items: [{ sku: "V-SKU", quantity: 1, name: "Widget", price: 5 }] } };

function makeAdmin(orderRow: any, rpc?: any, opts: any = {}) {
  const state: any = {
    order: orderRow ? { ...orderRow } : null,
    updates: [], rpcCalls: [], tasks: opts.tasks ? [...opts.tasks] : [], rpc,
    updateError: opts.updateError ?? false,
    updateZeroRows: opts.updateZeroRows ?? false,
    concurrentStatus: opts.concurrentStatus ?? null,
    upsertError: opts.upsertError ?? null,
  };
  const admin: any = {
    _state: state,
    from(table: string) {
      let mode = "select"; let patch: any = null; const filters: Record<string, unknown> = {};
      const b: any = {
        select() { return b; },
        update(p: any) { mode = "update"; patch = p; return b; },
        upsert(row: any) {
          if (table === "staff_tasks") {
            for (const k of Object.keys(row)) if (!REAL_STAFF_TASK_COLS.has(k)) return Promise.resolve({ error: { message: `unknown column ${k}` } });
            if (state.upsertError) return Promise.resolve({ error: state.upsertError });
            if (state.tasks.some((t: any) => t.id === row.id)) return Promise.resolve({ error: null }); // PK + ignoreDuplicates → no-op
            state.tasks.push(row);
            return Promise.resolve({ error: null });
          }
          return Promise.resolve({ error: null });
        },
        eq(c: string, v: unknown) { filters[c] = v; return b; },
        single() {
          if (table === "talabat_orders") return Promise.resolve({ data: state.order ? { ...state.order } : null, error: state.order ? null : { message: "nf" } });
          return Promise.resolve({ data: null, error: null });
        },
        then(resolve: (v: any) => void) {
          if (mode === "update" && table === "talabat_orders" && state.order) {
            if (state.updateError) return resolve({ data: null, error: { message: "update boom" } });
            if (state.updateZeroRows) { if (state.concurrentStatus) state.order.processing_status = state.concurrentStatus; return resolve({ data: [], error: null }); }
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
const noPII = (blob: string) => assert.ok(!/Fatima|55512345|Doha|phone|address|customer|_unparsed|SQLSTATE|boom|update boom/i.test(blob), blob);

// ---- reason whitelist -------------------------------------------------------

test("normalizeTalabatProcessingReason: known passthrough, unknown → processing_failed", () => {
  for (const r of ["event_not_allowed", "weak_order_identity", "duplicate_order", "rpc_failed", "schedule_failed", "processing_failed", "inventory_inconsistent"]) {
    assert.equal(normalizeTalabatProcessingReason(r), r);
  }
  for (const bad of ["DROP TABLE", "", null, undefined, 42, { a: 1 }, "Order.Placed"]) {
    assert.equal(normalizeTalabatProcessingReason(bad), "processing_failed", `bad=${String(bad)}`);
  }
});

// ---- happy path + RPC hygiene ----------------------------------------------

test("ready plan → RPC invoked exactly once; processed → no task", async () => {
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
  noPII(JSON.stringify(params));
  assert.equal(params.p_order_id, "ord-1");
  assert.equal(params.p_dedup_key, "talabat:oc-1");
});

// ---- gate + resolver/planner stops (no RPC) --------------------------------

test("feature flag false → store_only, no RPC", async () => {
  const admin = makeAdmin(order());
  const r = await processStoredTalabatOrder(admin, "ord-1", deps({ enabledFlag: "false" }));
  assert.equal(r.outcome, "store_only");
  assert.equal(admin._state.rpcCalls.length, 0);
});

test("event not allowed → event_not_allowed, no RPC, exactly one task keyed by order id", async () => {
  const admin = makeAdmin(order({ event: "order.cancelled" }));
  const r = await processStoredTalabatOrder(admin, "ord-1", deps());
  assert.equal(r.outcome, "manual_review:event_not_allowed");
  assert.equal(admin._state.rpcCalls.length, 0);
  assert.equal(admin._state.tasks.length, 1);
  assert.equal(admin._state.tasks[0].id, "ord-1"); // task PK == order id
});

test("weak identity → no RPC", async () => {
  const admin = makeAdmin(order({ raw: { items: [{ sku: "V-SKU", quantity: 1 }] }, order_code: null }));
  assert.equal((await processStoredTalabatOrder(admin, "ord-1", deps())).outcome, "manual_review:weak_order_identity");
  assert.equal(admin._state.rpcCalls.length, 0);
});

test("empty order → no RPC", async () => {
  const admin = makeAdmin(order({ raw: { order: { code: "OC-2", items: [] } } }));
  assert.equal((await processStoredTalabatOrder(admin, "ord-1", deps())).outcome, "manual_review:empty_order");
});

test("inactive mapping → no RPC", async () => {
  const ctx = { status: "ok", channelId: "cT", context: { ...CTX_OK.context, mappings: [{ ...CTX_OK.context.mappings[0], mappingStatus: "archived" }] } };
  const admin = makeAdmin(order());
  assert.equal((await processStoredTalabatOrder(admin, "ord-1", deps({ loadContext: async () => ctx }))).outcome, "manual_review:inactive_mapping");
  assert.equal(admin._state.rpcCalls.length, 0);
});

test("title-only → no RPC", async () => {
  const admin = makeAdmin(order({ raw: { order: { code: "OC-4", items: [{ title: "Prod One", quantity: 1 }] } } }));
  assert.equal((await processStoredTalabatOrder(admin, "ord-1", deps())).outcome, "manual_review:title_only_match");
});

test("insufficient stock → no RPC", async () => {
  const admin = makeAdmin(order());
  const snap = { status: "ok", snapshots: [{ kind: "variant", masterProductId: "p2", masterVariantSku: "V-SKU", variantId: "v1", variantStock: 0, shelves: [] }] };
  assert.equal((await processStoredTalabatOrder(admin, "ord-1", deps({ loadSnapshots: async () => snap }))).outcome, "manual_review:insufficient_stock");
  assert.equal(admin._state.rpcCalls.length, 0);
});

test("snapshot error → inventory_inconsistent; context error → context_unavailable; channel unresolved → talabat_channel_unresolved (all no RPC)", async () => {
  const a1 = makeAdmin(order());
  assert.equal((await processStoredTalabatOrder(a1, "ord-1", deps({ loadSnapshots: async () => ({ status: "error" }) }))).outcome, "manual_review:inventory_inconsistent");
  const a2 = makeAdmin(order());
  assert.equal((await processStoredTalabatOrder(a2, "ord-1", deps({ loadContext: async () => ({ status: "error" }) }))).outcome, "manual_review:context_unavailable");
  const a3 = makeAdmin(order());
  assert.equal((await processStoredTalabatOrder(a3, "ord-1", deps({ loadContext: async () => ({ status: "manual_review", reason: "talabat_channel_unresolved" }) }))).outcome, "manual_review:talabat_channel_unresolved");
});

// ---- atomic task dedupe (PK == order id) -----------------------------------

test("review task uses only real columns, id == order id, marker + classified reason, no PII/SKU", async () => {
  const admin = makeAdmin(order({ event: "order.cancelled" }));
  await processStoredTalabatOrder(admin, "ord-1", deps());
  const t = admin._state.tasks[0];
  for (const k of Object.keys(t)) assert.ok(REAL_STAFF_TASK_COLS.has(k), `unknown column ${k}`);
  assert.equal(t.id, "ord-1");
  assert.match(t.description, /\[talabat_review_order:ord-1\]/);
  assert.match(t.description, /event_not_allowed/);
  noPII(JSON.stringify(t));
  assert.ok(!/V-SKU|V-BC|PSKU|P3BC|OC-1/.test(JSON.stringify(t)), "no SKU/barcode/orderCode in the task");
});

test("two schedule-failure callbacks for the same order use the same task id → one task", async () => {
  const admin = makeAdmin(order());
  await handleScheduleFailure(admin, "ord-1", deps()); // marks failed + task id=ord-1
  await handleScheduleFailure(admin, "ord-1", deps()); // order already failed → upsert same id → no-op
  assert.equal(admin._state.tasks.length, 1);
  assert.equal(admin._state.tasks[0].id, "ord-1");
});

test("a COMPLETED existing task (same id) is not duplicated", async () => {
  const admin = makeAdmin(order({ event: "order.cancelled" }), undefined, { tasks: [{ id: "ord-1", status: "done", title: "old", description: "[talabat_review_order:ord-1]" }] });
  await processStoredTalabatOrder(admin, "ord-1", deps());
  assert.equal(admin._state.tasks.length, 1); // PK conflict → ignored
});

test("different orders create different task ids", async () => {
  const a = makeAdmin(order({ id: "ord-A", event: "order.cancelled" }));
  await processStoredTalabatOrder(a, "ord-A", deps());
  const b = makeAdmin(order({ id: "ord-B", event: "order.cancelled" }));
  await processStoredTalabatOrder(b, "ord-B", deps());
  assert.equal(a._state.tasks[0].id, "ord-A");
  assert.equal(b._state.tasks[0].id, "ord-B");
});

test("a 23505 upsert conflict is treated as already-exists (no crash, no raw error)", async () => {
  const admin = makeAdmin(order({ event: "order.cancelled" }), undefined, { upsertError: { code: "23505", message: "duplicate key value" } });
  const r = await processStoredTalabatOrder(admin, "ord-1", deps());
  assert.equal(r.outcome, "manual_review:event_not_allowed"); // order still parked; task op did not throw
});

// ---- verified status updates -----------------------------------------------

test("manual-review update ERROR → status_update_failed, no false success, no task", async () => {
  const admin = makeAdmin(order({ event: "order.cancelled" }), undefined, { updateError: true });
  const r = await processStoredTalabatOrder(admin, "ord-1", deps());
  assert.equal(r.outcome, "status_update_failed");
  assert.equal(admin._state.tasks.length, 0);
});

test("manual-review update ZERO rows + DB processed → reconciled_processed, no task", async () => {
  const admin = makeAdmin(order({ event: "order.cancelled" }), undefined, { updateZeroRows: true, concurrentStatus: "processed" });
  const r = await processStoredTalabatOrder(admin, "ord-1", deps());
  assert.equal(r.outcome, "reconciled_processed");
  assert.equal(admin._state.tasks.length, 0);
});

test("parkManualReview with already_failed → reconciled_failed, NO new task, prior reason kept", async () => {
  const admin = makeAdmin(order({ event: "order.cancelled" }), undefined, { updateZeroRows: true, concurrentStatus: "failed" });
  const r = await processStoredTalabatOrder(admin, "ord-1", deps());
  assert.equal(r.outcome, "reconciled_failed");
  assert.equal(admin._state.tasks.length, 0);
});

test("confirmed failed (rpc error, still pending) → exactly one task, no raw error", async () => {
  const admin = makeAdmin(order(), { data: null, error: { message: "SQLSTATE boom" } });
  const r = await processStoredTalabatOrder(admin, "ord-1", deps());
  assert.equal(r.outcome, "failed:rpc_failed");
  assert.equal(admin._state.order.processing_status, "failed");
  assert.equal(admin._state.tasks.length, 1);
  noPII(JSON.stringify(admin._state.updates));
});

// ---- RPC manual_review verification -----------------------------------------

test("RPC manual_review + DB manual_review → one task with the (normalized) reason", async () => {
  const admin = makeAdmin(order(), (_p: any, state: any) => { state.order.processing_status = "manual_review"; return Promise.resolve({ data: { status: "manual_review", reason: "duplicate_order" }, error: null }); });
  const r = await processStoredTalabatOrder(admin, "ord-1", deps());
  assert.equal(r.outcome, "manual_review:duplicate_order");
  assert.equal(admin._state.tasks.length, 1);
});

test("RPC manual_review + DB processed → no task (processed is truth)", async () => {
  const admin = makeAdmin(order(), (_p: any, state: any) => { state.order.processing_status = "processed"; return Promise.resolve({ data: { status: "manual_review", reason: "x" }, error: null }); });
  const r = await processStoredTalabatOrder(admin, "ord-1", deps());
  assert.equal(r.outcome, "reconciled_processed");
  assert.equal(admin._state.tasks.length, 0);
});

test("RPC manual_review + DB still pending → parkManualReview (verified) + task", async () => {
  const admin = makeAdmin(order(), { data: { status: "manual_review", reason: "inventory_inconsistent" }, error: null });
  const r = await processStoredTalabatOrder(admin, "ord-1", deps());
  assert.equal(r.outcome, "manual_review:inventory_inconsistent");
  assert.equal(admin._state.order.processing_status, "manual_review");
  assert.equal(admin._state.tasks.length, 1);
});

test("an arbitrary rpc.data.reason is normalized to processing_failed (never leaks into the task)", async () => {
  const admin = makeAdmin(order(), { data: { status: "manual_review", reason: "EVIL; DROP TABLE staff_tasks" }, error: null });
  const r = await processStoredTalabatOrder(admin, "ord-1", deps());
  assert.equal(r.outcome, "manual_review:processing_failed");
  assert.ok(!/EVIL|DROP TABLE/.test(JSON.stringify(admin._state.tasks)), "arbitrary reason must not reach the task");
});

test("duplicate_order RPC + still pending → parked manual_review duplicate_order + task", async () => {
  const admin = makeAdmin(order(), { data: { status: "duplicate_order" }, error: null });
  const r = await processStoredTalabatOrder(admin, "ord-1", deps());
  assert.equal(r.outcome, "manual_review:duplicate_order");
  assert.equal(admin._state.tasks.length, 1);
});

test("RPC error but DB already processed → reconcile, do NOT mark failed", async () => {
  const admin = makeAdmin(order(), (_p: any, state: any) => { state.order.processing_status = "processed"; return Promise.resolve({ data: null, error: { message: "network blip" } }); });
  const r = await processStoredTalabatOrder(admin, "ord-1", deps());
  assert.equal(r.outcome, "reconciled_processed");
  assert.ok(!admin._state.updates.some((u: any) => u.processing_status === "failed"));
});

// ---- unexpected processing failure -----------------------------------------

test("parseLines throws → failed/processing_failed (never leaves pending)", async () => {
  const admin = makeAdmin(order());
  const r = await processStoredTalabatOrder(admin, "ord-1", deps({ parseLines: () => { throw new Error("parse blew up: raw customer Fatima"); } }));
  assert.equal(r.outcome, "failed:processing_failed");
  assert.equal(admin._state.order.processing_status, "failed");
  noPII(JSON.stringify(admin._state.updates) + JSON.stringify(admin._state.tasks));
});

test("resolveOrder throws → failed/processing_failed", async () => {
  const admin = makeAdmin(order());
  const r = await processStoredTalabatOrder(admin, "ord-1", deps({ resolveOrder: () => { throw new Error("resolve boom"); } }));
  assert.equal(r.outcome, "failed:processing_failed");
});

test("buildPlan throws → failed/processing_failed", async () => {
  const admin = makeAdmin(order());
  const r = await processStoredTalabatOrder(admin, "ord-1", deps({ buildPlan: () => { throw new Error("plan boom"); } }));
  assert.equal(r.outcome, "failed:processing_failed");
});

test("handleUnexpectedProcessingFailure: pending → failed/processing_failed + task", async () => {
  const admin = makeAdmin(order());
  const r = await handleUnexpectedProcessingFailure(admin, "ord-1", deps());
  assert.equal(r.outcome, "failed:processing_failed");
  assert.equal(admin._state.order.processing_status, "failed");
  assert.equal(admin._state.tasks.length, 1);
});

test("handleUnexpectedProcessingFailure: DB already processed → untouched, no task", async () => {
  const admin = makeAdmin(order({ processing_status: "processed" }));
  const r = await handleUnexpectedProcessingFailure(admin, "ord-1", deps());
  assert.equal(r.outcome, "reconciled_processed");
  assert.equal(admin._state.updates.length, 0);
  assert.equal(admin._state.tasks.length, 0);
});

// ---- no-op guards -----------------------------------------------------------

test("already-processed order → no-op, no RPC; failed order → no-op", async () => {
  const p = makeAdmin(order({ processing_status: "processed" }));
  assert.equal((await processStoredTalabatOrder(p, "ord-1", deps())).outcome, "noop_processed");
  assert.equal(p._state.rpcCalls.length, 0);
  const f = makeAdmin(order({ processing_status: "failed" }));
  assert.equal((await processStoredTalabatOrder(f, "ord-1", deps())).outcome, "noop_failed");
});
