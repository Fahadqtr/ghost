// SupabaseSnapshotStore tests (Phase UI.9.3). Fake session client, no network.
// Run: node --conditions=react-server --experimental-strip-types --test lib/platforms/core/supabase-store.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { SupabaseSnapshotStore, type SnapshotStoreClient } from "./supabase-store.ts";
import { captureSnapshots } from "./capture.ts";
import { createSnapshot } from "./snapshot.ts";
import type { SnapshotInput } from "./types.ts";

// A fake Supabase client backed by an in-memory row array.
function fakeClient(opts: { failRead?: boolean; failInsert?: boolean } = {}) {
  const rows: Record<string, unknown>[] = [];
  const makeChain = () => {
    const filters: Record<string, unknown> = {};
    let ord: { col: string; ascending: boolean } | null = null;
    let lim = Infinity;
    const chain = {
      eq(col: string, val: unknown) {
        filters[col] = val;
        return chain;
      },
      order(col: string, o: { ascending: boolean }) {
        ord = { col, ascending: o.ascending };
        return chain;
      },
      limit(n: number) {
        lim = n;
        return chain;
      },
      then(resolve: (r: { data: unknown[] | null; error: unknown }) => void) {
        if (opts.failRead) return resolve({ data: null, error: { message: "boom" } });
        let out = rows.filter((r) => Object.entries(filters).every(([k, v]) => r[k] === v));
        if (ord) {
          const { col, ascending } = ord;
          out = [...out].sort((a, b) => String(a[col]).localeCompare(String(b[col])) * (ascending ? 1 : -1));
        }
        return resolve({ data: out.slice(0, lim), error: null });
      },
    };
    return chain;
  };
  const client: SnapshotStoreClient = {
    from() {
      return {
        select: () => makeChain() as never,
        async insert(newRows: Record<string, unknown>[]) {
          if (opts.failInsert) return { error: { message: "boom" } };
          for (const r of newRows) rows.push({ ...r });
          return { error: null };
        },
      };
    },
  };
  return { client, rows };
}

const snap = (over: Partial<SnapshotInput>) =>
  createSnapshot({ platform: "pure_seoul", productId: "p1", price: 10, capturedAt: "2026-01-01T00:00:00.000Z", ...over });

test("saveSnapshot inserts a mapped row; loadLatest reads it back", async () => {
  const { client, rows } = fakeClient();
  const store = new SupabaseSnapshotStore(client);
  await store.saveSnapshot(snap({}));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].product_id, "p1");
  assert.equal(rows[0].payload_hash, snap({}).payloadHash);
  const latest = await store.loadLatest("pure_seoul::p1");
  assert.equal(latest?.price, 10);
});

test("loadLatest returns the greatest captured_at", async () => {
  const { client } = fakeClient();
  const store = new SupabaseSnapshotStore(client);
  await store.saveSnapshot(snap({ capturedAt: "2026-01-01T00:00:00.000Z", price: 10 }));
  await store.saveSnapshot(snap({ capturedAt: "2026-05-05T00:00:00.000Z", price: 55 }));
  assert.equal((await store.loadLatest("pure_seoul::p1"))?.price, 55);
});

test("loadLatest → null for unknown / malformed key", async () => {
  const { client } = fakeClient();
  const store = new SupabaseSnapshotStore(client);
  assert.equal(await store.loadLatest("pure_seoul::nope"), null);
  assert.equal(await store.loadLatest("bogus"), null);
});

test("compareLatest → created then unchanged then changed", async () => {
  const { client } = fakeClient();
  const store = new SupabaseSnapshotStore(client);
  assert.equal((await store.compareLatest(snap({ price: 10 }))).kind, "created");
  await store.saveSnapshot(snap({ price: 10 }));
  assert.equal((await store.compareLatest(snap({ price: 10, capturedAt: "2026-02-02T00:00:00.000Z" }))).kind, "unchanged");
  assert.equal((await store.compareLatest(snap({ price: 20, capturedAt: "2026-02-02T00:00:00.000Z" }))).kind, "changed");
});

test("listLatestByPlatform dedupes to newest-per-product across products", async () => {
  const { client } = fakeClient();
  const store = new SupabaseSnapshotStore(client);
  await store.saveSnapshots([
    snap({ productId: "a", capturedAt: "2026-01-01T00:00:00.000Z", price: 1 }),
    snap({ productId: "a", capturedAt: "2026-02-01T00:00:00.000Z", price: 2 }), // newer
    snap({ productId: "b", capturedAt: "2026-01-01T00:00:00.000Z", price: 3 }),
  ]);
  const latest = await store.listLatestByPlatform("pure_seoul");
  const byId = new Map(latest.map((s) => [s.productId, s.price]));
  assert.equal(latest.length, 2);
  assert.equal(byId.get("a"), 2);
  assert.equal(byId.get("b"), 3);
});

test("listSnapshots filters by platform / productId / key", async () => {
  const { client } = fakeClient();
  const store = new SupabaseSnapshotStore(client);
  await store.saveSnapshots([
    snap({ platform: "pure_seoul", productId: "a" }),
    snap({ platform: "shopify", productId: "a" }),
    snap({ platform: "pure_seoul", productId: "b" }),
  ]);
  assert.equal((await store.listSnapshots({ platform: "pure_seoul" })).length, 2);
  assert.equal((await store.listSnapshots({ productId: "a" })).length, 2);
  assert.equal((await store.listSnapshots({ key: "pure_seoul::b" })).length, 1);
});

test("read failure throws (caller degrades to Unknown, never missing)", async () => {
  const { client } = fakeClient({ failRead: true });
  const store = new SupabaseSnapshotStore(client);
  await assert.rejects(() => store.loadLatest("pure_seoul::p1"));
  await assert.rejects(() => store.listLatestByPlatform("pure_seoul"));
});

test("insert failure throws (no partial/inconsistent success reported)", async () => {
  const { client } = fakeClient({ failInsert: true });
  const store = new SupabaseSnapshotStore(client);
  await assert.rejects(() => store.saveSnapshot(snap({})));
});

test("integration: captureSnapshots via the Supabase store is idempotent", async () => {
  const { client, rows } = fakeClient();
  const store = new SupabaseSnapshotStore(client);
  const inputs = [
    { platform: "pure_seoul", productId: "a", price: 10, capturedAt: "2026-01-01T00:00:00.000Z" },
    { platform: "pure_seoul", productId: "b", price: 20, capturedAt: "2026-01-01T00:00:00.000Z" },
  ];
  const r1 = await captureSnapshots(store, inputs);
  assert.equal(r1.created, 2);
  assert.equal(rows.length, 2);
  const r2 = await captureSnapshots(store, inputs.map((i) => ({ ...i, capturedAt: "2026-06-06T00:00:00.000Z" })));
  assert.equal(r2.unchanged, 2);
  assert.equal(rows.length, 2, "identical re-capture writes nothing");
});

test("source is READ+INSERT only — no update/delete/rpc/admin/service-role", () => {
  const src = readFileSync(new URL("./supabase-store.ts", import.meta.url), "utf8");
  for (const banned of [".update(", ".delete(", ".rpc(", "createAdminClient", "service_role", ".upsert("]) {
    assert.ok(!src.includes(banned), `store must not contain ${banned}`);
  }
  assert.ok(src.includes('import "server-only"'));
});
