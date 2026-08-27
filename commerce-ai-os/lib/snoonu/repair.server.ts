// SNOONU SCOPED REPAIR — server adapter (SERVER-ONLY; actions gate to OWNER).
//
// A deliberately separate, minimal write path for the five owner-authorized
// operations. It NEVER calls the sync apply path and has no reachable code
// that writes products (content, price, stock_status, sku, barcode, category,
// lifecycle) or creates anything: the only mutation is an UPDATE on
// `external_channel_listings` rows named by the freshly rebuilt plan.

import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import { SNOONU_STOREFRONT_KEY } from "./sync.ts";
import {
  planSnoonuRepair,
  SNOONU_REPAIR_SCOPE,
  type SnoonuRepairLiveProduct,
  type SnoonuRepairPlanResult,
} from "./repair.ts";

/** READ-ONLY live state for exactly the authorized SKUs. */
export async function loadSnoonuRepairState(): Promise<SnoonuRepairLiveProduct[] | null> {
  const admin = createAdminClient();
  const skus = SNOONU_REPAIR_SCOPE.map((s) => s.sku);
  const products = await admin.from("products").select("id, sku, lifecycle_state, platform_status").in("sku", skus);
  if (products.error) return null;
  const rows = (products.data ?? []) as Record<string, unknown>[];
  const ids = rows.map((r) => String(r.id));
  const listings = ids.length
    ? await admin
        .from("external_channel_listings")
        .select("id, product_id, external_product_id, mapping_status, variant_id, variant_sku")
        .eq("storefront_key", SNOONU_STOREFRONT_KEY)
        .in("product_id", ids)
    : { data: [], error: null };
  if (listings.error) return null;
  const byProduct = new Map<string, SnoonuRepairLiveProduct["listings"]>();
  for (const l of (listings.data ?? []) as Record<string, unknown>[]) {
    const pid = String(l.product_id);
    byProduct.set(pid, [
      ...(byProduct.get(pid) ?? []),
      {
        id: String(l.id),
        externalId: String(l.external_product_id ?? ""),
        mappingStatus: String(l.mapping_status ?? ""),
        variantGrain: l.variant_id !== null || (typeof l.variant_sku === "string" && l.variant_sku !== ""),
      },
    ]);
  }
  return rows.map((r) => ({
    sku: String(r.sku),
    productId: String(r.id),
    lifecycleState: (typeof r.lifecycle_state === "string" && r.lifecycle_state !== ""
      ? r.lifecycle_state
      : r.platform_status === "Active" ? "ACTIVE" : "DRAFT"),
    listings: byProduct.get(String(r.id)) ?? [],
  }));
}

/** READ-ONLY preview of the authorized repairs against live production state. */
export async function previewSnoonuRepair(): Promise<SnoonuRepairPlanResult | null> {
  const live = await loadSnoonuRepairState();
  if (!live) return null;
  return planSnoonuRepair(live);
}

export interface SnoonuRepairApplyRow {
  sku: string;
  spi: string;
  outcome: "repaired" | "already_repaired" | "blocked" | "failed";
  listingId: string | null;
  before: { externalId: string | null; mappingStatus: string | null };
  after: { externalId: string | null; mappingStatus: string | null };
  reason: string | null;
}

export interface SnoonuRepairApplyResult {
  applied: true;
  rows: SnoonuRepairApplyRow[];
  repaired: number;
  blocked: number;
  auditRecorded: boolean;
}

export type SnoonuRepairError = "state_failed" | "plan_changed" | "nothing_eligible";

/**
 * Execute the authorized repairs. The plan is REBUILT from fresh production
 * state and must fingerprint-match the preview the owner confirmed; anything
 * that drifted is refused. Only listing rows are written.
 */
export async function applySnoonuRepair(input: { expectedFingerprint: string; actor: string }):
  Promise<{ ok: true; value: SnoonuRepairApplyResult } | { ok: false; error: SnoonuRepairError }> {
  const live = await loadSnoonuRepairState();
  if (!live) return { ok: false, error: "state_failed" };
  const plan = planSnoonuRepair(live);
  if (plan.fingerprint !== input.expectedFingerprint) return { ok: false, error: "plan_changed" };
  if (plan.eligible === 0) return { ok: false, error: "nothing_eligible" };

  const admin = createAdminClient();
  const appliedAt = new Date().toISOString();
  const rows: SnoonuRepairApplyRow[] = [];

  for (const r of plan.rows) {
    const before = { externalId: r.beforeExternalId, mappingStatus: r.beforeMappingStatus };
    if (r.status !== "eligible") {
      rows.push({ sku: r.sku, spi: r.spi, outcome: r.status === "already_repaired" ? "already_repaired" : "blocked",
        listingId: r.listingId, before, after: before, reason: r.reason });
      continue;
    }
    // the ONLY write in this module: one listing row, addressed by its id AND
    // its expected current values, so a concurrent change cannot be clobbered.
    const res = await admin
      .from("external_channel_listings")
      .update(
        r.type === "RECONCILE_PLACEHOLDER"
          ? { external_product_id: r.afterExternalId, identity_type: "snoonu_spi", mapping_status: "active", updated_at: appliedAt }
          : { mapping_status: "archived", updated_at: appliedAt },
      )
      .eq("id", r.listingId as string)
      .eq("storefront_key", SNOONU_STOREFRONT_KEY)
      .eq("external_product_id", r.beforeExternalId as string)
      .eq("mapping_status", r.beforeMappingStatus as string)
      .select("id");
    const changed = (res.data ?? []).length;
    rows.push({
      sku: r.sku,
      spi: r.spi,
      outcome: res.error || changed !== 1 ? "failed" : "repaired",
      listingId: r.listingId,
      before,
      after: res.error || changed !== 1 ? before : { externalId: r.afterExternalId, mappingStatus: r.afterMappingStatus },
      reason: res.error ? "تعذّر تحديث صف الربط" : changed !== 1 ? "تغيّر صف الربط أثناء التنفيذ" : null,
    });
  }

  // durable audit — the EXISTING snoonu audit table, marked as a REPAIR run.
  let auditRecorded = false;
  try {
    const { error } = await admin.from("snoonu_sync_audits").insert({
      source_file: "SCOPED REPAIR (no workbook)",
      applied_at: appliedAt,
      actor: input.actor,
      import_mode: "REPAIR",
      counts: { eligible: plan.eligible, blocked: plan.blocked, alreadyRepaired: plan.alreadyRepaired,
        repaired: rows.filter((x) => x.outcome === "repaired").length },
      changes: { repairs: rows },
      fingerprint: plan.fingerprint,
    });
    auditRecorded = !error;
  } catch {
    auditRecorded = false;
  }

  return {
    ok: true,
    value: {
      applied: true,
      rows,
      repaired: rows.filter((x) => x.outcome === "repaired").length,
      blocked: rows.filter((x) => x.outcome === "blocked" || x.outcome === "failed").length,
      auditRecorded,
    },
  };
}
