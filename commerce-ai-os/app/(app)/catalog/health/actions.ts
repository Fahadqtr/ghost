"use server";

import { createClient } from "@/lib/supabase/server";
import { isSignedIn } from "@/lib/auth/requireUser";
import { logCatalogTask } from "@/lib/tasks/catalog-log";
import { revalidatePath } from "next/cache";
import { deleteShelfStockForProduct } from "@/lib/products/shelf-cleanup";

// Delete one product (and its dependent rows) WITHOUT redirecting — the catalog
// health page stays put so the owner can clean several duplicates in a row.
// Mirrors products/actions#deleteProduct minus the redirect.
export async function deleteProductById(id: string): Promise<{ ok: true } | { error: string }> {
  if (!(await isSignedIn())) return { error: "Not signed in." };
  if (!id) return { error: "Missing product id." };
  const supabase = createClient();
  const { data: doomed } = await supabase.from("products").select("*").eq("id", id).maybeSingle();
  // variant_shelf_stock holds variant ids with NO foreign key, so clear it
  // BEFORE the variants go — otherwise its rows outlive them silently.
  await deleteShelfStockForProduct(supabase, id);
  await supabase.from("product_variants").delete().eq("parent_product_id", id);
  await supabase.from("channel_products").delete().eq("product_id", id);
  await supabase.from("inventory").delete().eq("product_id", id);
  const { error } = await supabase.from("products").delete().eq("id", id);
  if (error) return { error: error.message };
  await logCatalogTask({ action: "delete", productId: id, snapshot: (doomed ?? {}) as Record<string, unknown> });
  revalidatePath("/products");
  revalidatePath("/inventory");
  revalidatePath("/catalog/health");
  return { ok: true };
}
