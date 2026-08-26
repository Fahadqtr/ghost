// SNOONU CATALOG SYNC — server adapter (SERVER-ONLY; the actions gate apply
// to the OWNER).
//
// preview: load canonical products + the snoonu:malikas listings (READ-ONLY)
//          and hand everything to the PURE planner — no write can occur here
//          by construction.
// apply:   executes ONLY a plan whose fingerprint matches what the owner saw:
//          • matched updates — owner-approved fields via one products update
//            per product; availability exclusively through the certified
//            Availability Engine (writeProductAvailability);
//          • NEW products — through the CANONICAL create path
//            (createProductCore + RPC-protected inventory initializer, seed 0)
//            with the explicit PENDING sentinel SKU when Snoonu supplied none
//            (values are never invented), then the active snoonu:malikas SPI
//            listing; created as DRAFT/unapproved (channel-invisible);
//          • REMOVED FROM SNOONU — lifecycle_state → STOPPED + the listing
//            archived. NEVER a destructive DELETE: the product row, identity,
//            orders and audit history all remain;
//          • a durable audit row (snoonu_sync_audits) — defensive: an
//            unmigrated table degrades to auditRecorded:false, never a lie.

import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import { transitionProductLifecycle } from "@/lib/lifecycle/transition.server";
import { writeProductAvailability, type AvailabilityWriteClient } from "@/lib/availability/engine";
import type { AvailabilityState } from "@/lib/availability/read";
import { createProductCore } from "@/lib/products/product-create";
import { makeInventoryInitializer } from "@/lib/products/inventory-initializer";
import { toProductRow, type ProductInput } from "@/lib/products/product-save";
import {
  planSnoonuSync,
  pendingSkuForSpi,
  availabilityToStockStatus,
  SNOONU_STOREFRONT_KEY,
  type SnoonuSyncRow,
  type SnoonuSyncPlan,
  type SnoonuCanonicalRecord,
  type SnoonuListingRecord,
} from "./sync.ts";

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : v == null ? null : Number(v) || null);
const s = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

/** READ-ONLY canonical + listing context for the planner. */
export async function loadSnoonuSyncContext(): Promise<{
  canonical: SnoonuCanonicalRecord[];
  listings: SnoonuListingRecord[];
} | null> {
  const admin = createAdminClient();
  const canonical: SnoonuCanonicalRecord[] = [];
  for (let fromIdx = 0; ; fromIdx += 1000) {
    const res = await admin
      .from("products")
      .select("id, sku, barcode, name_en, name_ar, description_en, description_ar, price, stock_status, lifecycle_state, platform_status")
      .order("id", { ascending: true })
      .range(fromIdx, fromIdx + 999);
    if (res.error) return null;
    const page = (res.data ?? []) as Record<string, unknown>[];
    for (const r of page) {
      canonical.push({
        id: String(r.id),
        sku: String(r.sku ?? ""),
        barcode: s(r.barcode),
        nameEn: s(r.name_en),
        nameAr: s(r.name_ar),
        descriptionEn: s(r.description_en),
        descriptionAr: s(r.description_ar),
        price: num(r.price),
        stockStatus: s(r.stock_status),
        lifecycleState: s(r.lifecycle_state) ?? (r.platform_status === "Active" ? "ACTIVE" : "DRAFT"),
      });
    }
    if (page.length < 1000) break;
  }

  const listings: SnoonuListingRecord[] = [];
  for (let fromIdx = 0; ; fromIdx += 1000) {
    const res = await admin
      .from("external_channel_listings")
      .select("product_id, external_product_id, mapping_status, variant_id, variant_sku")
      .eq("storefront_key", SNOONU_STOREFRONT_KEY)
      .order("id", { ascending: true })
      .range(fromIdx, fromIdx + 999);
    if (res.error) return null;
    const page = (res.data ?? []) as Record<string, unknown>[];
    for (const r of page) {
      const externalId = s(r.external_product_id);
      if (!externalId) continue;
      listings.push({
        productId: String(r.product_id),
        externalId,
        mappingStatus: String(r.mapping_status ?? ""),
        variantGrain: r.variant_id !== null || s(r.variant_sku) !== null,
      });
    }
    if (page.length < 1000) break;
  }
  return { canonical, listings };
}

/** READ-ONLY preview: parse → plan. */
export async function previewSnoonuSyncPlan(
  rows: readonly SnoonuSyncRow[],
  emptySpiRows: readonly number[],
): Promise<SnoonuSyncPlan | null> {
  const ctx = await loadSnoonuSyncContext();
  if (!ctx) return null;
  return planSnoonuSync({ rows, emptySpiRows, canonical: ctx.canonical, listings: ctx.listings });
}

export interface SnoonuApplyRowResult {
  spi: string;
  action: "updated" | "availability" | "created" | "removed" | "failed";
  productId: string | null;
  message: string | null;
}

export interface SnoonuApplyResult {
  applied: true;
  results: SnoonuApplyRowResult[];
  auditRecorded: boolean;
  counts: SnoonuSyncPlan["counts"];
}

export type SnoonuApplyError = "context_failed" | "plan_changed" | "apply_blocked";

/**
 * Execute a previewed plan. `expectedFingerprint` must equal the freshly
 * recomputed plan's fingerprint — data drift between preview and apply fails
 * closed instead of applying something the owner never saw.
 */
