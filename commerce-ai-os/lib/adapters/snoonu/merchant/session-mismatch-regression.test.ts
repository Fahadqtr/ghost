// MEDIA.1C-HOTFIX — session-mismatch regression. The reported bug: Connection
// Manager = CONNECTED while every discovery scan = SESSION_REQUIRED. Root cause:
// the live provider hardcoded state()="authenticated" and mapped ANY per-lookup
// 401/403 to session_required — so a portal rejection of ONE search mode
// (identity, searchTermType=1) short-circuited the engine at the barcode step
// and masqueraded as a dead session, even though the (name-mode) probe used by
// Test Connection succeeded. These tests pin the fix at every layer.
// node --conditions=react-server --experimental-strip-types --test lib/adapters/snoonu/merchant/session-mismatch-regression.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { mapIdentityLookupState, mapProbeState } from "./live-contract.ts";
import { runSnoonuDiscovery } from "./discovery-engine.ts";
import type { DiscoveryCandidate, DiscoveryLookup, SnoonuDiscoveryProvider } from "./discovery-contract.ts";

const ROOT = fileURLToPath(new URL("../../../..", import.meta.url));
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

const ADAPTER = "lib/adapters/snoonu/merchant/live-adapter.server.ts";
const STATUS = "lib/adapters/snoonu/merchant/session-status.server.ts";
const SERVER = "lib/adapters/snoonu/merchant/discovery.server.ts";

const cand = (over: Partial<DiscoveryCandidate> = {}): DiscoveryCandidate => ({
  storefrontKey: "snoonu:malikas", spi: "SPI-1", name: "P", sku: "mk1", barcode: "123",
  imageUrl: "https://images.snoonu.com/p/a.jpeg", imageWidth: null, imageHeight: null, ...over,
});

const authed = (candidates: DiscoveryCandidate[]): DiscoveryLookup => ({ state: "authenticated", candidates });

// ── pure mappers: one resolver semantics ──────────────────────────────────────
test("probe mapping: ok→authenticated, 401/403→session_required, transport→error", () => {
  assert.equal(mapProbeState("ok"), "authenticated");
  assert.equal(mapProbeState("unauthorized"), "session_required");
  assert.equal(mapProbeState("timeout"), "error");
  assert.equal(mapProbeState("error"), "error");
});

test("identity-mode 401/403 with a LIVE session is 'no candidates via this mode' — never a dead session", () => {
  assert.equal(mapIdentityLookupState("unauthorized", true), "authenticated", "alive session: mode rejection ≠ session_required");
  assert.equal(mapIdentityLookupState("unauthorized", false), "session_required", "dead probe: genuinely session_required");
  assert.equal(mapIdentityLookupState("ok", true), "authenticated");
  assert.equal(mapIdentityLookupState("timeout", true), "error");
});

// ── engine regression: CONNECTED ⇒ never SESSION_REQUIRED, search executes ────
test("CONNECTED session: even with identity modes rejected, discovery falls through — NEVER SESSION_REQUIRED", async () => {
  const calls = { state: 0, barcode: 0, sku: 0, exact: 0, contains: 0 };
  // Mimics the fixed adapter when the portal rejects searchTermType=1 but the
  // probe (Test Connection's request) proves the session alive.
  const provider: SnoonuDiscoveryProvider = {
    storefrontKey: "snoonu:malikas",
    state: async () => { calls.state++; return "authenticated"; },
    findByBarcode: async () => { calls.barcode++; return authed([]); },
    findBySku: async () => { calls.sku++; return authed([]); },
    searchExactName: async () => { calls.exact++; return authed([cand()]); },
    searchContainsName: async () => { calls.contains++; return authed([]); },
  };
  const r = await runSnoonuDiscovery(provider, { storefrontKey: "snoonu:malikas", barcode: "123", sku: "mk1", name: "P" });
  assert.notEqual(r.classification, "SESSION_REQUIRED", "connected session must never scan as SESSION_REQUIRED");
  assert.equal(r.classification, "NEEDS_REVIEW", "name fall-through classifies for review (never fabricated SAFE)");
  // the scan actually executed the provider searches in order
  assert.deepEqual(calls, { state: 1, barcode: 1, sku: 1, exact: 1, contains: 0 });
});

