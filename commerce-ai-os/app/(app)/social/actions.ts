"use server";

import { createAdminClient } from "@/lib/supabase/admin";
import { isSignedIn } from "@/lib/auth/requireUser";
import { revalidatePath } from "next/cache";
import { publishToInstagram, instagramConfigured } from "@/lib/social/instagram";
import { publishToTikTok, tiktokConfigured } from "@/lib/social/tiktok";
import { generateDailySocialPosts } from "@/lib/social/generate";

// Review-first social queue: list pending/recent, publish one (routes to the
// right platform), dismiss one. Owner session required; rows via service role.

export type SocialPost = {
  id: string;
  platform: string;
  caption: string;
  image_url: string;
  status: string;
  error: string | null;
  created_at: string;
  posted_at: string | null;
};

function admin(): any | null {
  try { return createAdminClient(); } catch { return null; }
}
const NO_DB = "الخادم غير مهيأ (SUPABASE_SERVICE_ROLE_KEY).";

export async function listSocialPosts(): Promise<{ error?: string; pending: SocialPost[]; recent: SocialPost[]; configured: { instagram: boolean; tiktok: boolean } }> {
  const configured = { instagram: instagramConfigured(), tiktok: tiktokConfigured() };
  if (!(await isSignedIn())) return { error: "Not signed in.", pending: [], recent: [], configured };
  const sb = admin();
  if (!sb) return { error: NO_DB, pending: [], recent: [], configured };

  const { data, error } = await sb
    .from("social_posts")
    .select("id, platform, caption, image_url, status, error, created_at, posted_at")
    .order("created_at", { ascending: false })
    .limit(40);
  if (error) {
    const hint = /social_posts/.test(error.message) ? " — شغّل supabase/social_posts.sql مرة وحدة." : "";
    return { error: error.message + hint, pending: [], recent: [], configured };
  }
  const rows = (data ?? []) as SocialPost[];
  return {
    pending: rows.filter((r) => r.status === "pending" || r.status === "failed"),
    recent: rows.filter((r) => r.status === "posted" || r.status === "dismissed").slice(0, 10),
    configured,
  };
}

export async function publishSocialPost(id: string, caption: string): Promise<{ ok?: true; error?: string }> {
  if (!(await isSignedIn())) return { error: "Not signed in." };
  const sb = admin();
  if (!sb) return { error: NO_DB };

  const { data: row } = await sb.from("social_posts").select("*").eq("id", id).single();
  if (!row) return { error: "المنشور غير موجود." };
  if (row.status === "posted") return { error: "منشور مسبقًا." };

  const text = String(caption ?? "").trim() || String(row.caption ?? "");
  const res = row.platform === "instagram"
    ? await publishToInstagram(row.image_url, text)
    : row.platform === "tiktok"
      ? await publishToTikTok(row.image_url, text)
      : { ok: false as const, error: `منصة غير معروفة: ${row.platform}` };

  if (!res.ok) {
    await sb.from("social_posts").update({ status: "failed", error: res.error ?? "فشل النشر", caption: text }).eq("id", id);
    revalidatePath("/social");
    return { error: res.error ?? "فشل النشر" };
  }

  await sb.from("social_posts").update({
    status: "posted",
    caption: text,
    error: null,
    external_id: (res as any).mediaId ?? (res as any).publishId ?? null,
    posted_at: new Date().toISOString(),
  }).eq("id", id);
  revalidatePath("/social");
  return { ok: true };
}

export async function dismissSocialPost(id: string): Promise<{ ok?: true; error?: string }> {
  if (!(await isSignedIn())) return { error: "Not signed in." };
  const sb = admin();
  if (!sb) return { error: NO_DB };
  await sb.from("social_posts").update({ status: "dismissed" }).eq("id", id);
  revalidatePath("/social");
  return { ok: true };
}

// Manual "generate now" for testing / a second post — same engine as the cron.
export async function generateNowAction(): Promise<{ ok?: true; error?: string; note?: string }> {
  if (!(await isSignedIn())) return { error: "Not signed in." };
  const sb = admin();
  if (!sb) return { error: NO_DB };
  const r = await generateDailySocialPosts(sb);
  revalidatePath("/social");
  if (!r.enabled) return { error: "المحرّك غير مفعّل — أضف SOCIAL_PLATFORMS في Vercel (مثال: instagram)." };
  if (!r.created) return { note: r.skipped ?? "ما انولّد شي" };
  return { ok: true };
}
