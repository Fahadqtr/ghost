"use server";

import { createClient } from "@/lib/supabase/server";
import { isSignedIn } from "@/lib/auth/requireUser";
import { safeImageUrlOrNull, safeFetchImage } from "@/lib/net/safeImage";
import { auditProductImageWithGemini, geminiConfigured } from "@/lib/social/scene-gemini";

// Catalog image health scan: probe every product's image_url (first KB only)
// and report the ones a browser can't render — dead links, hotlink-blocked
// CDNs, non-image responses, missing images. Read-only; the client loops in
// chunks with a progress note (established pattern).

export type ImageProblemKind = "no_image" | "unsafe_url" | "broken" | "blocked" | "not_image";

export interface ImageProblem {
  product_id: string;
  sku: string | null;
  name_en: string;
  image_url: string | null;
  kind: ImageProblemKind;
  detail: string; // "HTTP 404", "timeout", "content-type text/html", …
}

export interface ImageScanChunk {
  ok: boolean;
  error?: string;
  total: number;      // products in the catalog (for the progress bar)
  checked: number;    // products examined in THIS chunk
  okCount: number;    // of those, images that loaded fine
  problems: ImageProblem[];
}

const EMPTY: Omit<ImageScanChunk, "ok"> = { total: 0, checked: 0, okCount: 0, problems: [] };

async function probe(url: string): Promise<{ ok: boolean; kind?: ImageProblemKind; detail?: string }> {
  try {
    const res = await safeFetchImage(url, {
      headers: { Range: "bytes=0-2047" },
      cache: "no-store",
      signal: AbortSignal.timeout(8_000),
    });
    if (res.status === 403 || res.status === 401) return { ok: false, kind: "blocked", detail: `HTTP ${res.status} — المصدر يمنع التحميل` };
    if (!res.ok && res.status !== 206) return { ok: false, kind: "broken", detail: `HTTP ${res.status}` };
    const ct = String(res.headers.get("content-type") ?? "").toLowerCase();
    if (ct && !ct.startsWith("image/") && !ct.includes("octet-stream")) {
      return { ok: false, kind: "not_image", detail: `النوع ${ct.split(";")[0]}` };
    }
    return { ok: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "network";
    return { ok: false, kind: "broken", detail: /abort|timeout/i.test(msg) ? "مهلة انتهت (timeout)" : msg.slice(0, 80) };
  }
}

/** Scan ONE slice of the catalog (client loops; ≤30 products per call). */
export async function scanCatalogImages(offset: number, limit = 30): Promise<ImageScanChunk> {
  if (!(await isSignedIn())) return { ok: false, error: "Not signed in.", ...EMPTY };
  const from = Math.max(0, Math.floor(offset));
  const size = Math.max(1, Math.min(30, Math.floor(limit)));

  try {
    const sb = await createClient();
    const { count } = await sb.from("products").select("id", { count: "exact", head: true });
    const { data, error } = await sb
      .from("products")
      .select("id, sku, name_en, image_url")
      .order("sku", { ascending: true })
      .range(from, from + size - 1);
    if (error) return { ok: false, error: error.message, ...EMPTY };

    type Row = { id: string; sku: string | null; name_en: string | null; image_url: string | null };
    const rows = (data ?? []) as Row[];
    const problems: ImageProblem[] = [];
    let okCount = 0;

    await Promise.all(rows.map(async (r) => {
      const base = { product_id: r.id, sku: r.sku, name_en: String(r.name_en ?? ""), image_url: r.image_url };
      const url = String(r.image_url ?? "").trim();
      if (!url) { problems.push({ ...base, kind: "no_image", detail: "ما في صورة" }); return; }
      if (!safeImageUrlOrNull(url)) { problems.push({ ...base, kind: "unsafe_url", detail: "رابط غير صالح" }); return; }
      const res = await probe(url);
      if (res.ok) okCount++;
      else problems.push({ ...base, kind: res.kind ?? "broken", detail: res.detail ?? "" });
    }));

    return { ok: true, total: count ?? 0, checked: rows.length, okCount, problems };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Scan failed.", ...EMPTY };
  }
}

// ---- AI visual quality audit ---------------------------------------------------
// The HTTP scan above only proves the link works; this one LOOKS at the image
// (Gemini vision) and flags what a customer would notice: product cut off by
// the frame, glitched file, blur, watermark, placeholder, too dark, or not a
// product photo at all.

export interface ImageQualityIssue {
  product_id: string;
  sku: string | null;
  name_en: string;
  image_url: string;
  problems: string[];
  note: string;
}

export interface QualityScanChunk {
  ok: boolean;
  error?: string;
  total: number;    // products WITH an image (progress denominator)
  checked: number;  // examined in this chunk (unreadable images count too)
  flagged: ImageQualityIssue[];
}

const Q_EMPTY: Omit<QualityScanChunk, "ok"> = { total: 0, checked: 0, flagged: [] };

/** Audit ONE slice of the products that have an image (client loops; ≤10). */
export async function auditImageQuality(offset: number, limit = 10): Promise<QualityScanChunk> {
  if (!(await isSignedIn())) return { ok: false, error: "Not signed in.", ...Q_EMPTY };
  if (!geminiConfigured()) return { ok: false, error: "Gemini غير مفعّل (GEMINI_API_KEY).", ...Q_EMPTY };
  const from = Math.max(0, Math.floor(offset));
  const size = Math.max(1, Math.min(10, Math.floor(limit)));

  try {
    const sb = await createClient();
    const { count } = await sb
      .from("products")
      .select("id", { count: "exact", head: true })
      .not("image_url", "is", null)
      .neq("image_url", "");
    const { data, error } = await sb
      .from("products")
      .select("id, sku, name_en, image_url")
      .not("image_url", "is", null)
      .neq("image_url", "")
      .order("sku", { ascending: true })
      .range(from, from + size - 1);
    if (error) return { ok: false, error: error.message, ...Q_EMPTY };

    type Row = { id: string; sku: string | null; name_en: string | null; image_url: string };
    const rows = (data ?? []) as Row[];
    const flagged: ImageQualityIssue[] = [];

    await Promise.all(rows.map(async (r) => {
      if (!safeImageUrlOrNull(r.image_url)) return; // HTTP scan's territory
      const v = await auditProductImageWithGemini(r.image_url);
      if (v && !v.ok) {
        flagged.push({
          product_id: r.id, sku: r.sku, name_en: String(r.name_en ?? ""),
          image_url: r.image_url, problems: v.problems, note: v.note,
        });
      }
    }));

    return { ok: true, total: count ?? 0, checked: rows.length, flagged };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Audit failed.", ...Q_EMPTY };
  }
}
