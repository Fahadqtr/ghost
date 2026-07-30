"use server";

// Admin actions for the Beauty Rewards queue. These run inside the (app) route
// group, which is already login-gated by middleware; we re-check the session
// here as defense in depth before touching the service-role helpers.
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
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

export async function updateCustomerAction(
  id: string,
  fields: { name?: string; phone?: string; stamps?: number }
) {
  await requireUser();
  await updateCustomer(id, fields);
  revalidatePath("/loyalty/customers");
}

export async function deleteCustomerAction(id: string) {
  await requireUser();
  await deleteCustomer(id);
  revalidatePath("/loyalty/customers");
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
  await requireUser();
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
  revalidatePath("/loyalty/prizes");
  return {};
}

export async function setPrizeActiveAction(id: string, active: boolean) {
  await requireUser();
  await setPrizeActive(id, active);
  revalidatePath("/loyalty/prizes");
}

export async function deletePrizeAction(id: string) {
  await requireUser();
  await deletePrize(id);
  revalidatePath("/loyalty/prizes");
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
