"use server";

import { createAdminClient } from "@/lib/supabase/admin";
import { isSignedIn } from "@/lib/auth/requireUser";
import { requireOwner } from "@/lib/malak/authz";
import { revalidatePath } from "next/cache";
import { publishToInstagram, publishStoryToInstagram, publishVideoStoryToInstagram, publishReelToInstagram, instagramConfigured, fetchIgMediaStats } from "@/lib/social/instagram";
import { engagementScore, engagementRate, summarizeInsights, EMPTY_STATS, type PostStats } from "@/lib/social/insights-compute";
import { publishToTikTok, tiktokConfigured } from "@/lib/social/tiktok";
import { generateDailySocialPosts } from "@/lib/social/generate";
import { editProductImageCore } from "@/lib/products/imageEdit";
import { IG_IMAGE_STYLE } from "@/lib/social/content-compute";
import type { AdOverlayInput } from "@/lib/social/ad-overlay-compute";
import { formatQar } from "@/lib/social/ad-overlay-compute";
import { effectivePrice } from "@/lib/products/price-compute";
import { buildAdCopyPrompt, parseAdCopy, type AdCopy } from "@/lib/social/ad-copy-compute";
import { buildFullAdPrompt } from "@/lib/social/full-ad-compute";
import { buildStorySceneBrief } from "@/lib/social/story-compute";
import { DAY_SLOTS, slotTimeUtc } from "@/lib/social/schedule-compute";
import { generateScheduledPost } from "@/lib/social/generate";
import { geminiConfigured, generateSceneWithGemini, designSceneSettingWithGemini } from "@/lib/social/scene-gemini";
import { PRODUCT_SCENE_BASE, WORN_SCENE_BASE } from "@/lib/social/ad-variants";
import { SAFE_PUBLISH_FAILURE_MESSAGE, classifyPublishFailure, logPublishFailure } from "@/lib/social/publish-due";
import crypto from "crypto";

// السعر المعروض في الإعلان: إذا للمنتج خيارات مُسعّرة نمشي على سعر الخيارات
// (نبدأ من أقلها)، وإلا سعر المنتج نفسه (الخصم أولاً). فارغ = بدون شارة سعر.
async function adPriceLabel(sb: any, productId: string, price: number | string | null | undefined, discount: number | string | null | undefined): Promise<string> {
  const { data: vp } = await sb.from("product_variants").select("price").eq("parent_product_id", productId);
  const ep = effectivePrice(price, discount, vp ?? null);
  if (ep.fromVariants && ep.min != null) return formatQar(ep.min);
  return formatQar(discount ?? null) || formatQar(price ?? null);
}

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
  extras?: { story?: string; reel?: string; alt?: string } | null;
  scheduled_at?: string | null; // week-plan publish time (UTC ISO)
  approved?: boolean;           // owner approved → the publish cron may post it
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

  let { data, error } = await sb
    .from("social_posts")
    .select("id, platform, caption, image_url, status, error, created_at, posted_at, extras, scheduled_at, approved")
    .order("created_at", { ascending: false })
    .limit(80);
  if (error && /extras|scheduled_at|approved/i.test(error.message)) {
    // newer columns not migrated yet — degrade gracefully without them.
    ({ data, error } = await sb
      .from("social_posts")
      .select("id, platform, caption, image_url, status, error, created_at, posted_at")
      .order("created_at", { ascending: false })
      .limit(40));
  }
  if (error) {
    const hint = /social_posts/.test(error.message) ? " — شغّل supabase/social_posts.sql مرة وحدة." : "";
    return { error: error.message + hint, pending: [], recent: [], configured };
  }
  const rows = (data ?? []) as SocialPost[];
  return {
    // "publishing" = claimed by the cron mid-flight; keep it visible so a run
    // that was hard-killed leaves a recoverable row the owner can re-publish.
    pending: rows.filter((r) => r.status === "pending" || r.status === "failed" || r.status === "publishing"),
    recent: rows.filter((r) => r.status === "posted" || r.status === "dismissed").slice(0, 10),
    configured,
  };
}

