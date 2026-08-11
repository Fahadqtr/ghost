"use server";

// UX.4D-2 — AI "fill missing" PROPOSAL action. PROPOSE-ONLY: it reuses the
// EXISTING enrich prompt/parser (lib/products/enrich-compute) to ask the model to
// complete a product's Arabic name / Arabic description / category (and, with a
// photo, verify it), then maps the result through the shared proposal layer and
// RETURNS it. It NEVER writes anything — no products update, no product_images,
// no storage, no RPC — and it never calls the legacy DB-writing enrich action
// (it reuses only that flow's prompt + parser).
//
// The optional image comes from the caller (the edit form passes
// ProductMediaState.primary.url). It is fetched only after assertSafeImageUrl
// (SSRF guard) and its media type is sniffed from the bytes. Any image problem
// degrades to the text-only path — the proposal still returns. The model's raw
// text and any provider error are never surfaced; only fixed Arabic messages.

import Anthropic from "@anthropic-ai/sdk";
import { isSignedIn } from "@/lib/auth/requireUser";
import { assertSafeImageUrl } from "@/lib/net/safeImage";
import { CATEGORIES } from "@/lib/constants";
import { buildEnrichPrompt, parseEnrichResult, type EnrichInput } from "@/lib/products/enrich-compute";
import { toProductGenerationProposal, type ProductGenerationProposal } from "@/lib/products/product-generation";

export interface FillProposalInput {
  current: {
    name_en?: string;
    name_ar?: string;
    description_en?: string;
    description_ar?: string;
    main_category?: string;
  };
  /** Primary image URL (from the media state). Optional — omit for text-only. */
  imageUrl?: string | null;
}

export interface FillVerification {
  arMatchesEn: boolean | null;
  imageMatches: boolean | null;
  notes: string;
}

export type FillProposalResult =
  | { ok: true; proposal: ProductGenerationProposal; verification: FillVerification; usedImage: boolean }
  | { ok: false; error: string };

const MESSAGES = {
  not_signed_in: "الرجاء تسجيل الدخول.",
  ai_disabled: "ميزة الذكاء غير مفعّلة.",
  failed: "تعذّر توليد الاقتراح. حاول مرة أخرى.",
} as const;

const ALLOWED_IMG = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

// Detect the real image type from magic bytes — the server's Content-Type header
// often lies, and Anthropic rejects a base64 image whose declared type mismatches.
function sniffImageMediaType(buf: Buffer): string | null {
  if (buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length >= 4 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return "image/gif";
  if (buf.length >= 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return null;
}

/** Fetch + validate the primary image into an Anthropic image block, or null.
 *  Unsafe URLs (assertSafeImageUrl throws) and any fetch problem degrade to null
 *  so the caller falls back to the text-only path. */
async function buildImageBlock(rawUrl: string): Promise<{ type: "image"; source: { type: "base64"; media_type: string; data: string } } | null> {
  try {
    const url = assertSafeImageUrl(rawUrl); // SSRF guard — throws on private/unsafe hosts
    const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!r.ok) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    const ct = (r.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    const media_type = sniffImageMediaType(buf) || (ALLOWED_IMG.has(ct) ? ct : "image/jpeg");
    const b64 = buf.toString("base64");
    if (!b64) return null;
    return { type: "image", source: { type: "base64", media_type, data: b64 } };
  } catch {
    return null; // unsafe or unreachable → text-only
  }
}

export async function generateProductFillProposal(input: FillProposalInput): Promise<FillProposalResult> {
  if (!(await isSignedIn())) return { ok: false, error: MESSAGES.not_signed_in };
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { ok: false, error: MESSAGES.ai_disabled };

  const cur = input?.current ?? {};
  const enrichInput: EnrichInput = {
    name_en: cur.name_en ?? null,
    name_ar: cur.name_ar ?? null,
    description_en: cur.description_en ?? null,
    description_ar: cur.description_ar ?? null,
    main_category: cur.main_category ?? null,
  };

  const rawUrl = String(input?.imageUrl ?? "").trim();
  const imageBlock = rawUrl ? await buildImageBlock(rawUrl) : null;
  const usedImage = imageBlock !== null;

  try {
    const client = new Anthropic({ apiKey, timeout: 60_000, maxRetries: 1 });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- provider block union, same shape the enrich action uses
    const content: any[] = [];
    if (imageBlock) content.push(imageBlock);
    content.push({ type: "text", text: buildEnrichPrompt(enrichInput, CATEGORIES, usedImage) });

    const resp = await client.messages.create({
      model: process.env.STAFF_MALAK_MODEL || "claude-sonnet-5",
      max_tokens: 2000,
      messages: [{ role: "user", content }],
    });
    const text = resp.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { text: string }).text)
      .join("");
    const result = parseEnrichResult(text, CATEGORIES);
    if (!result) return { ok: false, error: MESSAGES.failed };

    const proposal = toProductGenerationProposal(result, usedImage ? "existing+image" : "existing");
    return {
      ok: true,
      proposal,
      verification: { arMatchesEn: result.arMatchesEn, imageMatches: result.imageMatches, notes: result.notes },
      usedImage,
    };
  } catch {
    return { ok: false, error: MESSAGES.failed };
  }
}
