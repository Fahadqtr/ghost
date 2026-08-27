// SNOONU TWO-SOURCE SYNC — server adapter. READ-ONLY.
//
// Loads the live catalog once and hands it, together with the parsed rows of
// whichever workbooks the owner uploaded, to the pure combined planner. There
// is no write path in this module at all: the combined preview exists to be
// looked at, and the existing FULL/PARTIAL apply remains the only writer.

import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import { writeProductAvailability, type AvailabilityWriteClient } from "@/lib/availability/engine";
import { loadSnoonuSyncContext } from "./sync.server.ts";
import type { SnoonuSyncRow } from "./sync.ts";
import {
  planSnoonuCombined,
  selectSnoonuOperationalApply,
  type SnoonuCombinedPlan,
  type SnoonuOperationalCounts,
} from "./two-source.ts";

export interface SnoonuSourceInput {
  rows: readonly SnoonuSyncRow[];
  emptySpiRows: readonly number[];
}

/** READ-ONLY combined preview. Returns null only when the catalog read fails. */
export async function previewSnoonuCombined(input: {
  full: SnoonuSourceInput | null;
  bulk: SnoonuSourceInput | null;
}): Promise<SnoonuCombinedPlan | null> {
  if (!input.full && !input.bulk) return null;
  const ctx = await loadSnoonuSyncContext();
  if (!ctx) return null;
  return planSnoonuCombined({
    full: input.full,
    bulk: input.bulk,
    canonical: ctx.canonical,
    listings: ctx.listings,
  });
}

// ── operational apply (OWNER-confirmed; BULK-authoritative) ──────────────────
//
// WRITE BOUNDARY — this is the complete list, and nothing else is reachable:
//   1. products.update({ price?, sku?, barcode? })  — operational identifiers
//   2. writeProductAvailability(...)                — stock, via the certified
//                                                     Availability Engine only
//   3. snoonu_sync_audits.insert(...)               — the durable audit row
//
// Deliberately ABSENT: createProductCore (no creation), transitionProductLifecycle
// and any lifecycle_state write (no stop/restore), any external_channel_listings
// write (no archive, no removal, no identity change), and any name/description/
// category column (FULL content never travels this path).

export interface SnoonuOperationalApplyRow {
  spi: string;
  productId: string;
  productSku: string;
  action: "updated" | "availability" | "failed";
  message: string | null;
}

export interface SnoonuOperationalApplyResult {
  applied: true;
  rows: SnoonuOperationalApplyRow[];
  counts: SnoonuOperationalCounts;
  auditRecorded: boolean;
}

export type SnoonuOperationalApplyError =
  | "context_failed" | "plan_changed" | "nothing_eligible" | "apply_blocked" | "removal_guard";

/**
 * Execute the operational half of the two-source model.
 *
 * The plan is REBUILT here from fresh catalog state and the rows the owner
 * uploaded; the client's classification is never trusted. It must fingerprint-
 * match the preview the owner confirmed, or the run is refused outright.
 */
