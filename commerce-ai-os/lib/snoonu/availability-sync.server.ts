// SNOONU AVAILABILITY SYNC — server adapter.
//
// WRITE BOUNDARY — this module's ENTIRE write surface:
//   1. writeProductAvailability(...)   — the certified Availability Engine
//   2. snoonu_sync_audits.insert(...)  — the durable audit row
//
// There is no products.update() here at all: price, SKU, barcode, names,
// descriptions and categories are simply not reachable from this path. Nor is
// any lifecycle transition, any external_channel_listings write, any product
// creation, or any deletion. Availability is the only thing this page writes.

import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import { writeProductAvailability, type AvailabilityWriteClient } from "@/lib/availability/engine";
import { loadSnoonuSyncContext } from "./sync.server.ts";
import type { SnoonuSyncRow } from "./sync.ts";
import {
  planSnoonuAvailability,
  selectAvailabilityWrites,
  AVAILABLE,
  UNAVAILABLE,
  type SnoonuAvailabilityCounts,
  type SnoonuAvailabilityPlan,
} from "./availability-sync.ts";

export interface SnoonuAvailabilityInput {
  full: readonly SnoonuSyncRow[];
  bulk: readonly SnoonuSyncRow[];
}

/** READ-ONLY preview. Returns null only when the catalog read fails. */
export async function previewSnoonuAvailability(
  input: SnoonuAvailabilityInput,
): Promise<SnoonuAvailabilityPlan | null> {
  const ctx = await loadSnoonuSyncContext();
  if (!ctx) return null;
  return planSnoonuAvailability({ ...input, canonical: ctx.canonical, listings: ctx.listings });
}

export interface SnoonuAvailabilityApplyResult {
  applied: true;
  movedToOut: number;
  movedToIn: number;
  unchanged: number;
  blocked: number;
  counts: SnoonuAvailabilityCounts;
  auditRecorded: boolean;
}

export type SnoonuAvailabilityApplyError =
  | "context_failed" | "plan_changed" | "nothing_eligible" | "apply_blocked";

/**
 * Apply availability, and ONLY availability.
 *
 * The plan is rebuilt from fresh catalog state before anything is written —
 * the client's plan is never trusted — and must fingerprint-match the preview
 * the owner confirmed, or the run is refused.
 */
export async function applySnoonuAvailability(input: {
  full: readonly SnoonuSyncRow[];
  bulk: readonly SnoonuSyncRow[];
  expectedFingerprint: string;
  sourceFileName: string;
  actor: string;
}): Promise<{ ok: true; value: SnoonuAvailabilityApplyResult } | { ok: false; error: SnoonuAvailabilityApplyError }> {
  const ctx = await loadSnoonuSyncContext();
  if (!ctx) return { ok: false, error: "context_failed" };

  const plan = planSnoonuAvailability({
    full: input.full, bulk: input.bulk, canonical: ctx.canonical, listings: ctx.listings,
  });
  if (plan.applyBlocked) return { ok: false, error: "apply_blocked" };
  if (plan.fingerprint !== input.expectedFingerprint) return { ok: false, error: "plan_changed" };

  const { toUnavailable, toAvailable } = selectAvailabilityWrites(plan);
  if (toUnavailable.length === 0 && toAvailable.length === 0) return { ok: false, error: "nothing_eligible" };

  const admin = createAdminClient();
  const client = admin as unknown as AvailabilityWriteClient;
  if (toUnavailable.length > 0) await writeProductAvailability(client, toUnavailable, UNAVAILABLE);
  if (toAvailable.length > 0) await writeProductAvailability(client, toAvailable, AVAILABLE);

  let auditRecorded = false;
  try {
    const { error } = await admin.from("snoonu_sync_audits").insert({
      source_file: `AVAILABILITY (BULK membership): ${input.sourceFileName}`,
      applied_at: new Date().toISOString(),
      actor: input.actor,
      // only rows present are considered and nothing is ever removed.
      import_mode: "PARTIAL",
      counts: plan.counts,
      changes: {
        availability: plan.rows.filter((r) => r.changed)
          .map((r) => ({ spi: r.spi, productId: r.productId, sku: r.productSku, from: r.current, to: r.target })),
        blocked: plan.blocked.map((b) => ({ spi: b.spi, reason: b.reason })),
        removals: [],
        contentApplied: false,
        priceApplied: false,
        identifiersApplied: false,
      },
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
      movedToOut: toUnavailable.length,
      movedToIn: toAvailable.length,
      unchanged: plan.counts.unchanged,
      blocked: plan.counts.blocked,
      counts: plan.counts,
      auditRecorded,
    },
  };
}
