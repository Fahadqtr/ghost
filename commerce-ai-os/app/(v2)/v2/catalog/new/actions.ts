"use server";

// AI product creator actions (Phase UI.5). Three thin steps:
//   1. analyzeAiProductImage — vision extraction (Anthropic, same model env
//      as the legacy describeProductFromImage; the image arrives as base64
//      from the browser, so no URL fetch and no SSRF surface).
//   2. prepareAiProduct — ONE identity-snapshot read that yields the next mk
//      SKU (scanning products AND variants), a unique EAN-13 per sellable
//      item, and the duplicate report.
//   3. createAiProduct — final re-validation + re-scan, image upload named
//      after the SKU, then the all-or-nothing createProductCore; the uploaded
//      image is removed again if the create fails. Nothing is written before
//      this step.
//
// Database writes go through the SESSION client (RLS). Storage upload/removal
// uses the existing admin-storage pattern shared by every image path in the
// app (lib/products/imageStore.ts, image-actions.ts) because the bucket has
// no user-level write policies — adding them would be new SQL, which this
// phase must not apply. No upsert: an existing object is never replaced.
//
// Every failure maps to a fixed Arabic message from CREATE_MESSAGES. The AI's
// raw text, storage paths, database codes and Supabase errors never leave here.

import Anthropic from "@anthropic-ai/sdk";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isSignedIn } from "@/lib/auth/requireUser";
import { CATEGORIES } from "@/lib/constants";
import { HOUSE_STYLE_EXAMPLE } from "@/lib/products/draft-compute";
import { buildVisionExtractPrompt, parseVisionExtract, type VisionExtract } from "@/lib/products/ai-extract";
import { loadIdentitySnapshot } from "@/lib/products/catalog-identity-read";
import { nextMkSku, normalizeMkSku } from "@/lib/products/sku-generate";
import { generateUniqueEan13Batch } from "@/lib/products/barcode-ean13";
import {
  findDuplicates,
  type DuplicateCandidate,
  type DuplicateLevel,
} from "@/lib/products/duplicate-detect";
import {
  loadSimilarProductCards,
  type SimilarProductCard,
} from "@/lib/products/similar-products-read";
import { CREATE_MESSAGES, validateAiProductInput } from "@/lib/products/create-validation";
import { toProductRow, type ProductInput } from "@/lib/products/product-save";
import { createProductCore, projectVariantInsertRows } from "@/lib/products/product-create";
import { makeInventoryInitializer } from "@/lib/products/inventory-initializer";

const BUCKET = "product-images";
const ALLOWED_MEDIA: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};
// The browser downsizes via lib/imagePrep (≤1600px JPEG) before sending, so
// this is a hard backstop, not the normal case.
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

function imageProblem(base64: string, mediaType: string): string | null {
  if (!Object.hasOwn(ALLOWED_MEDIA, mediaType)) return CREATE_MESSAGES.image_type;
  const clean = (base64 ?? "").replace(/\s+/g, "");
  if (clean.length === 0) return CREATE_MESSAGES.image_required;
  if (!/^[A-Za-z0-9+/=]+$/.test(clean)) return CREATE_MESSAGES.image_type;
  if ((clean.length * 3) / 4 > MAX_IMAGE_BYTES) return CREATE_MESSAGES.image_too_large;
  return null;
}

// ── Step 2/3: analysis ───────────────────────────────────────────────────────

export async function analyzeAiProductImage(
  base64: string,
  mediaType: string,
  note?: string,
): Promise<{ data: VisionExtract } | { error: string }> {
  if (!(await isSignedIn())) return { error: CREATE_MESSAGES.not_signed_in };
  const problem = imageProblem(base64, mediaType);
  if (problem) return { error: problem };
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { error: CREATE_MESSAGES.ai_disabled };

  try {
    // Explicit deadline: one retry, 60s cap — a hung provider surfaces as the
    // fixed analyze_failed message instead of an endless pending state.
    const client = new Anthropic({ apiKey, timeout: 60_000, maxRetries: 1 });
    const resp = await client.messages.create({
      model: process.env.STAFF_MALAK_MODEL || "claude-sonnet-5",
      max_tokens: 1600,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: mediaType as "image/jpeg" | "image/png" | "image/webp",
                data: base64.replace(/\s+/g, ""),
              },
            },
            { type: "text", text: buildVisionExtractPrompt(CATEGORIES, HOUSE_STYLE_EXAMPLE, note) },
          ],
        },
      ],
    });
    const text = resp.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { text: string }).text)
      .join("");
    const extract = parseVisionExtract(text, CATEGORIES);
    if (!extract) return { error: CREATE_MESSAGES.analyze_failed };
    return { data: extract };
  } catch {
    return { error: CREATE_MESSAGES.analyze_failed };
  }
}

