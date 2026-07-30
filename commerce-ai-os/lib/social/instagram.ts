import "server-only";
import { graphFetch } from "./graph";

// Env-gated Instagram publisher (Meta Graph API — official content publishing).
// Two-step: create a media container from a PUBLIC image URL (our Supabase
// storage URLs qualify), then publish it. Inactive until INSTAGRAM_USER_ID +
// INSTAGRAM_ACCESS_TOKEN are set — same pattern as WhatsApp/web-push.
//
// Setup (same Meta app as WhatsApp works): Instagram Business/Creator account
// linked to a Facebook Page → add the "Instagram Graph API" product → token
// with instagram_basic + instagram_content_publish + pages_show_list.
//
// The token rides in the Authorization: Bearer header (via graphFetch) so it
// never appears in a request URL, log, proxy, or error trace.

// Env values pasted into the dashboard often pick up a stray newline, space, or
// wrapping quotes — Meta then rejects the token with "Cannot parse access
// token". Normalize on read so a clean copy isn't required to publish.
function cleanEnv(v: string | undefined): string {
  return String(v ?? "").trim().replace(/^["']|["']$/g, "").trim();
}
// Accept BOTH the app's original names and the Meta-style aliases from the
// rollout plan, so whichever the operator pasted into Vercel just works.
function igUserId(): string { return cleanEnv(process.env.INSTAGRAM_USER_ID) || cleanEnv(process.env.IG_USER_ID); }
function igToken(): string { return cleanEnv(process.env.INSTAGRAM_ACCESS_TOKEN) || cleanEnv(process.env.META_ACCESS_TOKEN); }

export function instagramConfigured(): boolean {
  return Boolean(igUserId() && igToken());
}

export interface IgPublishResult {
  ok: boolean;
  mediaId?: string;
  error?: string;
}

export interface IgVerifyResult {
  ok: boolean;
  tokenPresent: boolean;
  igUserId: string | null;
  igUserIdSource: "env" | "derived" | null;
  username: string | null;
  containerId: string | null;
  summary: string;
  error?: string;
  setEnv?: string; // e.g. "INSTAGRAM_USER_ID=1784..." when derived and not yet set
}

// Derive the IG business account id from the token (page → instagram account),
// so the operator doesn't have to hunt for it manually.
async function deriveIgUserId(token: string): Promise<{ id?: string; error?: string }> {
  const r = await graphFetch<{ data?: { instagram_business_account?: { id?: string } }[] }>(
    "/me/accounts",
    { token, query: { fields: "name,instagram_business_account" }, timeoutMs: 15_000 },
  );
  if (!r.ok) return { error: r.errorMessage || `HTTP ${r.status}` };
  for (const p of r.data?.data ?? []) if (p?.instagram_business_account?.id) return { id: p.instagram_business_account.id };
  return { error: "ما لقيت instagram_business_account على أي صفحة — تأكد إن حساب انستقرام Business ومربوط بصفحة فيسبوك." };
}

/**
 * Phase 0 verification: confirm the token, resolve the IG user id (env or
 * derived), read the username, and CREATE a Reels container (no publish) to
 * prove content-publishing works. Nothing is posted.
 */
export async function verifyIgSetup(): Promise<IgVerifyResult> {
  const base: IgVerifyResult = { ok: false, tokenPresent: false, igUserId: null, igUserIdSource: null, username: null, containerId: null, summary: "" };
  const token = igToken();
  if (!token) return { ...base, summary: "❌ ما فيه توكن. ضبط INSTAGRAM_ACCESS_TOKEN (أو META_ACCESS_TOKEN) في Vercel ثم Redeploy." };
  base.tokenPresent = true;

  let id = igUserId();
  let source: "env" | "derived" = "env";
  if (!id) {
    const d = await deriveIgUserId(token);
    if (d.error || !d.id) return { ...base, error: d.error, summary: `❌ التوكن موجود بس تعذّر جلب IG_USER_ID: ${d.error ?? "غير معروف"}` };
    id = d.id; source = "derived";
  }
  base.igUserId = id; base.igUserIdSource = source;

  // username
  const u = await graphFetch<{ username?: string }>(`/${id}`, { token, query: { fields: "username" }, timeoutMs: 15_000 });
  if (!u.ok) return { ...base, error: u.errorMessage, summary: `❌ التوكن/الـID لا يعملان: ${u.errorMessage ?? `HTTP ${u.status}`}` };
  base.username = u.data?.username ?? null;

  // container test (create only — never publish)
  const SAMPLE = "https://storage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4";
  const c = await graphFetch<{ id?: string }>(`/${id}/media`, {
    token, method: "POST",
    body: { media_type: "REELS", video_url: SAMPLE, caption: "verification only — not published" },
    timeoutMs: 20_000,
  });
  const containerId = c.data?.id ?? null;
  if (!c.ok || !containerId) {
    return { ...base, error: c.errorMessage, summary: `⚠️ التوكن يقرأ الحساب (@${base.username}) بس إنشاء الحاوية فشل: ${c.errorMessage ?? `HTTP ${c.status}`} — تأكد من صلاحية instagram_content_publish.` };
  }

  const setEnv = source === "derived" ? `INSTAGRAM_USER_ID=${id}` : undefined;
  return {
    ...base, ok: true, containerId,
    setEnv,
    summary: `✅ جاهز! الحساب @${base.username} · IG_USER_ID=${id}${source === "derived" ? " (مشتقّ تلقائيًا)" : ""} · نجح إنشاء حاوية Reels (${containerId}). ${setEnv ? `أضف ${setEnv} في Vercel لتثبيته.` : ""} تقدر الحين تنشر ريل تجريبي.`,
  };
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
  const token = igToken();
  const empty = { likes: 0, comments: 0, reach: 0, views: 0, saved: 0, shares: 0 };
  if (!token) return { ok: false, error: "إنستقرام غير مهيأ (INSTAGRAM_ACCESS_TOKEN).", ...empty };
  try {
    const base = await graphFetch<{ like_count?: number; comments_count?: number; permalink?: string }>(
      `/${mediaId}`,
      { token, query: { fields: "like_count,comments_count,permalink" }, timeoutMs: 15_000 },
    );
    if (!base.ok) {
      return { ok: false, error: base.errorMessage || `HTTP ${base.status}`, ...empty };
    }
    const b = base.data ?? {};
    const stats = { ...empty, likes: Number(b.like_count) || 0, comments: Number(b.comments_count) || 0 };

    let gotInsights = false;
    let lastInsightErr = "";
    for (const metrics of INSIGHT_METRIC_SETS) {
      const r = await graphFetch<{ data?: { name?: string; values?: { value?: number }[] }[] }>(
        `/${mediaId}/insights`,
        { token, query: { metric: metrics }, timeoutMs: 15_000 },
      );
      if (!r.ok) {
        lastInsightErr = r.errorMessage || `HTTP ${r.status}`;
        continue;
      }
      const j = r.data ?? {};
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
  const igId = igUserId();
  const token = igToken();
  if (!igId || !token) return { ok: false, error: "إنستقرام غير مهيأ (INSTAGRAM_USER_ID / INSTAGRAM_ACCESS_TOKEN)." };

  try {
    // 1) Create the media container.
    const create = await graphFetch<{ id?: string }>(`/${igId}/media`, {
      token, method: "POST", body: { ...params }, timeoutMs: 20_000,
    });
    if (!create.ok) return { ok: false, error: create.errorMessage || `HTTP ${create.status}` };
    const container = create.data ?? {};
    if (!container.id) return { ok: false, error: "ما رجع معرف الحاوية من Meta." };

    // 1b) Wait for the container to finish processing before publishing.
    // Publishing too early returns "Media ID is not available" — Meta needs a
    // few seconds to fetch/process the image (heavier ad images take longer).
    let ready = false;
    for (let attempt = 0; attempt < pollAttempts; attempt++) {
      await new Promise((r) => setTimeout(r, attempt === 0 ? 1500 : 2000));
      const st = await graphFetch<{ status_code?: string; status?: string }>(
        `/${container.id}`,
        { token, query: { fields: "status_code,status" }, timeoutMs: 15_000 },
      );
      if (!st.ok) continue; // transient — keep polling
      const code = st.data?.status_code;
      if (code === "FINISHED") { ready = true; break; }
      // Surface Meta's specific reason (e.g. unsupported format / aspect ratio)
      // instead of a generic message, so a bad media file is diagnosable.
      if (code === "ERROR") return { ok: false, error: `فشلت معالجة الوسائط عند Meta: ${st.data?.status || "تحقق من الصيغة/الأبعاد (Reels: 9:16، MP4/H.264)."}` };
    }
    if (!ready) return { ok: false, error: "الصورة ما جهزت عند Meta في الوقت المتاح — جرّب مرة ثانية." };

    // 2) Publish it.
    const pub = await graphFetch<{ id?: string }>(`/${igId}/media_publish`, {
      token, method: "POST", body: { creation_id: container.id }, timeoutMs: 20_000,
    });
    if (!pub.ok) return { ok: false, error: pub.errorMessage || `HTTP ${pub.status}` };
    return { ok: true, mediaId: pub.data?.id };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "فشل النشر على إنستقرام." };
  }
}
