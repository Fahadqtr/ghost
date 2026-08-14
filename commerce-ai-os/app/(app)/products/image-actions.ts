"use server";

import { logCatalogTask } from "@/lib/tasks/catalog-log";
import { createAdminClient } from "@/lib/supabase/admin";
import { isSignedIn } from "@/lib/auth/requireUser";
import { revalidatePath } from "next/cache";
import { storePrimaryProductImage, storePrimaryProductImageBySku } from "@/lib/products/imageStore";

function revalidate(productId: string) {
  revalidatePath(`/products/${productId}/edit`);
  revalidatePath(`/products/${productId}`);
  revalidatePath("/products");
}

// Upload a new image, make it primary, point products.image_url at it.
// (Shared core with the supervisor flow on /staff — lib/products/imageStore.)
export async function uploadProductImage(formData: FormData) {
  if (!(await isSignedIn())) return { error: "Not signed in." };

  const file = formData.get("file");
  const productId = String(formData.get("productId") || "");

  let admin;
  try { admin = createAdminClient(); }
  catch (e) { return { error: e instanceof Error ? e.message : "Service role unavailable." }; }

  const r = await storePrimaryProductImage(admin, productId, file as File);
  if ("error" in r) return r;
  revalidate(productId);
  return r;
}

// Bulk "apply images by SKU": one file per call, matched to the catalog product
// whose SKU equals the (client-derived) filename. The client loops the folder
// and streams progress. Returns { ok, url, productId, name } on success, or
// { error, code } — code "no_product" means that SKU isn't in the catalog.
export async function applyCatalogImageBySku(formData: FormData) {
  if (!(await isSignedIn())) return { error: "Not signed in.", code: "auth" as const };

  const file = formData.get("file");
  const sku = String(formData.get("sku") || "");
  if (!(file instanceof File) || file.size === 0) return { error: "No file selected." };

  let admin;
  try { admin = createAdminClient(); }
  catch (e) { return { error: e instanceof Error ? e.message : "Service role unavailable." }; }

  const r = await storePrimaryProductImageBySku(admin, sku, file, "كتالوج: رفع بالـ SKU");
  if ("ok" in r) revalidate(r.productId);
  return r;
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

    const { data: prod } = await admin.from("products").select("image_url, name_en, name_ar, sku").eq("id", productId).single();
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
      await logCatalogTask({
        action: "image", productId,
        snapshot: { name_en: prod.name_en, name_ar: prod.name_ar, sku: prod.sku, image_url: next ?? "" },
        note: next ? "انحذفت الصورة الأساسية وحلّت محلها التالية." : "انحذفت صورة المنتج — صار بدون صورة.",
      });
    }

    revalidate(productId);
    return { ok: true };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Unexpected error." };
  }
}
