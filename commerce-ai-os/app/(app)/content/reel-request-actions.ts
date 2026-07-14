"use server";

import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireUser } from "@/lib/auth/requireUser";
import { queueReel } from "./actions";
import { buildReelBrief } from "@/lib/social/reel-request-compute";

// "Professional reel" request queue (Higgsfield Marketing Studio talking-avatar
// UGC). The owner files a request (product + style + desired slot + notes); the
// reel is produced via Marketing Studio, then its mp4 URL is pasted back here →
// the request is scheduled into social_posts (existing Reels queue) and closed.

function db(): any {
  try { return createAdminClient(); } catch { return createClient(); }
}

// A missing table (feature not migrated yet) shouldn't hard-fail the page.
const isMissingTable = (msg?: string) => !!msg && /reel_requests.*(does not exist|schema cache)|relation .*reel_requests/i.test(msg);

export interface ReelRequestRow {
  id: string;
  sku: string | null;
  productName: string | null;
  style: string | null;
  notes: string | null;
  scheduledAtIso: string | null;
  status: string;
  videoUrl: string | null;
  brief: string;
  createdAtIso: string | null;
}

export async function createReelRequest(input: {
  sku?: string | null; productName?: string | null; style?: string | null;
  notes?: string | null; scheduledAtIso?: string | null;
}): Promise<{ error: string } | { ok: true }> {
  const unauth = await requireUser();
  if (unauth) return unauth;
  if (!String(input.sku || input.productName || "").trim()) return { error: "اختر منتجًا أولًا." };
  const row = {
    sku: input.sku ?? null,
    product_name: input.productName ?? null,
    style: input.style ?? "ugc_gadget_saved_me",
    notes: (input.notes ?? "").trim() || null,
    scheduled_at: input.scheduledAtIso || null,
    status: "pending",
  };
  const { error } = await db().from("reel_requests").insert(row);
  if (error) {
    if (isMissingTable(error.message)) return { error: "جدول الطلبات غير مهيأ بعد — شغّل supabase/reel_requests.sql." };
    return { error: error.message };
  }
  return { ok: true };
}

export async function listReelRequests(): Promise<{ error: string } | { rows: ReelRequestRow[] }> {
  const unauth = await requireUser();
  if (unauth) return unauth;
  const { data, error } = await db()
    .from("reel_requests")
    .select("id, sku, product_name, style, notes, scheduled_at, status, video_url, created_at")
    .order("created_at", { ascending: false })
    .limit(40);
  if (error) {
    if (isMissingTable(error.message)) return { rows: [] };
    return { error: error.message };
  }
  const rows: ReelRequestRow[] = (data ?? []).map((r: any) => ({
    id: r.id,
    sku: r.sku ?? null,
    productName: r.product_name ?? null,
    style: r.style ?? null,
    notes: r.notes ?? null,
    scheduledAtIso: r.scheduled_at ?? null,
    status: r.status ?? "pending",
    videoUrl: r.video_url ?? null,
    brief: buildReelBrief({ productName: r.product_name, sku: r.sku, style: r.style, notes: r.notes, scheduledAtIso: r.scheduled_at }),
    createdAtIso: r.created_at ?? null,
  }));
  return { rows };
}

/** Attach the finished reel URL to a request and schedule it into social_posts. */
export async function scheduleReelRequest(input: { id: string; videoUrl: string }):
  Promise<{ error: string } | { ok: true }> {
  const unauth = await requireUser();
  if (unauth) return unauth;
  const id = String(input.id || "").trim();
  const videoUrl = String(input.videoUrl || "").trim();
  if (!id) return { error: "طلب غير معروف." };
  if (!/^https?:\/\/.+\.(mp4|mov|webm)(\?|$)/i.test(videoUrl)) return { error: "رابط فيديو غير صالح — لازم mp4/mov/webm." };

  const client = db();
  const { data: req, error: readErr } = await client
    .from("reel_requests").select("sku, scheduled_at").eq("id", id).maybeSingle();
  if (readErr) return { error: isMissingTable(readErr.message) ? "جدول الطلبات غير مهيأ بعد." : readErr.message };

  // Schedule into the existing Reels queue (talking-avatar reel → review/conversion).
  const slot = req?.scheduled_at || new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const q = await queueReel({ sku: req?.sku ?? null, format: "review", ctaType: "conversion", scheduledAtIso: slot, videoUrl });
  if ("error" in q) return q;

  const { error: upErr } = await client
    .from("reel_requests").update({ status: "scheduled", video_url: videoUrl, updated_at: new Date().toISOString() }).eq("id", id);
  if (upErr) return { error: upErr.message };
  return { ok: true };
}

export async function cancelReelRequest(id: string): Promise<{ error: string } | { ok: true }> {
  const unauth = await requireUser();
  if (unauth) return unauth;
  const { error } = await db().from("reel_requests")
    .update({ status: "cancelled", updated_at: new Date().toISOString() }).eq("id", String(id || "").trim());
  if (error) return { error: error.message };
  return { ok: true };
}
