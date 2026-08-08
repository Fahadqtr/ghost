// PureSoul presence bridge tests (Phase UI.9.1). Deps injected, no network; the
// module-level cache is reset before each case.
// Run: node --conditions=react-server --experimental-strip-types --test lib/platforms/puresoul/presence.test.ts

import test from "node:test";
import assert from "node:assert/strict";

import { loadPureSoulPresence, __resetPureSoulPresenceCache } from "./presence.ts";
import { buildPureSoulPresence } from "./mapper.ts";
import type { PureSoulOverlayRow } from "./types.ts";

const fakeClient = {} as never; // only passed through to the injected reader
const build = buildPureSoulPresence;

const okRead = (rows: PureSoulOverlayRow[], onRead?: () => void) => async () => {
  onRead?.();
  return { rows, degraded: false };
};

test("successful read → presence map + available:true, cached (reader once)", async () => {
  __resetPureSoulPresenceCache();
  let calls = 0;
  const readRows = okRead([{ productId: "a", approval: null, availability: "InStock" }], () => {
    calls++;
  });
  const a = await loadPureSoulPresence(fakeClient, { readRows, build });
  const b = await loadPureSoulPresence(fakeClient, { readRows, build });
  assert.equal(a.available, true);
  assert.equal(a.degraded, false);
  assert.equal(a.byProductId.get("a")?.live, true);
  assert.equal(calls, 1, "second call served from cache");
  assert.equal(a, b);
});

test("healthy-empty overlay → available:false, degraded:false, cached", async () => {
  __resetPureSoulPresenceCache();
  let calls = 0;
  const readRows = okRead([], () => {
    calls++;
  });
  const r = await loadPureSoulPresence(fakeClient, { readRows, build });
  await loadPureSoulPresence(fakeClient, { readRows, build });
  assert.equal(r.available, false);
  assert.equal(r.degraded, false);
  assert.equal(calls, 1, "healthy read (even empty) is cached");
});

test("degraded read → available:false, degraded:true, NOT cached (retries)", async () => {
  __resetPureSoulPresenceCache();
  let calls = 0;
  const readRows = async () => {
    calls++;
    return { rows: [], degraded: true };
  };
  const r = await loadPureSoulPresence(fakeClient, { readRows, build });
  await loadPureSoulPresence(fakeClient, { readRows, build });
  assert.equal(r.available, false);
  assert.equal(r.degraded, true);
  assert.equal(r.byProductId.size, 0);
  assert.equal(calls, 2, "a failed read is never cached");
});

test("a throwing reader → degraded, not cached", async () => {
  __resetPureSoulPresenceCache();
  let calls = 0;
  const readRows = async () => {
    calls++;
    throw new Error("db down");
  };
  const r = await loadPureSoulPresence(fakeClient, { readRows, build });
  assert.equal(r.degraded, true);
  await loadPureSoulPresence(fakeClient, { readRows, build });
  assert.equal(calls, 2);
});

test("__resetPureSoulPresenceCache clears the cache", async () => {
  __resetPureSoulPresenceCache();
  let calls = 0;
  const readRows = okRead([{ productId: "a", approval: null, availability: "InStock" }], () => {
    calls++;
  });
  await loadPureSoulPresence(fakeClient, { readRows, build });
  await loadPureSoulPresence(fakeClient, { readRows, build });
  assert.equal(calls, 1);
  __resetPureSoulPresenceCache();
  await loadPureSoulPresence(fakeClient, { readRows, build });
  assert.equal(calls, 2);
});

test("cache expires after the 90s TTL (injected clock)", async () => {
  __resetPureSoulPresenceCache();
  let calls = 0;
  const readRows = okRead([{ productId: "a", approval: null, availability: "InStock" }], () => {
    calls++;
  });
  let t = 1_000;
  const now = () => t;
  await loadPureSoulPresence(fakeClient, { readRows, build, now });
  t = 1_000 + 89_000;
  await loadPureSoulPresence(fakeClient, { readRows, build, now });
  assert.equal(calls, 1, "cached within 90s");
  t = 1_000 + 90_001;
  await loadPureSoulPresence(fakeClient, { readRows, build, now });
  assert.equal(calls, 2, "recomputed after 90s");
});
