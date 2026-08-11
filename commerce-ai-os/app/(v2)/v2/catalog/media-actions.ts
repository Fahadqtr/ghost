"use server";

// V2 product media WRITE actions (UX.4C-2). Thin server-side wrappers over the
// EXISTING image cores — they add NO new storage/DB sync logic of their own:
//   • uploadProductMedia → lib/products/imageStore.storePrimaryProductImage
//       (upload named <sku>.<ext> → product_images row is_primary → sync
//        products.image_url + image_filename). Used for BOTH "upload" and
//        "replace the primary".
//   • removeProductMedia → the existing app/(app)/products removeProductImage
//       action (delete the row; if it was primary, promote the next by
//        is_primary/sort_order or clear products.image_url).
// After each write they re-read the canonical state through the shared
// loadProductMedia reader and return a normalized ProductMediaState, so the
// client updates without a full reload and never sees a raw storage/DB error.
//
// Every write stays SERVER-SIDE. The client never touches Storage directly and
// never holds a service-role client. Auth is gated here AND re-gated inside the
// reused cores.

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isSignedIn } from "@/lib/auth/requireUser";
import { storePrimaryProductImage } from "@/lib/products/imageStore";
import { removeProductImage } from "@/app/(app)/products/image-actions";
import { loadProductMedia } from "@/lib/products/product-media-read";
import { EMPTY_PRODUCT_MEDIA, planReorder, type ProductMediaState } from "@/lib/products/product-media";
import { parseProductId } from "@/lib/catalog-v2/master-catalog-view";

const MEDIA_MESSAGES = {
  not_signed_in: "الرجاء تسجيل الدخول.",
  invalid: "طلب غير صالح.",
  no_file: "اختر ملف صورة.",
  type: "نوع الصورة غير مدعوم. استخدم JPG أو PNG أو WebP أو GIF.",
  too_large: "حجم الملف كبير جدًا (الحد الأقصى 10MB).",
  upload_failed: "تعذّر رفع الصورة. حاول مرة أخرى.",
  remove_failed: "تعذّر حذف الصورة. حاول مرة أخرى.",
  set_failed: "تعذّر تعيين الصورة الرئيسية. حاول مرة أخرى.",
  reorder_failed: "تعذّر تغيير الترتيب. حاول مرة أخرى.",
} as const;

// Same envelope the imageStore core enforces; validating here too gives a fixed
// Arabic message instead of the core's English string.
const ALLOWED_MEDIA: Record<string, true> = {
  "image/jpeg": true,
  "image/png": true,
  "image/webp": true,
  "image/gif": true,
};
const MAX_BYTES = 10 * 1024 * 1024; // 10 MB

type MediaResult = { data: ProductMediaState } | { error: string };

/** Re-read the canonical media state after a write (session client, read-only).
 *  A read failure degrades to the empty state — never a raw error. */
async function readState(productId: string): Promise<ProductMediaState> {
  try {
    const supabase = createClient();
    const res = await loadProductMedia(supabase, productId);
    return res.status === "ok" ? res.state : EMPTY_PRODUCT_MEDIA;
  } catch {
    return EMPTY_PRODUCT_MEDIA;
  }
}

/**
 * Upload a new photo and make it the product's primary (this is BOTH "upload"
 * and "replace the primary" — the reused core always sets the new image as
 * primary and repoints products.image_url). Returns the fresh media state.
 */
export async function uploadProductMedia(formData: FormData): Promise<MediaResult> {
  if (!(await isSignedIn())) return { error: MEDIA_MESSAGES.not_signed_in };

  const productId = parseProductId(String(formData.get("productId") ?? ""));
  if (productId === null) return { error: MEDIA_MESSAGES.invalid };

  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) return { error: MEDIA_MESSAGES.no_file };
  if (!ALLOWED_MEDIA[file.type]) return { error: MEDIA_MESSAGES.type };
  if (file.size > MAX_BYTES) return { error: MEDIA_MESSAGES.too_large };

  let admin;
  try {
    admin = createAdminClient();
  } catch {
    return { error: MEDIA_MESSAGES.upload_failed };
  }

  // The core validates the product, uploads under <sku>.<ext>, writes the
  // product_images row, and syncs products.image_url/image_filename. Its raw
  // (English) error is mapped to a fixed Arabic message — never surfaced.
  const r = await storePrimaryProductImage(admin, productId, file, "V2 محرر: رفع صورة");
  if ("error" in r) return { error: MEDIA_MESSAGES.upload_failed };

  revalidatePath(`/v2/catalog/${productId}`);
  revalidatePath(`/v2/catalog/${productId}/edit`);
  revalidatePath("/v2/catalog");

  return { data: await readState(productId) };
}

