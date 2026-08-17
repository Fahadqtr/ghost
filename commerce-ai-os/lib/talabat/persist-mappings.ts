import "server-only";
import {
  planMappingWrite,
  type TalabatMappingCandidate,
  type ExistingMappingRow,
} from "./export.ts";

// Server-side persistence for Talabat channel_variant_mappings. SERVICE ROLE
// ONLY — the caller passes a service-role client (lib/supabase/admin); this
// module never uses the browser/session client. It upserts one mapping per
// VALID export row, keyed by the durable identity
// (channel_id, master_product_id, master_variant_sku), and NEVER clears an
// existing channel_product_id. Blocked rows are not persisted here (the builder
// only emits candidates for valid rows).
//
// Contract: this returns { inserted, updated, failed } and does not throw, so
// the caller can enforce a FAIL-CLOSED gate — the export file must not download
// unless `failed === 0`. Re-running is idempotent (upsert by identity, updates
// never touch channel_product_id), so a later retry after a partial failure is
// safe. Raw DB errors are never returned to the client.
//
// The pure decision (planMappingWrite) lives in ./export and is unit-tested;
// this file is the thin, injectable I/O wrapper.

/** Minimal shape of the service-role client methods this helper uses. */
export interface MappingWriteClient {
  from(table: "channel_variant_mappings"): {
    select(cols: string): {
      eq(col: string, val: string): {
        eq(col: string, val: string): {
          is(col: string, val: null): { maybeSingle(): Promise<{ data: ExistingMappingRow | null; error: unknown }> };
          eq(col: string, val: string): { maybeSingle(): Promise<{ data: ExistingMappingRow | null; error: unknown }> };
        };
      };
    };
    insert(row: Record<string, unknown>): Promise<{ error: unknown }>;
    update(patch: Record<string, unknown>): { eq(col: string, val: string): Promise<{ error: unknown }> };
  };
}

export interface PersistResult {
  inserted: number;
  updated: number;
  failed: number;
}

/**
 * Upsert every candidate. Returns counts only — never throws to the caller, so
 * a persistence hiccup can never break the export download. Raw DB errors are
 * never surfaced.
 */
export async function persistTalabatMappings(
  admin: MappingWriteClient,
  channelId: string,
  candidates: TalabatMappingCandidate[],
  nowIso: string,
): Promise<PersistResult> {
  let inserted = 0;
  let updated = 0;
  let failed = 0;

  for (const candidate of candidates) {
    try {
      const base = admin
        .from("channel_variant_mappings")
        .select("id, channel_product_id")
        .eq("channel_id", channelId)
        .eq("master_product_id", candidate.masterProductId);
      const q = candidate.masterVariantSku === null
        ? base.is("master_variant_sku", null)
        : base.eq("master_variant_sku", candidate.masterVariantSku);
      const { data: existing, error: selErr } = await q.maybeSingle();
      if (selErr) { failed++; continue; }

      const plan = planMappingWrite(channelId, candidate, existing ?? null, nowIso);
      if (plan.op === "update") {
        const { error } = await admin.from("channel_variant_mappings").update(plan.patch).eq("id", plan.id);
        if (error) failed++; else updated++;
      } else {
        const { error } = await admin.from("channel_variant_mappings").insert(plan.row);
        if (error) failed++; else inserted++;
      }
    } catch {
      failed++;
    }
  }

  return { inserted, updated, failed };
}
