import "server-only";

// Env-gated TikTok publisher (official Content Posting API — photo post via
// PULL_FROM_URL). Inactive until TIKTOK_ACCESS_TOKEN is set.
//
// ⚠️ TikTok reality check (documented so nobody is surprised):
// • Until the TikTok developer app passes their AUDIT, direct posts are forced
//   to SELF_ONLY visibility (only the account sees them). Default here honors
//   that; set TIKTOK_PRIVACY=PUBLIC_TO_EVERYONE after the app is approved.
// • PULL_FROM_URL requires the image domain (our *.supabase.co storage) to be
//   verified in the TikTok app settings (URL properties).
// • Tokens come from TikTok's OAuth and expire — refresh is the owner's job
//   for now (or a later feature).

const TIKTOK_INIT = "https://open.tiktokapis.com/v2/post/publish/content/init/";

export function tiktokConfigured(): boolean {
  return Boolean(process.env.TIKTOK_ACCESS_TOKEN);
}

export interface TtPublishResult {
  ok: boolean;
  publishId?: string;
  error?: string;
}

export async function publishToTikTok(imageUrl: string, caption: string): Promise<TtPublishResult> {
  const token = process.env.TIKTOK_ACCESS_TOKEN;
  if (!token) return { ok: false, error: "تيك توك غير مهيأ (TIKTOK_ACCESS_TOKEN)." };
  const privacy = process.env.TIKTOK_PRIVACY || "SELF_ONLY";

  try {
    const r = await fetch(TIKTOK_INIT, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        post_info: {
          title: caption.slice(0, 90),        // photo-post title cap
          description: caption.slice(0, 4000),
          privacy_level: privacy,
          disable_comment: false,
          auto_add_music: true,
        },
        source_info: {
          source: "PULL_FROM_URL",
          photo_cover_index: 0,
          photo_images: [imageUrl],
        },
        post_mode: "DIRECT_POST",
        media_type: "PHOTO",
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(20_000),
    });
    const j = (await r.json().catch(() => null)) as { data?: { publish_id?: string }; error?: { code?: string; message?: string } } | null;
    if (!r.ok || (j?.error?.code && j.error.code !== "ok")) {
      return { ok: false, error: j?.error?.message || `HTTP ${r.status}` };
    }
    return { ok: true, publishId: j?.data?.publish_id };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "فشل النشر على تيك توك." };
  }
}