/**
 * Remove a photo by url. Delegates to the existing removeProductImage core,
 * which — when the removed photo was the primary — promotes the next gallery
 * image (is_primary, then sort_order) or clears products.image_url when none
 * remain. Returns the fresh media state.
 */
export async function removeProductMedia(productId: string, url: string): Promise<MediaResult> {
  if (!(await isSignedIn())) return { error: MEDIA_MESSAGES.not_signed_in };

  const validId = parseProductId(productId);
  if (validId === null || typeof url !== "string" || url.trim() === "") {
    return { error: MEDIA_MESSAGES.invalid };
  }

  const r = await removeProductImage(validId, url);
  if (r && typeof (r as { error?: unknown }).error === "string") {
    return { error: MEDIA_MESSAGES.remove_failed };
  }

  revalidatePath(`/v2/catalog/${validId}`);
  revalidatePath(`/v2/catalog/${validId}/edit`);
  revalidatePath("/v2/catalog");

  return { data: await readState(validId) };
}

/**
 * Make an EXISTING gallery image the primary (UX.4C-3). Maintains the
 * source-of-truth invariant: exactly one product_images row has is_primary=true
 * (the chosen one) and products.image_url/image_filename equal that row's
 * url/filename. Product-scoped: the image is verified to belong to this product,
 * so no cross-product set-primary is possible. Admin client is used server-side
 * only (the browser never holds it); auth is gated here.
 */
export async function setPrimaryProductMedia(productId: string, imageId: string): Promise<MediaResult> {
  if (!(await isSignedIn())) return { error: MEDIA_MESSAGES.not_signed_in };

  const validId = parseProductId(productId);
  if (validId === null || typeof imageId !== "string" || imageId.trim() === "") {
    return { error: MEDIA_MESSAGES.invalid };
  }

  let admin;
  try {
    admin = createAdminClient();
  } catch {
    return { error: MEDIA_MESSAGES.set_failed };
  }

  try {
    // The image MUST belong to this product — this scoping is what blocks a
    // cross-product set-primary. A missing row is a plain failure, never a throw.
    const { data: target, error: selErr } = await admin
      .from("product_images")
      .select("id, url, filename")
      .eq("id", imageId)
      .eq("product_id", validId)
      .maybeSingle();
    if (selErr || !target || typeof target.url !== "string") return { error: MEDIA_MESSAGES.set_failed };

    // Exactly one primary: clear all for this product, then set the chosen one.
    await admin.from("product_images").update({ is_primary: false }).eq("product_id", validId);
    await admin.from("product_images").update({ is_primary: true }).eq("id", imageId).eq("product_id", validId);
    // Sync the authoritative pointer.
    await admin
      .from("products")
      .update({ image_url: target.url, image_filename: target.filename ?? null })
      .eq("id", validId);
  } catch {
    return { error: MEDIA_MESSAGES.set_failed };
  }

  revalidatePath(`/v2/catalog/${validId}`);
  revalidatePath(`/v2/catalog/${validId}/edit`);
  revalidatePath("/v2/catalog");

  return { data: await readState(validId) };
}

/**
 * Move an EXTRA image one slot up/down (UX.4C-3). Writes ONLY product_images
 * .sort_order — never is_primary or products.image_url — so the primary is never
 * changed by a reorder. The bounded plan is computed by the pure planReorder from
 * the current product-scoped state; each write is scoped to this product. No new
 * schema, no RPC.
 */
export async function reorderProductMedia(
  productId: string,
  imageId: string,
  direction: "up" | "down",
): Promise<MediaResult> {
  if (!(await isSignedIn())) return { error: MEDIA_MESSAGES.not_signed_in };

  const validId = parseProductId(productId);
  if (
    validId === null ||
    typeof imageId !== "string" ||
    imageId.trim() === "" ||
    (direction !== "up" && direction !== "down")
  ) {
    return { error: MEDIA_MESSAGES.invalid };
  }

  // Read current state (product-scoped) and compute the bounded renumber plan.
  const current = await readState(validId);
  const plan = planReorder(current, imageId, direction);
  if (plan.length === 0) return { data: current }; // edge / unknown / primary → no-op

  let admin;
  try {
    admin = createAdminClient();
  } catch {
    return { error: MEDIA_MESSAGES.reorder_failed };
  }

  try {
    for (const { id, sortOrder } of plan) {
      const { error: upErr } = await admin
        .from("product_images")
        .update({ sort_order: sortOrder })
        .eq("id", id)
        .eq("product_id", validId); // product-scoped write
      if (upErr) return { error: MEDIA_MESSAGES.reorder_failed };
    }
  } catch {
    return { error: MEDIA_MESSAGES.reorder_failed };
  }

  revalidatePath(`/v2/catalog/${validId}`);
  revalidatePath(`/v2/catalog/${validId}/edit`);
  revalidatePath("/v2/catalog");

  return { data: await readState(validId) };
}
