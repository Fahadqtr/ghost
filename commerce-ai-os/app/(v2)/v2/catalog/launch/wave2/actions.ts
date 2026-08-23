"use server";

// CATALOG.GOLIVE.3A — Wave 2 Bulk Review actions. ORCHESTRATION ONLY.
//
// Every mutation below DELEGATES to an existing certified boundary — this file
// performs no direct products/inventory/lifecycle write of its own (no
// .update / .insert / .upsert / .delete / .rpc anywhere here):
//
//   • category  → the V2 editor's shared save core: loadProductForEdit (lossless
//     round-trip read) + validateProductEditInput + updateProductCore — the SAME
//     single write flow the edit form uses, with ONLY main_category replaced.
//   • availability → setManyAvailability (Availability Engine; explicit state,
//     NEVER derived from quantity; writer-gated inside).
//   • approval  → setProductApproval (quick-approve boundary: task log + Talabat
//     queue), offered ONLY for rows whose category is already resolved.
//   • activation → transitionProductLifecycle (the ONE lifecycle boundary; it
//     re-derives readiness and enforces the OPS.8B matrix + audit itself).
//
// Authorization: every delegated boundary enforces its own gate; the writer
// gate here is defense-in-depth so a non-writer fails closed with one message
// before any per-product work starts.

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireWriterGate } from "@/lib/auth/requireUser";
import { loadProductForEdit } from "@/lib/products/product-edit-read";
import { updateProductCore, type ProductInput } from "@/lib/products/product-save";
import { createInventoryAdapter, applyEditorInventoryEffects } from "@/lib/products/inventory-editor-adapter";
import { editFailureMessage, validateProductEditInput } from "@/lib/products/edit-validation";
import { transitionProductLifecycle } from "@/lib/lifecycle/transition.server";
import { setManyAvailability } from "@/app/(app)/inventory/actions";
import { setProductApproval } from "@/app/(app)/products/actions";
import { isValidCategoryChoice } from "@/lib/catalog/wave2/wave2-plan";

const BATCH_CAP = 100;
const MSG_INVALID = "طلب غير صالح.";
const MSG_BAD_CATEGORY = "فئة غير موجودة في التصنيف المعتمد.";

export interface Wave2ItemOutcome {
  productId: string;
  ok: boolean;
  /** fixed, safe message (never raw DB text) */
  note?: string;
}

function cleanIds(ids: readonly string[] | undefined): string[] {
  return Array.from(new Set((ids ?? []).map(String).filter(Boolean))).slice(0, BATCH_CAP);
}

function refreshWave2Paths(): void {
  revalidatePath("/v2/catalog/launch/wave2");
  revalidatePath("/v2/catalog/launch");
  revalidatePath("/v2/catalog");
}

// ── A) category apply — the editor's own save flow, category-only change ────

export async function applyWave2Categories(
  items: readonly { productId: string; category: string }[],
): Promise<{ results: Wave2ItemOutcome[]; error?: string }> {
  const unauth = await requireWriterGate();
  if (unauth) return { results: [], error: unauth.error };

  const list = (items ?? []).slice(0, BATCH_CAP);
  if (!list.length) return { results: [] };

  const supabase = createClient();
  const admin = createAdminClient();
  const results: Wave2ItemOutcome[] = [];

  for (const item of list) {
    const productId = String(item?.productId ?? "");
    if (!productId) continue;
    // Taxonomy check FIRST — only existing categories can ever be applied.
    if (!isValidCategoryChoice(item.category)) {
      results.push({ productId, ok: false, note: MSG_BAD_CATEGORY });
      continue;
    }
    // Lossless round-trip: read EVERY column the save core writes, replace
    // ONLY main_category, save through the shared core (ids preserved).
    const read = await loadProductForEdit(supabase, productId);
    if (read.status !== "ok") {
      results.push({ productId, ok: false, note: MSG_INVALID });
      continue;
    }
    const input: ProductInput = {
      ...read.initial,
      main_category: item.category,
      variants: read.initial.variants,
      original_sku: read.initial.sku,
      original_barcode: read.initial.barcode,
    };
    const validation = validateProductEditInput(input);
    if (!validation.ok) {
      results.push({ productId, ok: false, note: validation.message });
      continue;
    }
    const core = await updateProductCore(supabase, productId, input, {
      inventory: createInventoryAdapter(admin),
      variantSyncClient: admin,
    });
    if (!core.ok) {
      results.push({ productId, ok: false, note: editFailureMessage(core) });
      continue;
    }
    await applyEditorInventoryEffects(admin, {
      productId,
      sku: (core.row.sku as string | null) ?? null,
      core,
    });
    results.push({ productId, ok: true });
    revalidatePath(`/v2/catalog/${productId}`);
  }

  refreshWave2Paths();
  return { results };
}

