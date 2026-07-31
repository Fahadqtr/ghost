// Server-only Talabat order PROCESSOR (orchestration). SERVER-ONLY: the browser
// can never reach it — it is invoked only from the webhook's request-scoped
// after() callback (route.ts). It re-reads the stored order by internal id (never
// trusts a raw payload from a closure) and drives the Phase 2A.3A pure layers to a
// single atomic RPC call.
//
// Every collaborator is DEPENDENCY-INJECTED and only TYPES are imported from
// siblings (erased at runtime), so node:test — run under --conditions=react-server
// where server-only is a no-op — can drive it with fakes.
//
// Fail-closed everywhere: it deducts ONLY when the flag+event gate passes, the
// dedup identity is strong, the resolver fully resolves, the context is complete,
// and the planner returns "ready". The RPC is the sole arbiter of dedup and
// concurrency; this module performs NO stock writes. Every status update is
// VERIFIED (error + affected-row count, re-reading the DB on a zero-row update),
// and a manual-review task is opened ONLY after the DB state is confirmed. No raw
// payload / customer PII / DB error text ever enters resolution, a task, or a log.

import "server-only";
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
  enabledFlag: unknown;
  allowlistRaw: unknown;
  parseLines: (payload: any) => { orderCode: string | null; event: string | null; reference: string | null; createdAt: string | null; lines: any[] };
  buildDedupKey: (parsed: any) => { key: string; confidence: "strong" | "weak" };
  resolveOrder: (lines: any[], ctx: any, opts: { dedupConfidence: "strong" | "weak" }) => any;
  buildPlan: (targets: any[], stock: any[]) => any;
  sanitize: (r: unknown) => Record<string, unknown>;
  evaluateGate: (args: { enabledFlag: unknown; allowlistRaw: unknown; event: unknown }) => DeductGateDecision;
  loadContext: (admin: any) => Promise<ContextResult>;
  loadSnapshots: (admin: any, targets: SnapshotTarget[]) => Promise<SnapshotResult>;
  nowIso?: () => string;
}

type UpdateOutcome = "updated" | "already_processed" | "already_manual_review" | "already_failed" | "status_update_failed";

const nowIsoDefault = () => new Date().toISOString();
const log = (stage: string, orderId: string) => console.error(`[talabat-processing] stage failed order=${orderId} stage=${stage}`);

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

/** Re-read only the processing_status (used to reconcile updates / ambiguous RPC). */
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
 * Move a still-pending order to `targetStatus`, VERIFYING the write: inspect the
 * error and the number of returned rows; on a zero-row update, re-read the DB to
 * learn the actual current state. Never claims success it did not confirm, and
 * never writes a dedup key from TS.
 */
async function markStatus(
  admin: any, orderId: string, targetStatus: "manual_review" | "failed", resolution: Record<string, unknown>, nowIso: () => string,
): Promise<UpdateOutcome> {
  try {
    const { data, error } = await admin
      .from("talabat_orders")
      .update({ processing_status: targetStatus, processed_at: nowIso(), resolution })
      .eq("id", orderId)
      .eq("processing_status", "pending")
      .select("id");
    if (error) return "status_update_failed";
    if (Array.isArray(data) && data.length === 1) return "updated";
    // Zero rows changed → confirm the real state before claiming anything.
    const st = await rereadStatus(admin, orderId);
    if (st === "processed") return "already_processed";
    if (st === "manual_review") return "already_manual_review";
    if (st === "failed") return "already_failed";
    return "status_update_failed";
  } catch {
    return "status_update_failed";
  }
}

/**
 * Open ONE safe manual-review task for the order, deduped by an internal-id marker
 * embedded in the description. staff_tasks has ONLY the base columns
 * (title/description/priority/status/created_by/…) — no kind/payload/product_id —
 * so nothing else is written. The description carries no raw/PII/token/SKU/
 * customer/orderCode: just the internal UUID marker and the classified reason.
 * Best-effort: a lookup error is logged and NO task is created (so a duplicate is
 * never risked).
 */
