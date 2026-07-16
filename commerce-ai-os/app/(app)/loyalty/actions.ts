"use server";

// Admin actions for the Beauty Rewards queue. These run inside the (app) route
// group, which is already login-gated by middleware; we re-check the session
// here as defense in depth before touching the service-role helpers.
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import {
  approveSubmission,
  rejectSubmission,
  redeemReward,
} from "@/lib/loyalty/rewards";

async function requireUser() {
  const {
    data: { user },
  } = await createClient().auth.getUser();
  if (!user) throw new Error("غير مسجّل الدخول.");
}

export async function approveAction(submissionId: string) {
  await requireUser();
  await approveSubmission(submissionId);
  revalidatePath("/loyalty");
}

export async function rejectAction(submissionId: string, note?: string) {
  await requireUser();
  await rejectSubmission(submissionId, note);
  revalidatePath("/loyalty");
}

export async function redeemAction(customerId: string) {
  await requireUser();
  await redeemReward(customerId);
  revalidatePath("/loyalty");
}