export async function publishSocialPost(id: string, caption: string): Promise<{ ok?: true; story?: boolean; error?: string }> {
  const owner = await requireOwner();
  if (!owner.ok) return { error: owner.error };
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
    // Never store or surface the raw Meta/TikTok error — a generic message goes
    // to the row/UI, the classified category is logged server-side only.
    logPublishFailure((l) => console.warn(l), {
      platform: row.platform, kind: "post", category: classifyPublishFailure(res.error),
    });
    await sb.from("social_posts").update({ status: "failed", error: SAFE_PUBLISH_FAILURE_MESSAGE, caption: text }).eq("id", id);
    revalidatePath("/social");
    return { error: SAFE_PUBLISH_FAILURE_MESSAGE };
  }

  await sb.from("social_posts").update({
    status: "posted",
    caption: text,
    error: null,
    external_id: (res as any).mediaId ?? (res as any).publishId ?? null,
    posted_at: new Date().toISOString(),
  }).eq("id", id);

  // Feed post is live — mirror it to the STORY too (best-effort: a story
  // hiccup never rolls back the published post).
  let story = false;
  if (row.platform === "instagram") {
    try { story = (await publishStoryToInstagram(row.image_url)).ok; } catch { story = false; }
  }
  revalidatePath("/social");
  return { ok: true, story };
}

export async function dismissSocialPost(id: string): Promise<{ ok?: true; error?: string }> {
  if (!(await isSignedIn())) return { error: "Not signed in." };
  const sb = admin();
  if (!sb) return { error: NO_DB };
  await sb.from("social_posts").update({ status: "dismissed" }).eq("id", id);
  revalidatePath("/social");
  return { ok: true };
}

/**
 * Publish a Reel from a public video URL (uploaded to our storage client-side,
 * or any public link). Records the result in social_posts so it shows in the
 * recent list with its stats like any other post.
 */
export async function publishReelByUrl(videoUrl: string, caption: string): Promise<{ ok?: true; mediaId?: string; error?: string }> {
  const owner = await requireOwner();
  if (!owner.ok) return { error: owner.error };
  const sb = admin();
  if (!sb) return { error: NO_DB };
  const url = String(videoUrl || "").trim();
  if (!/^https:\/\/.+/i.test(url)) return { error: "رابط الفيديو غير صالح (لازم يكون https عام)." };
  const cap = String(caption || "").trim();

  const res = await publishReelToInstagram(url, cap);
  const now = new Date().toISOString();
  await sb.from("social_posts").insert({
    platform: "instagram",
    caption: cap,
    image_url: url,
    status: res.ok ? "posted" : "failed",
    error: res.ok ? null : (res.error ?? "فشل نشر الريل"),
    posted_at: res.ok ? now : null,
    external_id: res.ok ? (res.mediaId ?? null) : null,
    approved: true,
    extras: { kind: "reel" },
  });
  revalidatePath("/social");
  if (!res.ok) return { error: res.error ?? "فشل نشر الريل" };
  return { ok: true, mediaId: res.mediaId };
}

/**
 * Publish a Story (image or video) from a public URL — uploaded client-side to
 * our storage, or any public link. Stories carry no caption (text lives in the
 * media). Recorded in social_posts so it appears in the recent list.
 */
export async function publishStoryByUrl(mediaUrl: string, kind: "image" | "video"): Promise<{ ok?: true; error?: string }> {
  const owner = await requireOwner();
  if (!owner.ok) return { error: owner.error };
  const sb = admin();
  if (!sb) return { error: NO_DB };
  const url = String(mediaUrl || "").trim();
  if (!/^https:\/\/.+/i.test(url)) return { error: "رابط الوسائط غير صالح (لازم https عام)." };

  const res = kind === "video"
    ? await publishVideoStoryToInstagram(url)
    : await publishStoryToInstagram(url);
  const now = new Date().toISOString();
  await sb.from("social_posts").insert({
    platform: "instagram",
    caption: "",
    image_url: url,
    status: res.ok ? "posted" : "failed",
    error: res.ok ? null : (res.error ?? "فشل نشر الستوري"),
    posted_at: res.ok ? now : null,
    external_id: res.ok ? (res.mediaId ?? null) : null,
    approved: true,
    extras: { kind: "story" },
  });
  revalidatePath("/social");
  if (!res.ok) return { error: res.error ?? "فشل نشر الستوري" };
  return { ok: true };
}

// ---- Generate + schedule a Story ---------------------------------------------