async function createReviewTask(admin: any, args: { orderId: string; reason: string }): Promise<void> {
  const marker = `[talabat_review_order:${args.orderId}]`;
  let existing: any[];
  try {
    const { data, error } = await admin.from("staff_tasks").select("id, description, status").neq("status", "done").limit(200);
    if (error) { log("review_task_lookup", args.orderId); return; }
    existing = data ?? [];
  } catch {
    log("review_task_lookup", args.orderId);
    return;
  }
  if (existing.some((t) => typeof t?.description === "string" && t.description.includes(marker))) return; // already open

  try {
    const { error } = await admin.from("staff_tasks").insert({
      title: "🔴 مراجعة طلب Talabat",
      description: `${marker}\nنوع المهمة: talabat_review\nالسبب: ${args.reason}`,
      assigned_to: null,
      assigned_name: null,
      priority: "high",
      status: "open",
      created_by: "talabat",
    });
    if (error) log("review_task", args.orderId);
  } catch {
    log("review_task", args.orderId);
  }
}

/** Park a pending order in manual_review with a safe reason, then (only after the
 *  DB confirms a review-worthy state) open one task. Never touches a processed row. */
async function parkManualReview(
  admin: any, orderId: string, reason: string, resolution: Record<string, unknown>, nowIso: () => string,
): Promise<{ outcome: string }> {
  const res = await markStatus(admin, orderId, "manual_review", resolution, nowIso);
  if (res === "already_processed") return { outcome: "reconciled_processed" };
  if (res === "status_update_failed") return { outcome: "status_update_failed" };
  // updated / already_manual_review / already_failed → a confirmed non-pending, review-worthy state.
  await createReviewTask(admin, { orderId, reason });
  return { outcome: res === "already_failed" ? `reconciled_failed:${reason}` : `manual_review:${reason}` };
}

/** Park a pending order as failed with a safe reason, then (only after confirming
 *  the failed state) open one task. Never overwrites processed/manual_review. */
async function parkFailed(
  admin: any, orderId: string, reason: string, resolution: Record<string, unknown>, nowIso: () => string,
): Promise<{ outcome: string }> {
  const res = await markStatus(admin, orderId, "failed", resolution, nowIso);
  if (res === "already_processed") return { outcome: "reconciled_processed" };
  if (res === "already_manual_review") return { outcome: "reconciled_manual_review" };
  if (res === "status_update_failed") return { outcome: "status_update_failed" };
  // updated / already_failed → confirmed failed.
  await createReviewTask(admin, { orderId, reason });
  return { outcome: `failed:${reason}` };
}

/**
 * Handle a failure to REGISTER the after() callback: the order must not be left
 * silently pending. Mark it failed (schedule_failed), verified, and open a task
 * once confirmed. Exposed so the webhook adapter can call it synchronously.
 */
export async function handleScheduleFailure(admin: any, orderId: string, deps: ProcessOrderDeps): Promise<{ outcome: string }> {
  const nowIso = deps.nowIso ?? nowIsoDefault;
  return parkFailed(admin, orderId, "schedule_failed", deps.sanitize({ reason: "schedule_failed", method: "auto" }), nowIso);
}

/**
 * Process ONE stored Talabat order. No-op unless it is still "pending".
 * Returns a small classified outcome (for tests/telemetry) — never PII.
 */
