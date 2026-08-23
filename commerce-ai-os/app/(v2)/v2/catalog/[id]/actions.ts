"use server";

// OPS.8B — product-page lifecycle transition action. THIN wrapper: it forwards
// to the single approved lifecycle mutation boundary and returns its structured
// result. All authorization, current-state re-read, validation, the single
// lifecycle_state write, and the audit append happen inside the boundary — this
// file adds no logic and writes nothing itself.

import { revalidatePath } from "next/cache";
import {
  transitionProductLifecycle,
  type TransitionInput,
  type TransitionResult,
} from "@/lib/lifecycle/transition.server";
import { requireWriterGate } from "@/lib/auth/requireUser";
import { setProductApproval } from "@/app/(app)/products/actions";

export async function runLifecycleTransition(input: TransitionInput): Promise<TransitionResult> {
  return transitionProductLifecycle(input);
}

// PRODUCT.APPROVAL.UX.1 — approve from the product detail lifecycle card.
// THIN wrapper over the CANONICAL approval writer (setProductApproval): the
// boundary keeps its own gate, its catalog-task audit entry and the Talabat
// queue side-effect. This wrapper adds only (a) a writer gate up front
// (defense-in-depth, matching the Wave 2 bulk-approve surface) and (b) V2
// detail-page revalidation. It NEVER touches lifecycle_state — approval and
// activation remain two separate explicit owner actions.
export async function approveProductFromDetail(
  productId: string,
): Promise<{ ok: true } | { error: string }> {
  const unauth = await requireWriterGate();
  if (unauth) return { error: unauth.error };
  const id = String(productId ?? "").trim();
  if (!id) return { error: "طلب غير صالح." };

  const res = await setProductApproval(id, "Approved");
  if ("error" in res && res.error) return { error: res.error };

  revalidatePath(`/v2/catalog/${id}`);
  revalidatePath("/v2/catalog");
  return { ok: true };
}
