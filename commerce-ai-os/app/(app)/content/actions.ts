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

// ---- Weekly Reels engine -------------------------------------------------
// Build the week's 14-Reel plan (5 formats · 3/3/3/3/2) with English Higgsfield
// prompts, Gulf-Arabic caption briefs, CTA type and 13:00/20:00 Doha slots.
// Read-only: it plans + rotates real catalog products; queuing/generation is a
// separate step. Rotation leads with the newest arrivals.
import { buildWeeklyReelsPlan, type ReelPlanItem, type ReelPlanProduct } from "@/lib/social/reels-plan";

export async function previewReelsWeek(conversionRatio = 0): Promise<{ error: string } | { items: ReelPlanItem[] }> {
  const unauth = await requireUser();
  if (unauth) return unauth;
  let db: any;
  try { db = createAdminClient(); } catch { db = createClient(); }

  // Rotation pool: newest arrivals first (falls back to name order), priced +
  // not soft-deleted. The engine cycles this list across the 14 slots.
  const { data, error } = await db
    .from("products")
    .select("sku, name_en, name_ar, created_at, price")
    .not("sku", "is", null)
    .order("created_at", { ascending: false })
    .limit(40);
  if (error) return { error: error.message };
  const pool: ReelPlanProduct[] = ((data ?? []) as any[])
    .filter((p) => p.sku && Number(p.price) > 0)
    .map((p) => ({ sku: p.sku, name_en: p.name_en, name_ar: p.name_ar }));
  if (pool.length === 0) return { error: "ما في منتجات مسعّرة لبناء الخطة." };

  const items = buildWeeklyReelsPlan(pool, new Date(), { conversionRatio });
  return { items };
}

// Queue one Reel from the weekly plan into social_posts: generate the Arabic
// caption, then insert a scheduled, format-tagged row (pending owner approval
// on /social). The existing publish cron posts it as a Reel at its slot.
export async function queueReel(input: {
  sku: string | null; format: string; ctaType: string; scheduledAtIso: string; videoUrl: string;
}): Promise<{ error: string } | { ok: true }> {
  const unauth = await requireUser();
  if (unauth) return unauth;
  const videoUrl = String(input.videoUrl || "").trim();
  if (!/^https?:\/\/.+\.(mp4|mov|webm)(\?|$)/i.test(videoUrl)) {
    return { error: "رابط فيديو غير صالح — لازم رابط عام mp4/mov/webm." };
  }
  let db: any;
  try { db = createAdminClient(); } catch { db = createClient(); }

  // Caption: reuse the Claude generator (Gulf Arabic + hashtags); fall back to a
  // simple line if it's unavailable so queueing never hard-fails.
  let caption = "🌸 عالم ماليكا";
  let productId: string | null = null;
  if (input.sku) {
    const c = await generateCaption(input.sku).catch(() => null);
    if (c && !("error" in c)) caption = [c.caption_ar, (c.hashtags || []).join(" ")].filter(Boolean).join("\n\n");
    const { data: p } = await db.from("products").select("id").eq("sku", input.sku).maybeSingle();
    productId = p?.id ?? null;
  }

  const row: Record<string, unknown> = {
    product_id: productId, platform: "instagram", caption,
    image_url: videoUrl, scene_url: videoUrl,
    extras: { kind: "reel" }, status: "pending", approved: false,
    scheduled_at: input.scheduledAtIso, format: input.format, cta_type: input.ctaType,
  };
  let { error } = await db.from("social_posts").insert(row);
  // Graceful degrade if the format/cta_type columns aren't migrated yet on prod.
  if (error && /(format|cta_type)/i.test(error.message)) {
    const { format: _f, cta_type: _c, ...bare } = row;
    ({ error } = await db.from("social_posts").insert(bare));
  }
  if (error) return { error: error.message };
  return { ok: true };
}

// ---- Weekly Reels status/dashboard --------------------------------------
import { fetchIgMediaStats } from "@/lib/social/instagram";
import { formatWeeklyAverages, formatsToCut, type FormatWeekAvg } from "@/lib/social/reels-metrics";

// Monday-anchored week bucket (UTC) for grouping posted reels by week.
function reelWeekKey(iso: string | null): string {
  const d = iso ? new Date(iso) : null;
  if (!d || isNaN(d.getTime())) return "—";
  const mon = (d.getUTCDay() + 6) % 7; // Mon=0
  const m = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - mon));
  return m.toISOString().slice(0, 10);
}

export interface ReelQueueRow { format: string; ctaType: string | null; scheduledAtIso: string | null; status: string; approved: boolean; }

// The week's Reels pipeline (format-tagged social_posts) + per-format view
// averages for posted ones + the Sunday cut recommendation. Read-only.
export async function reelsWeekStatus(): Promise<
  { error: string } | { queue: ReelQueueRow[]; perFormat: FormatWeekAvg[]; toCut: string[] }
> {
  const unauth = await requireUser();
  if (unauth) return unauth;
  let db: any;
  try { db = createAdminClient(); } catch { db = createClient(); }

  const { data, error } = await db
    .from("social_posts")
    .select("id, format, cta_type, scheduled_at, status, approved, external_id, posted_at")
    .not("format", "is", null)
    .order("scheduled_at", { ascending: true })
    .limit(200);
  if (error) return { error: error.message };
  const rows = (data ?? []) as any[];

  const queue: ReelQueueRow[] = rows.map((r) => ({
    format: r.format, ctaType: r.cta_type ?? null, scheduledAtIso: r.scheduled_at ?? null,
    status: r.status ?? "pending", approved: !!r.approved,
  }));

  const posted = rows.filter((r) => r.status === "posted" && r.external_id).slice(-24);
  const metricRows: { format: string; week: string; views: number }[] = [];
  for (const r of posted) {
    const s = await fetchIgMediaStats(String(r.external_id)).catch(() => null);
    if (s && s.ok) metricRows.push({ format: r.format, week: reelWeekKey(r.posted_at ?? r.scheduled_at), views: s.views });
  }
  return { queue, perFormat: formatWeeklyAverages(metricRows), toCut: formatsToCut(metricRows) };
}
