import "server-only";
import {
  pickSpotlightProduct,
  buildCaptionPrompt,
  parseCaptionReply,
  IG_IMAGE_STYLE,
  type SpotlightCandidate,
} from "./content-compute";
import { editProductImageCore } from "@/lib/products/imageEdit";

// Daily social-post generation (called from the morning cron). Env-gated on
// SOCIAL_PLATFORMS ("instagram" / "instagram,tiktok"): unset → no-op, so the
// engine only starts when the owner opts in. Idempotent per day: if today's
// rows already exist, it does nothing — safe to call from retries.
//
// Review-first by design: rows land as 'pending' and the owner publishes from
// /social. Nothing is ever posted without a tap.

export interface GenerateResult {
  enabled: boolean;
  created: number;
  skipped?: string; // reason when nothing was created
}

export function socialPlatforms(): string[] {
  return String(process.env.SOCIAL_PLATFORMS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s === "instagram" || s === "tiktok");
}

export async function generateDailySocialPosts(admin: any): Promise<GenerateResult> {
  const platforms = socialPlatforms();
  if (!platforms.length) return { enabled: false, created: 0, skipped: "SOCIAL_PLATFORMS not set" };
  if (!process.env.ANTHROPIC_API_KEY) return { enabled: true, created: 0, skipped: "ANTHROPIC_API_KEY not set" };

  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);

  // Already generated today → done (idempotent). Dismissed rows don't count,
  // so the owner can dismiss a draft they dislike and hit "ولّد الآن" again.
  const { data: today, error: todayErr } = await admin
    .from("social_posts")
    .select("id")
    .gte("created_at", todayStart.toISOString())
    .neq("status", "dismissed")
    .limit(1);
  if (todayErr) {
    const hint = /social_posts/.test(todayErr.message) ? " — run supabase/social_posts.sql once" : "";
    return { enabled: true, created: 0, skipped: todayErr.message + hint };
  }
  if (today?.length) return { enabled: true, created: 0, skipped: "already generated today" };

  // Don't repeat a product featured in the last 14 days.
  const since = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
  const { data: recent } = await admin
    .from("social_posts")
    .select("product_id")
    .gte("created_at", since)
    .limit(200);
  const exclude = ((recent ?? []) as { product_id: string | null }[])
    .map((r) => String(r.product_id ?? ""))
    .filter(Boolean);

  // Newest approved, in-stock products with images.
  const { data: prods, error: prodErr } = await admin
    .from("products")
    .select("id, name_en, name_ar, brand_id, price, discount_price, image_url, created_at, approval, inventory(stock_quantity)")
    .eq("approval", "Approved")
    .not("image_url", "is", null)
    .order("created_at", { ascending: false })
    .limit(120);
  if (prodErr) return { enabled: true, created: 0, skipped: prodErr.message };

  // Resolve brand ids → names so the caption can lead with the brand.
  const brandName = new Map<string, string>();
  try {
    const { data: brands } = await admin.from("brands").select("id, name").limit(500);
    for (const b of (brands ?? []) as { id: string; name: string | null }[]) {
      if (b.name) brandName.set(String(b.id), String(b.name));
    }
  } catch { /* brand line is optional */ }

  const candidates: SpotlightCandidate[] = ((prods ?? []) as any[]).map((p) => ({
    id: String(p.id),
    name_en: p.name_en, name_ar: p.name_ar,
    brand: p.brand_id ? brandName.get(String(p.brand_id)) ?? null : null,
    image_url: p.image_url,
    price: p.price, discount_price: p.discount_price,
    stock: Array.isArray(p.inventory)
      ? p.inventory.reduce((s: number, r: any) => s + (Number(r?.stock_quantity) || 0), 0)
      : Number(p.inventory?.stock_quantity) || 0,
    created_at: p.created_at,
  }));

  const pick = pickSpotlightProduct(candidates, exclude);
  if (!pick) return { enabled: true, created: 0, skipped: "no eligible product (image + stock + not recently featured)" };

  // Caption via Claude (same key/model family as the product drafts).
  let caption = "";
  try {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const client = new Anthropic();
    const model = process.env.STAFF_MALAK_MODEL || "claude-sonnet-5";
    const resp: any = await client.messages.create({
      model, max_tokens: 700,
      messages: [{ role: "user", content: buildCaptionPrompt(pick) }],
    });
    const text = (resp.content || []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
    caption = parseCaptionReply(text);
  } catch (e) {
    return { enabled: true, created: 0, skipped: e instanceof Error ? e.message : "caption generation failed" };
  }
  if (!caption) return { enabled: true, created: 0, skipped: "empty caption" };

  // Style the catalog photo into an Instagram-ready shot (env-gated on
  // OPENAI_API_KEY; falls back to the original photo on any failure — the
  // owner can retry from /social with «حسّن الصورة»).
  let imageUrl = String(pick.image_url);
  if (process.env.OPENAI_API_KEY) {
    try {
      const styled = await editProductImageCore(admin, imageUrl, IG_IMAGE_STYLE, "social");
      if ("imageUrl" in styled) imageUrl = styled.imageUrl;
    } catch { /* keep the original */ }
  }

  const rows = platforms.map((platform) => ({
    product_id: pick.id,
    platform,
    caption,
    image_url: imageUrl,
    status: "pending",
  }));
  const { error: insErr } = await admin.from("social_posts").insert(rows);
  if (insErr) return { enabled: true, created: 0, skipped: insErr.message };

  return { enabled: true, created: rows.length };
}