export type StoryProduct = { id: string; name: string; imageUrl: string };

/** Products that can back an AI story (approved + have a photo), for the picker. */
export async function listProductsForStory(): Promise<{ error?: string; products: StoryProduct[] }> {
  if (!(await isSignedIn())) return { error: "Not signed in.", products: [] };
  const sb = admin();
  if (!sb) return { error: NO_DB, products: [] };
  const { data, error } = await sb
    .from("products")
    .select("id, name_ar, name_en, image_url, approval, created_at")
    .not("image_url", "is", null)
    .order("created_at", { ascending: false })
    .limit(300);
  if (error) return { error: error.message, products: [] };
  const products = ((data ?? []) as { id: string; name_ar: string | null; name_en: string | null; image_url: string | null; approval: string | null }[])
    .filter((p) => p.image_url && (p.approval ?? "Approved") !== "Rejected")
    .map((p) => ({ id: String(p.id), name: String(p.name_ar || p.name_en || "منتج").trim(), imageUrl: String(p.image_url) }));
  return { products };
}

export type StoryCreative = {
  copy: AdCopy;
  sceneUrl: string;   // TEXT-FREE vertical scene ("" → template uses its gradient + product photo)
  productUrl: string; // original product photo (composited when there's no scene)
  price: string;      // formatted, e.g. "78 ر.ق" ("" → no badge)
  options: string[];
};

/**
 * Build the pieces of an AI STORY for a product WITHOUT baking any Arabic into
 * the image (the model garbles Arabic). Returns the ad copy + a TEXT-FREE
 * vertical scene; the browser overlays the real Arabic with embedded fonts and
 * uploads the composed JPEG via saveStoryImage. Mirrors generateAdCreative.
 */
export async function generateStoryCreative(productId: string): Promise<{ error?: string } & Partial<StoryCreative>> {
  if (!(await isSignedIn())) return { error: "Not signed in." };
  const sb = admin();
  if (!sb) return { error: NO_DB };
  if (!process.env.ANTHROPIC_API_KEY) return { error: "توليد النصوص غير مفعّل (ANTHROPIC_API_KEY غير مضبوط)." };
  const { data: p } = await sb
    .from("products")
    .select("name_en, name_ar, description_en, description_ar, price, discount_price, image_url")
    .eq("id", productId)
    .single();
  if (!p) return { error: "المنتج غير موجود." };
  if (!p.image_url) return { error: "لا توجد صورة أصلية للمنتج." };

  // Product options (shades/sizes) → shown as chips and folded into the copy.
  const { data: vars } = await sb
    .from("product_variants")
    .select("variant_name, color, size")
    .eq("parent_product_id", productId)
    .limit(8);
  const options = (vars ?? [])
    .map((v: any) => String(v.variant_name || v.color || v.size || "").trim())
    .filter(Boolean)
    .slice(0, 6);

  const copyPrompt = buildAdCopyPrompt({
    nameAr: p.name_ar, nameEn: p.name_en,
    description: p.description_ar || p.description_en, options,
  });

  // Two AI jobs in parallel (fit the 60s budget): Claude writes the copy while
  // Gemini paints the wordless vertical scene. Scene is best-effort — the
  // template falls back to its gradient + the original product photo.
  const copyJob = (async (): Promise<AdCopy> => {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const client = new Anthropic();
    const model = process.env.STAFF_MALAK_MODEL || "claude-sonnet-5";
    const resp: any = await client.messages.create({ model, max_tokens: 500, messages: [{ role: "user", content: copyPrompt }] });
    const text = (resp.content || []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
    return parseAdCopy(text, String(p.name_ar || p.name_en || ""), String(p.name_en || ""));
  })();
  const sceneJob = geminiConfigured()
    ? generateSceneWithGemini(sb, String(p.image_url), buildStorySceneBrief({ nameAr: p.name_ar, nameEn: p.name_en }), "stories").catch(() => ({ error: "scene failed" }))
    : Promise.resolve({ error: "skipped" } as const);

  let copy: AdCopy;
  let scene: { imageUrl: string } | { error: string };
  try {
    [copy, scene] = await Promise.all([copyJob, sceneJob]);
  } catch (e) {
    return { error: e instanceof Error ? e.message : "تعذّر توليد الستوري." };
  }

  const price = await adPriceLabel(sb, productId, p.price, p.discount_price);
  return {
    copy, price, options,
    sceneUrl: "imageUrl" in scene ? scene.imageUrl : "",
    productUrl: String(p.image_url || ""),
  };
}

// Persist the browser-composed story (JPEG data URL) and return its public URL.
export async function saveStoryImage(dataUrl: string): Promise<{ ok?: true; imageUrl?: string; error?: string }> {
  if (!(await isSignedIn())) return { error: "Not signed in." };
  const sb = admin();
  if (!sb) return { error: NO_DB };
  const m = /^data:image\/(png|jpe?g);base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl ?? "").trim());
  if (!m) return { error: "صورة غير صالحة." };
  const bytes = Buffer.from(m[2], "base64");
  if (!bytes.length || bytes.length > 8 * 1024 * 1024) return { error: "حجم الصورة غير صالح." };
  const path = `stories/story-${Date.now()}-${crypto.randomBytes(4).toString("hex")}.jpg`;
  const up = await sb.storage.from(AD_BUCKET).upload(path, bytes, { contentType: "image/jpeg", upsert: false, cacheControl: "3600" });
  if (up.error) return { error: `تعذّر حفظ الصورة: ${up.error.message}` };
  return { ok: true, imageUrl: sb.storage.from(AD_BUCKET).getPublicUrl(path).data.publicUrl };
}