test("CONNECTED session with a working identity mode still yields SAFE_MATCH (unchanged behavior)", async () => {
  const provider: SnoonuDiscoveryProvider = {
    storefrontKey: "snoonu:malikas",
    state: async () => "authenticated",
    findByBarcode: async () => authed([cand()]),
    findBySku: async () => authed([]),
    searchExactName: async () => authed([]),
    searchContainsName: async () => authed([]),
  };
  const r = await runSnoonuDiscovery(provider, { storefrontKey: "snoonu:malikas", barcode: "123", sku: "mk1", name: "P" });
  assert.equal(r.classification, "SAFE_MATCH");
  assert.equal(r.sessionState, "authenticated");
});

// ── source guard: ONE session source, ONE resolver, real state(), safe logging ─
test("Test Connection, Discovery and Recovery resolve the SAME env source per storefront", () => {
  const grab = (src: string) => ({
    malikas: /"snoonu:malikas":\s*"([A-Z_]+)"/.exec(src)?.[1],
    pureSeoul: /"snoonu:pure_seoul":\s*"([A-Z_]+)"/.exec(src)?.[1],
  });
  const a = grab(read(ADAPTER));
  const s = grab(read(STATUS));
  assert.equal(a.malikas, "SNOONU_MALIKAS_MERCHANT_SESSION");
  assert.equal(a.pureSeoul, "SNOONU_PURE_SEOUL_MERCHANT_SESSION");
  assert.deepEqual(a, s, "session-status and live-adapter read identical env names");
  for (const f of [ADAPTER, STATUS]) {
    assert.ok(/process\.env\[SESSION_ENV\[storefrontKey\]\]/.test(read(f)), `${f} reads by the SAME storefront key`);
  }
  // discovery + recovery both build their provider from the configured resolver
  assert.ok(/createConfiguredSnoonuDiscoveryProvider\(key\)/.test(read(SERVER)), "discovery uses the configured resolver");
  assert.ok(/createConfiguredSnoonuDiscoveryProvider\(storefrontKey\)/.test(read("lib/adapters/snoonu/merchant/media-recovery.server.ts")), "recovery uses the configured resolver");
});

test("live provider state() is a REAL probe (Test Connection's request) — never hardcoded", () => {
  const raw = read(ADAPTER);
  assert.equal(/state:\s*async\s*\(\)\s*=>\s*"authenticated"/.test(raw), false, "hardcoded authenticated state removed");
  assert.ok(/state:\s*async\s*\(\)\s*=>\s*mapProbeState\(/.test(raw), "state() derives from the memoized probe");
  assert.ok(/buildNameSearchBody\(config\.businessUnitId,\s*"a"\)/.test(raw), "probe = the SAME request Test Connection performs");
  assert.ok(/mapIdentityLookupState\(read\.kind/.test(raw), "identity 401/403 judged against the probe, not assumed dead");
  // no stale cross-request cache exists: the probe memo lives per provider instance
  assert.ok(/let probePromise/.test(raw), "probe memo is instance-scoped (per scan), not module-global");
});

test("hotfix tracing is dev/test-only and carries NO secret material", () => {
  const raw = read(SERVER);
  assert.ok(/process\.env\.NODE_ENV !== "production"/.test(raw), "trace gated out of production");
  const log = /console\.debug\("\[snoonu-discovery\]",\s*\{([\s\S]*?)\}\);/.exec(raw)?.[1] ?? "";
  assert.ok(log.length > 0, "trace present");
  for (const field of ["storefrontKey", "resolver", "configState", "providerInvoked", "sessionState"]) {
    assert.ok(log.includes(field), `trace includes ${field}`);
  }
  for (const banned of [/config\.headers/, /Authorization/i, /Cookie/i, /SNOONU_[A-Z_]*SESSION/, /businessUnitId/]) {
    assert.equal(banned.test(log), false, `trace must not log ${banned}`);
  }
});
