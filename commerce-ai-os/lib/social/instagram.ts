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
      body: JSON.stringify({ image_url: imageUrl, caption, access_token: token }),
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
