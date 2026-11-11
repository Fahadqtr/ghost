"use server";

// Admin actions for the Beauty Rewards queue.
//
// D-2 — OWNER-ONLY, all of them, and they must stay that way. Every action here
// runs on the SERVICE-ROLE helpers in lib/loyalty/rewards, so RLS constrains
// nothing and this gate is the only boundary. Under the previous check — "a
// Supabase session exists" — any authenticated account could delete a customer,
// rewrite their name/phone/stamp balance, redeem a reward on their behalf, or
// add and remove prizes.
//
// The owner ruled: staff may NOT change loyalty points/balance, may NOT redeem
// rewards, and may NOT create/edit/delete prizes or any loyalty configuration —
// and no staff loyalty READ is wired in this step (no staff surface calls these;
// every caller is the owner-facing /v2/loyalty UI).
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireOwner } from "@/lib/malak/authz";
import {
  approveSubmission,
  rejectSubmission,
  redeemReward,
  updateCustomer,
  deleteCustomer,
  addPrize,
  setPrizeActive,
  deletePrize,
  sendVoucherWhatsApp,
  PRIZE_BUCKET,
} from "@/lib/loyalty/rewards";

/**
 * Owner gate for the void-returning actions. It THROWS so the denial keeps the
 * exact shape the previous session check had (these actions return void, so a
 * silent return would read to the caller as success).
 */
async function requireOwnerOrThrow() {
  const owner = await requireOwner();
  if (!owner.ok) throw new Error(owner.error);
}

export async function approveAction(submissionId: string) {
  await requireOwnerOrThrow();
  await approveSubmission(submissionId);
  revalidatePath("/v2/loyalty");
}

export async function rejectAction(submissionId: string, note?: string) {
  await requireOwnerOrThrow();
  await rejectSubmission(submissionId, note);
  revalidatePath("/v2/loyalty");
}

export async function redeemAction(customerId: string) {
  await requireOwnerOrThrow();
  await redeemReward(customerId);
  revalidatePath("/v2/loyalty");
}

export async function updateCustomerAction(
  id: string,
  fields: { name?: string; phone?: string; stamps?: number }
) {
  await requireOwnerOrThrow();
  await updateCustomer(id, fields);
  revalidatePath("/v2/loyalty/customers");
}

export async function deleteCustomerAction(id: string) {
  await requireOwnerOrThrow();
  await deleteCustomer(id);
  revalidatePath("/v2/loyalty/customers");
}

// --- Prizes ---

const PRIZE_MAX_BYTES = 10 * 1024 * 1024; // 10 MB
const PRIZE_EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
};

/** Upload a prize image + name. Returns an error string (not throw) for the UI. */
export async function addPrizeAction(formData: FormData): Promise<{ error?: string }> {
  const owner = await requireOwner();
  if (!owner.ok) return { error: owner.error };
  const name = String(formData.get("name") ?? "");
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) return { error: "اختاري صورة الجائزة." };
  if (file.size > PRIZE_MAX_BYTES)
    return { error: `الصورة كبيرة (${(file.size / 1048576).toFixed(1)}MB). الحد 10MB.` };
  const ext = PRIZE_EXT[file.type];
  if (!ext) return { error: `نوع غير مدعوم "${file.type || "?"}". استخدمي JPG أو PNG.` };

  const admin = createAdminClient();
  const path = `prize_${Date.now()}_${Math.floor(Math.random() * 1e4)}.${ext}`;
  const buf = Buffer.from(await file.arrayBuffer());
  const { error: upErr } = await admin.storage
    .from(PRIZE_BUCKET)
    .upload(path, buf, { contentType: file.type, upsert: false, cacheControl: "3600" });
  if (upErr) return { error: `فشل رفع الصورة: ${upErr.message}` };

  const imageUrl = admin.storage.from(PRIZE_BUCKET).getPublicUrl(path).data.publicUrl;
  await addPrize(name, path, imageUrl);
  revalidatePath("/v2/loyalty/prizes");
  return {};
}

export async function setPrizeActiveAction(id: string, active: boolean) {
  await requireOwnerOrThrow();
  await setPrizeActive(id, active);
  revalidatePath("/v2/loyalty/prizes");
}

export async function deletePrizeAction(id: string) {
  await requireOwnerOrThrow();
  await deletePrize(id);
  revalidatePath("/v2/loyalty/prizes");
}

/** Send the win-confirmation WhatsApp to a customer. Reports the send result. */
export async function sendVoucherAction(
  customerId: string
): Promise<{ configured: boolean; ok: boolean; error?: string }> {
  // OWNER-only: this dispatches a real WhatsApp message to a customer.
  const owner = await requireOwner();
  if (!owner.ok) return { configured: true, ok: false, error: owner.error };
  const res = await sendVoucherWhatsApp(customerId);
  return { configured: res.configured, ok: res.ok, error: res.error };
}
