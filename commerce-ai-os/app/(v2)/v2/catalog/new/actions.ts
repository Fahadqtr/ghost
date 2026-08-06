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
  type DuplicateReport,
} from "@/lib/products/duplicate-detect";
import { CREATE_MESSAGES, validateAiProductInput } from "@/lib/products/create-validation";
import { toProductRow, type ProductInput } from "@/lib/products/product-save";
import { createProductCore, projectVariantInsertRows } from "@/lib/products/product-create";

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
    const client = new Anthropic({ apiKey });
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

export interface PreparedIdentity {
  sku: string;
  productBarcode: string;
  variantBarcodes: string[];
  duplicates: DuplicateReport;
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

  const duplicates = findDuplicates(
    { ...candidate, sku, barcodes: [] },
    snapshot.rows,
  );

  return {
    data: {
      sku,
      productBarcode: barcodes[0],
      variantBarcodes: barcodes.slice(1),
      duplicates,
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
  const ext = ALLOWED_MEDIA[imageMediaType];
  const filename = `${mainSku}.${ext}`;
  const admin = createAdminClient();
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

  const removeImage = async () => {
    try {
      await admin.storage.from(BUCKET).remove([filename]);
    } catch {
      /* the failure path below already reports the create as failed */
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
    await removeImage();
    return { error: CREATE_MESSAGES.invalid_input };
  }

  const core = await createProductCore(supabase, row, projectVariantInsertRows(variants));
  if (!core.ok) {
    await removeImage();
    if (core.cleanup === "failed") return { error: CREATE_MESSAGES.cleanup_failed };
    if (core.stage === "variant_insert") return { error: CREATE_MESSAGES.variant_create_failed };
    if (core.duplicateIdentity) return { error: CREATE_MESSAGES.sku_taken };
    return { error: CREATE_MESSAGES.create_failed };
  }

  revalidatePath("/v2/catalog");
  redirect(`/v2/catalog/${core.productId}?created=1`);
}
