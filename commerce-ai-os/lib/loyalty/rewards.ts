// Beauty Rewards loyalty logic — the single source of truth for stamps.
// SERVER ONLY: every function here uses the service-role admin client, so it
// must never be imported into a Client Component. The public API routes
// (/api/rewards/*) and the admin server actions call in through here.
import { createAdminClient } from "@/lib/supabase/admin";
import { sendWhatsAppTo, sendWhatsAppImageTo } from "@/lib/whatsapp";
import { planCustomerName, shouldApplyPrizeChange } from "@/lib/loyalty/rewards-public";

/** Hearts needed to earn one free product. */
export const STAMPS_REQUIRED = 6;

export const REVIEW_BUCKET = "loyalty-reviews";
export const PRIZE_BUCKET = "loyalty-prizes";

export type SubmissionStatus = "pending" | "approved" | "rejected";

export type PrizeOption = {
  id: string;
  name: string;
  imageUrl: string;
};

export type RewardState = {
  name: string;
  phone: string;
  stamps: number;
  required: number;
  rewardReady: boolean;
  cyclesCompleted: number;
  pending: number; // screenshots awaiting review
  lastStatus: SubmissionStatus | null; // status of the most recent submission
  prizes: PrizeOption[]; // active prizes the customer can pick from
  chosenPrizeId: string | null; // which prize they selected (after completing)
  voucherCode: string | null; // printable code once the card is complete
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
  const COLS = "id, name, phone, stamps, cycles_completed, reward_ready_at, chosen_prize_id";

  // Look the customer up first. Existing customers KEEP their stored name — a
  // public request must never rename them (renames are admin-only) and we don't
  // touch updated_at when nothing actually changes. New phones are created with
  // the submitted name.
  const { data: existing } = await admin
    .from("loyalty_customers")
    .select(COLS)
    .eq("phone", phone)
    .maybeSingle();

  const plan = planCustomerName(existing ? { name: existing.name } : null, name);
  if (plan.action === "keep") {
    return stateFor(admin, existing as CustomerRow);
  }

  const { data: created, error } = await admin
    .from("loyalty_customers")
    .insert({ phone, name: plan.name })
    .select(COLS)
    .single();
  if (error || !created) {
    // A concurrent create can lose the insert race (unique phone) — re-read.
    const { data: again } = await admin
      .from("loyalty_customers")
      .select(COLS)
      .eq("phone", phone)
      .maybeSingle();
    if (again) return stateFor(admin, again as CustomerRow);
    throw new Error("تعذّر إنشاء البطاقة.");
  }
  return stateFor(admin, created);
}

/** Read-only state lookup by phone (returns null if the customer doesn't exist). */
export async function getStateByPhone(rawPhone: string): Promise<RewardState | null> {
  const phone = normalizePhone(rawPhone);
  if (!phone) return null;
  const admin = createAdminClient();
  const { data: customer } = await admin
    .from("loyalty_customers")
    .select("id, name, phone, stamps, cycles_completed, reward_ready_at, chosen_prize_id")
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
  chosen_prize_id: string | null;
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

  const prizes = await listActivePrizes();

  return {
    name: customer.name,
    phone: customer.phone,
    stamps: Math.min(customer.stamps, STAMPS_REQUIRED),
    required: STAMPS_REQUIRED,
    rewardReady: customer.stamps >= STAMPS_REQUIRED,
    cyclesCompleted: customer.cycles_completed,
    pending: pending ?? 0,
    lastStatus: (last?.status as SubmissionStatus | undefined) ?? null,
    prizes,
    chosenPrizeId: customer.chosen_prize_id,
    voucherCode:
      customer.stamps >= STAMPS_REQUIRED
        ? voucherCode(customer.id, customer.cycles_completed)
        : null,
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

// --- Prizes -----------------------------------------------------------------

export type PrizeRecord = {
  id: string;
  name: string;
  imageUrl: string;
  imagePath: string;
  active: boolean;
  sortOrder: number;
};

/** Active prizes for the customer card, in display order. */
export async function listActivePrizes(): Promise<PrizeOption[]> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("loyalty_prizes")
    .select("id, name, image_url")
    .eq("active", true)
    .order("sort_order", { ascending: true })
    .order("created_at", { ascending: true })
    .limit(50);
  if (error) throw new Error(error.message);
  return (data ?? []).map((r: any) => ({ id: r.id, name: r.name ?? "", imageUrl: r.image_url }));
}

/** Every prize (active + hidden) for the admin manager. */
export async function listAllPrizes(): Promise<PrizeRecord[]> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("loyalty_prizes")
    .select("id, name, image_url, image_path, active, sort_order")
    .order("sort_order", { ascending: true })
    .order("created_at", { ascending: true })
    .limit(200);
  if (error) throw new Error(error.message);
  return (data ?? []).map((r: any) => ({
    id: r.id,
    name: r.name ?? "",
    imageUrl: r.image_url,
    imagePath: r.image_path,
    active: r.active,
    sortOrder: r.sort_order,
  }));
}

