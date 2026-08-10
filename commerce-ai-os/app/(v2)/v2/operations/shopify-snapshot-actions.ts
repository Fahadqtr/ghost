"use server";

// Malikas V2 — Shopify snapshot capture (Phase UI.9.5). SERVER ACTION.
// Persists one reliable snapshot per Malika product for Shopify into
// platform_snapshots, built ENTIRELY from the EXISTING trusted Shopify read
// model (loadShopifyCatalog). OWNER-ONLY. READ-only on Shopify + products;
// INSERT-only on platform_snapshots through the SESSION client (RLS) — no service
// role, no product/inventory/platform_status write, no RPC. Idempotent: re-running
// on an unchanged catalog writes nothing. Errors surface as a fixed Arabic
// message — never a raw DB/Shopify error, token, or domain.

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireOwner } from "@/lib/malak/authz";
import { captureShopifySnapshots, type CaptureShopifyResult } from "@/lib/platforms/shopify/snapshot-capture";

export async function captureShopifySnapshotsAction(): Promise<CaptureShopifyResult> {
  const base: CaptureShopifyResult = {
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
  const result = await captureShopifySnapshots(client as never, new Date().toISOString());
  if (result.ok && !result.skipped) revalidatePath("/v2/operations");
  return result;
}
