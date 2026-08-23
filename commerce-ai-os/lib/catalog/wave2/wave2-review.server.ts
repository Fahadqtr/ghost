// CATALOG.GOLIVE.3A — Wave 2 Bulk Review read model (SERVER-ONLY, READ-ONLY).
//
// Loads the fixed Wave 2 batch (WAVE2_BATCH_SKUS) plus any other DRAFT product
// that is still missing a category or availability, projects each row through
// the CERTIFIED operations projection (mapProductRow) and readiness engine
// (computeProductReadiness), and decorates it with the audited review seeds.
//
// This module performs ZERO writes: select-only. Every mutation lives behind
// the certified boundaries reused by the wave2 actions file — never here.

import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import { computeProductReadiness } from "@/lib/operations/readiness/readiness";
import { mapProductRow } from "@/lib/operations/dashboard-view";
import {
  WAVE2_BATCH_SKUS,
  decorateWave2Row,
  wave2Progress,
  type Wave2Progress,
  type Wave2Row,
  type Wave2RowView,
} from "./wave2-plan";

const COLUMNS =
  "id, sku, barcode, name_ar, name_en, description_ar, description_en, brand_id, main_category, price, image_url, approval, platform_status, lifecycle_state, stock_status";

export interface Wave2ReviewModel {
  rows: Wave2RowView[];
  progress: Wave2Progress;
}

const s = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v : null);

/** Read the Wave 2 queue. Throws only on a read failure the page turns into one fixed message. */
export async function loadWave2Review(): Promise<Wave2ReviewModel> {
  const admin = createAdminClient();

  // (1) The fixed audited batch, by SKU (chunked; keeps activated rows visible
  //     so the progress header can show "activated x/62").
  const rowsBySku: Record<string, unknown>[] = [];
  const skus = [...WAVE2_BATCH_SKUS];
  for (let i = 0; i < skus.length; i += 100) {
    const { data, error } = await admin
      .from("products")
      .select(COLUMNS)
      .in("sku", skus.slice(i, i + 100));
    if (error) throw new Error("wave2 read failed");
    rowsBySku.push(...((data ?? []) as Record<string, unknown>[]));
  }

  // (2) Any OTHER DRAFT product still missing category or availability — new
  //     intake arriving after the audit shows up instead of being missed.
  const { data: extraRows, error: extraErr } = await admin
    .from("products")
    .select(COLUMNS)
    .eq("lifecycle_state", "DRAFT")
    .or("main_category.is.null,stock_status.is.null");
  if (extraErr) throw new Error("wave2 read failed");

  const byId = new Map<string, Record<string, unknown>>();
  for (const r of [...rowsBySku, ...((extraRows ?? []) as Record<string, unknown>[])]) {
    const id = typeof r.id === "string" ? r.id : "";
    if (id) byId.set(id, r);
  }

  // (3) Variant counts in one grouped pass (bounded: the queue is small).
  const ids = [...byId.keys()];
  const counts = new Map<string, number>();
  for (let i = 0; i < ids.length; i += 100) {
    const { data, error } = await admin
      .from("product_variants")
      .select("id, parent_product_id")
      .in("parent_product_id", ids.slice(i, i + 100));
    if (error) throw new Error("wave2 read failed");
    for (const v of (data ?? []) as { parent_product_id?: unknown }[]) {
      const pid = typeof v.parent_product_id === "string" ? v.parent_product_id : "";
      if (pid) counts.set(pid, (counts.get(pid) ?? 0) + 1);
    }
  }

  // (4) Certified projection + readiness, then the pure review decoration.
  const rows: Wave2RowView[] = [];
  for (const raw of byId.values()) {
    const ops = mapProductRow(raw, counts.get(String(raw.id)) ?? 0);
    const readiness = computeProductReadiness(ops);
    const row: Wave2Row = {
      id: ops.id,
      sku: ops.sku ?? "",
      nameEn: ops.nameEn,
      nameAr: ops.nameAr,
      imageUrl: ops.imageUrl,
      category: ops.category,
      availability: s(raw.stock_status),
      approval: ops.approval,
      lifecycle: ops.lifecycleState ?? null,
      readinessStatus: readiness.status,
      readyToPublish: readiness.readyToPublish,
      variantCount: ops.variantCount,
      price: ops.price,
    };
    rows.push(decorateWave2Row(row));
  }

  rows.sort((a, b) => a.sku.localeCompare(b.sku, undefined, { numeric: true }));
  return { rows, progress: wave2Progress(rows) };
}
