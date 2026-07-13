"use server";

import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@/lib/supabase/server";
import { isSignedIn } from "@/lib/auth/requireUser";
import { assertSafeImageUrl } from "@/lib/net/safeImage";
import { CATEGORIES } from "@/lib/constants";
import { buildEnrichPrompt, parseEnrichResult, missingFields, type EnrichInput } from "@/lib/products/enrich-compute";

// AI catalog completion: find products missing Arabic name / Arabic description
// / category, and let Claude fill the gaps (matching the English), while
// verifying the Arabic⇄English consistency and that the photo matches.

export interface EnrichTarget {
  id: string;
  sku: string | null;
  name_en: string | null;
  name_ar: string | null;
  main_category: string | null;
  image_url: string | null;
  missing: string[]; // empty when the row is only here for verification
}

/**
 * Products to process. Default: only those missing an Arabic name / Arabic
 * description / category. `all` returns every product too (missing = []) so the
 * Arabic⇄English and photo checks can verify complete rows as well.
 */
export async function listEnrichTargets(all = false): Promise<{ ok: boolean; items: EnrichTarget[]; error?: string }> {
  if (!(await isSignedIn())) return { ok: false, items: [], error: "Not signed in." };
  const supabase = createClient();
  const items: EnrichTarget[] = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("products")
      .select("id, sku, name_en, name_ar, description_en, description_ar, main_category, image_url")
      .order("created_at", { ascending: false })
      .range(from, from + PAGE - 1);
    if (error) return { ok: false, items: [], error: error.message };
    for (const p of (data ?? []) as any[]) {
      const miss = missingFields(p as EnrichInput);
      if (miss.length || all) items.push({
        id: String(p.id), sku: p.sku ?? null, name_en: p.name_en ?? null, name_ar: p.name_ar ?? null,
        main_category: p.main_category ?? null, image_url: p.image_url ?? null, missing: miss,
      });
    }
    if (!data || data.length < PAGE) break;
  }
  return { ok: true, items };
}

const ALLOWED_IMG = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

export interface EnrichOutcome {
  ok: boolean;
  filled: string[];               // fields written this run
  arMatchesEn: boolean | null;
  imageMatches: boolean | null;
  notes: string;
  error?: string;
}

/**
 * Enrich one product: generate the missing Arabic/category (matching the
 * English), verify Arabic⇄English and the photo. By default only writes fields
 * that were empty; pass overwrite to refresh existing ones too.
 */
export async function enrichProduct(id: string, overwrite = false): Promise<EnrichOutcome> {
  const base: EnrichOutcome = { ok: false, filled: [], arMatchesEn: null, imageMatches: null, notes: "" };
  if (!(await isSignedIn())) return { ...base, error: "Not signed in." };
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { ...base, error: "ميزة الذكاء غير مفعّلة (ANTHROPIC_API_KEY)." };

  const supabase = createClient();
  const { data: p, error } = await supabase
    .from("products")
    .select("id, name_en, name_ar, description_en, description_ar, main_category, image_url")
    .eq("id", id).maybeSingle();
  if (error) return { ...base, error: error.message };
  if (!p) return { ...base, error: "المنتج غير موجود." };

  // Fetch the photo (SSRF-guarded) so the model can use + verify it.
  let imageBlock: any = null;
  const rawUrl = String((p as any).image_url ?? "").trim();
  if (rawUrl) {
    try {
      const url = assertSafeImageUrl(rawUrl);
      const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (r.ok) {
        const ct = (r.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
        const media_type = ALLOWED_IMG.has(ct) ? ct : "image/jpeg";
        const b64 = Buffer.from(await r.arrayBuffer()).toString("base64");
        if (b64) imageBlock = { type: "image", source: { type: "base64", media_type, data: b64 } };
      }
    } catch { /* proceed without the image */ }
  }

  const input: EnrichInput = {
    name_en: (p as any).name_en ?? null, name_ar: (p as any).name_ar ?? null,
    description_en: (p as any).description_en ?? null, description_ar: (p as any).description_ar ?? null,
    main_category: (p as any).main_category ?? null,
  };

  let result;
  try {
    const client = new Anthropic({ apiKey });
    const content: any[] = [];
    if (imageBlock) content.push(imageBlock);
    content.push({ type: "text", text: buildEnrichPrompt(input, CATEGORIES, !!imageBlock) });
    const resp = await client.messages.create({
      model: process.env.STAFF_MALAK_MODEL || "claude-sonnet-5",
      max_tokens: 1400,
      messages: [{ role: "user", content }],
    });
    const text = resp.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
    result = parseEnrichResult(text, CATEGORIES);
  } catch (e) {
    return { ...base, error: e instanceof Error ? e.message : "فشل التحليل." };
  }
  if (!result) return { ...base, error: "ما قدرت أحلّل رد الذكاء." };

  // Write only the fields that were missing (or all, when overwrite is on).
  const patch: Record<string, unknown> = {};
  const want = new Set(overwrite ? ["name_ar", "description_ar", "main_category"] : input && missingFields(input));
  if (want.has("name_ar") && result.name_ar) patch.name_ar = result.name_ar;
  if (want.has("description_ar") && result.description_ar) patch.description_ar = result.description_ar;
  if (want.has("main_category") && result.main_category) patch.main_category = result.main_category;

  if (Object.keys(patch).length) {
    const { error: upErr } = await supabase.from("products").update(patch).eq("id", id);
    if (upErr) return { ...base, error: upErr.message, arMatchesEn: result.arMatchesEn, imageMatches: result.imageMatches, notes: result.notes };
  }

  return {
    ok: true, filled: Object.keys(patch),
    arMatchesEn: result.arMatchesEn, imageMatches: result.imageMatches, notes: result.notes,
  };
}
