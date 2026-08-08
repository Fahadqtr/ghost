// TickTick synced-ids reader tests (Phase UI.8). Dependencies are injected, so
// this runs with no network; the module-level cache is reset before each case.
// Run: node --conditions=react-server --experimental-strip-types --test lib/integrations/ticktick/synced-ids.test.ts

import test from "node:test";
import assert from "node:assert/strict";

import { loadTickTickSyncedIds, __resetTickTickSyncedCache } from "./synced-ids.ts";
import type { TickTickClient, TickTickTaskRecord } from "./types.ts";

// A read-only fake client: listProjectTasks returns fixed records; any WRITE
// method throws, proving the dashboard reader never writes to TickTick.
function fakeClient(records: TickTickTaskRecord[], onList?: () => void): TickTickClient {
  return {
    listProjectTasks: async () => {
      onList?.();
      return records;
    },
    createTask: async () => {
      throw new Error("must not write");
    },
    updateTask: async () => {
      throw new Error("must not write");
    },
    completeTask: async () => {
      throw new Error("must not write");
    },
  };
}

// deterministic marker parse: "m:<id>" → "<id>", else null.
const parse = (c: string | null | undefined): string | null =>
  typeof c === "string" && c.startsWith("m:") ? c.slice(2) : null;

const projectMap = { photos: "PID1" } as const;

test("successful read: parses markers into the id set and caches (listProjectTasks once)", async () => {
  __resetTickTickSyncedCache();
  let calls = 0;
  const client = fakeClient(
    [
      { id: "tt1", content: "m:needs_image:p1" },
      { id: "tt2", content: "m:needs_data:p2" },
      { id: "tt3", content: "manual note (no marker)" },
    ],
    () => {
      calls++;
    },
  );
  const a = await loadTickTickSyncedIds({ client, projectMap, configured: true, parse });
  const b = await loadTickTickSyncedIds({ client, projectMap, configured: true, parse });
  assert.equal(a.available, true);
  assert.deepEqual([...a.ids].sort(), ["needs_data:p2", "needs_image:p1"]);
  assert.equal(a.ids.has("needs_image:p1"), true);
  assert.equal(calls, 1, "second call served from cache");
  assert.equal(a, b, "same cached object");
});

test("not configured → not available, empty, and the client is never called", async () => {
  __resetTickTickSyncedCache();
  let called = false;
  const client = fakeClient([{ id: "x", content: "m:needs_image:p1" }], () => {
    called = true;
  });
  const r = await loadTickTickSyncedIds({ client, projectMap, configured: false, parse });
  assert.equal(r.available, false);
  assert.equal(r.ids.size, 0);
  assert.equal(called, false);
});

test("no configured project ids → not available, empty (no scan)", async () => {
  __resetTickTickSyncedCache();
  const client = fakeClient([{ id: "x", content: "m:needs_image:p1" }]);
  const r = await loadTickTickSyncedIds({ client, projectMap: {}, configured: true, parse });
  assert.equal(r.available, false);
  assert.equal(r.ids.size, 0);
});

test("a throwing read → degraded (available:false, empty) and NOT cached (retries)", async () => {
  __resetTickTickSyncedCache();
  let calls = 0;
  const client: TickTickClient = {
    listProjectTasks: async () => {
      calls++;
      throw new Error("ticktick down");
    },
    createTask: async () => {
      throw new Error("no");
    },
    updateTask: async () => {
      throw new Error("no");
    },
    completeTask: async () => {
      throw new Error("no");
    },
  };
  const r = await loadTickTickSyncedIds({ client, projectMap, configured: true, parse });
  assert.equal(r.available, false);
  assert.equal(r.ids.size, 0);
  await loadTickTickSyncedIds({ client, projectMap, configured: true, parse });
  assert.equal(calls, 2, "failure is never cached");
});

test("__resetTickTickSyncedCache clears the cache", async () => {
  __resetTickTickSyncedCache();
  let calls = 0;
  const client = fakeClient([{ id: "tt1", content: "m:needs_image:p1" }], () => {
    calls++;
  });
  await loadTickTickSyncedIds({ client, projectMap, configured: true, parse });
  await loadTickTickSyncedIds({ client, projectMap, configured: true, parse });
  assert.equal(calls, 1, "cached within TTL");
  __resetTickTickSyncedCache();
  await loadTickTickSyncedIds({ client, projectMap, configured: true, parse });
  assert.equal(calls, 2, "recomputed after reset");
});

test("cache expires after the 60s TTL (injected clock)", async () => {
  __resetTickTickSyncedCache();
  let calls = 0;
  const client = fakeClient([{ id: "tt1", content: "m:needs_image:p1" }], () => {
    calls++;
  });
  let t = 1_000;
  const now = () => t;
  await loadTickTickSyncedIds({ client, projectMap, configured: true, parse, now });
  t = 1_000 + 59_000;
  await loadTickTickSyncedIds({ client, projectMap, configured: true, parse, now });
  assert.equal(calls, 1, "cached within 60s");
  t = 1_000 + 60_001;
  await loadTickTickSyncedIds({ client, projectMap, configured: true, parse, now });
  assert.equal(calls, 2, "recomputed after 60s");
});
