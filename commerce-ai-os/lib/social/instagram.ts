import "server-only";

// Env-gated Instagram publisher (Meta Graph API — official content publishing).
// Two-step: create a media container from a PUBLIC image URL (our Supabase
// storage URLs qualify), then publish it. Inactive until INSTAGRAM_USER_ID +
// INSTAGRAM_ACCESS_TOKEN are set — same pattern as WhatsApp/web-push.
//
// Setup (same Meta app as WhatsApp works): Instagram Business/Creator account
// linked to a Facebook Page → add the "Instagram Graph API" product → token
// with instagram_basic + instagram_content_publish + pages_show_list.

const GRAPH = "https://graph.facebook.com/v21.0";

export function instagramConfigured(): boolean {
  return Boolean(process.env.INSTAGRAM_USER_ID && process.env.INSTAGRAM_ACCESS_TOKEN);
}

export interface IgPublishResult {
  ok: boolean;
  mediaId?: string;
  error?: string;
}

export async function publishToInstagram(imageUrl: string, caption: string): Promise<IgPublishResult> {
  return publishIg({ image_url: imageUrl, caption });
}

/** Publish an image STORY (no caption support in the API — text lives in the image). */
export async function publishStoryToInstagram(imageUrl: string): Promise<IgPublishResult> {
  return publishIg({ image_url: imageUrl, media_type: "STORIES" });
}

/** Publish a VIDEO story from a public URL (video needs longer processing). */
export async function publishVideoStoryToInstagram(videoUrl: string): Promise<IgPublishResult> {
  return publishIg({ media_type: "STORIES", video_url: videoUrl }, 18);
}

/** Publish a Reel from a PUBLIC video URL. Video takes longer to process, so
 *  we poll the container longer than for images. */
export async function publishReelToInstagram(videoUrl: string, caption: string): Promise<IgPublishResult> {
  return publishIg({ media_type: "REELS", video_url: videoUrl, caption, share_to_feed: "true" }, 18);
}

export interface IgMediaStats {
  ok: boolean;
  error?: string;
  permalink?: string;
  likes: number;
  comments: number;
  reach: number;
  views: number;
  saved: number;
  shares: number;
}

// Insight metric sets tried in order: Meta renamed impressions→views across
// API versions and some media types reject some metrics — the first set the
// API accepts wins. Likes/comments come from the media fields (always work).
const INSIGHT_METRIC_SETS = [
  "views,reach,saved,shares",
  "impressions,reach,saved,shares",
  "reach,saved",
  "reach",
];

/** Performance stats for one published IG media (feed post). */
export async function fetchIgMediaStats(mediaId: string): Promise<IgMediaStats> {
  const token = process.env.INSTAGRAM_ACCESS_TOKEN;
  const empty = { likes: 0, comments: 0, reach: 0, views: 0, saved: 0, shares: 0 };
  if (!token) return { ok: false, error: "إنستقرام غير مهيأ (INSTAGRAM_ACCESS_TOKEN).", ...empty };
  try {
    const base = await fetch(
      `${GRAPH}/${mediaId}?fields=like_count,comments_count,permalink&access_token=${encodeURIComponent(token)}`,
      { cache: "no-store", signal: AbortSignal.timeout(15_000) },
    );
    if (!base.ok) {
      const j = await base.json().catch(() => null) as { error?: { message?: string } } | null;
      return { ok: false, error: j?.error?.message || `HTTP ${base.status}`, ...empty };
    }
    const b = (await base.json()) as { like_count?: number; comments_count?: number; permalink?: string };
    const stats = { ...empty, likes: Number(b.like_count) || 0, comments: Number(b.comments_count) || 0 };

    let gotInsights = false;
    let lastInsightErr = "";
    for (const metrics of INSIGHT_METRIC_SETS) {
      const r = await fetch(
        `${GRAPH}/${mediaId}/insights?metric=${metrics}&access_token=${encodeURIComponent(token)}`,
        { cache: "no-store", signal: AbortSignal.timeout(15_000) },
      );
      if (!r.ok) {
        const j = await r.json().catch(() => null) as { error?: { message?: string } } | null;
        lastInsightErr = j?.error?.message || `HTTP ${r.status}`;
        continue;
      }
      const j = (await r.json()) as { data?: { name?: string; values?: { value?: number }[] }[] };
      for (const m of j.data ?? []) {
        const v = Number(m.values?.[0]?.value) || 0;
        if (m.name === "reach") stats.reach = v;
        else if (m.name === "views" || m.name === "impressions") stats.views = v;
        else if (m.name === "saved") stats.saved = v;
        else if (m.name === "shares") stats.shares = v;
      }
      gotInsights = true;
      break;
    }
    if (!gotInsights && lastInsightErr) console.error("[ig-insights]", mediaId, lastInsightErr);
    return { ok: true, permalink: b.permalink, ...stats };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "فشل جلب الإحصائيات.", ...empty };
  }
}

async function publishIg(params: Record<string, string>, pollAttempts = 6): Promise<IgPublishResult> {
  const igId = process.env.INSTAGRAM_USER_ID;
  const token = process.env.INSTAGRAM_ACCESS_TOKEN;
  if (!igId || !token) return { ok: false, error: "إنستقرام غير مهيأ (INSTAGRAM_USER_ID / INSTAGRAM_ACCESS_TOKEN)." };

  const metaError = async (r: Response) => {
    const j = await r.json().catch(() => null) as { error?: { message?: string } } | null;
    return j?.error?.message || `HTTP ${r.status}`;
  };

  try {
    // 1) Create the media container.
    const create = await fetch(`${GRAPH}/${igId}/media`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...params, access_token: token }),
      cache: "no-store",
      signal: AbortSignal.timeout(20_000),
    });
    if (!create.ok) return { ok: false, error: await metaError(create) };
    const container = (await create.json()) as { id?: string };
    if (!container.id) return { ok: false, error: "ما رجع معرف الحاوية من Meta." };

    // 1b) Wait for the container to finish processing before publishing.
    // Publishing too early returns "Media ID is not available" — Meta needs a
    // few seconds to fetch/process the image (heavier ad images take longer).
    let ready = false;
    for (let attempt = 0; attempt < pollAttempts; attempt++) {
      await new Promise((r) => setTimeout(r, attempt === 0 ? 1500 : 2000));
      try {
        const st = await fetch(
          `${GRAPH}/${container.id}?fields=status_code&access_token=${encodeURIComponent(token)}`,
          { cache: "no-store", signal: AbortSignal.timeout(15_000) }
        );
        const sj = (await st.json().catch(() => null)) as { status_code?: string } | null;
        const code = sj?.status_code;
        if (code === "FINISHED") { ready = true; break; }
        if (code === "ERROR") return { ok: false, error: "فشلت معالجة الصورة عند Meta (تحقق من رابط/حجم الصورة)." };
      } catch { /* transient — keep polling */ }
    }
    if (!ready) return { ok: false, error: "الصورة ما جهزت عند Meta في الوقت المتاح — جرّب مرة ثانية." };

    // 2) Publish it.
    const pub = await fetch(`${GRAPH}/${igId}/media_publish`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ creation_id: container.id, access_token: token }),
      cache: "no-store",
      signal: AbortSignal.timeout(20_000),
    });
    if (!pub.ok) return { ok: false, error: await metaError(pub) };
    const media = (await pub.json()) as { id?: string };
    return { ok: true, mediaId: media.id };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "فشل النشر على إنستقرام." };
  }
}
