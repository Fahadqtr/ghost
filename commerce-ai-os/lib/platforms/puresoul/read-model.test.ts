// PureSoul overlay reader tests (Phase UI.9.1). Fake session client, no network.
// Run: node --conditions=react-server --experimental-strip-types --test lib/platforms/puresoul/read-model.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { loadPureSoulOverlayRows, type PureSoulReadClient } from "./read-model.ts";

// A fake session client exposing ONLY select→eq→range (no write methods exist).
function client(rows: unknown[], opts: { error?: boolean } = {}): PureSoulReadClient {
  const b = {
    eq: () => b,
    range: async (from: number, to: number) =>
      opts.error ? { data: null, error: { message: "boom" } } : { data: rows.slice(from, to + 1), error: null },
  };
  return { from: () => ({ select: () => b }) } as unknown as PureSoulReadClient;
}

test("reads overlay rows (product_id + approval + availability), degraded:false", async () => {
  const res = await loadPureSoulOverlayRows(
    client([
      { product_id: "a", approval: null, availability: "InStock" },
      { product_id: "b", approval: "Rejected", availability: "OutOfStock" },
    ]),
  );
  assert.equal(res.degraded, false);
  assert.deepEqual(res.rows, [
    { productId: "a", approval: null, availability: "InStock" },
    { productId: "b", approval: "Rejected", availability: "OutOfStock" },
  ]);
});

test("paginates beyond the page size", async () => {
  const rows = Array.from({ length: 1001 }, (_, i) => ({ product_id: `p${i}`, approval: null, availability: "InStock" }));
  const res = await loadPureSoulOverlayRows(client(rows));
  assert.equal(res.degraded, false);
  assert.equal(res.rows.length, 1001);
});

test("a read error → degraded:true with NO rows (never partial, never missing)", async () => {
  const res = await loadPureSoulOverlayRows(client([{ product_id: "a" }], { error: true }));
  assert.equal(res.degraded, true);
  assert.deepEqual(res.rows, []);
});

test("healthy but empty overlay → rows:[] degraded:false (not synced yet)", async () => {
  const res = await loadPureSoulOverlayRows(client([]));
  assert.deepEqual(res, { rows: [], degraded: false });
});

test("malformed rows / missing product_id are skipped", async () => {
  const res = await loadPureSoulOverlayRows(
    client([null, "nope", 7, { approval: "Rejected" }, { product_id: "", availability: "InStock" }, { product_id: "ok" }]),
  );
  assert.deepEqual(res.rows, [{ productId: "ok", approval: null, availability: null }]);
});

test("reader is READ-ONLY: no admin/service-role/write/rpc in the source", () => {
  const src = readFileSync(new URL("./read-model.ts", import.meta.url), "utf8");
  for (const banned of ["createAdminClient", "service_role", ".insert(", ".update(", ".delete(", ".rpc(", ".upsert("]) {
    assert.ok(!src.includes(banned), `read-model must not contain ${banned}`);
  }
  assert.ok(src.includes('import "server-only"'));
});
