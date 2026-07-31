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
// a manual-review task is opened ONLY after the DB state is confirmed, and the
// task is keyed on the internal order id so the staff_tasks PRIMARY KEY makes it
// at-most-one-per-order (no scan-then-insert race). An unexpected exception can
// never escape unclassified or leave the order silently pending. No raw payload /
// customer PII / DB error text ever enters resolution, a task, or a log.

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

/**
 * A CONSTANT, self-contained safe resolution for the final rescue paths. It never
 * calls deps.sanitize() — that collaborator might be the very thing that threw —
 * and contains only a classified reason, never raw/PII.
 */
function safeFailureResolution(reason: "schedule_failed" | "processing_failed"): Record<string, unknown> {
  return { reason, method: "auto" };
}

// Only these classified reasons may ever reach resolution / a task / an outcome.
// Anything else (a rogue rpc.data.reason, a stray resolver value) collapses to
// processing_failed — no arbitrary string can leak through.
const KNOWN_REASONS = new Set([
  "auto_deduct_misconfigured", "event_not_allowed", "talabat_channel_unresolved", "context_unavailable",
  "weak_order_identity", "empty_order", "invalid_quantity", "inactive_mapping", "ambiguous_match",
  "conflicting_identifiers", "title_only_match", "unmatched", "inventory_inconsistent", "invalid_plan",
  "insufficient_stock", "duplicate_order", "rpc_failed", "schedule_failed", "processing_failed", "manual_review",
]);

/** Map any value to a KNOWN classified reason; unknown → "processing_failed". */
export function normalizeTalabatProcessingReason(value: unknown): string {
  return typeof value === "string" && KNOWN_REASONS.has(value) ? value : "processing_failed";
}

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

/** Re-read only the processing_status. Returns null when it cannot be read. */
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
 * Open ONE safe manual-review task for the order. ATOMIC dedupe: the task's
 * primary key IS the internal order id, so the staff_tasks PRIMARY KEY guarantees
 * at most one Talabat task per order — no open-task scan, no lookup-then-insert
 * race. Uses upsert(onConflict:id, ignoreDuplicates) and treats a 23505 as an
 * existing task. Only real base columns are written; the description carries no
 * raw/PII/token/SKU/barcode/customer/orderCode — just the internal-id marker and
 * a classified reason.
 */
async function createReviewTask(admin: any, args: { orderId: string; reason: string }): Promise<void> {
  const reason = normalizeTalabatProcessingReason(args.reason);
  const marker = `[talabat_review_order:${args.orderId}]`;
  const row = {
    id: args.orderId, // = talabat_orders.id → PK makes it one-per-order
    title: "🔴 مراجعة طلب Talabat",
    description: `${marker}\nنوع المهمة: talabat_review\nالسبب: ${reason}`,
    assigned_to: null,
    assigned_name: null,
    priority: "high",
    status: "open",
    created_by: "talabat",
  };
  try {
    const { error } = await admin.from("staff_tasks").upsert(row, { onConflict: "id", ignoreDuplicates: true });
    if (error) {
      if (error.code === "23505") return; // already exists — expected, not an error
      log("review_task", args.orderId);
    }
  } catch {
    log("review_task", args.orderId);
  }
}

/** Park a pending order in manual_review, then (only after the DB confirms a
 *  manual_review state) open the atomic task. A concurrently processed/failed
 *  order is left untouched with its own reason as the truth. */
async function parkManualReview(
  admin: any, orderId: string, rawReason: string, resolution: Record<string, unknown>, nowIso: () => string,
): Promise<{ outcome: string }> {
  const reason = normalizeTalabatProcessingReason(rawReason);
  const res = await markStatus(admin, orderId, "manual_review", resolution, nowIso);
  if (res === "already_processed") return { outcome: "reconciled_processed" };
  if (res === "already_failed") return { outcome: "reconciled_failed" }; // prior failed reason wins; no retask
  if (res === "status_update_failed") return { outcome: "status_update_failed" };
  // updated / already_manual_review → confirmed manual_review.
  await createReviewTask(admin, { orderId, reason });
  return { outcome: `manual_review:${reason}` };
}