/** Insert a prize (image already uploaded to the prizes bucket). */
export async function addPrize(name: string, imagePath: string, imageUrl: string): Promise<void> {
  const admin = createAdminClient();
  const { error } = await admin.from("loyalty_prizes").insert({
    name: (name ?? "").trim().slice(0, 100),
    image_path: imagePath,
    image_url: imageUrl,
  });
  if (error) throw new Error(error.message);
}

/** Show / hide a prize on the customer card without deleting it. */
export async function setPrizeActive(id: string, active: boolean): Promise<void> {
  const admin = createAdminClient();
  const { error } = await admin.from("loyalty_prizes").update({ active }).eq("id", id);
  if (error) throw new Error(error.message);
}

/** Delete a prize. Customers who chose it fall back to null (FK on delete). */
export async function deletePrize(id: string): Promise<void> {
  const admin = createAdminClient();
  const { error } = await admin.from("loyalty_prizes").delete().eq("id", id);
  if (error) throw new Error(error.message);
}

/**
 * A completed customer picks their prize. Only allowed once the card is full,
 * and only for an active prize. Records the choice for the owner to fulfill.
 */
export async function chooseReward(rawPhone: string, prizeId: string): Promise<RewardState> {
  const phone = normalizePhone(rawPhone);
  if (!phone) throw new Error("رقم الجوال غير صحيح.");
  const admin = createAdminClient();

  const { data: customer } = await admin
    .from("loyalty_customers")
    .select("id, stamps, chosen_prize_id")
    .eq("phone", phone)
    .maybeSingle();
  if (!customer) throw new Error("العميلة غير موجودة.");
  if (customer.stamps < STAMPS_REQUIRED) throw new Error("لم تكتمل الختمات بعد.");

  // Idempotent: re-choosing the SAME prize is a no-op — no write, and no
  // second WhatsApp (which would let a repeat call spam the customer).
  if (!shouldApplyPrizeChange(customer.chosen_prize_id, prizeId)) {
    const cur = await getStateByPhone(phone);
    if (!cur) throw new Error("تعذّر تحديث الحالة.");
    return cur;
  }

  const { data: prize } = await admin
    .from("loyalty_prizes")
    .select("id, active")
    .eq("id", prizeId)
    .maybeSingle();
  if (!prize || !prize.active) throw new Error("الجائزة غير متاحة.");

  const { error } = await admin
    .from("loyalty_customers")
    .update({ chosen_prize_id: prizeId, updated_at: new Date().toISOString() })
    .eq("id", customer.id);
  if (error) throw new Error(error.message);

  // Send the prize card to the customer's WhatsApp (best-effort — never blocks).
  try {
    const v = await getVoucher(customer.id);
    const caption =
      `🎁 مبروك ${v.name}! جائزتك من مكافآت الجمال: ${v.prizeName || "منتج مجاني"}.\n` +
      `رقم القسيمة: ${v.code}\n` +
      `أبرزي هذه البطاقة عند الاستلام 💝`;
    if (v.prizeImage) await sendWhatsAppImageTo(v.phone, v.prizeImage, caption);
    else await sendWhatsAppTo(v.phone, caption);
  } catch {
    /* notification failure must never fail the choice */
  }

  const next = await getStateByPhone(phone);
  if (!next) throw new Error("تعذّر تحديث الحالة.");
  return next;
}

