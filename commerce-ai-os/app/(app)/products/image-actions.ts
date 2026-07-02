"use server";

import { createAdminClient } from "@/lib/supabase/admin";
import { isSignedIn } from "@/lib/auth/requireUser";
import { revalidatePath } from "next/cache";

const MAX_BYTES = 10 * 1024 * 1024; // 10 MB
const EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
};

const BUCKET = "product-images";

function revalidate(productId: string) {
  revalidatePath(`/products/${productId}/edit`);
  revalidatePath(`/products/${productId}`);
  revalidatePath("/products");
}

// Upload a new image, make it primary, point products.image_url at it.
export async function uploadProductImage(formData: FormData) {
  if (!(await isSignedIn())) return { error: "Not signed in." };

  const file = formData.get("file");
  const productId = String(formData.get("productId") || "");
  if (!productId) return { error: "Missing product id." };
  if (!(file instanceof File) || file.size === 0) return { error: "No file selected." };
  if (file.size > MAX_BYTES) return { error: `File too large (${(file.size / 1048576).toFixed(1)} MB). Max 10 MB.` };

  const ext = EXT[file.type];
  if (!ext) return { error: `Unsupported type "${file.type || "unknown"}". Use JPG, PNG, WebP, or GIF (HEIC isn't supported by browsers).` };

  let admin;
  try { admin = createAdminClient(); }
  catch (e) { return { error: e instanceof Error ? e.message : "Service role unavailable." }; }

  const { data: prod, error: pErr } = await admin
    .from("products").select("sku").eq("id", productId).single();
  if (pErr || !prod) return { error: "Product not found." };

  const sku = String(prod.sku || "img").replace(/[^a-zA-Z0-9_-]/g, "") || "img";
  // Save the file under the SKU name (e.g. mk1995.jpg) so it matches the catalog
  // convention and the Talabat "New Image Filename" column. upsert replaces the
  // product's canonical image.
  const filename = `${sku}.${ext}`;

  try {
    const buf = Buffer.from(await file.arrayBuffer());
    const { error: upErr } = await admin.storage
      .from(BUCKET)
      .upload(filename, buf, { contentType: file.type, upsert: true, cacheControl: "3600" });
    if (upErr) return { error: `Upload failed: ${upErr.message}` };

    // Cache-bust the URL (we overwrote the same object) so the new image shows
    // immediately; image_filename stays the clean "<sku>.<ext>".
    const base = admin.storage.from(BUCKET).getPublicUrl(filename).data.publicUrl;
    const url = `${base}?t=${Date.now()}`;

    // make this the primary image
    await admin.from("product_images").update({ is_primary: false }).eq("product_id", productId);
    await admin.from("product_images").insert({
      product_id: productId, url, filename, is_primary: true, sort_order: 0,
    });
    await admin.from("products").update({ image_url: url, image_filename: filename }).eq("id", productId);

    revalidate(productId);
    return { ok: true, url };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Unexpected upload error." };
  }
}

// Upload an image for a product that doesn't exist yet (the "New product"
// form). Stores the file in the bucket and returns its public URL + filename so
// the form can set image_url/image_filename; the product is created afterwards
// with createProduct. No product_images row is written (there's no product id).
export async function uploadNewProductImage(formData: FormData) {
  if (!(await isSignedIn())) return { error: "Not signed in." };

  const file = formData.get("file");
  const skuRaw = String(formData.get("sku") || "").replace(/[^a-zA-Z0-9_-]/g, "");
  if (!(file instanceof File) || file.size === 0) return { error: "No file selected." };
  if (file.size > MAX_BYTES) return { error: `File too large (${(file.size / 1048576).toFixed(1)} MB). Max 10 MB.` };

  const ext = EXT[file.type];
  if (!ext) return { error: `Unsupported type "${file.type || "unknown"}". Use JPG, PNG, WebP, or GIF (HEIC isn't supported by browsers).` };

  let admin;
  try { admin = createAdminClient(); }
  catch (e) { return { error: e instanceof Error ? e.message : "Service role unavailable." }; }

  // Name by SKU when known (catalog convention), else a unique temporary name.
  const base = skuRaw || `new-${Date.now()}`;
  const filename = `${base}.${ext}`;

  try {
    const buf = Buffer.from(await file.arrayBuffer());
    const { error: upErr } = await admin.storage
      .from(BUCKET)
      .upload(filename, buf, { contentType: file.type, upsert: true, cacheControl: "3600" });
    if (upErr) return { error: `Upload failed: ${upErr.message}` };

    const publicUrl = admin.storage.from(BUCKET).getPublicUrl(filename).data.publicUrl;
    const url = `${publicUrl}?t=${Date.now()}`;
    return { ok: true, url, filename };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Unexpected upload error." };
  }
}

// Remove an image (by url). If it was the primary, repoint products.image_url
// to another image (or null). Storage object is left in place (harmless).
export async function removeProductImage(productId: string, url: string) {
  if (!(await isSignedIn())) return { error: "Not signed in." };
  if (!productId || !url) return { error: "Missing arguments." };

  let admin;
  try { admin = createAdminClient(); }
  catch (e) { return { error: e instanceof Error ? e.message : "Service role unavailable." }; }

  try {
    await admin.from("product_images").delete().eq("product_id", productId).eq("url", url);

    const { data: prod } = await admin.from("products").select("image_url").eq("id", productId).single();
    if (prod && prod.image_url === url) {
      const { data: rest } = await admin
        .from("product_images").select("url")
        .eq("product_id", productId)
        .order("is_primary", { ascending: false })
        .order("sort_order", { ascending: true })
        .limit(1);
      const next = rest && rest[0] ? rest[0].url : null;
      await admin.from("products").update({ image_url: next }).eq("id", productId);
      if (next) await admin.from("product_images").update({ is_primary: true }).eq("product_id", productId).eq("url", next);
    }

    revalidate(productId);
    return { ok: true };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Unexpected error." };
  }
}