// ── Step 3/4: identity + duplicates ─────────────────────────────────────────

/** Card-ready duplicate payload: only the hydrated top matches travel to the
 *  browser — never the identity snapshot or the full catalog. */
export interface DuplicateCards {
  level: DuplicateLevel;
  cards: SimilarProductCard[];
  total: number;
}

export interface PreparedIdentity {
  sku: string;
  productBarcode: string;
  variantBarcodes: string[];
  duplicates: DuplicateCards;
  partial: boolean;
}

export async function prepareAiProduct(
  candidate: DuplicateCandidate,
  variantCount: number,
): Promise<{ data: PreparedIdentity } | { error: string }> {
  if (!(await isSignedIn())) return { error: CREATE_MESSAGES.not_signed_in };
  const count = Number.isSafeInteger(variantCount) && variantCount >= 0 && variantCount <= 20 ? variantCount : 0;

  const supabase = createClient();
  const result = await loadIdentitySnapshot(supabase);
  if (result.status !== "ok") return { error: CREATE_MESSAGES.identity_scan_failed };
  const { snapshot } = result;

  const sku = nextMkSku(snapshot.skus);
  let barcodes: string[];
  try {
    barcodes = generateUniqueEan13Batch(count + 1, snapshot.barcodes, Math.random);
  } catch {
    return { error: CREATE_MESSAGES.identity_scan_failed };
  }

  const report = findDuplicates({ ...candidate, sku, barcodes: [] }, snapshot.rows);
  // Hydrate ONLY the reported product ids into card/preview fields — the
  // snapshot itself never leaves the server.
  const hydrated = await loadSimilarProductCards(supabase, report.matches, report.total);

  return {
    data: {
      sku,
      productBarcode: barcodes[0],
      variantBarcodes: barcodes.slice(1),
      duplicates: { level: report.level, cards: hydrated.cards, total: hydrated.total },
      partial: snapshot.partial,
    },
  };
}

// ── Step 6: save ─────────────────────────────────────────────────────────────

