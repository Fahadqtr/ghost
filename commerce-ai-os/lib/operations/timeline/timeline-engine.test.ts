// Timeline Engine tests (Phase UI.7.4). The engine is SOURCE-AGNOSTIC: it only
// aggregates + orders TimelineEvents from providers. PURE — no db/network/clock.
// Run:
// node --conditions=react-server --experimental-strip-types --test lib/operations/timeline/timeline-engine.test.ts

import test from "node:test";
import assert from "node:assert/strict";

import { buildTimeline, sortTimelineEvents } from "./timeline-engine.ts";
import { createSnapshotTimelineProvider } from "./providers/snapshot-provider.ts";
import type { TimelineProvider } from "./providers/timeline-provider.ts";
import type { TimelineEvent, TimelineProductSnapshot } from "../shared/models.ts";

let seq = 0;
function ev(over: Partial<TimelineEvent> = {}): TimelineEvent {
  seq += 1;
  return {
    id: over.id ?? `snapshot:created:e${seq}`,
    source: over.source ?? "snapshot",
    productId: over.productId ?? "p1",
    kind: over.kind ?? "created",
    at: over.at ?? "2026-08-01T10:00:00.000Z",
    atKnown: over.atKnown ?? true,
    title: over.title ?? "عنوان",
    description: over.description ?? "وصف",
  };
}

/** A trivial provider that returns a fixed set of events (any source). */
function fakeProvider(source: TimelineProvider["source"], events: TimelineEvent[]): TimelineProvider {
  return { source, getEvents: () => events };
}

const CREATED = "2026-08-01T10:00:00.000Z";
const UPDATED = "2026-08-05T12:00:00.000Z";
const MID = "2026-08-03T00:00:00.000Z";

function fullSnapshot(): TimelineProductSnapshot {
  return {
    id: "p1", sku: "mk1", barcode: null, nameAr: "اسم", nameEn: null, imageUrl: null,
    approval: "Approved", platformStatus: "shopify", createdAt: CREATED, updatedAt: UPDATED,
  };
}

// ── single-provider ordering ──────────────────────────────────────────────────

test("buildTimeline orders one provider's events newest-first (kind rank on ties)", () => {
  const events = buildTimeline([createSnapshotTimelineProvider(fullSnapshot())]);
  // updated/approved/published share UPDATED (newest); created (oldest) last.
  assert.deepEqual(events.map((e) => e.kind), ["updated", "approved", "published", "created"]);
});

test("buildTimeline over no providers, or providers with no events, is empty", () => {
  assert.deepEqual(buildTimeline([]), []);
  assert.deepEqual(buildTimeline([fakeProvider("ticktick", [])]), []);
});

// ── multi-provider merge (the point of the engine) ────────────────────────────

test("buildTimeline MERGES multiple sources and orders purely by time — source-agnostic", () => {
  const snapshot = createSnapshotTimelineProvider(fullSnapshot());
  const ticktick = fakeProvider("ticktick", [
    ev({ id: "ticktick:updated:p1", source: "ticktick", kind: "updated", at: MID }),
  ]);
  const merged = buildTimeline([snapshot, ticktick]);
  // 08-05 group (snapshot updated/approved/published) → 08-03 (ticktick) → 08-01 (snapshot created)
  assert.deepEqual(
    merged.map((e) => `${e.source}:${e.kind}`),
    ["snapshot:updated", "snapshot:approved", "snapshot:published", "ticktick:updated", "snapshot:created"],
  );
});

test("the final order is independent of the order providers are passed in", () => {
  const a = createSnapshotTimelineProvider(fullSnapshot());
  const b = fakeProvider("ticktick", [ev({ id: "ticktick:updated:p1", source: "ticktick", kind: "updated", at: MID })]);
  assert.deepEqual(buildTimeline([a, b]).map((e) => e.id), buildTimeline([b, a]).map((e) => e.id));
});

test("buildTimeline de-duplicates by id (keeps the first occurrence)", () => {
  const dup = fakeProvider("ai", [
    ev({ id: "ai:created:p1", source: "ai", at: CREATED }),
    ev({ id: "ai:created:p1", source: "ai", at: CREATED }),
  ]);
  const out = buildTimeline([dup]);
  assert.equal(out.length, 1);
  assert.equal(out[0]!.id, "ai:created:p1");
});

// ── sort determinism ──────────────────────────────────────────────────────────

test("sortTimelineEvents is deterministic, idempotent, and non-mutating", () => {
  const derived = buildTimeline([createSnapshotTimelineProvider(fullSnapshot())]);
  const shuffled: TimelineEvent[] = [derived[2]!, derived[0]!, derived[3]!, derived[1]!];
  const before = shuffled.map((e) => e.id);
  const resorted = sortTimelineEvents(shuffled);
  assert.deepEqual(resorted.map((e) => e.id), derived.map((e) => e.id));
  assert.deepEqual(sortTimelineEvents(resorted).map((e) => e.id), resorted.map((e) => e.id), "idempotent");
  assert.deepEqual(shuffled.map((e) => e.id), before, "does not mutate the input");
});

test("events with an unknown/unparseable time sort to the bottom (oldest)", () => {
  const known = ev({ id: "a:x:p1", source: "shopify", at: UPDATED });
  const unknown = ev({ id: "b:x:p1", source: "shopify", at: null });
  assert.deepEqual(sortTimelineEvents([unknown, known]).map((e) => e.id), ["a:x:p1", "b:x:p1"]);
});