/**
 * Schedule a Story (image or video, from a public URL) to auto-publish at a
 * future time. Inserts an approved+pending social_posts row the publish cron
 * posts as a story when scheduled_at passes. Immediate (empty/past time) posts now.
 */
export async function scheduleStory(mediaUrl: string, kind: "image" | "video", whenIso: string): Promise<{ ok?: true; scheduled?: boolean; error?: string }> {
  const owner = await requireOwner();
  if (!owner.ok) return { error: owner.error };
  const sb = admin();
  if (!sb) return { error: NO_DB };
  const url = String(mediaUrl || "").trim();
  if (!/^https:\/\/.+/i.test(url)) return { error: "رابط الوسائط غير صالح (لازم https عام)." };
  const when = new Date(whenIso);
  if (isNaN(when.getTime())) return { error: "وقت غير صالح." };
  if (when.getTime() < Date.now() - 60_000) return { error: "الوقت في الماضي — اختر وقتًا قادمًا." };

  const { error } = await sb.from("social_posts").insert({
    platform: "instagram",
    caption: "",
    image_url: url,
    status: "pending",
    approved: true,
    scheduled_at: when.toISOString(),
    extras: { kind: "story", storyKind: kind },
  });
  if (error) {
    const hint = /scheduled_at|approved|extras/.test(error.message) ? " — شغّل supabase/social_schedule.sql مرة وحدة." : "";
    return { error: error.message + hint };
  }
  revalidatePath("/social");
  return { ok: true, scheduled: true };
}

// ---- Weekly plan --------------------------------------------------------------

/**
 * Generate ONE slot of the week plan (called 21× from the client with a
 * progress bar — each call fits the 60s route budget). Idempotent per slot:
 * if a live row already sits inside this slot's window, it is kept.
 */
export async function planWeekSlot(dayOffset: number, slot: number): Promise<{ ok?: true; created?: boolean; name?: string; scheduledAt?: string; error?: string }> {
  const owner = await requireOwner();
  if (!owner.ok) return { error: owner.error };
  const sb = admin();
  if (!sb) return { error: NO_DB };

  const s = DAY_SLOTS[Math.max(0, Math.min(DAY_SLOTS.length - 1, slot))];
  const when = slotTimeUtc(new Date(), dayOffset, slot, Math.random() * s.windowMinutes);

  // Slot already planned? (any live row inside the slot window on that day)
  const w0 = slotTimeUtc(new Date(), dayOffset, slot, 0);
  const w1 = new Date(w0.getTime() + s.windowMinutes * 60_000);
  const { data: existing, error: exErr } = await sb
    .from("social_posts")
    .select("id")
    .gte("scheduled_at", w0.toISOString())
    .lt("scheduled_at", w1.toISOString())
    .neq("status", "dismissed")
    .limit(1);
  if (exErr) {
    const hint = /scheduled_at|approved/.test(exErr.message) ? " — شغّل supabase/social_schedule.sql مرة وحدة." : "";
    return { error: exErr.message + hint };
  }
  if (existing?.length) return { ok: true, created: false };

  // Don't repeat products: anything already in the plan or featured recently.
  const since = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
  const { data: recent } = await sb
    .from("social_posts")
    .select("product_id")
    .or(`created_at.gte.${since},scheduled_at.gte.${new Date().toISOString()}`)
    .neq("status", "dismissed")
    .limit(300);
  const exclude = ((recent ?? []) as { product_id: string | null }[])
    .map((r) => String(r.product_id ?? "")).filter(Boolean);

  const res = await generateScheduledPost(sb, when, exclude);
  if (!res.created) return { error: res.skipped ?? "تعذّر توليد المنشور" };
  revalidatePath("/social");
  return { ok: true, created: true, name: res.productName, scheduledAt: when.toISOString() };
}

