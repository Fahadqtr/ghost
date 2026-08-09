"use server";

// Malikas V2 — PureSoul snapshot capture (Phase UI.9.3). SERVER ACTION.
// After a PureSoul upload/compare, persist ONE reliable snapshot per Malika
// product into platform_snapshots (via the Platform Snapshot Engine, PR #532).
// READ-ONLY on products; INSERT-only on platform_snapshots through the SESSION
// client (RLS) — no service role, no product/inventory/platform_status write.
// Idempotent: re-running the same upload writes nothing (all diffs "unchanged").
// Errors surface as fixed Arabic messages — never a raw DB error.

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireOwner } from "@/lib/malak/authz";
import { SupabaseSnapshotStore } from "@/lib/platforms/core/supabase-store";
import { captureSnapshots } from "@/lib/platforms/core/capture";
import {
  computePureSoulVerdicts,
  verdictsToSnapshotInputs,
  pickVerdictForProduct,
  type PsCatalogRow,
  type PsUploadRow,
} from "@/lib/platforms/puresoul/capture-compute";

export interface CapturePsResult {
  ok: boolean;
  error?: string;
  total: number; // products with a verdict (snapshot inputs built)
  created: number;
  changed: number;
  unchanged: number;
  events: number;
  capturedAt?: string;
}

const CATALOG_COLUMNS = "id, snoonu_id, pure_seoul_id, sku, barcode, name_en, price";
const CATALOG_COLUMNS_NO_PSID = "id, snoonu_id, sku, barcode, name_en, price";

/**
 * Persist PureSoul snapshots from an upload.
 *
 * Default (no opts): WHOLE-CATALOG capture — a snapshot per product (unchanged
 * behavior). `opts.onlyProductId`: OWNER-ONLY scoped capture for a controlled
 * production test — it reuses the exact same verdict logic over the whole
 * catalog but PERSISTS only the target product's snapshot (every other product
 * is left untouched). The browser supplies only the product id; all snapshot
 * field values are derived server-side, and the id is re-validated against the
 * freshly-computed catalog verdicts.
 */
export async function capturePureSeoulSnapshots(
  rows: PsUploadRow[],
  opts?: { onlyProductId?: string },
): Promise<CapturePsResult> {
  const base: CapturePsResult = { ok: false, total: 0, created: 0, changed: 0, unchanged: 0, events: 0 };
  if (!rows?.length) return { ...base, error: "ما في صفوف في الملف." };

  const scopedId = String(opts?.onlyProductId ?? "").trim();
  const sb = createClient();
  if (scopedId !== "") {
    // Scoped test capture is OWNER-ONLY (verified from the server session).
    const owner = await requireOwner();
    if (!owner.ok) return { ...base, error: owner.error };
  } else {
    const {
      data: { user },
    } = await sb.auth.getUser();
    if (!user) return { ...base, error: "غير مسجّل الدخول." };
  }

  try {
    // Read the catalog (paged, READ-ONLY). Tolerate a catalog without the
    // pure_seoul_id column (matching then falls back to snoonu_id/name).
    const catalog: PsCatalogRow[] = [];
    let columns = CATALOG_COLUMNS;
    for (let f = 0; ; f += 1000) {
      const { data, error } = await sb.from("products").select(columns).range(f, f + 999);
      if (error) {
        if (columns === CATALOG_COLUMNS && /pure_seoul_id/.test(String((error as { message?: string }).message ?? ""))) {
          columns = CATALOG_COLUMNS_NO_PSID;
          continue; // retry this page without the optional column
        }
        return { ...base, error: "تعذّرت قراءة الكتالوج." };
      }
      catalog.push(...((data ?? []) as unknown as PsCatalogRow[]));
      if ((data ?? []).length < 1000) break;
    }

    const verdicts = computePureSoulVerdicts(rows, catalog);
    // Scoped mode: keep ONLY the target product's verdict (re-validated against
    // the server-computed catalog); everything else is neither built nor saved.
    let selected = verdicts;
    if (scopedId !== "") {
      const one = pickVerdictForProduct(verdicts, scopedId);
      if (!one) return { ...base, error: "المنتج غير موجود في الكتالوج." };
      selected = [one];
    }
    const capturedAt = new Date().toISOString();
    const inputs = verdictsToSnapshotInputs(selected, capturedAt);

    const store = new SupabaseSnapshotStore(sb as never);
    const result = await captureSnapshots(store, inputs);

    revalidatePath("/v2/operations");
    return {
      ok: true,
      total: inputs.length,
      created: result.created,
      changed: result.changed,
      unchanged: result.unchanged,
      events: result.events.length,
      capturedAt,
    };
  } catch {
    // Includes the case where the migration hasn't been applied yet (table
    // missing) — the dashboard simply stays "Unknown" for PureSoul.
    return { ...base, error: "تعذّر حفظ لقطات PureSoul حاليًا." };
  }
}