export async function applySnoonuOperational(input: {
  full: SnoonuSourceInput | null;
  bulk: SnoonuSourceInput;
  expectedFingerprint: string;
  /** SPIs whose zero price the owner EXPLICITLY approved; anything else stays blocked. */
  zeroPriceOverrides: readonly string[];
  sourceFileName: string;
  actor: string;
}): Promise<{ ok: true; value: SnoonuOperationalApplyResult } | { ok: false; error: SnoonuOperationalApplyError }> {
  const ctx = await loadSnoonuSyncContext();
  if (!ctx) return { ok: false, error: "context_failed" };

  // server-side rebuild — the authority, not the client's plan.
  const combined = planSnoonuCombined({
    full: input.full, bulk: input.bulk, canonical: ctx.canonical, listings: ctx.listings,
  });
  const plan = selectSnoonuOperationalApply(combined);
  if (plan.applyBlocked) return { ok: false, error: "apply_blocked" };
  if (plan.fingerprint !== input.expectedFingerprint) return { ok: false, error: "plan_changed" };
  // BULK is planned PARTIAL, so this is structurally unreachable — asserted
  // anyway so a future planner change fails closed instead of removing things.
  if (plan.counts.removals !== 0 || (combined.bulk?.removals.length ?? 0) !== 0) {
    return { ok: false, error: "removal_guard" };
  }
  if (plan.rows.length === 0) return { ok: false, error: "nothing_eligible" };

  const admin = createAdminClient();
  const appliedAt = new Date().toISOString();
  const rows: SnoonuOperationalApplyRow[] = [];
  const toAvailable: string[] = [];
  const toUnavailable: string[] = [];

  for (const r of plan.rows) {
    // price / sku / barcode — the only product columns this path may set.
    const payload: Record<string, unknown> = {};
    if (r.price !== null) payload.price = r.price;
    if (r.sku !== null) payload.sku = r.sku;
    if (r.barcode !== null) payload.barcode = r.barcode;
    if (Object.keys(payload).length > 0) {
      const { error } = await admin.from("products").update(payload).eq("id", r.productId);
      rows.push({ spi: r.spi, productId: r.productId, productSku: r.productSku,
        action: error ? "failed" : "updated", message: error ? "تعذّر تحديث الحقول التشغيلية" : null });
    }
    if (r.stockTo !== null) {
      (r.stockTo === "In Stock" ? toAvailable : toUnavailable).push(r.productId);
      rows.push({ spi: r.spi, productId: r.productId, productSku: r.productSku, action: "availability", message: null });
    }
  }

  // stock goes EXCLUSIVELY through the certified Availability Engine.
  for (const [ids, state] of [[toAvailable, "In Stock"], [toUnavailable, "Out of Stock"]] as const) {
    if (ids.length > 0) await writeProductAvailability(admin as unknown as AvailabilityWriteClient, ids, state);
  }

  // PRICE_REVIEW_ZERO — only an EXPLICIT per-row owner approval writes a zero,
  // and only for a row the rebuilt plan itself flagged.
  const reviewBySpi = new Map(plan.blockedZeroPrice.map((z) => [z.spi.toLowerCase(), z]));
  for (const spi of new Set(input.zeroPriceOverrides.map((s) => s.toLowerCase()))) {
    const review = reviewBySpi.get(spi);
    if (!review) continue;
    const { error } = await admin.from("products").update({ price: 0 }).eq("id", review.productId);
    rows.push({ spi: review.spi, productId: review.productId, productSku: review.productSku,
      action: error ? "failed" : "updated", message: error ? "تعذّر اعتماد السعر صفر" : "اعتماد السعر صفر (قرار صريح من المالك)" });
  }

  let auditRecorded = false;
  try {
    const { error } = await admin.from("snoonu_sync_audits").insert({
      source_file: `COMBINED OPERATIONAL (BULK): ${input.sourceFileName}`,
      applied_at: appliedAt,
      actor: input.actor,
      // no removals, only rows present ⇒ PARTIAL semantics.
      import_mode: "PARTIAL",
      counts: plan.counts,
      changes: {
        operational: plan.rows.map((r) => ({ spi: r.spi, productId: r.productId,
          stockTo: r.stockTo, price: r.price, sku: r.sku, barcode: r.barcode })),
        blockedZeroPrice: plan.blockedZeroPrice.map((z) => ({ spi: z.spi, sku: z.productSku,
          kept: !input.zeroPriceOverrides.some((o) => o.toLowerCase() === z.spi.toLowerCase()) })),
        blockedIdentityCollisions: plan.blockedIdentityCollisions.map((i) => ({ spi: i.spi,
          identifier: i.identifier, collidingSku: i.colliding.sku })),
        removals: [],
        contentApplied: false,
      },
      fingerprint: plan.fingerprint,
    });
    auditRecorded = !error;
  } catch {
    auditRecorded = false;
  }

  return { ok: true, value: { applied: true, rows, counts: plan.counts, auditRecorded } };
}
