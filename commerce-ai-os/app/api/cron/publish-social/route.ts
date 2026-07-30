// Auto-publisher for the weekly plan. Polled every 15 minutes by Supabase
// pg_cron (supabase/social_publish_cron.sql) — the Vercel Hobby plan only allows
// once-daily crons, so vercel.json keeps a single daily entry as a safety-net
// fallback while pg_cron drives the real 15-minute cadence. Publishes ONLY rows
// the owner explicitly approved on /social whose scheduled_at (UTC) has passed —
// nothing ever posts without that approval tap. Each due row is CLAIMED
// (pending → publishing) before its external call, so overlapping runs / retries
// never publish the same post twice.
//
// Auth: same CRON_SECRET bearer scheme as availability-sync / notify — verified
// before any DB or external work.
import { createAdminClient } from "@/lib/supabase/admin";
import { publishToInstagram, publishStoryToInstagram, publishVideoStoryToInstagram, publishReelToInstagram, instagramConfigured } from "@/lib/social/instagram";
import { publishDuePosts, PUBLISH_LIMIT, type SchedulablePost } from "@/lib/social/publish-due";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const isVid = (u: string) => /\.(mp4|mov|webm)(\?|$)/i.test(u);

export async function GET(req: Request) {
  // 1) Auth first — no DB or external work happens on a bad/absent secret.
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

  const nowIso = new Date().toISOString(); // UTC — the scheduling comparison is timezone-safe

  try {
    const { published, results } = await publishDuePosts({
      nowIso,
      limit: PUBLISH_LIMIT,
      // Due = approved + pending + time passed, oldest first, capped. The pure
      // core re-applies the same gate authoritatively before publishing.
      fetchCandidates: async (cutoffIso, limit) => {
        const { data, error } = await admin
          .from("social_posts")
          .select("id, platform, caption, image_url, status, approved, scheduled_at, extras")
          .eq("status", "pending")
          .eq("approved", true)
          .lte("scheduled_at", cutoffIso)
          .order("scheduled_at", { ascending: true })
          .limit(limit);
        if (error) {
          const hint = /scheduled_at|approved/.test(error.message) ? " — run supabase/social_schedule.sql once" : "";
          throw new Error(error.message + hint);
        }
        return (data ?? []) as SchedulablePost[];
      },
      // Atomic compare-and-set: only the run whose UPDATE still matches
      // status='pending' wins the row. Concurrent runs/retries get [] → false.
      claim: async (id) => {
        const { data } = await admin
          .from("social_posts")
          .update({ status: "publishing" })
          .eq("id", id)
          .eq("status", "pending")
          .select("id");
        return Array.isArray(data) && data.length > 0;
      },
      publish: async (post) => {
        const kind = post.extras?.kind ?? "post";
        const storyIsVideo = post.extras?.storyKind === "video" || isVid(post.image_url);
        const res = kind === "story"
          ? (storyIsVideo ? await publishVideoStoryToInstagram(post.image_url) : await publishStoryToInstagram(post.image_url))
          : kind === "reel"
            ? await publishReelToInstagram(post.image_url, post.caption)
            : await publishToInstagram(post.image_url, post.caption);
        if (!res.ok) return { ok: false, rawError: res.error ?? null };
        // Feed post is live — mirror it to the STORY too (best-effort).
        let storyMirrored = false;
        if (kind === "post") {
          try { storyMirrored = (await publishStoryToInstagram(post.image_url)).ok; } catch { storyMirrored = false; }
        }
        return { ok: true, mediaId: (res as { mediaId?: string }).mediaId ?? null, storyMirrored };
      },
      markPosted: async (id, mediaId, storyMirrored) => {
        await admin.from("social_posts").update({
          status: "posted", error: null, external_id: mediaId, posted_at: new Date().toISOString(),
        }).eq("id", id);
        void storyMirrored;
      },
      markFailed: async (id, safeMessage) => {
        await admin.from("social_posts").update({ status: "failed", error: safeMessage }).eq("id", id);
      },
      warn: (line) => console.warn(line),
    });

    return Response.json({ ok: true, published, results });
  } catch (e: any) {
    return Response.json({ ok: false, error: e?.message ?? "publish run failed" }, { status: 500 });
  }
}
