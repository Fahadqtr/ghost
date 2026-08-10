"use server";

// Malikas V2 — Talabat snapshot capture (Phase UI.9.6). SERVER ACTION.
// After a successful Talabat catalog upload/diff, persist ONE reliable snapshot
// per Approved Malika product into platform_snapshots (present/missing verdict
// from the EXISTING diffTalabat). OWNER-ONLY. READ-only on products; INSERT-only
// on platform_snapshots through the SESSION client (RLS) — no service role, no
// product/mapping/order write, no RPC. Never touches the order pipeline, stock
// deduction, or channel_variant_mappings. Idempotent: re-uploading the same sheet
// writes nothing. Errors surface as a fixed Arabic message — never a raw error.

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireOwner } from "@/lib/malak/authz";
import { captureTalabatSnapshots, type CaptureTalabatResult } from "@/lib/platforms/talabat/snapshot-capture";

export async function captureTalabatSnapshotsAction(
  rows: Record<string, unknown>[],
): Promise<CaptureTalabatResult> {
  const base: CaptureTalabatResult = {
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
  const result = await captureTalabatSnapshots(client as never, rows, new Date().toISOString());
  if (result.ok && !result.skipped) revalidatePath("/v2/operations");
  return result;
}
