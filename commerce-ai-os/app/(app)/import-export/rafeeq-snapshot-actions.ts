"use server";

// Malikas V2 — Rafeeq snapshot capture (Phase UI.9.7). SERVER ACTION.
// Persists one reliable snapshot per product for Rafeeq into platform_snapshots,
// built ENTIRELY from the EXISTING DB overlays (products.rafeeq_product_id +
// channel_products.channel_status for the exactly-resolved Rafeeq channel).
// OWNER-ONLY. READ-only on channels/channel_products/products; INSERT-only on
// platform_snapshots through the SESSION client (RLS) — no service role, no
// product / channel_products / availability-overlay write, no RPC. Changes no
// channel_products / availability-overlay / export semantics. Idempotent:
// re-running on unchanged overlays writes nothing. Errors surface as a fixed message.

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireOwner } from "@/lib/malak/authz";
import { captureRafeeqSnapshots, type CaptureRafeeqResult } from "@/lib/platforms/rafeeq/snapshot-capture";

export async function captureRafeeqSnapshotsAction(): Promise<CaptureRafeeqResult> {
  const base: CaptureRafeeqResult = {
    ok: false,
    skipped: false,
    total: 0,
    created: 0,
    changed: 0,
    unchanged: 0,
    events: 0,
  };
  const owner = await requireOwner();
  if (!owner.ok) return { ...base, error: owner.error };

  const client = createClient();
  const result = await captureRafeeqSnapshots(client as never, new Date().toISOString());
  if (result.ok && !result.skipped) revalidatePath("/v2/operations");
  return result;
}