export async function createAiProduct(
  input: ProductInput,
  imageBase64: string,
  imageMediaType: string,
): Promise<{ error: string }> {
  if (!(await isSignedIn())) return { error: CREATE_MESSAGES.not_signed_in };

  const imageErr = imageProblem(imageBase64, imageMediaType);
  if (imageErr) return { error: imageErr };

  const validation = validateAiProductInput(input);
  if (!validation.ok) return { error: validation.message };

  const supabase = createClient();

  // Re-scan at save time: SKUs (products AND variants), barcodes, real dups.
  const scan = await loadIdentitySnapshot(supabase);
  if (scan.status !== "ok") return { error: CREATE_MESSAGES.identity_scan_failed };
  const { snapshot } = scan;

  const variants = Array.isArray(input.variants) ? input.variants : [];
  const takenSkus = new Set(snapshot.skus.map((s) => s.trim().toLowerCase()));
  const mainSku = normalizeMkSku(input.sku);
  const allSkus = [mainSku, ...variants.map((v) => (v.sku ?? "").trim().toLowerCase())];
  for (const s of allSkus) {
    if (takenSkus.has(s)) return { error: CREATE_MESSAGES.sku_taken };
  }
  const allBarcodes = [(input.barcode ?? "").trim(), ...variants.map((v) => (v.barcode ?? "").trim())];
  for (const b of allBarcodes) {
    if (snapshot.barcodes.has(b)) return { error: CREATE_MESSAGES.barcode_taken };
  }

  const duplicates = findDuplicates(
    {
      sku: mainSku,
      barcodes: [],
      brand: "",
      nameEn: input.name_en,
      nameAr: input.name_ar,
      size: input.size,
      shade: input.color,
    },
    snapshot.rows,
  );
  if (duplicates.level === "exact") return { error: CREATE_MESSAGES.duplicate_exact };

  // Upload the image FIRST (the row needs its URL), named after the main SKU,
  // never with the original filename, never a uuid/timestamp, never upsert.
  // The extension comes from the server-validated MIME map only, and the SKU
  // already matched ^mk\d+$ — so the object path cannot contain traversal or
  // user-controlled characters of any kind.
  const ext = ALLOWED_MEDIA[imageMediaType];
  const filename = `${mainSku}.${ext}`;
  const admin = createAdminClient();

  // A file for this SKU under ANY supported extension blocks the write — we
  // never overwrite and never sit a .png next to an existing .jpg.
  try {
    const { data: existing, error: listErr } = await admin.storage
      .from(BUCKET)
      .list("", { limit: 100, search: `${mainSku}.` });
    if (listErr) return { error: CREATE_MESSAGES.image_upload_failed };
    const names = new Set((existing ?? []).map((f: { name: string }) => f.name));
    for (const e of Object.values(ALLOWED_MEDIA)) {
      if (names.has(`${mainSku}.${e}`)) return { error: CREATE_MESSAGES.image_name_taken };
    }
  } catch {
    return { error: CREATE_MESSAGES.image_upload_failed };
  }

  let imageUrl: string;
  try {
    const buf = Buffer.from(imageBase64.replace(/\s+/g, ""), "base64");
    const { error: upErr } = await admin.storage
      .from(BUCKET)
      .upload(filename, buf, { contentType: imageMediaType, upsert: false, cacheControl: "3600" });
    if (upErr) {
      const msg = String((upErr as { message?: string }).message ?? "").toLowerCase();
      return {
        error: msg.includes("exist") || msg.includes("duplicate")
          ? CREATE_MESSAGES.image_name_taken
          : CREATE_MESSAGES.image_upload_failed,
      };
    }
    imageUrl = admin.storage.from(BUCKET).getPublicUrl(filename).data.publicUrl;
  } catch {
    return { error: CREATE_MESSAGES.image_upload_failed };
  }

  // Removes ONLY the object this very request uploaded. Returns false instead
  // of throwing so a failed cleanup is REPORTED to the user, and logged
  // server-side with the filename only — never the error body or a URL.
  const removeImage = async (): Promise<boolean> => {
    try {
      const { error: rmErr } = await admin.storage.from(BUCKET).remove([filename]);
      if (rmErr) {
        console.error("[ai-product-creator] image cleanup failed:", filename);
        return false;
      }
      return true;
    } catch {
      console.error("[ai-product-creator] image cleanup failed:", filename);
      return false;
    }
  };

  // Project the row. New products are NEVER approved and never carry a
  // platform status — no Shopify/Snoonu/Talabat/Rafeeq sync can pick them up.
  let row: Record<string, unknown>;
  try {
    row = await toProductRow({
      ...input,
      sku: mainSku,
      approval: "",
      rejection_reason: "",
      platform_status: "",
      image_filename: filename,
      image_url: imageUrl,
    });
  } catch {
    const removed = await removeImage();
    return { error: removed ? CREATE_MESSAGES.invalid_input : CREATE_MESSAGES.image_cleanup_failed };
  }

  const core = await createProductCore(supabase, row, projectVariantInsertRows(variants), makeInventoryInitializer(admin));
  if (!core.ok) {
    const removed = await removeImage();
    if (core.cleanup === "failed") return { error: CREATE_MESSAGES.cleanup_failed };
    if (!removed) return { error: CREATE_MESSAGES.image_cleanup_failed };
    if (core.stage === "variant_insert") return { error: CREATE_MESSAGES.variant_create_failed };
    if (core.duplicateIdentity) return { error: CREATE_MESSAGES.sku_taken };
    return { error: CREATE_MESSAGES.create_failed };
  }

  // Close the V2 create ↔ product_images gap (UX.4C-2): record the same primary
  // photo in the gallery so V2-created products match the edit/legacy flows.
  // This runs ONLY after the product+variants+image_url are committed, so it can
  // never orphan a gallery row. It is best-effort and NON-fatal: products.image_url
  // is the authoritative primary (the media reducer synthesizes a primary from it
  // when no gallery row exists), so a failure here leaves a fully-valid product —
  // it is logged (filename only, never the URL or the raw error) and the create
  // still succeeds. Session client (RLS), same as the product/variant writes.
  try {
    const { error: galleryErr } = await supabase
      .from("product_images")
      .insert({ product_id: core.productId, url: imageUrl, filename, is_primary: true, sort_order: 0 });
    if (galleryErr) console.error("[ai-product-creator] gallery row insert failed:", filename);
  } catch {
    console.error("[ai-product-creator] gallery row insert failed:", filename);
  }

  revalidatePath("/v2/catalog");
  redirect(`/v2/catalog/${core.productId}?created=1`);
}
