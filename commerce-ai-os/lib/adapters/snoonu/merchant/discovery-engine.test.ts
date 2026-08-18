// MEDIA.1B — Snoonu discovery engine unit tests (pure, fake provider).
// node --conditions=react-server --experimental-strip-types --test lib/adapters/snoonu/merchant/discovery-engine.test.ts

import test from "node:test";
import assert from "node:assert/strict";

import { runSnoonuDiscovery } from "./discovery-engine.ts";
import type {
  DiscoveryCandidate,
  DiscoveryLookup,
  MerchantSessionState,
  SnoonuDiscoveryProvider,
  SnoonuStorefrontKey,
} from "./discovery-contract.ts";

const KEY: SnoonuStorefrontKey = "snoonu:malikas";

function cand(key: SnoonuStorefrontKey, over: Partial<DiscoveryCandidate> = {}): DiscoveryCandidate {
  return { storefrontKey: key, spi: "SPI1", name: "P", sku: "mk1", barcode: "123456", imageUrl: "https://cdn.snoonu.com/x.jpg", imageWidth: 800, imageHeight: 800, ...over };
}
const ok = (candidates: DiscoveryCandidate[]): DiscoveryLookup => ({ state: "authenticated", candidates });

interface FakeCfg {
  state?: MerchantSessionState;
  barcode?: DiscoveryLookup;
  sku?: DiscoveryLookup;
  exactName?: DiscoveryLookup;
  containsName?: DiscoveryLookup;
}
function fake(key: SnoonuStorefrontKey, cfg: FakeCfg = {}): SnoonuDiscoveryProvider & { calls: string[] } {
  const calls: string[] = [];
  return {
    storefrontKey: key,
    calls,
    state: async () => cfg.state ?? "authenticated",
    findByBarcode: async () => { calls.push("barcode"); return cfg.barcode ?? ok([]); },
    findBySku: async () => { calls.push("sku"); return cfg.sku ?? ok([]); },
    searchExactName: async () => { calls.push("exactName"); return cfg.exactName ?? ok([]); },
    searchContainsName: async () => { calls.push("containsName"); return cfg.containsName ?? ok([]); },
  };
}
const query = (over: Partial<{ barcode: string | null; sku: string | null; name: string | null }> = {}) => ({
  storefrontKey: KEY, barcode: "123456", sku: "mk1", name: "Lip Tint", ...over,
});

test("exact barcode → SAFE_MATCH and short-circuits SKU/name searches", async () => {
  const p = fake(KEY, { barcode: ok([cand(KEY)]) });
  const r = await runSnoonuDiscovery(p, query());
  assert.equal(r.classification, "SAFE_MATCH");
  assert.equal(r.matchReason, "exact_barcode");
  assert.equal(r.confidence, "high");
  assert.deepEqual(p.calls, ["barcode"], "later searches never run");
});

test("SKU fallback → SAFE_MATCH when barcode has no results", async () => {
  const p = fake(KEY, { barcode: ok([]), sku: ok([cand(KEY)]) });
  const r = await runSnoonuDiscovery(p, query());
  assert.equal(r.classification, "SAFE_MATCH");
  assert.equal(r.matchReason, "exact_sku");
  assert.deepEqual(p.calls, ["barcode", "sku"], "stops at SKU; no name search");
});

test("exact-name fallback → NEEDS_REVIEW (never SAFE)", async () => {
  const p = fake(KEY, { barcode: ok([]), sku: ok([]), exactName: ok([cand(KEY)]) });
  const r = await runSnoonuDiscovery(p, query());
  assert.equal(r.classification, "NEEDS_REVIEW");
  assert.equal(r.matchReason, "exact_name");
  assert.equal(r.confidence, "medium");
  assert.deepEqual(p.calls, ["barcode", "sku", "exactName"]);
});

test("contains-name fallback → NEEDS_REVIEW low", async () => {
  const p = fake(KEY, { barcode: ok([]), sku: ok([]), exactName: ok([]), containsName: ok([cand(KEY), cand(KEY, { spi: "SPI2" })]) });
  const r = await runSnoonuDiscovery(p, query());
  assert.equal(r.classification, "NEEDS_REVIEW");
  assert.equal(r.matchReason, "contains_name");
  assert.equal(r.confidence, "low");
  assert.deepEqual(p.calls, ["barcode", "sku", "exactName", "containsName"]);
});

test("multiple barcode candidates → NEEDS_REVIEW (never SAFE)", async () => {
  const p = fake(KEY, { barcode: ok([cand(KEY), cand(KEY, { spi: "SPI2" })]) });
  const r = await runSnoonuDiscovery(p, query());
  assert.equal(r.classification, "NEEDS_REVIEW");
  assert.equal(r.matchReason, "multiple_barcode");
  assert.equal(r.candidateCount, 2);
});

test("no results anywhere → NO_MATCH", async () => {
  const p = fake(KEY, {});
  const r = await runSnoonuDiscovery(p, query());
  assert.equal(r.classification, "NO_MATCH");
  assert.equal(r.matchReason, "no_match");
  assert.equal(r.candidateCount, 0);
});

test("session_required → SESSION_REQUIRED, NO search attempted, NO fabricated result", async () => {
  const p = fake(KEY, { state: "session_required" });
  const r = await runSnoonuDiscovery(p, query());
  assert.equal(r.classification, "SESSION_REQUIRED");
  assert.equal(r.matchReason, "session_required");
  assert.equal(r.candidateCount, 0);
  assert.deepEqual(p.calls, [], "no search method is ever called without a session");
});

test("otp_required also yields SESSION_REQUIRED (no live discovery)", async () => {
  const p = fake(KEY, { state: "otp_required" });
  const r = await runSnoonuDiscovery(p, query());
  assert.equal(r.classification, "SESSION_REQUIRED");
  assert.deepEqual(p.calls, []);
});

test("provider error → ERROR", async () => {
  const p = fake(KEY, { state: "error" });
  const r = await runSnoonuDiscovery(p, query());
  assert.equal(r.classification, "ERROR");
  assert.equal(r.matchReason, "error");
});

test("not searchable (no barcode/sku/name) → NO_MATCH not_searchable", async () => {
  const p = fake(KEY, {});
  const r = await runSnoonuDiscovery(p, query({ barcode: null, sku: null, name: null }));
  assert.equal(r.classification, "NO_MATCH");
  assert.equal(r.matchReason, "not_searchable");
  assert.deepEqual(p.calls, [], "no search runs when there is nothing to search by");
});

test("storefront isolation: result + candidates retain their own storefront", async () => {
  const ps = fake("snoonu:pure_seoul", { barcode: ok([cand("snoonu:pure_seoul", { spi: "PS-1" })]) });
  const r = await runSnoonuDiscovery(ps, { storefrontKey: "snoonu:pure_seoul", barcode: "123456", sku: "mk1", name: "P" });
  assert.equal(r.storefrontKey, "snoonu:pure_seoul");
  assert.equal(r.candidates[0]!.storefrontKey, "snoonu:pure_seoul");
  assert.equal(r.candidates[0]!.spi, "PS-1", "Pure Seoul SPI is never a Malikas SPI");
});

test("a session that expires mid-search surfaces SESSION_REQUIRED (no partial fabrication)", async () => {
  const p = fake(KEY, { barcode: ok([]), sku: { state: "session_required", candidates: [] } });
  const r = await runSnoonuDiscovery(p, query());
  assert.equal(r.classification, "SESSION_REQUIRED");
  assert.equal(r.candidateCount, 0);
});