export async function processStoredTalabatOrder(
  admin: any, orderId: string, deps: ProcessOrderDeps,
): Promise<{ outcome: string }> {
  const nowIso = deps.nowIso ?? nowIsoDefault;

  const order = await readOrder(admin, orderId);
  if (!order) { log("read", orderId); return { outcome: "read_failed" }; }
  if (order.processing_status !== "pending") return { outcome: `noop_${order.processing_status}` };

  // 1) Event gate — closed by default.
  const gate = deps.evaluateGate({ enabledFlag: deps.enabledFlag, allowlistRaw: deps.allowlistRaw, event: order.event });
  if (gate.action === "store_only") return { outcome: "store_only" };
  if (gate.action === "manual_review") {
    return parkManualReview(admin, orderId, gate.reason, deps.sanitize({ reason: gate.reason, method: "auto" }), nowIso);
  }

  // 2) Parse structured lines + dedup identity from the STORED raw payload.
  const parsed = deps.parseLines(order.raw);
  const dedup = deps.buildDedupKey(parsed);

  // 3) Exact Talabat channel + resolution context.
  const ctx = await deps.loadContext(admin);
  if (ctx.status === "error") {
    return parkManualReview(admin, orderId, "context_unavailable", deps.sanitize({ reason: "context_unavailable", method: "auto" }), nowIso);
  }
  if (ctx.status === "manual_review") {
    return parkManualReview(admin, orderId, ctx.reason, deps.sanitize({ reason: ctx.reason, method: "auto" }), nowIso);
  }

  // 4) Resolve (weak identity, empty order, or any unresolved line stops here).
  const resolved = deps.resolveOrder(parsed.lines, ctx.context, { dedupConfidence: dedup.confidence });
  if (resolved.status !== "resolved") {
    const reason = String(resolved.reason ?? "manual_review");
    return parkManualReview(admin, orderId, reason, deps.sanitize({ ...(resolved.resolution ?? {}), reason, method: "auto" }), nowIso);
  }

  // 5) Stock snapshots for the resolved targets only.
  const targets: SnapshotTarget[] = (resolved.targets ?? []).map((t: any) => ({ masterProductId: t.masterProductId, masterVariantSku: t.masterVariantSku }));
  const snap = await deps.loadSnapshots(admin, targets);
  if (snap.status === "error") {
    return parkManualReview(admin, orderId, "inventory_inconsistent", deps.sanitize({ reason: "inventory_inconsistent", method: "auto" }), nowIso);
  }

  // 6) Final pre-RPC plan (last classifier before any deduction).
  const planTargets = (resolved.targets ?? []).map((t: any) => ({ masterProductId: t.masterProductId, masterVariantSku: t.masterVariantSku, quantity: t.quantity, lineKeys: t.lineKeys }));
  const plan = deps.buildPlan(planTargets, snap.snapshots);
  if (plan.status !== "ready") {
    const reason = String(plan.reason ?? "manual_review");
    return parkManualReview(admin, orderId, reason, deps.sanitize({ ...(resolved.resolution ?? {}), reason, method: "auto" }), nowIso);
  }

  // 7) One atomic RPC call. p_resolution is the deep-safe classified projection.
  const pResolution = deps.sanitize({ lines: resolved.resolution?.lines, targets: resolved.resolution?.targets, method: "auto" });
  let rpc: { data: any; error: any } | null = null;
  try {
    rpc = await admin.rpc("process_talabat_order_deduction", { p_order_id: orderId, p_dedup_key: dedup.key, p_plan: plan, p_resolution: pResolution });
  } catch {
    rpc = null;
  }

  // 8) Reconcile ONLY classified outcomes; never store a raw error.
  if (!rpc || rpc.error || !rpc.data) {
    const state = await rereadStatus(admin, orderId);
    if (state === "processed" || state === "manual_review") return { outcome: `reconciled_${state}` };
    return parkFailed(admin, orderId, "rpc_failed", deps.sanitize({ reason: "rpc_failed", method: "auto" }), nowIso);
  }

  const status = String(rpc.data.status ?? "");
  if (status === "processed") return { outcome: "processed" };
  if (status === "manual_review") {
    // The RPC already set status+resolution atomically — open one safe task.
    await createReviewTask(admin, { orderId, reason: String(rpc.data.reason ?? "manual_review") });
    return { outcome: `manual_review:${rpc.data.reason ?? "manual_review"}` };
  }
  if (status === "duplicate_order") {
    // Reconcile: the DB is truth if terminal; a still-pending order is parked.
    const state = await rereadStatus(admin, orderId);
    if (state === "processed" || state === "manual_review") return { outcome: `reconciled_${state}` };
    return parkManualReview(admin, orderId, "duplicate_order", deps.sanitize({ reason: "duplicate_order", method: "auto" }), nowIso);
  }
  // status === 'error' (missing_dedup_key/order_not_found/…): reconcile like an ambiguous failure.
  const state = await rereadStatus(admin, orderId);
  if (state === "processed" || state === "manual_review") return { outcome: `reconciled_${state}` };
  return parkFailed(admin, orderId, "rpc_failed", deps.sanitize({ reason: "rpc_failed", method: "auto" }), nowIso);
}
