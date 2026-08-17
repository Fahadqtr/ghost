// INT.2F.1 — Talabat mapping-sync boundary tests.
// Proves the certified boundary delegates to the canonical writer with IDENTICAL
// behavior (same counts, idempotent, never clears channel_product_id), records a
// best-effort audit, never throws, and introduces no legacy identity.
// node --conditions=react-server --experimental-strip-types --test lib/talabat/mapping-sync/mapping-sync.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { syncTalabatMappings, type MappingSyncAdmin } from "./mapping-sync.server.ts";
import { persistTalabatMappings } from "../persist-mappings.ts";
import { type TalabatMappingCandidate, type ExistingMappingRow } from "../export.ts";

function candidate(over: Partial<TalabatMappingCandidate> = {}): TalabatMappingCandidate {
  return {
    masterProductId: "p1", masterVariantSku: "MK1", exportedSku: "MK1", exportedBarcode: "6291041500213",
    mappingStatus: "active" as TalabatMappingCandidate["mappingStatus"],
    exportSnapshot: { price: 10 } as TalabatMappingCandidate["exportSnapshot"],
    ...over,
  };
}

interface Ops { inserts: Record<string, unknown>[]; updates: Record<string, unknown>[]; audits: Record<string, unknown>[] }
function makeFake(opts: { existing?: ExistingMappingRow | null; failInsert?: boolean; failAudit?: boolean } = {}) {
  const ops: Ops = { inserts: [], updates: [], audits: [] };
  const cvm = {
    select: () => cvm,
    eq: () => cvm,
    is: () => cvm,
    maybeSingle: () => Promise.resolve({ data: opts.existing ?? null, error: null }),
    insert: (row: Record<string, unknown>) => { ops.inserts.push(row); return Promise.resolve({ error: opts.failInsert ? { message: "x" } : null }); },
    update: (patch: Record<string, unknown>) => ({ eq: () => { ops.updates.push(patch); return Promise.resolve({ error: null }); } }),
  };
  const client = {
    from(table: string) {
      if (table === "malak_audit") {
        return { insert: (row: Record<string, unknown>) => { if (opts.failAudit) throw new Error("audit down"); ops.audits.push(row); return Promise.resolve({ error: null }); } };
      }
      return cvm;
    },
  };
  return { admin: client as unknown as MappingSyncAdmin, ops };
}

test("delegates to the canonical writer — identical counts to persistTalabatMappings", async () => {
  const a = makeFake();
  const viaBoundary = await syncTalabatMappings(a.admin, "ch1", [candidate()], "2026-08-17T00:00:00Z", "owner@example.com");
  const b = makeFake();
  const viaDirect = await persistTalabatMappings(b.admin as never, "ch1", [candidate()], "2026-08-17T00:00:00Z");
  assert.deepEqual(viaBoundary, viaDirect, "boundary result == canonical writer result (no behavior change)");
  assert.deepEqual(viaBoundary, { inserted: 1, updated: 0, failed: 0 });
  assert.equal(a.ops.inserts.length, 1, "one insert for a new candidate");
});

test("existing mapping → update, never a duplicate insert, channel_product_id preserved", async () => {
  const { admin, ops } = makeFake({ existing: { id: "m1", channel_product_id: "CP9" } });
  const counts = await syncTalabatMappings(admin, "ch1", [candidate()], "2026-08-17T00:00:00Z", "owner@example.com");
  assert.deepEqual(counts, { inserted: 0, updated: 1, failed: 0 });
  assert.equal(ops.inserts.length, 0, "no duplicate insert when a mapping exists");
  assert.equal(ops.updates.length, 1);
  assert.equal("channel_product_id" in ops.updates[0], false, "update never clears channel_product_id");
});

test("writes a best-effort audit row (talabat_mapping_sync) with no secrets", async () => {
  const { admin, ops } = makeFake();
  await syncTalabatMappings(admin, "ch1", [candidate()], "2026-08-17T00:00:00Z", "owner@example.com");
  assert.equal(ops.audits.length, 1);
  assert.equal(ops.audits[0].action_type, "talabat_mapping_sync");
  const details = ops.audits[0].details as Record<string, unknown>;
  assert.equal(details.channel_id, "ch1");
  assert.equal(details.inserted, 1);
  const json = JSON.stringify(ops.audits[0]).toLowerCase();
  for (const secret of ["service_role", "authorization", "bearer ", "password", "secret", "access_token"]) {
    assert.equal(json.includes(secret), false, `audit must not contain ${secret}`);
  }
});

test("never throws and reports failed on a persistence error", async () => {
  const { admin } = makeFake({ failInsert: true });
  const counts = await syncTalabatMappings(admin, "ch1", [candidate()], "2026-08-17T00:00:00Z", "owner@example.com");
  assert.deepEqual(counts, { inserted: 0, updated: 0, failed: 1 });
});

test("a failed audit never breaks the sync (best-effort, fail-closed gate intact)", async () => {
  const { admin } = makeFake({ failAudit: true });
  const counts = await syncTalabatMappings(admin, "ch1", [candidate()], "2026-08-17T00:00:00Z", "owner@example.com");
  assert.deepEqual(counts, { inserted: 1, updated: 0, failed: 0 }, "mapping persisted even though audit threw");
});

test("identity is durable only — insert row carries channel_id + master ids, no legacy id column", async () => {
  const { admin, ops } = makeFake();
  await syncTalabatMappings(admin, "ch1", [candidate({ masterVariantSku: "RED" })], "2026-08-17T00:00:00Z", "owner@example.com");
  const row = ops.inserts[0];
  assert.equal(row.channel_id, "ch1");
  assert.equal(row.master_product_id, "p1");
  assert.equal(row.master_variant_sku, "RED");
  for (const legacy of ["snoonu_id", "rafeeq_product_id", "pure_seoul_id"]) {
    assert.equal(legacy in row, false, `no legacy id column ${legacy}`);
  }
});
