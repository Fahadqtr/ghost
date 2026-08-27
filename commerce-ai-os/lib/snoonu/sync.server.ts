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
  selectSnoonuRepairPlan,
  pendingSkuForSpi,
  availabilityToStockStatus,
  SNOONU_STOREFRONT_KEY,
  type SnoonuImportMode,
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

/** READ-ONLY preview: parse → plan (mode chosen EXPLICITLY by the caller). */
export async function previewSnoonuSyncPlan(
  mode: SnoonuImportMode,
  rows: readonly SnoonuSyncRow[],
  emptySpiRows: readonly number[],
): Promise<SnoonuSyncPlan | null> {
  const ctx = await loadSnoonuSyncContext();
  if (!ctx) return null;
  return planSnoonuSync({ mode, rows, emptySpiRows, canonical: ctx.canonical, listings: ctx.listings });
}

/**
 * READ-ONLY repair preview: re-plan the workbook against LIVE data and keep
 * only the operations still outstanding (SPI reconciliations + Snoonu
 * removals). Anything that already succeeded disappears on its own, so this
 * is scoped to the failed rows without storing or trusting a failure list.
 */
export async function previewSnoonuRepairPlan(
  mode: SnoonuImportMode,
  rows: readonly SnoonuSyncRow[],
  emptySpiRows: readonly number[],
): Promise<{ plan: SnoonuSyncPlan; repair: ReturnType<typeof selectSnoonuRepairPlan> } | null> {
  const plan = await previewSnoonuSyncPlan(mode, rows, emptySpiRows);
  if (!plan) return null;
  return { plan, repair: selectSnoonuRepairPlan(plan) };
}

