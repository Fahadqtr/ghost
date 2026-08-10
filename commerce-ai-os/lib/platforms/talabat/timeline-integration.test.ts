// Phase UI.9.6 — Talabat snapshots flow into Platform History + Timeline through
// the UNCHANGED generic engine (no Talabat-specific logic in history/timeline).
// Run: node --experimental-strip-types --test lib/platforms/talabat/timeline-integration.test.ts

import test from "node:test";
import assert from "node:assert/strict";

import { diffToSnapshotInputs, type TalabatCatalogRow } from "./capture-compute.ts";
import { createSnapshot } from "../core/snapshot.ts";
import { buildPlatformHistory } from "../core/history.ts";
import { createPlatformTimelineProviders, platformToTimelineSource } from "../../operations/timeline/providers/platform-provider.ts";
import { buildTimeline } from "../../operations/timeline/timeline-engine.ts";

const ours: TalabatCatalogRow[] = [{ id: "p1", sku: "S1", barcode: null, name_en: "One", name_ar: null, approval: "Approved" }];
const snap = (missing: string[], at: string) =>
  createSnapshot(diffToSnapshotInputs(ours, { ok: true, missing: missing.map((product_id) => ({ product_id })) }, at)[0]!);

test("talabat platform id maps to the talabat timeline source", () => {
  assert.equal(platformToTimelineSource("talabat"), "talabat");
});

test("a captured Talabat snapshot becomes a talabat timeline event", () => {
  const created = snap([], "2026-08-01T10:00:00.000Z"); // present
  const changed = snap(["p1"], "2026-08-05T10:00:00.000Z"); // flipped to missing
  const entries = buildPlatformHistory([created, changed]);
  assert.equal(entries.length, 2); // created + changed

  const events = buildTimeline(createPlatformTimelineProviders(entries));
  assert.ok(events.length >= 2);
  for (const e of events) {
    assert.equal(e.source, "talabat");
    assert.ok(e.kind === "platform_created" || e.kind === "platform_changed");
    assert.equal(e.productId, "p1");
    // values-free: no raw verdict/sku leaks into the card copy
    assert.equal(/present|missing|S1/.test(`${e.title} ${e.description}`), false);
  }
});

test("identical repeat produces no timeline event (unchanged dropped)", () => {
  const a = snap([], "2026-08-01T10:00:00.000Z");
  const b = snap([], "2026-08-02T10:00:00.000Z");
  assert.equal(buildPlatformHistory([a, b]).length, 1);
});
