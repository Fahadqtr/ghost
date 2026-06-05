"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

export async function updateInventory(
  id: string,
  values: { stock_quantity: string; low_stock_threshold: string }
) {
  const supabase = createClient();
  const toNum = (v: string) => {
    const t = (v ?? "").trim();
    if (t === "") return null;
    const n = Number(t);
    return isNaN(n) ? null : n;
  };

  const { error } = await supabase
    .from("inventory")
    .update({
      stock_quantity: toNum(values.stock_quantity),
      low_stock_threshold: toNum(values.low_stock_threshold),
      updated_at: new Date().toISOString(),
    })
    .eq("id", id);

  if (error) return { error: error.message };
  revalidatePath("/inventory");
  revalidatePath("/dashboard");
  return { ok: true };
}