export interface SnoonuApplyRowResult {
  spi: string;
  action: "updated" | "availability" | "created" | "reconciled" | "removed" | "failed";
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
  /** verified server-side: the plan is REBUILT in this mode — client
   *  classifications are never trusted, and FULL removal semantics are
   *  unreachable from a PARTIAL request (planner + hard guard below). */
  mode: SnoonuImportMode;
  rows: readonly SnoonuSyncRow[];
  emptySpiRows: readonly number[];
  expectedFingerprint: string;
  /** SPIs whose PRICE_REVIEW_ZERO the owner EXPLICITLY resolved as
   *  «اعتماد السعر صفر». Validated against the rebuilt plan's review list —
   *  a zero price can never be written any other way. */
  zeroPriceOverrides: readonly string[];
  sourceFileName: string;
  actor: string;
}): Promise<{ ok: true; value: SnoonuApplyResult } | { ok: false; error: SnoonuApplyError }> {
  const ctx = await loadSnoonuSyncContext();
  if (!ctx) return { ok: false, error: "context_failed" };
  const plan = planSnoonuSync({ mode: input.mode, rows: input.rows, emptySpiRows: input.emptySpiRows, canonical: ctx.canonical, listings: ctx.listings });
  if (plan.applyBlocked) return { ok: false, error: "apply_blocked" };
  if (plan.fingerprint !== input.expectedFingerprint) return { ok: false, error: "plan_changed" };
  // HARD SERVER-SIDE INVARIANT: absence-based removal exists ONLY in FULL
  // mode. The planner already guarantees this structurally; a non-empty
  // removal set outside FULL mode is treated as corruption and fails closed.
  if (input.mode !== "FULL" && plan.removals.length > 0) return { ok: false, error: "context_failed" };

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
    const fresh = ids.splice(0);
    if (fresh.length > 0) await writeProductAvailability(admin as unknown as AvailabilityWriteClient, fresh, state as AvailabilityState);
  }

  // ── PRICE_REVIEW_ZERO — only EXPLICIT per-row owner resolutions write 0 ──
  const reviewBySpi = new Map(plan.zeroPriceReviews.map((z) => [z.spi.toLowerCase(), z]));
  for (const spi of new Set(input.zeroPriceOverrides.map((s) => s.toLowerCase()))) {
    const review = reviewBySpi.get(spi);
    if (!review) continue; // never write a zero the plan did not flag
    const { error } = await admin.from("products").update({ price: 0 }).eq("id", review.productId);
    results.push({
      spi: review.spi,
      action: error ? "failed" : "updated",
      productId: review.productId,
      message: error ? "تعذّر اعتماد السعر صفر" : "اعتماد السعر صفر (قرار صريح من المالك)",
    });
  }

  // ── RECONCILE_EXISTING — link the SPI to the existing product, NOTHING else ──
  // The rebuilt plan (fresh canonical + listings, exact SKU+barcode ownership,
  // no-existing-active-mapping rule) IS the server-side revalidation — no
  // client-provided target id is ever trusted. The product row keeps its id,
  // SKU and barcode untouched; only the certified external-channel listing is
  // written, then the row's safe field diffs flow through the normal path.
  for (const rec of plan.reconciles) {
    // IDENTITY UPGRADE — the listing table enforces ONE product-grain mapping
    // per (storefront, product), so inserting a second row alongside a legacy
    // placeholder always fails. When exactly one placeholder exists we upgrade
    // THAT ROW IN PLACE (same row id, same product, same SKU/barcode); only a
    // product with no snoonu mapping at all gets a fresh insert. The plan
    // already failed closed on >1 placeholder or any active SPI-shaped row.
    let linkErr: { message: string } | null = null;
    if (rec.placeholderMappings.length === 1) {
      const upgraded = await admin
        .from("external_channel_listings")
        .update({
          external_product_id: rec.spi,
          identity_type: "snoonu_spi",
          mapping_status: "active",
          exported_sku: rec.importedSku,
          exported_barcode: rec.importedBarcode,
          updated_at: appliedAt,
        })
        .eq("storefront_key", SNOONU_STOREFRONT_KEY)
        .eq("product_id", rec.productId)
        .eq("mapping_status", "active")
        .eq("external_product_id", rec.placeholderMappings[0])
        .select("id");
      linkErr = upgraded.error as { message: string } | null;
      if (!linkErr && (upgraded.data ?? []).length !== 1) {
        // the placeholder moved between preview and apply — fail closed.
        linkErr = { message: "placeholder drift" };
      }
    } else if (rec.placeholderMappings.length === 0) {
      const inserted = await admin.from("external_channel_listings").insert({
        product_id: rec.productId,
        channel_key: "snoonu",
        storefront_key: SNOONU_STOREFRONT_KEY,
        external_product_id: rec.spi,
        identity_type: "snoonu_spi",
        mapping_status: "active",
        exported_sku: rec.importedSku,
        exported_barcode: rec.importedBarcode,
      });
      linkErr = inserted.error as { message: string } | null;
    } else {
      linkErr = { message: "ambiguous placeholder set" };
    }
    if (linkErr) {
      results.push({ spi: rec.spi, action: "failed", productId: rec.productId, message: "تعذّر ربط SPI بالمنتج الموجود" });
      continue;
    }
    const payload: Record<string, unknown> = {};
    for (const c of rec.changes) {
      if (c.field === "availability") {
        (c.to === "In Stock" ? toAvailable : toUnavailable).push(rec.productId);
        continue;
      }
      payload[c.field] = c.field === "price" ? Number(c.to) : c.to;
    }
    if (Object.keys(payload).length > 0) {
      await admin.from("products").update(payload).eq("id", rec.productId);
    }
    results.push({ spi: rec.spi, action: "reconciled", productId: rec.productId, message: null });
  }
  for (const [ids, state] of [
    [toAvailable, "In Stock"],
    [toUnavailable, "Out of Stock"],
  ] as const) {
    const fresh = ids.splice(0);
    if (fresh.length > 0) await writeProductAvailability(admin as unknown as AvailabilityWriteClient, fresh, state as AvailabilityState);
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

  // ── REMOVED FROM SNOONU — FULL mode ONLY (hard invariant above) — the
  //    CANONICAL lifecycle boundary (STOPPED) + listing archive. NEVER DELETE.
  for (const r of plan.mode === "FULL" ? plan.removals : []) {
    // "REMOVED FROM SNOONU" means STOP THE SNOONU LISTING. Only an ACTIVE
    // product also takes the certified ACTIVE→STOPPED lifecycle transition;
    // a DRAFT product has no legal DRAFT→STOPPED transition (and needs none),
    // and a STOPPED one is already there — both simply lose the listing.
    let lifecycleOk = true;
    let behavior: "stop_and_archive" | "archive_listing_only" = "archive_listing_only";
    if (r.lifecycleState === "ACTIVE") {
      const transition = await transitionProductLifecycle({
        productId: r.productId,
        targetState: "STOPPED",
        reason: `REMOVED FROM SNOONU — SPI ${r.spi} absent from ${input.sourceFileName}`,
        expectedFromState: "ACTIVE",
      });
      lifecycleOk = transition.outcome === "UPDATED" || transition.outcome === "UNCHANGED";
      behavior = "stop_and_archive";
    }
    if (!lifecycleOk) {
      results.push({ spi: r.spi, action: "failed", productId: r.productId, message: "تعذّر إيقاف المنتج عبر مسار دورة الحياة" });
      continue;
    }
    const { error: archiveErr } = await admin
      .from("external_channel_listings")
      .update({ mapping_status: "archived", updated_at: appliedAt })
      .eq("storefront_key", SNOONU_STOREFRONT_KEY)
      .eq("product_id", r.productId)
      .eq("mapping_status", "active");
    results.push({
      spi: r.spi,
      action: archiveErr ? "failed" : "removed",
      productId: r.productId,
      message: archiveErr
        ? "تعذّر أرشفة ربط سنونو"
        : behavior === "stop_and_archive"
          ? "أُوقف المنتج (ACTIVE → STOPPED) وأُرشف ربط سنونو"
          : `أُرشف ربط سنونو فقط — المنتج ${r.lifecycleState} ولم تتغيّر دورة حياته`,
    });
  }

  // ── durable audit (defensive) ──
  let auditRecorded = false;
  try {
    const { error } = await admin.from("snoonu_sync_audits").insert({
      source_file: input.sourceFileName,
      applied_at: appliedAt,
      actor: input.actor,
      import_mode: plan.mode,
      counts: plan.counts,
      changes: {
        matched: plan.matched.map((m) => ({ spi: m.spi, productId: m.productId, changes: m.changes })),
        created: plan.news.map((n) => ({ spi: n.spi, klass: n.klass, sku: n.sku, barcode: n.barcode })),
        removed: plan.removals.map((r) => ({ spi: r.spi, productId: r.productId, sku: r.productSku })),
        reconciled: plan.reconciles.map((x) => ({ spi: x.spi, canonical_product_id: x.productId, sku: x.canonicalSku, barcode: x.canonicalBarcode })),
        reconciled_existing_count: plan.reconciles.length,
        zeroPriceReviews: plan.zeroPriceReviews.map((z) => ({ spi: z.spi, sku: z.productSku, kept: !input.zeroPriceOverrides.some((o) => o.toLowerCase() === z.spi.toLowerCase()) })),
        identityCollisions: plan.identityCollisions.map((i) => ({ spi: i.spi, identifier: i.identifier, collidingSku: i.colliding.sku })),
      },
      fingerprint: plan.fingerprint,
    });
    auditRecorded = !error;
  } catch {
    auditRecorded = false;
  }

  return { ok: true, value: { applied: true, results, auditRecorded, counts: plan.counts } };
}
