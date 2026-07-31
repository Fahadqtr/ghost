// Server-only Talabat order PROCESSOR (orchestration). The browser can never
// reach it: it is only invoked from the webhook's request-scoped after()
// callback in app/api/webhooks/talabat/[token]/route.ts. It re-reads the stored
// order from the DB by internal id (never trusts a raw payload from a closure)
// and drives the Phase 2A.3A pure layers to a single atomic RPC call.
//
// Every collaborator (pure layers, context/snapshot loaders, gate, admin client)
// is DEPENDENCY-INJECTED, and only TYPES are imported from siblings (erased at
// runtime), so this stays self-contained and node:test can drive it with fakes.
//
// Fail-closed everywhere: it deducts ONLY when the flag+event gate passes, the
// dedup identity is strong, the resolver fully resolves, the context is complete,
// and the planner returns "ready". The RPC is the sole arbiter of dedup and
// concurrency; this module performs NO stock writes. No raw payload / customer
// PII / DB error text is ever stored in resolution or a review task, or logged.

import type { ContextResult } from "./resolution-context";
import type { SnapshotResult, SnapshotTarget } from "./stock-snapshots";
import type { DeductGateDecision } from "./event-gate";

export interface StoredOrder {
  id: string;
  processing_status: string;
  raw: any;
  event: string | null;
  order_code: string | null;
}

export interface ProcessOrderDeps {
  // env-derived flags
  enabledFlag: unknown;
  allowlistRaw: unknown;
  // pure Phase 2A.3A layers
  parseLines: (payload: any) => { orderCode: string | null; event: string | null; reference: string | null; createdAt: string | null; lines: any[] };
  buildDedupKey: (parsed: any) => { key: string; confidence: "strong" | "weak" };
  resolveOrder: (lines: any[], ctx: any, opts: { dedupConfidence: "strong" | "weak" }) => any;
  buildPlan: (targets: any[], stock: any[]) => any;
  sanitize: (r: unknown) => Record<string, unknown>;
  evaluateGate: (args: { enabledFlag: unknown; allowlistRaw: unknown; event: unknown }) => DeductGateDecision;
  // server loaders (DI'd)
  loadContext: (admin: any) => Promise<ContextResult>;
  loadSnapshots: (admin: any, targets: SnapshotTarget[]) => Promise<SnapshotResult>;
  // clock (injectable for determinism)
  nowIso?: () => string;
}

const nowIsoDefault = () => new Date().toISOString();
const log = (stage: string, orderId: string) => console.error(`[talabat-processing] stage failed order=${orderId} stage=${stage}`);

/** Read the stored order by internal id. Returns null on any error / not found. */
async function readOrder(admin: any, orderId: string): Promise<StoredOrder | null> {
  try {
    const { data, error } = await admin
      .from("talabat_orders")
      .select("id, processing_status, raw, event, order_code")
      .eq("id", orderId)
      .single();
    if (error || !data) return null;
    return data as StoredOrder;
  } catch {
    return null;
  }
}

/** Mark the order manual_review ONLY while it is still pending (never overwrite a
 *  processed/manual_review row, never write a dedup key from TS). Best-effort. */
async function markManualReview(admin: any, orderId: string, resolution: Record<string, unknown>, nowIso: () => string): Promise<void> {
  try {
    await admin
      .from("talabat_orders")
      .update({ processing_status: "manual_review", processed_at: nowIso(), resolution })
      .eq("id", orderId)
      .eq("processing_status", "pending")
      .select("id");
  } catch {
    log("mark_manual_review", orderId);
  }
}

/** Mark the order failed ONLY while it is still pending. Best-effort. */
async function markFailed(admin: any, orderId: string, resolution: Record<string, unknown>, nowIso: () => string): Promise<void> {
  try {
    await admin
      .from("talabat_orders")
      .update({ processing_status: "failed", processed_at: nowIso(), resolution })
      .eq("id", orderId)
      .eq("processing_status", "pending")
      .select("id");
  } catch {
    log("mark_failed", orderId);
  }
}

/**
 * Open ONE safe manual-review task for the order (kind='talabat_review'), deduped
 * per internal order id. Best-effort: a task failure never changes the order's
 * outcome. The payload carries only classified, non-PII fields.
 */
