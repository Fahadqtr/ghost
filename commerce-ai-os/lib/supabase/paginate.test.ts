// Tests for the shared Supabase pager.
// Run: node --experimental-strip-types --test lib/supabase/paginate.test.ts

import test from "node:test";
import assert from "node:assert/strict";

import { fetchAll } from "./paginate.ts";

const PAGE = 1000;

// Minimal fake of the Supabase query builder: .from(table).select(cols).range(from,to).
// Optionally fails on a given 0-based page index to exercise the error path.
function fakeClient(rowsByTable: Record<string, any[]>, opts: { errorAtPage?: number } = {}) {
  return {
    from(table: string) {
      const rows = rowsByTable[table] ?? [];
      return {
        select(_cols: string) {
          return {
            range(from: number, to: number) {
              const page = Math.floor(from / PAGE);
              if (opts.errorAtPage != null && page === opts.errorAtPage) {
                return Promise.resolve({ data: null, error: { message: "boom" } });
              }
              return Promise.resolve({ data: rows.slice(from, to + 1), error: null });
            },
          };
        },
      };
    },
  };
}

const makeRows = (n: number) => Array.from({ length: n }, (_, i) => ({ id: i }));

test("fetchAll returns every row across multiple full pages", async () => {
  const got = await fetchAll(fakeClient({ products: makeRows(2500) }), "products", "id");
  assert.equal(got.length, 2500);
  assert.equal(got[0].id, 0);
  assert.equal(got[2499].id, 2499);
});

test("fetchAll stops on a short final page", async () => {
  const got = await fetchAll(fakeClient({ products: makeRows(1500) }), "products", "id");
  assert.equal(got.length, 1500);
});

test("fetchAll stops exactly on an empty trailing page (exact multiple of PAGE)", async () => {
  // 2000 rows = two full pages; the third page is empty (<PAGE) and ends the loop.
  const got = await fetchAll(fakeClient({ products: makeRows(2000) }), "products", "id");
  assert.equal(got.length, 2000);
});

test("fetchAll returns rows gathered before an error and stops", async () => {
  // Error on the 2nd page (index 1) → only the first 1000 rows come back.
  const got = await fetchAll(fakeClient({ products: makeRows(2500) }, { errorAtPage: 1 }), "products", "id");
  assert.equal(got.length, 1000);
});

test("fetchAll returns [] for an empty table", async () => {
  const got = await fetchAll(fakeClient({ products: [] }), "products", "id");
  assert.deepEqual(got, []);
});
