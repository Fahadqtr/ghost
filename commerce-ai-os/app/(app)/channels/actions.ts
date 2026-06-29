"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth/requireUser";
import { CHANNEL_STATUSES } from "@/lib/constants";

export async function setChannelStatus(
  productId: string,
  channelId: string,
  status: string
) {
  const unauth = await requireUser();
  if (unauth) return { error: unauth.error };

  if (!CHANNEL_STATUSES.includes(status as (typeof CHANNEL_STATUSES)[number])) {
    return { error: `Invalid status "${status}".` };
  }

  const supabase = createClient();

  // Find an existing join row for this product+channel.
  const { data: existing } = await supabase
    .from("channel_products")
    .select("id")
    .eq("product_id", productId)
    .eq("channel_id", channelId)
    .maybeSingle();

  if (existing?.id) {
    const { error } = await supabase
      .from("channel_products")
      .update({ channel_status: status })
      .eq("id", existing.id);
    if (error) return { error: error.message };
  } else {
    const { error } = await supabase.from("channel_products").insert({
      product_id: productId,
      channel_id: channelId,
      channel_status: status,
    });
    if (error) return { error: error.message };
  }

  revalidatePath("/channels");
  return { ok: true };
}