/** Approve / un-approve a planned post (only approved rows auto-publish). */
export async function approveSocialPost(id: string, approved: boolean): Promise<{ ok?: true; error?: string }> {
  const owner = await requireOwner();
  if (!owner.ok) return { error: owner.error };
  const sb = admin();
  if (!sb) return { error: NO_DB };
  const { error } = await sb.from("social_posts").update({ approved }).eq("id", id);
  if (error) return { error: error.message };
  revalidatePath("/social");
  return { ok: true };
}

/** Move a planned post to another time (datetime-local from the UI). */
export async function rescheduleSocialPost(id: string, iso: string): Promise<{ ok?: true; error?: string }> {
  const owner = await requireOwner();
  if (!owner.ok) return { error: owner.error };
  const sb = admin();
  if (!sb) return { error: NO_DB };
  const when = new Date(iso);
  if (isNaN(when.getTime())) return { error: "وقت غير صالح." };
  if (when.getTime() < Date.now() - 60_000) return { error: "الوقت في الماضي — اختر وقتًا قادمًا." };
  const { error } = await sb.from("social_posts").update({ scheduled_at: when.toISOString() }).eq("id", id);
  if (error) return { error: error.message };
  revalidatePath("/social");
  return { ok: true };
}

// Re-style the post photo with AI (same engine as the product form's photo
// edit). Default = the Instagram studio look; a custom hint overrides it.
export async function improveSocialImage(id: string, hint?: string): Promise<{ ok?: true; imageUrl?: string; error?: string }> {
  if (!(await isSignedIn())) return { error: "Not signed in." };
  const sb = admin();
  if (!sb) return { error: NO_DB };
  const { data: row } = await sb.from("social_posts").select("id, image_url, product_id").eq("id", id).single();
  if (!row) return { error: "المنشور غير موجود." };

  // Restyle from the ORIGINAL catalog photo (not the post's current image) so
  // repeated styling — or a previously baked-in overlay — never compounds.
  let base = row.image_url;
  if (row.product_id) {
    const { data: prod } = await sb.from("products").select("image_url").eq("id", row.product_id).single();
    if (prod?.image_url) base = prod.image_url;
  }
  // Prefer Gemini 2.5 Flash Image (stronger product fidelity) when configured;
  // otherwise fall back to the OpenAI image-edit path.
  const scenePrompt = String(hint ?? "").trim() || IG_IMAGE_STYLE;
  const res = geminiConfigured()
    ? await generateSceneWithGemini(sb, base, scenePrompt, "social")
    : await editProductImageCore(sb, base, scenePrompt, "social");
  if ("error" in res) return { error: res.error };

  // The same daily draft exists once per platform — restyle all of them together.
  // scene_url tracks the CLEAN styled scene so the ad designer never builds on a composed ad.
  await sb.from("social_posts")
    .update({ image_url: res.imageUrl, scene_url: res.imageUrl })
    .eq("product_id", row.product_id)
    .in("status", ["pending", "failed"]);
  revalidatePath("/social");
  return { ok: true, imageUrl: res.imageUrl };
}

