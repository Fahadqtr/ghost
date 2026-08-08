// PureSoul mapper tests (Phase UI.9.1). PURE — no db/network/clock.
// Run: node --conditions=react-server --experimental-strip-types --test lib/platforms/puresoul/mapper.test.ts
//
// These pin presence → status through the REAL operations engine, so the whole
// contract is proven: InStock=published, OutOfStock=ready, Rejected=review, and
// a product with no overlay row is "unknown" — NEVER "missing"/"different".

import test from "node:test";
import assert from "node:assert/strict";

import { overlayRowToPresence, buildPureSoulPresence } from "./mapper.ts";
import { computePlatformStatusValue } from "../../operations/platforms/platform-status.ts";
import type { PureSoulOverlayRow } from "./types.ts";

const row = (over: Partial<PureSoulOverlayRow> = {}): PureSoulOverlayRow => ({
  productId: "p",
  approval: null,
  availability: null,
  ...over,
});

test("InStock → linked+live → status 'published'", () => {
  const pres = overlayRowToPresence(row({ availability: "InStock" }));
  assert.deepEqual(pres, { linked: true, live: true, drift: false, reviewRequired: false });
  assert.equal(computePlatformStatusValue(pres, false), "published");
});

test("OutOfStock → linked, not live → status 'ready' (مخلّصة), never missing", () => {
  const pres = overlayRowToPresence(row({ availability: "OutOfStock" }));
  assert.deepEqual(pres, { linked: true, live: false, drift: false, reviewRequired: false });
  assert.equal(computePlatformStatusValue(pres, false), "ready");
});

test("Rejected → review_required (regardless of availability)", () => {
  const pres = overlayRowToPresence(row({ approval: "Rejected", availability: "InStock" }));
  assert.equal(pres.reviewRequired, true);
  assert.equal(computePlatformStatusValue(pres, false), "review_required");
});

test("a blank overlay row is still 'known on PureSoul' (linked) → ready, not missing", () => {
  const pres = overlayRowToPresence(row({ approval: "", availability: null }));
  assert.equal(pres.linked, true);
  assert.equal(computePlatformStatusValue(pres, false), "ready");
});

test("never emits 'different' — drift is always false", () => {
  const pres = overlayRowToPresence(row({ availability: "InStock", approval: "Approved" }));
  assert.equal(pres.drift, false);
  assert.notEqual(computePlatformStatusValue(pres, false), "different");
});

test("case/space-insensitive availability + approval", () => {
  assert.equal(overlayRowToPresence(row({ availability: "  instock " })).live, true);
  assert.equal(overlayRowToPresence(row({ approval: " REJECTED " })).reviewRequired, true);
});

test("buildPureSoulPresence: one presence per row; blank ids skipped", () => {
  const rows: PureSoulOverlayRow[] = [
    row({ productId: "a", availability: "InStock" }),
    row({ productId: "b", availability: "OutOfStock" }),
    row({ productId: "", availability: "InStock" }),
    row({ productId: "  ", availability: "InStock" }),
  ];
  const map = buildPureSoulPresence(rows);
  assert.equal(map.size, 2);
  assert.equal(map.get("a")?.live, true);
  assert.equal(map.get("b")?.live, false);
});

test("a product with NO overlay row is absent from the map → engine reports 'unknown'", () => {
  const map = buildPureSoulPresence([row({ productId: "a", availability: "InStock" })]);
  assert.equal(map.has("other"), false);
  // the engine's undefined-presence path (what the caller passes for 'other'):
  // undefined presence is ALWAYS "unknown" (checked first) — we never pass a
  // linked:false snapshot, so PureSoul can never resolve to "missing".
  assert.equal(computePlatformStatusValue(undefined, false), "unknown");
  assert.equal(computePlatformStatusValue(undefined, true), "unknown");
});