// --- Prize voucher (win) ----------------------------------------------------

export type Voucher = {
  customerId: string;
  name: string;
  phone: string;
  ready: boolean; // card is complete
  code: string; // printable voucher code
  prizeName: string | null;
  prizeImage: string | null;
  issuedAt: string; // ISO — when the voucher was viewed/generated
};

/** Deterministic, human-readable voucher code for a completed card. */
function voucherCode(id: string, cycle: number): string {
  return `MU-${id.replace(/-/g, "").slice(0, 6).toUpperCase()}-${cycle + 1}`;
}

/** Build the win voucher for a customer (must have completed the card). */
export async function getVoucher(customerId: string): Promise<Voucher> {
  const admin = createAdminClient();
  const { data: c } = await admin
    .from("loyalty_customers")
    .select("id, name, phone, stamps, cycles_completed, chosen_prize_id")
    .eq("id", customerId)
    .maybeSingle();
  if (!c) throw new Error("العميلة غير موجودة.");

  let prizeName: string | null = null;
  let prizeImage: string | null = null;
  if (c.chosen_prize_id) {
    const { data: p } = await admin
      .from("loyalty_prizes")
      .select("name, image_url")
      .eq("id", c.chosen_prize_id)
      .maybeSingle();
    if (p) {
      prizeName = p.name ?? "";
      prizeImage = p.image_url;
    }
  }

  return {
    customerId: c.id,
    name: c.name,
    phone: c.phone,
    ready: c.stamps >= STAMPS_REQUIRED,
    code: voucherCode(c.id, c.cycles_completed),
    prizeName,
    prizeImage,
    issuedAt: new Date().toISOString(),
  };
}

/**
 * Send the customer a WhatsApp confirming their won prize + voucher code.
 * Returns the send result (so the admin UI can report configured/ok/error).
 */
export async function sendVoucherWhatsApp(customerId: string) {
  const v = await getVoucher(customerId);
  if (!v.ready) throw new Error("لم تكتمل الختمات بعد.");
  const prizeLine = v.prizeName
    ? `جائزتك: ${v.prizeName}`
    : "جائزتك المجانية جاهزة";
  const msg = `🎉 مبروك ${v.name}! أكملتِ بطاقة مكافآت الجمال. ${prizeLine}. رقم القسيمة: ${v.code}. أبرزي هذه الرسالة عند الاستلام 💝`;
  return sendWhatsAppTo(v.phone, msg);
}

/**
 * Edit a customer's details from the admin table. Any of name / phone / stamps
 * may be updated. Phone is re-normalized and must stay unique; stamps is clamped
 * to 0..required and re-arms or clears the reward-ready flag accordingly.
 */
export async function updateCustomer(
  id: string,
  fields: { name?: string; phone?: string; stamps?: number }
): Promise<void> {
  const admin = createAdminClient();
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };

  if (fields.name !== undefined) {
    const name = fields.name.trim().replace(/\s+/g, " ").slice(0, 80);
    if (!name) throw new Error("الاسم مطلوب.");
    patch.name = name;
  }
  if (fields.phone !== undefined) {
    const phone = normalizePhone(fields.phone);
    if (!phone) throw new Error("رقم الجوال غير صحيح.");
    patch.phone = phone;
  }
  if (fields.stamps !== undefined) {
    const stamps = Math.max(0, Math.min(Math.floor(fields.stamps), STAMPS_REQUIRED));
    patch.stamps = stamps;
    // keep reward_ready_at consistent with the new count
    patch.reward_ready_at = stamps >= STAMPS_REQUIRED ? new Date().toISOString() : null;
  }

  const { error } = await admin.from("loyalty_customers").update(patch).eq("id", id);
  if (error) {
    // 23505 = unique_violation on phone
    if ((error as any).code === "23505") throw new Error("رقم الجوال مستخدم لزبونة أخرى.");
    throw new Error(error.message);
  }
}

