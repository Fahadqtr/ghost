// Behavioral tests for the server-only Talabat processor. Uses the REAL pure
// Phase 2A.3A layers + a fake admin client (with a strict staff_tasks schema that
// rejects unknown columns) and fake loaders. NO Supabase, NO network, NO stock
// writes. Run under --conditions=react-server (server-only → no-op).
// Run: node --conditions=react-server --experimental-strip-types --test lib/talabat/process-order.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { processStoredTalabatOrder, handleScheduleFailure } from "./process-order.ts";
import { parseTalabatOrderLines, buildTalabatDedupKey } from "./order-lines.ts";
import { resolveTalabatOrder } from "./order-resolver.ts";
import { buildTalabatDeductionPlan, sanitizeResolution } from "./deduction-plan.ts";
import { evaluateDeductGate } from "./event-gate.ts";

// The REAL staff_tasks columns — the fake insert rejects anything else so a test
// can never pass against an invented schema (kind/payload/product_id are gone).
const REAL_STAFF_TASK_COLS = new Set(["title", "description", "assigned_to", "assigned_name", "priority", "due_date", "status", "created_by", "completed_at", "completed_by"]);

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
    updates: [], rpcCalls: [], tasks: [], rpc,
    existingTasks: opts.existingTasks ?? [],
    updateError: opts.updateError ?? false,
    updateZeroRows: opts.updateZeroRows ?? false,
    concurrentStatus: opts.concurrentStatus ?? null,
    taskLookupError: opts.taskLookupError ?? false,
  };
  const admin: any = {
    _state: state,
    from(table: string) {
      let mode = "select"; let patch: any = null; const filters: Record<string, unknown> = {};
      const b: any = {
        select() { return b; },
        update(p: any) { mode = "update"; patch = p; return b; },
        insert(row: any) {
          if (table === "staff_tasks") {
            for (const k of Object.keys(row)) if (!REAL_STAFF_TASK_COLS.has(k)) return Promise.resolve({ error: { message: `unknown column ${k}` } });
            state.tasks.push(row);
            return Promise.resolve({ error: null });
          }
          return Promise.resolve({ error: null });
        },
        eq(c: string, v: unknown) { filters[c] = v; return b; },
        neq() { return b; },
        limit() {
          if (state.taskLookupError) return Promise.resolve({ data: null, error: { message: "boom" } });
          return Promise.resolve({ data: [...state.existingTasks, ...state.tasks], error: null });
        },
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

// ---- gate ------------------------------------------------------------------

test("feature flag false → store_only, no RPC, no status change", async () => {
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

test("event not in allowlist → event_not_allowed, no RPC, exactly one task", async () => {
  const admin = makeAdmin(order({ event: "order.cancelled" }));
  const r = await processStoredTalabatOrder(admin, "ord-1", deps());
  assert.equal(r.outcome, "manual_review:event_not_allowed");
  assert.equal(admin._state.rpcCalls.length, 0);
  assert.equal(admin._state.tasks.length, 1);
});

// ---- resolver / planner stops (no RPC) -------------------------------------

test("weak identity → no RPC", async () => {
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

test("ambiguous mapping → no RPC", async () => {
  const ctx = { status: "ok", channelId: "cT", context: { mappings: [], products: [{ id: "p3", sku: "P3SKU", barcode: "P3BC", title: "Prod Three" }], variants: [{ parentProductId: "p3", sku: "P3-V1", barcode: "P3-V1-BC" }] } };
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

test("insufficient stock → no RPC", async () => {
  const admin = makeAdmin(order());
  const snap = { status: "ok", snapshots: [{ kind: "variant", masterProductId: "p2", masterVariantSku: "V-SKU", variantId: "v1", variantStock: 0, shelves: [] }] };
  const r = await processStoredTalabatOrder(admin, "ord-1", deps({ loadSnapshots: async () => snap }));
  assert.equal(r.outcome, "manual_review:insufficient_stock");
  assert.equal(admin._state.rpcCalls.length, 0);
});

test("snapshot error → inventory_inconsistent, no RPC", async () => {
  const admin = makeAdmin(order());
  const r = await processStoredTalabatOrder(admin, "ord-1", deps({ loadSnapshots: async () => ({ status: "error" }) }));
  assert.equal(r.outcome, "manual_review:inventory_inconsistent");
  assert.equal(admin._state.rpcCalls.length, 0);
});

test("context error → context_unavailable, no RPC (fail closed)", async () => {
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

// ---- staff_tasks schema + dedup --------------------------------------------

test("review task uses ONLY real staff_tasks columns and a description marker (no kind/payload/product_id)", async () => {
  const admin = makeAdmin(order({ event: "order.cancelled" }));
  await processStoredTalabatOrder(admin, "ord-1", deps());
  assert.equal(admin._state.tasks.length, 1); // insert accepted → only real columns used
  const t = admin._state.tasks[0];
  for (const k of Object.keys(t)) assert.ok(REAL_STAFF_TASK_COLS.has(k), `unknown column ${k}`);
  assert.match(t.description, /\[talabat_review_order:ord-1\]/);
  assert.match(t.description, /event_not_allowed/);
  noPII(JSON.stringify(t));
  assert.ok(!/V-SKU|V-BC|PSKU|P3BC/.test(JSON.stringify(t)), "no SKU/barcode in the task");
});

test("existing description marker → no duplicate task (dedupe by marker)", async () => {
  const admin = makeAdmin(order({ event: "order.cancelled" }), undefined, { existingTasks: [{ id: "t0", description: "prev [talabat_review_order:ord-1] ...", status: "open" }] });
  await processStoredTalabatOrder(admin, "ord-1", deps());
  assert.equal(admin._state.tasks.length, 0); // marker already present
});

test("task-lookup query error → no task created (never risk a duplicate)", async () => {
  const admin = makeAdmin(order({ event: "order.cancelled" }), undefined, { taskLookupError: true });
  const r = await processStoredTalabatOrder(admin, "ord-1", deps());
  assert.equal(r.outcome, "manual_review:event_not_allowed"); // still parked
  assert.equal(admin._state.tasks.length, 0);                 // but no task inserted
});

test("duplicate manual_review RPC results create only ONE task (marker dedupe across callbacks)", async () => {
  const admin = makeAdmin(order(), { data: { status: "manual_review", reason: "duplicate_order" }, error: null });
  await processStoredTalabatOrder(admin, "ord-1", deps());
  await processStoredTalabatOrder(admin, "ord-1", deps()); // second callback (order still pending in the fake)
  assert.equal(admin._state.tasks.length, 1);
});

// ---- verified status updates -----------------------------------------------

test("manual-review update ERROR → status_update_failed, no false success, no task", async () => {
  const admin = makeAdmin(order({ event: "order.cancelled" }), undefined, { updateError: true });
  const r = await processStoredTalabatOrder(admin, "ord-1", deps());
  assert.equal(r.outcome, "status_update_failed");
  assert.equal(admin._state.tasks.length, 0);
});

test("manual-review update ZERO rows + DB already processed → reconciled_processed, no task", async () => {
  const admin = makeAdmin(order({ event: "order.cancelled" }), undefined, { updateZeroRows: true, concurrentStatus: "processed" });
  const r = await processStoredTalabatOrder(admin, "ord-1", deps());
  assert.equal(r.outcome, "reconciled_processed");
  assert.equal(admin._state.tasks.length, 0);
});

test("failed update ERROR → status_update_failed (no false failed), no task", async () => {
  const admin = makeAdmin(order(), { data: null, error: { message: "SQLSTATE boom" } }, { updateError: true });
  const r = await processStoredTalabatOrder(admin, "ord-1", deps());
  assert.equal(r.outcome, "status_update_failed");
  assert.equal(admin._state.tasks.length, 0);
});

test("confirmed manual_review → exactly one task; confirmed failed → exactly one task", async () => {
  const mr = makeAdmin(order({ event: "order.cancelled" }));
  await processStoredTalabatOrder(mr, "ord-1", deps());
  assert.equal(mr._state.order.processing_status, "manual_review");
  assert.equal(mr._state.tasks.length, 1);

  const fl = makeAdmin(order(), { data: null, error: { message: "SQLSTATE boom" } });
  const r = await processStoredTalabatOrder(fl, "ord-1", deps());
  assert.equal(r.outcome, "failed:rpc_failed");
  assert.equal(fl._state.order.processing_status, "failed");
  assert.equal(fl._state.tasks.length, 1);
  noPII(JSON.stringify(fl._state.updates));
});

// ---- RPC reconciliation ----------------------------------------------------

test("RPC error but DB already processed → reconcile, do NOT mark failed", async () => {
  const admin = makeAdmin(order(), (_p: any, state: any) => { state.order.processing_status = "processed"; return Promise.resolve({ data: null, error: { message: "network blip" } }); });
  const r = await processStoredTalabatOrder(admin, "ord-1", deps());
  assert.equal(r.outcome, "reconciled_processed");
  assert.ok(!admin._state.updates.some((u: any) => u.processing_status === "failed"));
});

test("RPC throws → treated as ambiguous → reread → failed when still pending", async () => {
  const admin = makeAdmin(order(), () => { throw new Error("thrown"); });
  const r = await processStoredTalabatOrder(admin, "ord-1", deps());
  assert.equal(r.outcome, "failed:rpc_failed");
  assert.equal(admin._state.order.processing_status, "failed");
});

test("duplicate_order RPC result + DB terminal → reconciled (no new write)", async () => {
  const admin = makeAdmin(order(), (_p: any, state: any) => { state.order.processing_status = "manual_review"; return Promise.resolve({ data: { status: "duplicate_order" }, error: null }); });
  const r = await processStoredTalabatOrder(admin, "ord-1", deps());
  assert.equal(r.outcome, "reconciled_manual_review");
});

test("duplicate_order RPC result + still pending → parked manual_review duplicate_order + task", async () => {
  const admin = makeAdmin(order(), { data: { status: "duplicate_order" }, error: null });
  const r = await processStoredTalabatOrder(admin, "ord-1", deps());
  assert.equal(r.outcome, "manual_review:duplicate_order");
  assert.equal(admin._state.order.processing_status, "manual_review");
  assert.equal(admin._state.tasks.length, 1);
});

// ---- no-op guards + schedule failure ---------------------------------------

test("duplicate callback on an already-processed order → no-op, no RPC", async () => {
  const admin = makeAdmin(order({ processing_status: "processed" }));
  const r = await processStoredTalabatOrder(admin, "ord-1", deps());
  assert.equal(r.outcome, "noop_processed");
  assert.equal(admin._state.rpcCalls.length, 0);
  assert.equal(admin._state.updates.length, 0);
});

test("a failed order is not auto-processed → no-op, no RPC", async () => {
  const admin = makeAdmin(order({ processing_status: "failed" }));
  const r = await processStoredTalabatOrder(admin, "ord-1", deps());
  assert.equal(r.outcome, "noop_failed");
  assert.equal(admin._state.rpcCalls.length, 0);
});

test("handleScheduleFailure marks a pending order failed(schedule_failed) + one task, no PII", async () => {
  const admin = makeAdmin(order());
  const r = await handleScheduleFailure(admin, "ord-1", deps());
  assert.equal(r.outcome, "failed:schedule_failed");
  assert.equal(admin._state.order.processing_status, "failed");
  assert.equal(admin._state.tasks.length, 1);
  assert.match(admin._state.tasks[0].description, /schedule_failed/);
  noPII(JSON.stringify(admin._state.updates) + JSON.stringify(admin._state.tasks));
});
