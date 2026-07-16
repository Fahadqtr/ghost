// Beauty Rewards loyalty logic — the single source of truth for stamps.
// SERVER ONLY: every function here uses the service-role admin client, so it
// must never be imported into a Client Component. The public API routes
// (/api/rewards/*) and the admin server actions call in through here.
import { createAdminClient } from "@/lib/supabase/admin";

/** Hearts needed to earn one free product. */
export const STAMPS_REQUIRED = 6;

export const REVIEW_BUCKET = "loyalty-reviews";

export type SubmissionStatus = "pending" | "approved" | "rejected";

export type RewardState = {
  name: string;
  phone: string;
  stamps: number;
  required: number;
  rewardReady: boolean;
  cyclesCompleted: number;
  pending: number; // screenshots awaiting review
  lastStatus: SubmissionStatus | null; // status of the most recent submission
};

export type PendingSubmission = {
  id: string;
  customerId: string;
  name: string;
  phone: string;
  imageUrl: string;
  createdAt: string;
  stamps: number;
};

/**
 * Normalize a phone number to digits only so the SAME person is one row no
 * matter how they typed it ("+974 5551 2345", "05551-2345" → "97455512345").
 * Returns null when there aren't enough digits to be a real number.
 */
export function normalizePhone(raw: string): string | null {
  const digits = (raw || "").replace(/\D/g, "");
  return digits.length >= 7 && digits.length <= 15 ? digits : null;
}

function cleanName(raw: string): string {
  return (raw || "").trim().replace(/\s+/g, " ").slice(0, 80);
}

/**
 * Look the customer up by phone, creating the row on first visit. Updates the
 * stored name if they typed a new one. Returns their current reward state.
 */
export async function getOrCreateState(
  rawName: string,
  rawPhone: string
): Promise<RewardState> {
  const phone = normalizePhone(rawPhone);
  if (!phone) throw new Error("رقم الجوال غير صحيح.");
  const name = cleanName(rawName);
  if (!name) throw new Error("الاسم مطلوب.");

  const admin = createAdminClient();

  // Upsert on the unique phone. On conflict we refresh the name + updated_at.
  const { data: customer, error } = await admin
    .from("loyalty_customers")
    .upsert(
      { phone, name, updated_at: new Date().toISOString() },
      { onConflict: "phone" }
    )
    .select("id, name, phone, stamps, cycles_completed, reward_ready_at")
    .single();
  if (error || !customer) throw new Error(error?.message ?? "تعذّر إنشاء البطاقة.");

  return stateFor(admin, customer);
}

/** Read-only state lookup by phone (returns null if the customer doesn't exist). */
export async function getStateByPhone(rawPhone: string): Promise<RewardState | null> {
  const phone = normalizePhone(rawPhone);
  if (!phone) return null;
  const admin = createAdminClient();
  const { data: customer } = await admin
    .from("loyalty_customers")
    .select("id, name, phone, stamps, cycles_completed, reward_ready_at")
    .eq("phone", phone)
    .maybeSingle();
  if (!customer) return null;
  return stateFor(admin, customer);
}

type CustomerRow = {
  id: string;
  name: string;
  phone: string;
  stamps: number;
  cycles_completed: number;
  reward_ready_at: string | null;
};

async function stateFor(
  admin: ReturnType<typeof createAdminClient>,
  customer: CustomerRow
): Promise<RewardState> {
  const { count: pending } = await admin
    .from("loyalty_submissions")
    .select("id", { count: "exact", head: true })
    .eq("customer_id", customer.id)
    .eq("status", "pending");

  const { data: last } = await admin
    .from("loyalty_submissions")
    .select("status")
    .eq("customer_id", customer.id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  return {
    name: customer.name,
    phone: customer.phone,
    stamps: Math.min(customer.stamps, STAMPS_REQUIRED),
    required: STAMPS_REQUIRED,
    rewardReady: customer.stamps >= STAMPS_REQUIRED,
    cyclesCompleted: customer.cycles_completed,
    pending: pending ?? 0,
    lastStatus: (last?.status as SubmissionStatus | undefined) ?? null,
  };
}

/**
 * Record an uploaded review screenshot as a PENDING submission. The image is
 * already in storage; we just link it. No heart is granted here — that only
 * happens on approval.
 */
export async function addSubmission(
  rawPhone: string,
  imagePath: string,
  imageUrl: string
): Promise<void> {
  const phone = normalizePhone(rawPhone);
  if (!phone) throw new Error("رقم الجوال غير صحيح.");
  const admin = createAdminClient();

  const { data: customer } = await admin
    .from("loyalty_customers")
    .select("id")
    .eq("phone", phone)
    .maybeSingle();
  if (!customer) throw new Error("سجّلي بياناتك أولاً قبل رفع الصورة.");

  const { error } = await admin.from("loyalty_submissions").insert({
    customer_id: customer.id,
    image_path: imagePath,
    image_url: imageUrl,
    status: "pending",
  });
  if (error) throw new Error(error.message);
}

/** Every screenshot still awaiting review, newest first — for the admin queue. */
export async function listPending(): Promise<PendingSubmission[]> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("loyalty_submissions")
    .select("id, image_url, created_at, customer_id, loyalty_customers(name, phone, stamps)")
    .eq("status", "pending")
    .order("created_at", { ascending: true })
    .limit(200);
  if (error) throw new Error(error.message);

  return (data ?? []).map((r: any) => ({
    id: r.id,
    customerId: r.customer_id,
    name: r.loyalty_customers?.name ?? "—",
    phone: r.loyalty_customers?.phone ?? "",
    imageUrl: r.image_url,
    createdAt: r.created_at,
    stamps: Math.min(r.loyalty_customers?.stamps ?? 0, STAMPS_REQUIRED),
  }));
}

