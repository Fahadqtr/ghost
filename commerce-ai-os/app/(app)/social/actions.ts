"use server";

import { createAdminClient } from "@/lib/supabase/admin";
import { isSignedIn } from "@/lib/auth/requireUser";
import { revalidatePath } from "next/cache";
import { publishToInstagram, instagramConfigured } from "@/lib/social/instagram";
import { publishToTikTok, tiktokConfigured } from "@/lib/social/tiktok";
import { generateDailySocialPosts } from "@/lib/social/generate";
import { editProductImageCore } from "@/lib/products/imageEdit";
import { IG_IMAGE_STYLE } from "@/lib/social/content-compute";
import type { AdOverlayInput } from "@/lib/social/ad-overlay-compute";
import { formatQar } from "@/lib/social/ad-overlay-compute";
import { buildAdCopyPrompt, parseAdCopy, type AdCopy } from "@/lib/social/ad-copy-compute";
import { buildFullAdPrompt } from "@/lib/social/full-ad-compute";
import { geminiConfigured, generateSceneWithGemini, designSceneSettingWithGemini } from "@/lib/social/scene-gemini";
import { PRODUCT_SCENE_BASE, WORN_SCENE_BASE } from "@/lib/social/ad-variants";
import crypto from "crypto";

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
    .select("id, platform, caption, image_url, status, error, created_at, posted_at, extras")
    .order("created_at", { ascending: false })
    .limit(40);
  if (error && /extras/i.test(error.message)) {
    // extras column not migrated yet — degrade gracefully without it.
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
  return { data: { brand, nameAr: p.name_ar, nameEn: p.name_en, price: p.price, discountPrice: p.discount_price } };
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

  const price = formatQar(p.discount_price ?? null) || formatQar(p.price ?? null);
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

  const price = formatQar(p.discount_price ?? null) || formatQar(p.price ?? null);
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