// Product fields the browser needs to paint the ad text (brand/name/price).
export async function getAdOverlayData(id: string): Promise<{ error?: string; data?: AdOverlayInput }> {
  if (!(await isSignedIn())) return { error: "Not signed in." };
  const sb = admin();
  if (!sb) return { error: NO_DB };
  const { data: row } = await sb.from("social_posts").select("product_id").eq("id", id).single();
  if (!row?.product_id) return { error: "المنتج غير مرتبط بهذا المنشور." };
  const { data: p } = await sb
    .from("products")
    .select("name_en, name_ar, brand_id, price, discount_price")
    .eq("id", row.product_id)
    .single();
  if (!p) return { error: "المنتج غير موجود." };
  let brand: string | null = null;
  if (p.brand_id) {
    const { data: b } = await sb.from("brands").select("name").eq("id", p.brand_id).single();
    brand = b?.name ?? null;
  }
  // خيارات مُسعّرة → نعرض سعر البداية (أقل خيار) بدون شارة خصم للمنتج الأب.
  const { data: vp } = await sb.from("product_variants").select("price").eq("parent_product_id", row.product_id);
  const ep = effectivePrice(p.price, p.discount_price, vp ?? null);
  const price = ep.fromVariants ? ep.min : p.price;
  const discountPrice = ep.fromVariants ? null : p.discount_price;
  return { data: { brand, nameAr: p.name_ar, nameEn: p.name_en, price, discountPrice } };
}

// One-shot luxury ad: gpt-image-1 generates the WHOLE creative (scene + product
// + elegant Arabic typography + icons + price badge + CTA + footer) from a rich
// prompt. Built on the product's ORIGINAL photo. Replaces the scene+HTML overlay.
export async function generateFullAd(id: string): Promise<{ ok?: true; imageUrl?: string; error?: string }> {
  if (!(await isSignedIn())) return { error: "Not signed in." };
  const sb = admin();
  if (!sb) return { error: NO_DB };

  const { data: row } = await sb.from("social_posts").select("product_id").eq("id", id).single();
  if (!row?.product_id) return { error: "المنتج غير مرتبط بهذا المنشور." };
  const { data: p } = await sb
    .from("products")
    .select("name_en, name_ar, description_en, description_ar, price, discount_price, image_url")
    .eq("id", row.product_id)
    .single();
  if (!p) return { error: "المنتج غير موجود." };
  if (!p.image_url) return { error: "لا توجد صورة أصلية للمنتج." };

  const price = await adPriceLabel(sb, row.product_id, p.price, p.discount_price);
  const prompt = buildFullAdPrompt({
    nameAr: p.name_ar, nameEn: p.name_en,
    description: p.description_ar || p.description_en, price,
  });
  // Gemini renders in-image text (incl. Arabic) far better than gpt-image-1, so
  // when configured let it produce the fully-integrated ad; else OpenAI raw mode.
  const res = geminiConfigured()
    ? await generateSceneWithGemini(sb, String(p.image_url), prompt, "social")
    : await editProductImageCore(sb, String(p.image_url), prompt, "social", { raw: true, quality: "high" });
  if ("error" in res) return { error: res.error };

  await sb.from("social_posts")
    .update({ image_url: res.imageUrl })
    .eq("product_id", row.product_id)
    .in("status", ["pending", "failed"]);
  revalidatePath("/social");
  return { ok: true, imageUrl: res.imageUrl };
}

