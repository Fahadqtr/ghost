import "server-only";
import {
  pickSpotlightProduct,
  buildPostPrompt,
  parsePostReply,
  type PostExtras,
  type SpotlightCandidate,
} from "./content-compute";
import { analyzeProductImageWithGemini } from "./scene-gemini";

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

  const { candidates, error: candErr } = await loadCandidates(admin);
  if (candErr) return { enabled: true, created: 0, skipped: candErr };

  const pick = pickSpotlightProduct(candidates, exclude);
  if (!pick) return { enabled: true, created: 0, skipped: "no eligible product (image + stock + not recently featured)" };

  const composed = await composePost(pick);
  if ("error" in composed) return { enabled: true, created: 0, skipped: composed.error };
  const { caption, extras } = composed;

  // Drafts carry the ORIGINAL catalog photo — the owner sees the real product
  // first, and the ad designer (button on /social) builds the scene on demand.
  const imageUrl = String(pick.image_url);
  const rows = platforms.map((platform) => ({
    product_id: pick.id,
    platform,
    caption,
    image_url: imageUrl,
    scene_url: imageUrl,
    extras,
    status: "pending",
  }));
  let { error: insErr } = await admin.from("social_posts").insert(rows);
  if (insErr && /extras/i.test(insErr.message)) {
    // extras column not migrated yet — insert without it (graceful degrade).
    const bare = rows.map(({ extras: _x, ...r }) => r);
    ({ error: insErr } = await admin.from("social_posts").insert(bare));
  }
  if (insErr) return { enabled: true, created: 0, skipped: insErr.message };

  return { enabled: true, created: rows.length };
}

/** Newest approved, in-stock products with images, brand names resolved. */
async function loadCandidates(admin: any): Promise<{ candidates: SpotlightCandidate[]; error?: string }> {
  const { data: prods, error: prodErr } = await admin
    .from("products")
    .select("id, name_en, name_ar, brand_id, price, discount_price, image_url, created_at, approval, inventory(stock_quantity)")
    .eq("approval", "Approved")
    .not("image_url", "is", null)
    .order("created_at", { ascending: false })
    .limit(120);
  if (prodErr) return { candidates: [], error: prodErr.message };

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
  return { candidates };
}

/** Gemini photo analysis + Claude full post pack for one product. */
async function composePost(pick: SpotlightCandidate): Promise<{ caption: string; extras: PostExtras } | { error: string }> {
  // 1) Gemini reads the product photo (what's really on the packaging) so the
  //    copywriter never invents details. Optional — null just omits the block.
  const analysis = await analyzeProductImageWithGemini(String(pick.image_url));

  // 2) Full post pack via Claude: caption + story + reel script + alt text.
  try {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const client = new Anthropic();
    const model = process.env.STAFF_MALAK_MODEL || "claude-sonnet-5";
    const resp: any = await client.messages.create({
      model, max_tokens: 1200,
      messages: [{ role: "user", content: buildPostPrompt(pick, analysis ?? undefined) }],
    });
    const text = (resp.content || []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
    const parsed = parsePostReply(text);
    if (!parsed.caption) return { error: "empty caption" };
    return { caption: parsed.caption, extras: parsed.extras };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "caption generation failed" };
  }
}

export interface ScheduledResult {
  created: number;
  productId?: string;
  productName?: string;
  skipped?: string;
}

/**
 * One WEEK-PLAN draft: pick a product not in `exclude`, compose the caption
 * pack, and insert a single pending row with scheduled_at (approval happens
 * on /social; the publish cron only touches approved rows).
 */
export async function generateScheduledPost(admin: any, scheduledAt: Date, exclude: string[], platform = "instagram"): Promise<ScheduledResult> {
  if (!process.env.ANTHROPIC_API_KEY) return { created: 0, skipped: "ANTHROPIC_API_KEY not set" };

  const { candidates, error: candErr } = await loadCandidates(admin);
  if (candErr) return { created: 0, skipped: candErr };

  const pick = pickSpotlightProduct(candidates, exclude);
  if (!pick) return { created: 0, skipped: "no eligible product left" };

  const composed = await composePost(pick);
  if ("error" in composed) return { created: 0, skipped: composed.error };

  const imageUrl = String(pick.image_url);
  const row: Record<string, unknown> = {
    product_id: pick.id,
    platform,
    caption: composed.caption,
    image_url: imageUrl,
    scene_url: imageUrl,
    extras: composed.extras,
    status: "pending",
    approved: false,
    scheduled_at: scheduledAt.toISOString(),
  };
  let { error: insErr } = await admin.from("social_posts").insert(row);
  if (insErr && /extras/i.test(insErr.message)) {
    const { extras: _x, ...bare } = row;
    ({ error: insErr } = await admin.from("social_posts").insert(bare));
  }
  if (insErr) return { created: 0, skipped: insErr.message };
  return { created: 1, productId: pick.id, productName: String(pick.name_ar || pick.name_en || "") };
}