// ── B) availability apply — Availability Engine, explicit choice only ───────

export async function applyWave2Availability(
  productIds: readonly string[],
  choice: "in_stock" | "out_of_stock",
): Promise<{ ok: boolean; count: number; error?: string }> {
  const unauth = await requireWriterGate();
  if (unauth) return { ok: false, count: 0, error: unauth.error };
  if (choice !== "in_stock" && choice !== "out_of_stock") {
    return { ok: false, count: 0, error: MSG_INVALID };
  }
  const ids = cleanIds(productIds);
  if (!ids.length) return { ok: true, count: 0 };
  // KEEP UNKNOWN is a non-action by design — this function is never called for it.
  const res = await setManyAvailability(ids, choice === "in_stock");
  refreshWave2Paths();
  return res;
}

// ── C) bulk approve — only rows whose category is ALREADY resolved ──────────

export async function approveWave2(
  productIds: readonly string[],
): Promise<{ results: Wave2ItemOutcome[]; skippedUnresolved: string[]; error?: string }> {
  const unauth = await requireWriterGate();
  if (unauth) return { results: [], skippedUnresolved: [], error: unauth.error };

  const ids = cleanIds(productIds);
  if (!ids.length) return { results: [], skippedUnresolved: [] };

  // Fresh authoritative read: a row without a resolved category is REFUSED
  // here, server-side — the client filter is convenience, never the boundary.
  const admin = createAdminClient();
  const { data, error } = await admin.from("products").select("id, main_category").in("id", ids);
  if (error) return { results: [], skippedUnresolved: [], error: MSG_INVALID };

  const categoryById = new Map<string, string | null>(
    ((data ?? []) as { id: string; main_category: string | null }[]).map((r) => [r.id, r.main_category]),
  );

  const results: Wave2ItemOutcome[] = [];
  const skippedUnresolved: string[] = [];
  for (const id of ids) {
    const category = categoryById.get(id);
    if (typeof category !== "string" || category.trim() === "") {
      skippedUnresolved.push(id);
      continue;
    }
    const res = await setProductApproval(id, "Approved");
    results.push({ productId: id, ok: !("error" in res && res.error), note: (res as { error?: string }).error });
  }

  refreshWave2Paths();
  return { results, skippedUnresolved };
}

// ── D) bulk activate — the lifecycle boundary decides, per product ───────────

export async function activateWave2(
  productIds: readonly string[],
): Promise<{ results: Wave2ItemOutcome[]; error?: string }> {
  const unauth = await requireWriterGate();
  if (unauth) return { results: [], error: unauth.error };

  const ids = cleanIds(productIds);
  const results: Wave2ItemOutcome[] = [];
  for (const id of ids) {
    // The boundary re-reads state, re-derives readiness (READY_FOR_ACTIVATION),
    // enforces the transition matrix + authorization and writes the audit row.
    const res = await transitionProductLifecycle({ productId: id, targetState: "ACTIVE" });
    results.push({
      productId: id,
      ok: res.outcome === "UPDATED" || res.outcome === "UNCHANGED",
      note: res.outcome === "BLOCKED" ? (res.reasons ?? []).join("، ") : res.error,
    });
  }

  refreshWave2Paths();
  return { results };
}