// AI ad copy (headline + 3 benefits + 3 trust features) + the formatted price,
// for the browser to lay out in the full ad template.
export async function generateAdCreative(id: string, sceneStyle?: string, tap?: number): Promise<{ error?: string; copy?: AdCopy; price?: string; title?: string; productUrl?: string; backdropUrl?: string; options?: string[] }> {
  if (!(await isSignedIn())) return { error: "Not signed in." };
  const sb = admin();
  if (!sb) return { error: NO_DB };
  if (!process.env.ANTHROPIC_API_KEY) return { error: "توليد النصوص غير مفعّل (ANTHROPIC_API_KEY غير مضبوط)." };

  const { data: row } = await sb.from("social_posts").select("product_id, scene_url").eq("id", id).single();
  if (!row?.product_id) return { error: "المنتج غير مرتبط بهذا المنشور." };
  const { data: p } = await sb
    .from("products")
    .select("name_en, name_ar, description_en, description_ar, price, discount_price, image_url")
    .eq("id", row.product_id)
    .single();
  if (!p) return { error: "المنتج غير موجود." };

  // Product options (shades/sizes) — real catalog data, shown as elegant
  // chips on the design and folded into both AI briefs.
  const { data: vars } = await sb
    .from("product_variants")
    .select("variant_name, color, size")
    .eq("parent_product_id", row.product_id)
    .limit(8);
  const options = (vars ?? [])
    .map((v: any) => String(v.variant_name || v.color || v.size || "").trim())
    .filter(Boolean)
    .slice(0, 6);

  const prompt = buildAdCopyPrompt({
    nameAr: p.name_ar, nameEn: p.name_en,
    description: p.description_ar || p.description_en,
    options,
  });

  // Two AI jobs in PARALLEL (to fit the 60s route budget):
  //  1. Claude writes the ad copy.
  //  2. Gemini places THE EXACT PRODUCT (from its photo) INTO the luxury scene
  //     — standing on the pedestal, grounded shadow, real lighting — as ONE
  //     photograph (no compositing seams, never floating). The Arabic type is
  //     still overlaid later with real fonts.
  // Fallback: if the scene fails, the template frames the original photo on
  // its designed CSS background.
  const style = String(sceneStyle ?? "").trim().slice(0, 4000);
  const gemini = geminiConfigured();
  const copyJob = (async (): Promise<AdCopy> => {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const client = new Anthropic();
    const model = process.env.STAFF_MALAK_MODEL || "claude-sonnet-5";
    const resp: any = await client.messages.create({ model, max_tokens: 500, messages: [{ role: "user", content: prompt }] });
    const text = (resp.content || []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
    return parseAdCopy(text, String(p.name_ar || p.name_en || ""), String(p.name_en || ""));
  })();
  // Art direction FROM the product itself: Gemini reads the photo and invents
  // scene concept #tap (packaging palette, matching textures/props), replacing
  // the brief's generic "Setting:" clause — every re-tap is a new concept
  // inspired by THIS product. Falls back to the rotating mood on any failure.
  const sceneJob = gemini && p.image_url && style
    ? (async () => {
        const productName = String(p.name_en || p.name_ar || "").trim().slice(0, 120);
        let brief = style;
        const design = await designSceneSettingWithGemini(String(p.image_url), (tap ?? 0) + 1, productName).catch(() => null);
        if (design?.setting) brief = style.replace(/Setting:[\s\S]*$/, design.setting);
        // WORN photo (nails on a hand, lashes on an eye…): the photographed
        // subject IS the hero — keep the hand/product pixel-faithful and
        // rebuild only the world around it, instead of extracting an object.
        if (design?.worn) brief = brief.replace(PRODUCT_SCENE_BASE, WORN_SCENE_BASE);
        // Tell the image model what the item actually IS, so a collage of
        // press-on nails can never come back as a polish bottle.
        if (productName) {
          brief =
            `THE PRODUCT IS: "${productName}". Identify this exact item in the provided photo (read its packaging) ` +
            "and reproduce its REAL form faithfully — never swap it for a different object type. " + brief;
        }
        // Multi-option product (shades/colors): the options ARE the story —
        // show them together, neatly lined up (exception to the show-once rule).
        if (options.length >= 2) {
          brief =
            `IT COMES IN ${options.length} OPTIONS shown in the photo — display the option variants TOGETHER, ` +
            "neatly aligned side by side as one styled group (this variant line-up is the ONLY exception to the " +
            "show-once rule; still no scattered duplicates of the same option). " + brief;
        }
        return generateSceneWithGemini(sb, String(p.image_url), brief, "social");
      })().catch(() => ({ error: "scene failed" }))
    : Promise.resolve({ error: "skipped" } as const);

  let copy: AdCopy;
  let scene: { imageUrl: string } | { error: string };
  try {
    [copy, scene] = await Promise.all([copyJob, sceneJob]);
  } catch (e) {
    return { error: e instanceof Error ? e.message : "تعذّر توليد النصوص." };
  }

  const price = await adPriceLabel(sb, row.product_id, p.price, p.discount_price);
  const backdropUrl = "imageUrl" in scene ? scene.imageUrl : "";
  return { copy, price, title: String(p.name_ar || p.name_en || ""), productUrl: String(p.image_url || ""), backdropUrl, options };
}

// Persist the browser-composed ad card (JPEG data URL) and point every pending
// row of the same product at it — mirrors improveSocialImage's fan-out.
const AD_BUCKET = "product-images";
export async function saveSocialImage(id: string, dataUrl: string): Promise<{ ok?: true; imageUrl?: string; error?: string }> {
  if (!(await isSignedIn())) return { error: "Not signed in." };
  const sb = admin();
  if (!sb) return { error: NO_DB };
  const m = /^data:image\/(png|jpe?g);base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl ?? "").trim());
  if (!m) return { error: "صورة غير صالحة." };
  const bytes = Buffer.from(m[2], "base64");
  if (!bytes.length || bytes.length > 8 * 1024 * 1024) return { error: "حجم الصورة غير صالح." };

  const { data: row } = await sb.from("social_posts").select("product_id").eq("id", id).single();
  if (!row) return { error: "المنشور غير موجود." };

  const path = `social/ad-${Date.now()}-${crypto.randomBytes(4).toString("hex")}.jpg`;
  const up = await sb.storage.from(AD_BUCKET).upload(path, bytes, { contentType: "image/jpeg", upsert: false, cacheControl: "3600" });
  if (up.error) return { error: `تعذّر حفظ الصورة: ${up.error.message}` };
  const imageUrl = sb.storage.from(AD_BUCKET).getPublicUrl(path).data.publicUrl;

  await sb.from("social_posts")
    .update({ image_url: imageUrl })
    .eq("product_id", row.product_id)
    .in("status", ["pending", "failed"]);
  revalidatePath("/social");
  return { ok: true, imageUrl };
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

