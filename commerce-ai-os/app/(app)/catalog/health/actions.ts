"use server";

import { createClient } from "@/lib/supabase/server";
import { isSignedIn } from "@/lib/auth/requireUser";
import { logCatalogTask } from "@/lib/tasks/catalog-log";
import { revalidatePath } from "next/cache";

// Delete one product WITHOUT redirecting — the catalog health page stays put so
// the owner can clean several duplicates in a row. Mirrors products/actions#deleteProduct
// minus the redirect.
export async function deleteProductById(id: string): Promise<{ ok: true } | { error: string }> {
  if (!(await isSignedIn())) return { error: "Not signed in." };
  if (!id) return { error: "Missing product id." };
  const supabase = createClient();
  const { data: doomed } = await supabase.from("products").select("*").eq("id", id).maybeSingle();
  // INV.6A — numeric dependents (inventory → shelf_stock, product_variants →
  // variant_shelf_stock, channel_products) are removed by ON DELETE CASCADE, so
  // deleting the product row is sufficient and atomic. No manual child deletes.
  const { error } = await supabase.from("products").delete().eq("id", id);
  if (error) return { error: error.message };
  await logCatalogTask({ action: "delete", productId: id, snapshot: (doomed ?? {}) as Record<string, unknown> });
  revalidatePath("/products");
  revalidatePath("/inventory");
  revalidatePath("/catalog/health");
  return { ok: true };
}