/** Park a pending order as failed, then (only after confirming failed) open the
 *  atomic task. Never overwrites processed/manual_review. */
async function parkFailed(
  admin: any, orderId: string, rawReason: string, resolution: Record<string, unknown>, nowIso: () => string,
): Promise<{ outcome: string }> {
  const reason = normalizeTalabatProcessingReason(rawReason);
  const res = await markStatus(admin, orderId, "failed", resolution, nowIso);
  if (res === "already_processed") return { outcome: "reconciled_processed" };
  if (res === "already_manual_review") return { outcome: "reconciled_manual_review" };
  if (res === "status_update_failed") return { outcome: "status_update_failed" };
  // updated / already_failed → confirmed failed.
  await createReviewTask(admin, { orderId, reason });
  return { outcome: `failed:${reason}` };
}

/**
 * Safe handler for a failure to REGISTER the after() callback: the order must not
 * be left silently pending. Mark it failed (schedule_failed), verified, then task.
 */
export async function handleScheduleFailure(admin: any, orderId: string, deps: ProcessOrderDeps): Promise<{ outcome: string }> {
  try {
    // Does NOT use deps.sanitize (rescue path). Any internal failure → status_update_failed.
    return await parkFailed(admin, orderId, "schedule_failed", safeFailureResolution("schedule_failed"), deps.nowIso ?? nowIsoDefault);
  } catch {
    return { outcome: "status_update_failed" };
  }
}

/**
 * Safe handler for an UNEXPECTED processing exception (the background callback
 * rejected, or a pure layer/sanitize threw). Never re-runs the processor and
 * never calls deps.sanitize. Re-reads state: processed/manual_review/failed →
 * untouched; pending → failed/processing_failed (verified); otherwise
 * status_update_failed. No raw error is ever stored/logged and it never throws.
 */
export async function handleUnexpectedProcessingFailure(admin: any, orderId: string, deps: ProcessOrderDeps): Promise<{ outcome: string }> {
  try {
    const st = await rereadStatus(admin, orderId);
    if (st === "processed") return { outcome: "reconciled_processed" };
    if (st === "manual_review") return { outcome: "reconciled_manual_review" };
    if (st === "failed") return { outcome: "reconciled_failed" };
    return await parkFailed(admin, orderId, "processing_failed", safeFailureResolution("processing_failed"), deps.nowIso ?? nowIsoDefault);
  } catch {
    return { outcome: "status_update_failed" };
  }
}

/**
 * Process ONE stored Talabat order. No-op unless it is still "pending". An outer
 * boundary guarantees no unclassified exception escapes — any throw collapses to
 * a verified failed/processing_failed.
 */
