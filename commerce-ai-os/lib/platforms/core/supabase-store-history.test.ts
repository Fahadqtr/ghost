// Phase UI.9.4 — SupabaseSnapshotStore.listByProduct: bounded, product-scoped,
// newest-first, degraded-safe. Fake session client, no network.
// Run: node --conditions=react-server --experimental-strip-types --test lib/platforms/core/supabase-store-history.test.ts

import test from "node:test";
import assert from "node:assert/strict";

import { SupabaseSnapshotStore, type SnapshotStoreClient } from "./supabase-store.ts";
import { createSnapshot } from "./snapshot.ts";
import type { SnapshotInput } from "./types.ts";

function fakeClient(opts: { failRead?: boolean } = {}) {
  const rows: Record<string, unknown>[] = [];
  const makeChain = () => {
    const filters: Record<string, unknown> = {};
    let ord: { col: string; ascending: boolean } | null = null;
    let lim = Infinity;
    const chain = {
      eq(col: string, val: unknown) { filters[col] = val; return chain; },
      order(col: string, o: { ascending: boolean }) { ord = { col, ascending: o.ascending }; return chain; },
      limit(n: number) { lim = n; return chain; },
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
          for (const r of newRows) rows.push({ ...r });
          return { error: null };
        },
      };
    },
  };
  return { client };
}

const snap = (over: Partial<SnapshotInput> & { capturedAt: string }) =>
  createSnapshot({ platform: "puresoul", productId: "p1", price: 10, ...over });

test("listByProduct: product-scoped, newest-first", async () => {
  const { client } = fakeClient();
  const store = new SupabaseSnapshotStore(client);
  await store.saveSnapshots([
    snap({ capturedAt: "2026-01-01T00:00:00.000Z", price: 10 }),
    snap({ capturedAt: "2026-01-03T00:00:00.000Z", price: 30 }),
    snap({ capturedAt: "2026-01-02T00:00:00.000Z", price: 20 }),
    snap({ productId: "other", capturedAt: "2026-01-05T00:00:00.000Z" }),
  ]);
  const out = await store.listByProduct("p1");
  assert.deepEqual(out.map((s) => s.capturedAt), [
    "2026-01-03T00:00:00.000Z",
    "2026-01-02T00:00:00.000Z",
    "2026-01-01T00:00:00.000Z",
  ]);
  assert.equal(out.every((s) => s.productId === "p1"), true);
});

test("listByProduct: platform scoping", async () => {
  const { client } = fakeClient();
  const store = new SupabaseSnapshotStore(client);
  await store.saveSnapshots([
    snap({ platform: "puresoul", capturedAt: "2026-01-01T00:00:00.000Z" }),
    snap({ platform: "shopify", capturedAt: "2026-01-02T00:00:00.000Z" }),
  ]);
  const out = await store.listByProduct("p1", { platform: "shopify" });
  assert.equal(out.length, 1);
  assert.equal(out[0].platform, "shopify");
});

test("listByProduct: bounded by limit", async () => {
  const { client } = fakeClient();
  const store = new SupabaseSnapshotStore(client);
  await store.saveSnapshots([
    snap({ capturedAt: "2026-01-01T00:00:00.000Z" }),
    snap({ capturedAt: "2026-01-02T00:00:00.000Z" }),
    snap({ capturedAt: "2026-01-03T00:00:00.000Z" }),
  ]);
  const out = await store.listByProduct("p1", { limit: 1 });
  assert.equal(out.length, 1);
  assert.equal(out[0].capturedAt, "2026-01-03T00:00:00.000Z"); // newest
});

test("listByProduct: read failure throws a constant error", async () => {
  const { client } = fakeClient({ failRead: true });
  const store = new SupabaseSnapshotStore(client);
  await assert.rejects(() => store.listByProduct("p1"), /snapshot_read_failed/);
});
