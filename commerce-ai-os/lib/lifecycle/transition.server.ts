// OPS.8B — the ONE approved lifecycle mutation boundary (SERVER-ONLY).
//
// This is the single place that writes products.lifecycle_state (outside the
// OPS.8A migration/backfill and tests). Every transition flows through here:
//   1. authenticate (writer minimum; owner for owner-gated edges)
//   2. re-read the CURRENT state (admin client — authoritative, RLS-free)
//   3. derive readiness (certified engine) when the edge requires READY
//   4. validate the edge via the pure transition engine
//   5. apply lifecycle_state ONLY, with optimistic from-state concurrency guard
//   6. append a best-effort malak_audit row (never fails the write)
//   7. return a structured, safe result
//
// It writes NOTHING else — no inventory, no availability (stock_status), no
// channel_products, no external_channel_listings, no platform_status, no delete.

import "server-only";

import { revalidatePath } from "next/cache";

import { requireMalakWriter, requireOwner } from "@/lib/malak/authz";
import { createAdminClient } from "@/lib/supabase/admin";
import { insertAuditRow } from "@/lib/audit";
import { computeProductReadiness } from "@/lib/operations/readiness/readiness";
import { mapProductRow } from "@/lib/operations/dashboard-view";
import { resolveLifecycleState, type LifecycleState } from "./state";
import { evaluateTransition, findTransitionRule, isKnownLifecycleState } from "./transitions";

const READ_COLUMNS =
  "id, sku, barcode, name_ar, name_en, description_ar, description_en, brand_id, main_category, price, image_url, approval, platform_status, lifecycle_state";

const VARIANT_CAP = 500;

/** Outcomes the caller/UI switches on. */
export type TransitionOutcome = "UPDATED" | "UNCHANGED" | "BLOCKED" | "STALE" | "FAILED";

export interface TransitionResult {
  outcome: TransitionOutcome;
  from?: LifecycleState;
  to?: LifecycleState;
  /** fixed, safe reason strings (never raw DB text) */
  reasons?: string[];
  /** safe error message for FAILED (auth / not found / write error) */
  error?: string;
}

export interface TransitionInput {
  productId: string;
  targetState: string;
  reason?: string;
  /** the state the UI believed the product was in — rejects stale previews */
  expectedFromState?: string;
}

const SAFE_NOT_FOUND = "المنتج غير موجود أو مؤرشف.";
const SAFE_WRITE_FAILED = "تعذّر تحديث حالة المنتج.";
const SAFE_BAD_TARGET = "حالة غير صالحة.";

/**
 * Perform one lifecycle transition. Pure validation lives in the engine; this
 * function owns auth, the authoritative re-read, the single write, and audit.
 */
export async function transitionProductLifecycle(input: TransitionInput): Promise<TransitionResult> {
  const { productId, targetState, reason, expectedFromState } = input;

  if (!isKnownLifecycleState(targetState)) {
    return { outcome: "FAILED", error: SAFE_BAD_TARGET };
  }
  if (typeof productId !== "string" || productId === "") {
    return { outcome: "FAILED", error: SAFE_NOT_FOUND };
  }

  // (1a) Writer is the minimum for ANY transition. Non-writers stop here.
  const writer = await requireMalakWriter();
  if (!writer.ok) return { outcome: "FAILED", error: writer.error };

  const admin = createAdminClient();

  // (2) Authoritative current-state read.
  const { data: row, error: readErr } = await admin
    .from("products")
    .select(READ_COLUMNS)
    .eq("id", productId)
    .maybeSingle();
  if (readErr || !row) return { outcome: "FAILED", error: SAFE_NOT_FOUND };

  const from = resolveLifecycleState(row as Record<string, unknown>);
  const to = targetState;
  const sku = typeof (row as { sku?: unknown }).sku === "string" ? (row as { sku: string }).sku : null;

  // Stale preview: the UI acted on an out-of-date state.
  if (typeof expectedFromState === "string" && expectedFromState !== from) {
    return { outcome: "STALE", from, to };
  }
  if (from === to) return { outcome: "UNCHANGED", from, to };

  const rule = findTransitionRule(from, to);
  if (!rule) {
    const decision = evaluateTransition(from, to, { ready: false, archived: false });
    return { outcome: "BLOCKED", from, to, reasons: decision.reasons };
  }

  // (1b) Owner-gated edges require the stricter boundary.
  let actor = writer.email;
  if (rule.authority === "owner") {
    const owner = await requireOwner();
    if (!owner.ok) return { outcome: "FAILED", error: owner.error };
    actor = owner.email;
  }

  // (3) Derive readiness only when the edge gates on READY.
  let ready = false;
  let blocking: string[] = [];
  if (rule.requiresReady) {
    let variantCount = 0;
    try {
      const { data: vrows } = await admin
        .from("product_variants")
        .select("id")
        .eq("parent_product_id", productId)
        .limit(VARIANT_CAP);
      if (Array.isArray(vrows)) variantCount = vrows.length;
    } catch {
      variantCount = 0;
    }
    const readiness = computeProductReadiness(mapProductRow(row as Record<string, unknown>, variantCount));
    ready = readiness.readyToPublish;
    blocking = readiness.reasons.map((r) => r.message);
  }

  // (4) Validate the edge.
  const decision = evaluateTransition(from, to, { ready, archived: false });
  if (!decision.allowed) {
    const reasons = decision.code === "BLOCKED" ? [...decision.reasons, ...blocking] : decision.reasons;
    return { outcome: "BLOCKED", from, to, reasons };
  }

  // (5) Apply lifecycle_state ONLY, guarded on the from-state (optimistic
  //     concurrency — a racing write flips the row out of `from` and the update
  //     matches 0 rows ⇒ STALE, never a blind overwrite).
  const { data: updated, error: writeErr } = await admin
    .from("products")
    .update({ lifecycle_state: to })
    .eq("id", productId)
    .eq("lifecycle_state", from)
    .select("id");
  if (writeErr) return { outcome: "FAILED", error: SAFE_WRITE_FAILED };
  if (!Array.isArray(updated) || updated.length === 0) {
    return { outcome: "STALE", from, to };
  }

  // (6) Best-effort audit — never fails the business write.
  try {
    await insertAuditRow(admin, {
      action_type: "lifecycle_transition",
      action: "lifecycle_transition",
      agent: actor,
      sku,
      product_id: productId,
      field: "lifecycle_state",
      old_value: from,
      new_value: to,
      status: "committed",
      details: {
        source: "lifecycle",
        actor,
        authority: rule.authority,
        reason: typeof reason === "string" && reason.trim() !== "" ? reason.trim() : null,
      },
    });
  } catch {
    /* audit is best-effort */
  }

  // (7) Refresh the product surface.
  try {
    revalidatePath(`/v2/catalog/${productId}`);
  } catch {
    /* revalidate is best-effort */
  }

  return { outcome: "UPDATED", from, to };
}