/** Delete a customer and all their submissions (cascade via the FK). */
export async function deleteCustomer(id: string): Promise<void> {
  const admin = createAdminClient();
  const { error } = await admin.from("loyalty_customers").delete().eq("id", id);
  if (error) throw new Error(error.message);
}

export type ReadyCustomer = {
  id: string;
  name: string;
  phone: string;
  stamps: number;
  readyAt: string | null;
  chosenPrizeName: string | null; // what the customer picked (null = not chosen yet)
  chosenPrizeImage: string | null;
};

/** Customers who completed a card and are waiting to redeem their free product. */
export async function listRewardReady(): Promise<ReadyCustomer[]> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("loyalty_customers")
    .select("id, name, phone, stamps, reward_ready_at, chosen_prize_id")
    .gte("stamps", STAMPS_REQUIRED)
    .order("reward_ready_at", { ascending: true })
    .limit(200);
  if (error) throw new Error(error.message);
  const rows = data ?? [];

  // Resolve chosen prizes in one lookup (avoids relying on the FK embed name).
  const prizeIds = [...new Set(rows.map((r: any) => r.chosen_prize_id).filter(Boolean))];
  const prizeMap = new Map<string, { name: string; imageUrl: string }>();
  if (prizeIds.length) {
    const { data: prizes } = await admin
      .from("loyalty_prizes")
      .select("id, name, image_url")
      .in("id", prizeIds);
    for (const p of prizes ?? []) prizeMap.set(p.id, { name: p.name ?? "", imageUrl: p.image_url });
  }

  return rows.map((r: any) => {
    const prize = r.chosen_prize_id ? prizeMap.get(r.chosen_prize_id) : undefined;
    return {
      id: r.id,
      name: r.name,
      phone: r.phone,
      stamps: r.stamps,
      readyAt: r.reward_ready_at,
      chosenPrizeName: prize?.name ?? null,
      chosenPrizeImage: prize?.imageUrl ?? null,
    };
  });
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
    .select("id, name, phone, stamps, reward_ready_at")
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

  // Congratulate the customer on WhatsApp (best-effort — never blocks approval;
  // no-ops unless WhatsApp is configured, and delivery follows Meta's rules).
  const shown = Math.min(nextStamps, STAMPS_REQUIRED);
  const msg =
    shown >= STAMPS_REQUIRED
      ? `🎉🌷 مبروك ${customer.name}! أكملتِ قلوبك الـ${STAMPS_REQUIRED} في بطاقة مكافآت الجمال — Malika's Universe.\n` +
        `جمالك استحق المكافأة 💝 افتحي بطاقتك واختاري جائزتك الحين، وبتوصلك على واتساب.`
      : `❤ تم ختم قلب لكِ يا ${customer.name}! صار عندك ${shown} من ${STAMPS_REQUIRED} في بطاقة مكافآت الجمال. ${STAMPS_REQUIRED - shown} باقية على هديتك 🌷`;
  try {
    await sendWhatsAppTo(customer.phone, msg);
  } catch {
    /* best-effort: a notification failure must never fail the approval */
  }
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
      chosen_prize_id: null, // fresh card → no prize chosen yet
      cycles_completed: customer.cycles_completed + 1,
      updated_at: new Date().toISOString(),
    })
    .eq("id", customerId);
  if (error) throw new Error(error.message);
}
