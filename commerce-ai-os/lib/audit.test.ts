// Tests for the schema-drift-healing malak_audit insert helper.
// Run: node --conditions=react-server --experimental-strip-types --test lib/audit.test.ts

import test from "node:test";
import assert from "node:assert/strict";

import { insertAuditRow, type AuditAdmin } from "./audit.ts";

// Fake admin that records every insert and answers from a scripted queue.
function fakeAdmin(results: { error: { message?: string; code?: string } | null }[]) {
  const inserts: Record<string, unknown>[] = [];
  const admin: AuditAdmin = {
    from(table: string) {
      assert.equal(table, "malak_audit");
      return {
        insert(row: Record<string, unknown>) {
          inserts.push(row);
          return Promise.resolve(results[inserts.length - 1] ?? { error: null });
        },
      };
    },
  };
  return { admin, inserts };
}

const UUID = "3fa85f64-5717-4562-b3fc-2c963f66afa6";

test("writes product_id directly on a migrated (uuid) column", async () => {
  const { admin, inserts } = fakeAdmin([{ error: null }]);
  const res = await insertAuditRow(admin, { action_type: "set_price", product_id: UUID });
  assert.equal(res.error, null);
  assert.equal(inserts.length, 1);
  assert.equal(inserts[0].product_id, UUID);
});

test("falls back without product_id when the legacy bigint column rejects it (22P02)", async () => {
  const { admin, inserts } = fakeAdmin([
    { error: { code: "22P02", message: "invalid input syntax for type bigint" } },
    { error: null },
  ]);
  const res = await insertAuditRow(admin, { action_type: "stock_in", product_id: UUID, details: { productId: UUID } });
  assert.equal(res.error, null);
  assert.equal(inserts.length, 2);
  assert.equal("product_id" in inserts[1], false);         // retried WITHOUT the column
  assert.deepEqual(inserts[1].details, { productId: UUID }); // uuid still preserved in details
});

test("falls back when the column does not exist at all (42703)", async () => {
  const { admin, inserts } = fakeAdmin([{ error: { code: "42703" } }, { error: null }]);
  const res = await insertAuditRow(admin, { action_type: "stocktake", product_id: UUID });
  assert.equal(res.error, null);
  assert.equal(inserts.length, 2);
});

test("does NOT retry on unrelated errors (they surface to the caller)", async () => {
  const { admin, inserts } = fakeAdmin([{ error: { code: "23502", message: "null value in column" } }]);
  const res = await insertAuditRow(admin, { action_type: "set_price", product_id: UUID });
  assert.equal(res.error?.code, "23502");
  assert.equal(inserts.length, 1);
});

test("null/absent product_id inserts once, without the column", async () => {
  const { admin, inserts } = fakeAdmin([{ error: null }]);
  await insertAuditRow(admin, { action_type: "shelf_move", product_id: null });
  assert.equal(inserts.length, 1);
  assert.equal("product_id" in inserts[0], false);
});
