// Phase UI.9.7 — Rafeeq snapshots flow into Platform History + Timeline through
// the UNCHANGED generic engine (no Rafeeq-specific logic in history/timeline).
// Run: node --experimental-strip-types --test lib/platforms/rafeeq/timeline-integration.test.ts

import test from "node:test";
import assert from "node:assert/strict";

import { buildRafeeqSnapshotInputs, type RafeeqProductRow } from "./capture-compute.ts";
import { createSnapshot } from "../core/snapshot.ts";
import { buildPlatformHistory } from "../core/history.ts";
import { createPlatformTimelineProviders, platformToTimelineSource } from "../../operations/timeline/providers/platform-provider.ts";
import { buildTimeline } from "../../operations/timeline/timeline-engine.ts";

const products: RafeeqProductRow[] = [{ id: "p1", sku: "S1", barcode: null, name_en: "One", name_ar: null, rafeeq_product_id: "R1" }];
const snap = (status: string, at: string) =>
  createSnapshot(buildRafeeqSnapshotInputs(products, new Map([["p1", status]]), at)[0]!);

test("rafeeq platform id maps to the rafeeq timeline source", () => {
  assert.equal(platformToTimelineSource("rafeeq"), "rafeeq");
});

test("a captured Rafeeq snapshot becomes a rafeeq timeline event", () => {
  const created = snap("Active", "2026-08-01T10:00:00.000Z"); // present
  const changed = snap("Not Listed", "2026-08-05T10:00:00.000Z"); // → missing
  const entries = buildPlatformHistory([created, changed]);
  assert.equal(entries.length, 2);

  const events = buildTimeline(createPlatformTimelineProviders(entries));
  assert.ok(events.length >= 2);
  for (const e of events) {
    assert.equal(e.source, "rafeeq");
    assert.ok(e.kind === "platform_created" || e.kind === "platform_changed");
    assert.equal(e.productId, "p1");
    // values-free: no raw status/id leaks into the card copy
    assert.equal(/Active|Not Listed|R1/.test(`${e.title} ${e.description}`), false);
  }
});

test("identical repeat produces no timeline event (unchanged dropped)", () => {
  const a = snap("Active", "2026-08-01T10:00:00.000Z");
  const b = snap("Active", "2026-08-02T10:00:00.000Z");
  assert.equal(buildPlatformHistory([a, b]).length, 1);
});
