"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireMalakWriter } from "@/lib/malak/authz";
import { safeError } from "@/lib/security/safe-error";
import { CHANNEL_STATUSES } from "@/lib/constants";

const CHANNEL_WRITE_FAILED = "تعذّر تحديث حالة القناة. حاول مرة أخرى.";

export async function setChannelStatus(
  productId: string,
  channelId: string,
  status: string
) {
  // OPS.7 §7 — channel republish/unpublish mutation: writer-gated (was login-only).
  const writer = await requireMalakWriter();
  if (!writer.ok) return { error: writer.error };

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
    if (error) return { error: safeError("channels.setChannelStatus", error, CHANNEL_WRITE_FAILED) };
  } else {
    const { error } = await supabase.from("channel_products").insert({
      product_id: productId,
      channel_id: channelId,
      channel_status: status,
    });
    if (error) return { error: safeError("channels.setChannelStatus", error, CHANNEL_WRITE_FAILED) };
  }

  revalidatePath("/channels");
  return { ok: true };
}