// ---- Performance report --------------------------------------------------------

export type SocialInsight = {
  id: string;
  caption: string;       // first line only — enough to recognize the post
  image_url: string;
  posted_at: string | null;
  permalink: string | null;
  stats: PostStats;
  score: number;
  rate: number | null;
};

export type SocialInsightsReport = {
  ok?: true;
  error?: string;
  posts: SocialInsight[];
  totals: PostStats;
  bestId: string | null;
  avgReach: number;
  failed: number; // media we could not read stats for (deleted, token limits)
};

/**
 * Pull live Instagram stats for the latest published posts (we stored each
 * post's IG media id in external_id at publish time). Read-only.
 */
export async function fetchSocialInsights(): Promise<SocialInsightsReport> {
  const empty = { posts: [], totals: { ...EMPTY_STATS }, bestId: null, avgReach: 0, failed: 0 };
  if (!(await isSignedIn())) return { error: "Not signed in.", ...empty };
  if (!instagramConfigured()) return { error: "إنستقرام غير مربوط.", ...empty };
  const sb = admin();
  if (!sb) return { error: NO_DB, ...empty };

  const { data, error } = await sb
    .from("social_posts")
    .select("id, caption, image_url, posted_at, external_id")
    .eq("platform", "instagram")
    .eq("status", "posted")
    .not("external_id", "is", null)
    .order("posted_at", { ascending: false })
    .limit(25);
  if (error) return { error: error.message, ...empty };

  type Row = { id: string; caption: string; image_url: string; posted_at: string | null; external_id: string };
  const rows = (data ?? []) as Row[];
  if (!rows.length) return { ok: true, ...empty };

  let failed = 0;
  const posts: SocialInsight[] = [];
  const results = await Promise.all(rows.map((r) => fetchIgMediaStats(r.external_id)));
  for (let i = 0; i < rows.length; i++) {
    const res = results[i];
    if (!res.ok) { failed++; continue; }
    const stats: PostStats = { likes: res.likes, comments: res.comments, reach: res.reach, views: res.views, saved: res.saved, shares: res.shares };
    posts.push({
      id: rows[i].id,
      caption: String(rows[i].caption ?? "").split("\n")[0].slice(0, 80),
      image_url: rows[i].image_url,
      posted_at: rows[i].posted_at,
      permalink: res.permalink ?? null,
      stats,
      score: engagementScore(stats),
      rate: engagementRate(stats),
    });
  }
  posts.sort((a, b) => b.score - a.score);
  const { totals, bestId, avgReach } = summarizeInsights(posts);
  return { ok: true, posts, totals, bestId, avgReach, failed };
}
