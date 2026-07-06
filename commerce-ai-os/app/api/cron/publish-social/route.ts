// Auto-publisher for the weekly plan (called every ~15 min — Supabase pg_cron
// or Vercel Cron, see supabase/social_publish_cron.sql). Publishes ONLY rows
// the owner explicitly approved on /social whose scheduled_at has passed —
// nothing ever posts without that approval tap.
//
// Auth: same CRON_SECRET bearer scheme as availability-sync / notify.
import { createAdminClient } from "@/lib/supabase/admin";
import { publishToInstagram, instagramConfigured } from "@/lib/social/instagram";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  if (!instagramConfigured()) {
    return Response.json({ ok: true, configured: false, note: "Instagram env missing — nothing published" });
  }

  let admin;
  try { admin = createAdminClient(); }
  catch (e: any) { return Response.json({ ok: false, error: e?.message ?? "service role unavailable" }, { status: 500 }); }

  // Due = approved + pending + scheduled time passed. Cap per run so one hung
  // Meta call can never starve the rest; the next tick picks up the remainder.
  const { data: due, error } = await admin
    .from("social_posts")
    .select("id, platform, caption, image_url")
    .eq("status", "pending")
    .eq("approved", true)
    .lte("scheduled_at", new Date().toISOString())
    .order("scheduled_at", { ascending: true })
    .limit(3);
  if (error) {
    const hint = /scheduled_at|approved/.test(error.message) ? " — run supabase/social_schedule.sql once" : "";
    return Response.json({ ok: false, error: error.message + hint }, { status: 500 });
  }
  if (!due?.length) return Response.json({ ok: true, published: 0 });

  const results: Record<string, unknown>[] = [];
  for (const row of due as { id: string; platform: string; caption: string; image_url: string }[]) {
    if (row.platform !== "instagram") { results.push({ id: row.id, skipped: row.platform }); continue; }
    const res = await publishToInstagram(row.image_url, row.caption);
    if (res.ok) {
      await admin.from("social_posts").update({
        status: "posted", error: null, external_id: res.mediaId ?? null, posted_at: new Date().toISOString(),
      }).eq("id", row.id);
      results.push({ id: row.id, ok: true });
    } else {
      await admin.from("social_posts").update({ status: "failed", error: res.error ?? "فشل النشر" }).eq("id", row.id);
      results.push({ id: row.id, error: res.error });
    }
  }
  return Response.json({ ok: true, published: results.filter((r) => r.ok).length, results });
}
