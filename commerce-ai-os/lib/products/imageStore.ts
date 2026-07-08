import "server-only";
import { logCatalogTask } from "@/lib/tasks/catalog-log";

// Shared "replace the product's primary photo" core — used by the manager's
// product editor AND the supervisor flow on /staff, so the SKU-named-file
// convention (matches the Talabat "New Image Filename" column) and the
// auto-task never drift between the two entry points.

const MAX_BYTES = 10 * 1024 * 1024; // 10 MB
const EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
};
const BUCKET = "product-images";

export async function storePrimaryProductImage(
  admin: any,
  productId: string,
  file: File,
  actor?: string,
): Promise<{ ok: true; url: string } | { error: string }> {
  if (!productId) return { error: "Missing product id." };
  if (!(file instanceof File) || file.size === 0) return { error: "No file selected." };
  if (file.size > MAX_BYTES) return { error: `File too large (${(file.size / 1048576).toFixed(1)} MB). Max 10 MB.` };
  const ext = EXT[file.type];
  if (!ext) return { error: `Unsupported type "${file.type || "unknown"}". Use JPG, PNG, WebP, or GIF (HEIC isn't supported by browsers).` };

  const { data: prod, error: pErr } = await admin
    .from("products").select("sku, name_en, name_ar").eq("id", productId).single();
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

    await logCatalogTask({
      action: "image", productId, actor,
      snapshot: { name_en: prod.name_en, name_ar: prod.name_ar, sku: prod.sku, image_url: url },
      note: "انرفعت صورة جديدة وصارت الأساسية.",
    });

    return { ok: true, url };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Unexpected upload error." };
  }
}
