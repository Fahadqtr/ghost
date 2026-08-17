import "server-only";
// INT.2F.1 — Talabat mapping-sync boundary (SERVER-ONLY).
//
// The single, certified, reusable entry for persisting Talabat
// channel_variant_mappings. It exists so the persistence capability is no longer
// welded to the legacy export route: any writer-gated caller can converge Talabat
// identity through THIS boundary, and the legacy route now merely delegates here.
//
// It delegates the durable upsert to persistTalabatMappings — the canonical,
// idempotent writer keyed by (channel_id, master_product_id, master_variant_sku)
// that NEVER clears an existing channel_product_id — and records a BEST-EFFORT
// malak_audit row. It NEVER throws and returns the exact same {inserted, updated,
// failed} counts, so callers keep their FAIL-CLOSED gate (download only when
// failed === 0). Mapping semantics are unchanged: this is a pure re-homing of
// WHERE the write is invoked, not WHAT is written.
//
// Identity is durable only — channel_id + master_product_id + master_variant_sku.
// No legacy per-store id column and no approximate/name matching is introduced.
//
// Authorization: callers own the writer gate (identical precedent to the ECL
// write boundary, lib/missing-products/ecl-repair-write.server.ts). `actor` is the
// already-verified writer email, recorded in the audit trail.

import { persistTalabatMappings, type MappingWriteClient, type PersistResult } from "../persist-mappings.ts";
import { type TalabatMappingCandidate } from "../export.ts";
import { insertAuditRow, type AuditAdmin } from "../../audit.ts";

export type { MappingWriteClient, PersistResult } from "../persist-mappings.ts";

/** The client the boundary needs: the mapping writer + the audit writer. */
export type MappingSyncAdmin = MappingWriteClient & AuditAdmin;

/**
 * Persist every Talabat mapping candidate through the canonical writer, then
 * record a best-effort audit row. Returns counts only — never throws.
 */
export async function syncTalabatMappings(
  admin: MappingSyncAdmin,
  channelId: string,
  candidates: readonly TalabatMappingCandidate[],
  nowIso: string,
  actor: string,
): Promise<PersistResult> {
  const counts = await persistTalabatMappings(admin, channelId, [...candidates], nowIso);

  // Durable audit trail for the identity write (best-effort — a failed audit
  // never changes the caller's fail-closed gate). No secrets, no raw payloads.
  await insertAuditRow(admin, {
    action_type: "talabat_mapping_sync",
    product_id: null,
    details: {
      channel_id: channelId,
      candidates: candidates.length,
      inserted: counts.inserted,
      updated: counts.updated,
      failed: counts.failed,
      actor,
    },
  }).catch(() => {});

  return counts;
}