export async function applySnoonuSyncPlan(input: {
  rows: readonly SnoonuSyncRow[];
  emptySpiRows: readonly number[];
  expectedFingerprint: string;
  sourceFileName: string;
  actor: string;
}): Promise<{ ok: true; value: SnoonuApplyResult } | { ok: false; error: SnoonuApplyError }> {
  const ctx = await loadSnoonuSyncContext();
  if (!ctx) return { ok: false, error: "context_failed" };
  const plan = planSnoonuSync({ rows: input.rows, emptySpiRows: input.emptySpiRows, canonical: ctx.canonical, listings: ctx.listings });
  if (plan.applyBlocked) return { ok: false, error: "apply_blocked" };
  if (plan.fingerprint !== input.expectedFingerprint) return { ok: false, error: "plan_changed" };

  const admin = createAdminClient();
  const results: SnoonuApplyRowResult[] = [];
  const appliedAt = new Date().toISOString();

  // ── matched updates (owner-approved fields; availability via the engine) ──
  const toAvailable: string[] = [];
  const toUnavailable: string[] = [];
  for (const m of plan.matched) {
    const payload: Record<string, unknown> = {};
    for (const c of m.changes) {
      if (c.field === "availability") {
        (c.to === "In Stock" ? toAvailable : toUnavailable).push(m.productId);
        continue;
      }
      payload[c.field] = c.field === "price" ? Number(c.to) : c.to;
    }
    if (Object.keys(payload).length > 0) {
      const { error } = await admin.from("products").update(payload).eq("id", m.productId);
      results.push({
        spi: m.spi,
        action: error ? "failed" : "updated",
        productId: m.productId,
        message: error ? "تعذّر تحديث الحقول" : null,
      });
    }
    if (m.changes.some((c) => c.field === "availability")) {
      results.push({ spi: m.spi, action: "availability", productId: m.productId, message: null });
    }
  }
  for (const [ids, state] of [
    [toAvailable, "In Stock"],
    [toUnavailable, "Out of Stock"],
  ] as const) {
    if (ids.length > 0) await writeProductAvailability(admin as unknown as AvailabilityWriteClient, ids, state as AvailabilityState);
  }

  // ── NEW Snoonu products — canonical create path; identifiers never invented ──
  const initialize = makeInventoryInitializer(admin as never);
  for (const n of plan.news) {
    if (n.blocked) {
      results.push({ spi: n.spi, action: "failed", productId: null, message: n.blocked });
      continue;
    }
    const productInput: ProductInput = {
      sku: n.sku ?? pendingSkuForSpi(n.spi),
      barcode: n.barcode ?? "",
      name_en: n.nameEn ?? n.nameAr ?? "",
      name_ar: n.nameAr ?? "",
      brand_id: "",
      main_category: "Uncategorized",
      sub_category: "",
      product_type: "",
      color: "",
      size: "",
      price: n.price === null ? "" : String(n.price),
      discount_price: "",
      cost: "",
      stock_quantity: "",
      stock_status: n.availability === null ? "" : availabilityToStockStatus(n.availability),
      platform_status: "",
      approval: "",
      rejection_reason: "",
      image_filename: "",
      image_url: "",
      description_en: n.descriptionEn ?? "",
      description_ar: n.descriptionAr ?? "",
      keywords_en: "",
      keywords_ar: "",
      notes: `Created from Snoonu sync (SPI ${n.spi})`,
      variants: [],
    };
    const row = await toProductRow(productInput);
    const created = await createProductCore(admin as never, row, [], initialize);
    if (!created.ok) {
      results.push({ spi: n.spi, action: "failed", productId: null, message: `تعذّر الإنشاء (${created.stage})` });
      continue;
    }
    const { error: eclErr } = await admin.from("external_channel_listings").insert({
      product_id: created.productId,
      channel_key: "snoonu",
      storefront_key: SNOONU_STOREFRONT_KEY,
      external_product_id: n.spi,
      identity_type: "snoonu_spi",
      mapping_status: "active",
      exported_sku: n.sku,
      exported_barcode: n.barcode,
    });
    results.push({
      spi: n.spi,
      action: "created",
      productId: created.productId,
      message: eclErr ? "أُنشئ المنتج لكن تعذّر تسجيل ربط SPI — يحتاج مراجعة" : null,
    });
  }

  // ── REMOVED FROM SNOONU — the CANONICAL lifecycle boundary (STOPPED) +
  //    listing archive. NEVER a destructive DELETE.
  for (const r of plan.removals) {
    const transition = await transitionProductLifecycle({
      productId: r.productId,
      targetState: "STOPPED",
      reason: `REMOVED FROM SNOONU — SPI ${r.spi} absent from ${input.sourceFileName}`,
    });
    const ok = transition.outcome === "UPDATED" || transition.outcome === "UNCHANGED";
    if (ok) {
      await admin
        .from("external_channel_listings")
        .update({ mapping_status: "archived", updated_at: appliedAt })
        .eq("storefront_key", SNOONU_STOREFRONT_KEY)
        .eq("product_id", r.productId)
        .eq("mapping_status", "active");
    }
    results.push({
      spi: r.spi,
      action: ok ? "removed" : "failed",
      productId: r.productId,
      message: ok ? null : "تعذّر إيقاف المنتج عبر مسار دورة الحياة",
    });
  }

  // ── durable audit (defensive) ──
  let auditRecorded = false;
  try {
    const { error } = await admin.from("snoonu_sync_audits").insert({
      source_file: input.sourceFileName,
      applied_at: appliedAt,
      actor: input.actor,
      counts: plan.counts,
      changes: {
        matched: plan.matched.map((m) => ({ spi: m.spi, productId: m.productId, changes: m.changes })),
        created: plan.news.map((n) => ({ spi: n.spi, klass: n.klass, sku: n.sku, barcode: n.barcode })),
        removed: plan.removals.map((r) => ({ spi: r.spi, productId: r.productId, sku: r.productSku })),
      },
      fingerprint: plan.fingerprint,
    });
    auditRecorded = !error;
  } catch {
    auditRecorded = false;
  }

  return { ok: true, value: { applied: true, results, auditRecorded, counts: plan.counts } };
}
