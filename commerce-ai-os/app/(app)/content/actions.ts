"use server";

import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireUser } from "@/lib/auth/requireUser";

export type ProductForContent = {
  sku: string;
  name_en: string | null;
  name_ar: string | null;
  price: number | null;
  category: string | null;
  image_url: string | null;
  description_en: string | null;
  description_ar: string | null;
};

export type CaptionResult = {
  caption_ar: string;
  caption_en: string;
  hashtags: string[];
};

const MALIKA_STYLE = `You are the social-media copywriter for "Malika's Universe", a Qatar-based online beauty & lifestyle store. Apply "Malika Style Mode" and reply with ONLY valid JSON, no prose.

Arabic caption (caption_ar) — Qatari/Gulf dialect, warm and persuasive:
- A short punchy hook line first.
- 3–5 benefit bullets, each starting with 🔸.
- A clear CTA mentioning: السعر, توصيل لكل قطر, والدفع عند الاستلام.
- Natural, not robotic; emojis used tastefully.

English caption (caption_en) — professional e-commerce tone:
- Short hook line.
- 3–5 benefit bullets, each starting with ✔️.
- One-line CTA.

hashtags — 8 to 12 relevant tags mixing Qatar/GCC + the product category (Arabic and English ok), each starting with # and no spaces.`;

// Read-only fetch of a product by SKU (never writes to products).
async function fetchProduct(sku: string): Promise<ProductForContent | null> {
  let db: any;
  try {
    db = createAdminClient();
  } catch {
    db = createClient();
  }
  const { data } = await db
    .from("products")
    .select("sku, name_en, name_ar, price, main_category, image_url, description_en, description_ar")
    .eq("sku", sku)
    .maybeSingle();
  if (!data) return null;
  return {
    sku: data.sku,
    name_en: data.name_en ?? null,
    name_ar: data.name_ar ?? null,
    price: data.price ?? null,
    category: data.main_category ?? null,
    image_url: data.image_url ?? null,
    description_en: data.description_en ?? null,
    description_ar: data.description_ar ?? null,
  };
}

/** Generate Instagram caption (AR + EN + hashtags) via Claude. */
export async function generateCaption(sku: string): Promise<{ error: string } | CaptionResult> {
  const unauth = await requireUser();
  if (unauth) return unauth;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { error: "ANTHROPIC_API_KEY isn’t configured on the server." };
  const p = await fetchProduct(sku);
  if (!p) return { error: `Product ${sku} not found.` };

  const priceLine = p.price != null ? `${p.price} QAR` : "—";
  const productBlock = [
    `SKU: ${p.sku}`,
    `Name (EN): ${p.name_en ?? "—"}`,
    `Name (AR): ${p.name_ar ?? "—"}`,
    `Price: ${priceLine}`,
    `Category: ${p.category ?? "—"}`,
    `Description (EN): ${(p.description_en ?? "").replace(/<[^>]+>/g, " ").slice(0, 600)}`,
    `Description (AR): ${(p.description_ar ?? "").replace(/<[^>]+>/g, " ").slice(0, 600)}`,
  ].join("\n");

  try {
    const client = new Anthropic({ apiKey });
    const resp = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1200,
      system: MALIKA_STYLE,
      messages: [
        {
          role: "user",
          content:
            `Write the Instagram post content for this product. Return JSON exactly: {"caption_ar": string, "caption_en": string, "hashtags": string[]}.\n\n${productBlock}`,
        },
      ],
    });
    const text = resp.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    const json = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
    return {
      caption_ar: String(json.caption_ar ?? "").trim(),
      caption_en: String(json.caption_en ?? "").trim(),
      hashtags: Array.isArray(json.hashtags)
        ? json.hashtags.map((h: any) => String(h).trim()).filter(Boolean)
        : [],
    };
  } catch (e: any) {
    return { error: `Caption generation failed: ${e?.message ?? "unknown error"}` };
  }
}

/**
 * Generate a marketing image or reels video via Higgsfield.
 * Env-gated: requires HIGGSFIELD_API_KEY. Returns a clear "not configured"
 * status until the key is added and the Higgsfield REST endpoints are wired.
 */
export async function generateMedia(
  kind: "image" | "video",
  _sku: string
): Promise<{ configured: false; message: string } | { configured: true; url: string }> {
  const unauth = await requireUser();
  if (unauth) return { configured: false, message: unauth.error };
  const key = process.env.HIGGSFIELD_API_KEY;
  if (!key) {
    return {
      configured: false,
      message:
        "Higgsfield isn’t configured yet. Add HIGGSFIELD_API_KEY to the server env to enable image & video generation.",
    };
  }
  // Wiring of the Higgsfield REST API (marketing_studio_image / _video, media
  // import, async polling) is pending the key + endpoint confirmation.
  return {
    configured: false,
    message: `Higgsfield ${kind} generation is staged but not wired yet — pending HIGGSFIELD_API_KEY + endpoint confirmation.`,
  };
}

/** Persist generated content to the separate generated_content table (optional). */
export async function saveGeneratedContent(row: {
  sku: string;
  caption_ar: string;
  caption_en: string;
  hashtags: string[];
  image_url?: string | null;
  video_url?: string | null;
}) {
  const unauth = await requireUser();
  if (unauth) return unauth;
  // Service role if available, else the request-scoped RLS client.
  let db: any;
  try {
    db = createAdminClient();
  } catch {
    db = createClient();
  }
  const { error } = await db.from("generated_content").insert({
    sku: row.sku,
    caption_ar: row.caption_ar,
    caption_en: row.caption_en,
    hashtags: row.hashtags,
    image_url: row.image_url ?? null,
    video_url: row.video_url ?? null,
    status: "draft",
  });
  if (error) return { error: error.message };
  return { ok: true };
}
