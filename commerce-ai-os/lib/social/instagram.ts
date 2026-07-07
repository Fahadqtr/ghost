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

    for (const metrics of INSIGHT_METRIC_SETS) {
      const r = await fetch(
        `${GRAPH}/${mediaId}/insights?metric=${metrics}&access_token=${encodeURIComponent(token)}`,
        { cache: "no-store", signal: AbortSignal.timeout(15_000) },
      );
      if (!r.ok) continue;
      const j = (await r.json()) as { data?: { name?: string; values?: { value?: number }[] }[] };
      for (const m of j.data ?? []) {
        const v = Number(m.values?.[0]?.value) || 0;
        if (m.name === "reach") stats.reach = v;
        else if (m.name === "views" || m.name === "impressions") stats.views = v;
        else if (m.name === "saved") stats.saved = v;
        else if (m.name === "shares") stats.shares = v;
      }
      break;
    }
    return { ok: true, permalink: b.permalink, ...stats };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "فشل جلب الإحصائيات.", ...empty };
  }
}

async function publishIg(params: Record<string, string>): Promise<IgPublishResult> {
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