export async function processStoredTalabatOrder(
  admin: any, orderId: string, deps: ProcessOrderDeps,
): Promise<{ outcome: string }> {
  const nowIso = deps.nowIso ?? nowIsoDefault;

  const order = await readOrder(admin, orderId);
  if (!order) {
    // The FIRST read failed — don't give up. Log a generic stage and route through
    // the safe failure handler, which re-reads state and, if still pending,
    // marks it failed/processing_failed (a transient read blip must not leave a
    // pending order stuck).
    log("read", orderId);
    return handleUnexpectedProcessingFailure(admin, orderId, deps);
  }
  if (order.processing_status !== "pending") return { outcome: `noop_${order.processing_status}` };

  try {
    // 1) Event gate — closed by default.
    const gate = deps.evaluateGate({ enabledFlag: deps.enabledFlag, allowlistRaw: deps.allowlistRaw, event: order.event });
    if (gate.action === "store_only") return { outcome: "store_only" };
    if (gate.action === "manual_review") {
      return await parkManualReview(admin, orderId, gate.reason, deps.sanitize({ reason: gate.reason, method: "auto" }), nowIso);
    }

    // 2) Parse structured lines + dedup identity from the STORED raw payload.
    const parsed = deps.parseLines(order.raw);
    const dedup = deps.buildDedupKey(parsed);

    // 3) Exact Talabat channel + resolution context.
    const ctx = await deps.loadContext(admin);
    if (ctx.status === "error") {
      return await parkManualReview(admin, orderId, "context_unavailable", deps.sanitize({ reason: "context_unavailable", method: "auto" }), nowIso);
    }
    if (ctx.status === "manual_review") {
      return await parkManualReview(admin, orderId, ctx.reason, deps.sanitize({ reason: ctx.reason, method: "auto" }), nowIso);
    }

    // 4) Resolve (weak identity, empty order, or any unresolved line stops here).
    const resolved = deps.resolveOrder(parsed.lines, ctx.context, { dedupConfidence: dedup.confidence });
    if (resolved.status !== "resolved") {
      const reason = normalizeTalabatProcessingReason(resolved.reason);
      return await parkManualReview(admin, orderId, reason, deps.sanitize({ ...(resolved.resolution ?? {}), reason, method: "auto" }), nowIso);
    }

    // 5) Stock snapshots for the resolved targets only.
    const targets: SnapshotTarget[] = (resolved.targets ?? []).map((t: any) => ({ masterProductId: t.masterProductId, masterVariantSku: t.masterVariantSku }));
    const snap = await deps.loadSnapshots(admin, targets);
    if (snap.status === "error") {
      return await parkManualReview(admin, orderId, "inventory_inconsistent", deps.sanitize({ reason: "inventory_inconsistent", method: "auto" }), nowIso);
    }

    // 6) Final pre-RPC plan (last classifier before any deduction).
    const planTargets = (resolved.targets ?? []).map((t: any) => ({ masterProductId: t.masterProductId, masterVariantSku: t.masterVariantSku, quantity: t.quantity, lineKeys: t.lineKeys }));
    const plan = deps.buildPlan(planTargets, snap.snapshots);
    if (plan.status !== "ready") {
      const reason = normalizeTalabatProcessingReason(plan.reason);
      return await parkManualReview(admin, orderId, reason, deps.sanitize({ ...(resolved.resolution ?? {}), reason, method: "auto" }), nowIso);
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
      return await parkFailed(admin, orderId, "rpc_failed", deps.sanitize({ reason: "rpc_failed", method: "auto" }), nowIso);
    }

    const status = String(rpc.data.status ?? "");
    if (status === "processed") return { outcome: "processed" };
    if (status === "manual_review") {
      // Verify the DB state before creating/parking anything.
      const reason = normalizeTalabatProcessingReason(rpc.data.reason);
      const state = await rereadStatus(admin, orderId);
      if (state === "manual_review") { await createReviewTask(admin, { orderId, reason }); return { outcome: `manual_review:${reason}` }; }
      if (state === "processed") return { outcome: "reconciled_processed" };            // processed is truth, no task
      if (state === "failed") return { outcome: "reconciled_failed" };                  // do not mislabel
      if (state === "pending") return await parkManualReview(admin, orderId, reason, deps.sanitize({ reason, method: "auto" }), nowIso);
      return { outcome: "manual_review_unconfirmed" };                                  // reread failed → no guess
    }
    if (status === "duplicate_order") {
      const state = await rereadStatus(admin, orderId);
      if (state === "processed" || state === "manual_review") return { outcome: `reconciled_${state}` };
      return await parkManualReview(admin, orderId, "duplicate_order", deps.sanitize({ reason: "duplicate_order", method: "auto" }), nowIso);
    }
    // status === 'error' → reconcile like an ambiguous failure.
    const state = await rereadStatus(admin, orderId);
    if (state === "processed" || state === "manual_review") return { outcome: `reconciled_${state}` };
    return await parkFailed(admin, orderId, "rpc_failed", deps.sanitize({ reason: "rpc_failed", method: "auto" }), nowIso);
  } catch {
    // OUTER BOUNDARY: no unclassified exception escapes; never leave it pending.
    return handleUnexpectedProcessingFailure(admin, orderId, deps);
  }
}