async function createReviewTask(
  admin: any,
  args: { orderId: string; orderCode: string | null; reason: string; lineKeys: string[] },
): Promise<void> {
  try {
    // Dedup against existing open talabat_review tasks for this internal order id.
    const { data: existing } = await admin
      .from("staff_tasks")
      .select("id, payload")
      .eq("kind", "talabat_review")
      .neq("status", "done")
      .limit(50);
    if (((existing ?? []) as { payload?: { orderId?: string } }[]).some((t) => t?.payload?.orderId === args.orderId)) return;

    const payload = {
      kind: "talabat_review",
      orderId: args.orderId,
      orderCode: args.orderCode ?? null,
      reason: args.reason,
      lineKeys: args.lineKeys ?? [],
    };
    const row: Record<string, unknown> = {
      title: `🔴 مراجعة طلب Talabat — ${args.reason}`.slice(0, 200),
      description: `طلب Talabat يحتاج مراجعة يدوية.\nالسبب: ${args.reason}\nرقم الطلب الداخلي: ${args.orderId}`.slice(0, 4000),
      assigned_to: null,
      assigned_name: null,
      priority: "high",
      status: "open",
      created_by: "talabat",
      kind: "talabat_review",
      product_id: null,
      payload,
    };
    // Tiered fallback so a review task is never lost on a pre-migration table.
    let { error } = await admin.from("staff_tasks").insert(row);
    if (error) {
      const { payload: _pl, ...noPayload } = row;
      ({ error } = await admin.from("staff_tasks").insert(noPayload));
    }
    if (error) {
      const { kind: _k, product_id: _p, payload: _pl2, ...legacy } = row;
      ({ error } = await admin.from("staff_tasks").insert(legacy));
    }
    if (error) log("review_task", args.orderId);
  } catch {
    log("review_task", args.orderId);
  }
}

/** Re-read only the processing_status (used to reconcile after an ambiguous RPC). */
async function rereadStatus(admin: any, orderId: string): Promise<string | null> {
  try {
    const { data, error } = await admin.from("talabat_orders").select("processing_status").eq("id", orderId).single();
    if (error || !data) return null;
    return String(data.processing_status ?? "") || null;
  } catch {
    return null;
  }
}

/**
 * Process ONE stored Talabat order. No-op unless it is still "pending".
 * Returns a small classified outcome (handy for tests/telemetry) — never PII.
 */
