// MEDIA.1A-P — Snoonu session-status unit tests (pure, injected live reader).
// node --conditions=react-server --experimental-strip-types --test lib/adapters/snoonu/merchant/session-status.test.ts

import test from "node:test";
import assert from "node:assert/strict";

import {
  resolveSnoonuSessionState,
  runSnoonuSessionTest,
  type LiveReadResult,
  type SnoonuLiveSessionReader,
} from "./session-status.ts";

const reader = (r: LiveReadResult): SnoonuLiveSessionReader => async () => r;

test("no secret configured → SESSION_REQUIRED (never CONNECTED)", async () => {
  const s = await runSnoonuSessionTest("snoonu:malikas", false, reader({ outcome: "ok" }));
  assert.equal(s.state, "SESSION_REQUIRED");
  assert.equal(s.configured, false);
  assert.equal(s.connected, false);
});

test("secret present but NO live reader → UNKNOWN (env presence never implies CONNECTED)", async () => {
  const s = await runSnoonuSessionTest("snoonu:malikas", true, null);
  assert.equal(s.state, "UNKNOWN");
  assert.equal(s.configured, true);
  assert.equal(s.connected, false);
});

test("valid mocked session (ok read) → CONNECTED", async () => {
  const s = await runSnoonuSessionTest("snoonu:malikas", true, reader({ outcome: "ok" }));
  assert.equal(s.state, "CONNECTED");
  assert.equal(s.connected, true);
});

test("ok but stale → STALE (connected but old)", async () => {
  const s = await runSnoonuSessionTest("snoonu:malikas", true, reader({ outcome: "ok", stale: true }));
  assert.equal(s.state, "STALE");
  assert.equal(s.connected, false);
});

test("expired read → EXPIRED", async () => {
  const s = await runSnoonuSessionTest("snoonu:malikas", true, reader({ outcome: "expired" }));
  assert.equal(s.state, "EXPIRED");
  assert.equal(s.connected, false);
});

test("timeout → ERROR", async () => {
  const s = await runSnoonuSessionTest("snoonu:malikas", true, reader({ outcome: "timeout" }));
  assert.equal(s.state, "ERROR");
});

test("error read → ERROR", async () => {
  const s = await runSnoonuSessionTest("snoonu:malikas", true, reader({ outcome: "error" }));
  assert.equal(s.state, "ERROR");
});

test("live reader that throws → ERROR (never leaks, never CONNECTED)", async () => {
  const s = await runSnoonuSessionTest("snoonu:malikas", true, async () => { throw new Error("boom"); });
  assert.equal(s.state, "ERROR");
  assert.equal(s.connected, false);
});

test("pure resolver: presence alone is UNKNOWN, only a proven ok read is CONNECTED", () => {
  assert.equal(resolveSnoonuSessionState({ configured: false, live: null }), "SESSION_REQUIRED");
  assert.equal(resolveSnoonuSessionState({ configured: true, live: null }), "UNKNOWN");
  assert.equal(resolveSnoonuSessionState({ configured: true, live: { outcome: "ok" } }), "CONNECTED");
  assert.equal(resolveSnoonuSessionState({ configured: true, live: { outcome: "ok", stale: true } }), "STALE");
  assert.equal(resolveSnoonuSessionState({ configured: true, live: { outcome: "expired" } }), "EXPIRED");
});

test("storefront isolation: each test carries its own storefront + its own injected reader", async () => {
  const malikas = await runSnoonuSessionTest("snoonu:malikas", true, reader({ outcome: "ok" }));
  const pureseoul = await runSnoonuSessionTest("snoonu:pure_seoul", true, null);
  assert.equal(malikas.storefrontKey, "snoonu:malikas");
  assert.equal(malikas.state, "CONNECTED");
  assert.equal(pureseoul.storefrontKey, "snoonu:pure_seoul");
  assert.equal(pureseoul.state, "UNKNOWN", "Pure Seoul never inherits the Malikas session");
});

test("returned status carries NO secret material — only safe fields", async () => {
  const s = await runSnoonuSessionTest("snoonu:malikas", true, reader({ outcome: "ok" }));
  assert.deepEqual(Object.keys(s).sort(), ["configured", "connected", "state", "storefrontKey"]);
});