export type CustomerRecord = {
  id: string;
  name: string;
  phone: string;
  stamps: number; // hearts in the current card (0..required)
  cyclesCompleted: number; // rewards earned & redeemed over time
  rewardReady: boolean;
  createdAt: string;
  updatedAt: string;
};

/**
 * Every rewards customer, most recently active first — for the customers table.
 * Optional case-insensitive search over name / phone.
 */
export async function listCustomers(search?: string): Promise<CustomerRecord[]> {
  const admin = createAdminClient();
  let query = admin
    .from("loyalty_customers")
    .select("id, name, phone, stamps, cycles_completed, reward_ready_at, created_at, updated_at")
    .order("updated_at", { ascending: false })
    .limit(500);

  const term = (search ?? "").trim();
  if (term) {
    const digits = term.replace(/\D/g, "");
    // match name OR phone; if the term has digits, also match the phone fragment
    const ors = [`name.ilike.%${term}%`];
    if (digits) ors.push(`phone.ilike.%${digits}%`);
    query = query.or(ors.join(","));
  }

  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return (data ?? []).map((r: any) => ({
    id: r.id,
    name: r.name,
    phone: r.phone,
    stamps: Math.min(r.stamps, STAMPS_REQUIRED),
    cyclesCompleted: r.cycles_completed,
    rewardReady: r.stamps >= STAMPS_REQUIRED,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
}

export type ReadyCustomer = {
  id: string;
  name: string;
  phone: string;
  stamps: number;
  readyAt: string | null;
};

/** Customers who completed a card and are waiting to redeem their free product. */
export async function listRewardReady(): Promise<ReadyCustomer[]> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("loyalty_customers")
    .select("id, name, phone, stamps, reward_ready_at")
    .gte("stamps", STAMPS_REQUIRED)
    .order("reward_ready_at", { ascending: true })
    .limit(200);
  if (error) throw new Error(error.message);
  return (data ?? []).map((r: any) => ({
    id: r.id,
    name: r.name,
    phone: r.phone,
    stamps: r.stamps,
    readyAt: r.reward_ready_at,
  }));
}

/**
 * Approve a submission → stamp one heart. Caps the visible counter at the goal
 * and stamps `reward_ready_at` the moment it's reached. Idempotent-ish: a second
 * approval of the same row is a no-op because the status is already 'approved'.
 */
export async function approveSubmission(submissionId: string): Promise<void> {
  const admin = createAdminClient();

  const { data: sub } = await admin
    .from("loyalty_submissions")
    .select("id, customer_id, status")
    .eq("id", submissionId)
    .maybeSingle();
  if (!sub) throw new Error("الطلب غير موجود.");
  if (sub.status !== "pending") return; // already handled

  const { data: customer } = await admin
    .from("loyalty_customers")
    .select("id, stamps, reward_ready_at")
    .eq("id", sub.customer_id)
    .single();
  if (!customer) throw new Error("العميلة غير موجودة.");

  const nextStamps = customer.stamps + 1;
  const patch: Record<string, unknown> = {
    stamps: nextStamps,
    updated_at: new Date().toISOString(),
  };
  if (nextStamps >= STAMPS_REQUIRED && !customer.reward_ready_at) {
    patch.reward_ready_at = new Date().toISOString();
  }

  const { error: cErr } = await admin
    .from("loyalty_customers")
    .update(patch)
    .eq("id", customer.id);
  if (cErr) throw new Error(cErr.message);

  const { error: sErr } = await admin
    .from("loyalty_submissions")
    .update({ status: "approved", reviewed_at: new Date().toISOString() })
    .eq("id", submissionId);
  if (sErr) throw new Error(sErr.message);
}

/** Reject a submission (no heart). Optional note explains why. */
export async function rejectSubmission(submissionId: string, note?: string): Promise<void> {
  const admin = createAdminClient();
  const { error } = await admin
    .from("loyalty_submissions")
    .update({
      status: "rejected",
      note: note?.slice(0, 300) ?? null,
      reviewed_at: new Date().toISOString(),
    })
    .eq("id", submissionId)
    .eq("status", "pending");
  if (error) throw new Error(error.message);
}

/**
 * Redeem the earned reward and start a fresh card: reset hearts to 0, clear the
 * ready flag, and bump the lifetime cycle counter.
 */
export async function redeemReward(customerId: string): Promise<void> {
  const admin = createAdminClient();
  const { data: customer } = await admin
    .from("loyalty_customers")
    .select("id, stamps, cycles_completed")
    .eq("id", customerId)
    .maybeSingle();
  if (!customer) throw new Error("العميلة غير موجودة.");
  if (customer.stamps < STAMPS_REQUIRED) throw new Error("لم تكتمل الختمات بعد.");

  const { error } = await admin
    .from("loyalty_customers")
    .update({
      stamps: 0,
      reward_ready_at: null,
      cycles_completed: customer.cycles_completed + 1,
      updated_at: new Date().toISOString(),
    })
    .eq("id", customerId);
  if (error) throw new Error(error.message);
}