export async function processStoredTalabatOrder(
  admin: any,
  orderId: string,
  deps: ProcessOrderDeps,
): Promise<{ outcome: string }> {
  const nowIso = deps.nowIso ?? nowIsoDefault;

  const order = await readOrder(admin, orderId);
  if (!order) { log("read", orderId); return { outcome: "read_failed" }; }

  // Idempotency: only a still-pending order is processed. failed is NOT retried
  // here; processed/manual_review are terminal. The RPC remains the final arbiter.
  if (order.processing_status !== "pending") return { outcome: `noop_${order.processing_status}` };

  // 1) Event gate — closed by default.
  const gate = deps.evaluateGate({ enabledFlag: deps.enabledFlag, allowlistRaw: deps.allowlistRaw, event: order.event });
  if (gate.action === "store_only") return { outcome: "store_only" };
  if (gate.action === "manual_review") {
    const resolution = deps.sanitize({ reason: gate.reason, method: "auto" });
    await markManualReview(admin, orderId, resolution, nowIso);
    await createReviewTask(admin, { orderId, orderCode: order.order_code, reason: gate.reason, lineKeys: [] });
    return { outcome: `manual_review:${gate.reason}` };
  }

  // 2) Parse structured lines + dedup identity from the STORED raw payload.
  const parsed = deps.parseLines(order.raw);
  const dedup = deps.buildDedupKey(parsed);

  // 3) Exact Talabat channel + resolution context.
  const ctx = await deps.loadContext(admin);
  if (ctx.status === "error") {
    const resolution = deps.sanitize({ reason: "context_unavailable", method: "auto" });
    await markManualReview(admin, orderId, resolution, nowIso);
    await createReviewTask(admin, { orderId, orderCode: order.order_code, reason: "context_unavailable", lineKeys: [] });
    return { outcome: "manual_review:context_unavailable" };
  }
  if (ctx.status === "manual_review") {
    const resolution = deps.sanitize({ reason: ctx.reason, method: "auto" });
    await markManualReview(admin, orderId, resolution, nowIso);
    await createReviewTask(admin, { orderId, orderCode: order.order_code, reason: ctx.reason, lineKeys: [] });
    return { outcome: `manual_review:${ctx.reason}` };
  }

  // 4) Resolve (a weak identity, empty order, or any unresolved line stops here).
  const resolved = deps.resolveOrder(parsed.lines, ctx.context, { dedupConfidence: dedup.confidence });
  if (resolved.status !== "resolved") {
    const reason = String(resolved.reason ?? "manual_review");
    const resolution = deps.sanitize({ ...(resolved.resolution ?? {}), reason, method: "auto" });
    await markManualReview(admin, orderId, resolution, nowIso);
    await createReviewTask(admin, { orderId, orderCode: order.order_code, reason, lineKeys: reviewLineKeys(resolved.resolution) });
    return { outcome: `manual_review:${reason}` };
  }

  // 5) Stock snapshots for the resolved targets only.
  const targets: SnapshotTarget[] = (resolved.targets ?? []).map((t: any) => ({ masterProductId: t.masterProductId, masterVariantSku: t.masterVariantSku }));
  const snap = await deps.loadSnapshots(admin, targets);
  if (snap.status === "error") {
    const resolution = deps.sanitize({ reason: "inventory_inconsistent", method: "auto" });
    await markManualReview(admin, orderId, resolution, nowIso);
    await createReviewTask(admin, { orderId, orderCode: order.order_code, reason: "inventory_inconsistent", lineKeys: [] });
    return { outcome: "manual_review:inventory_inconsistent" };
  }

  // 6) Final pre-RPC plan (last classifier before any deduction).
  const planTargets = (resolved.targets ?? []).map((t: any) => ({
    masterProductId: t.masterProductId, masterVariantSku: t.masterVariantSku, quantity: t.quantity, lineKeys: t.lineKeys,
  }));
  const plan = deps.buildPlan(planTargets, snap.snapshots);
  if (plan.status !== "ready") {
    const reason = String(plan.reason ?? "manual_review");
    const resolution = deps.sanitize({ ...(resolved.resolution ?? {}), reason, method: "auto" });
    await markManualReview(admin, orderId, resolution, nowIso);
    await createReviewTask(admin, { orderId, orderCode: order.order_code, reason, lineKeys: reviewLineKeys(resolved.resolution) });
    return { outcome: `manual_review:${reason}` };
  }

  // 7) One atomic RPC call. p_resolution is the deep-safe classified projection —
  //    never the raw payload or any customer data.
  const pResolution = deps.sanitize({ lines: resolved.resolution?.lines, targets: resolved.resolution?.targets, method: "auto" });
  let rpc: { data: any; error: any } | null = null;
  try {
    rpc = await admin.rpc("process_talabat_order_deduction", {
      p_order_id: orderId,
      p_dedup_key: dedup.key,
      p_plan: plan,
      p_resolution: pResolution,
    });
  } catch {
    rpc = null; // thrown → treated as ambiguous below
  }

  // 8) Reconcile ONLY classified outcomes; never store a raw error.
  if (!rpc || rpc.error || !rpc.data) {
    // Ambiguous / network / thrown: the DB is the source of truth.
    const state = await rereadStatus(admin, orderId);
    if (state === "processed" || state === "manual_review") return { outcome: `reconciled_${state}` };
    // Still pending (or unreadable) → mark failed with a SAFE reason.
    await markFailed(admin, orderId, deps.sanitize({ reason: "rpc_failed", method: "auto" }), nowIso);
    await createReviewTask(admin, { orderId, orderCode: order.order_code, reason: "rpc_failed", lineKeys: [] });
    return { outcome: "failed:rpc_failed" };
  }

  const status = String(rpc.data.status ?? "");
  if (status === "processed") return { outcome: "processed" };
  if (status === "manual_review") {
    // The RPC already set status+resolution atomically — just open one safe task.
    await createReviewTask(admin, { orderId, orderCode: order.order_code, reason: String(rpc.data.reason ?? "manual_review"), lineKeys: [] });
    return { outcome: `manual_review:${rpc.data.reason ?? "manual_review"}` };
  }
  if (status === "duplicate_order") return { outcome: "duplicate_order" };
  // status === 'error' (missing_dedup_key/order_not_found/…): reconcile like an ambiguous failure.
  const state = await rereadStatus(admin, orderId);
  if (state === "processed" || state === "manual_review") return { outcome: `reconciled_${state}` };
  await markFailed(admin, orderId, deps.sanitize({ reason: "rpc_failed", method: "auto" }), nowIso);
  await createReviewTask(admin, { orderId, orderCode: order.order_code, reason: "rpc_failed", lineKeys: [] });
  return { outcome: "failed:rpc_failed" };
}

/** Extract only line keys (strings) from a resolver resolution — never any PII. */
function reviewLineKeys(resolution: any): string[] {
  const out: string[] = [];
  const reasons = Array.isArray(resolution?.reasons) ? resolution.reasons : [];
  for (const r of reasons) if (typeof r?.lineKey === "string") out.push(r.lineKey);
  return out;
}
