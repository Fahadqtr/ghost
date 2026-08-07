// Product Timeline & Activity engine tests (Phase UI.7.4). PURE — no
// db/network/clock. Run:
// node --conditions=react-server --experimental-strip-types --test lib/operations/timeline/activity-engine.test.ts

import test from "node:test";
import assert from "node:assert/strict";

import { deriveActivityEvents, sortActivityEvents } from "./activity-engine.ts";
import type { ActivityEvent, ActivityProductSnapshot } from "../shared/models.ts";

function snap(over: Partial<ActivityProductSnapshot> = {}): ActivityProductSnapshot {
  return {
    id: "p1",
    sku: "mk123",
    barcode: "6291041500213",
    nameAr: "كريم مرطب",
    nameEn: "Hydrating Cream",
    imageUrl: "https://cdn.example.test/mk123.jpg",
    approval: "",
    platformStatus: "",
    createdAt: null,
    updatedAt: null,
    ...over,
  };
}

const CREATED = "2026-08-01T10:00:00.000Z";
const UPDATED = "2026-08-05T12:00:00.000Z";

// ── derivation ────────────────────────────────────────────────────────────────

test("a fully-processed product derives created + updated + approved + published, newest first", () => {
  const events = deriveActivityEvents(
    snap({ createdAt: CREATED, updatedAt: UPDATED, approval: "Approved", platformStatus: "shopify" }),
  );
  // updated/approved/published share the update time (newest); created is oldest.
  assert.deepEqual(events.map((e) => e.kind), ["updated", "approved", "published", "created"]);
});

test("event ids are deterministic `<kind>:<productId>`", () => {
  const events = deriveActivityEvents(snap({ createdAt: CREATED, approval: "Approved" }));
  const byKind = new Map(events.map((e) => [e.kind, e.id]));
  assert.equal(byKind.get("created"), "created:p1");
  assert.equal(byKind.get("approved"), "approved:p1");
});

test("atKnown is true only for created/updated (independently-timed), false for state events", () => {
  const events = deriveActivityEvents(
    snap({ createdAt: CREATED, updatedAt: UPDATED, approval: "Approved", platformStatus: "shopify" }),
  );
  const known = (k: string) => events.find((e) => e.kind === k)!.atKnown;
  assert.equal(known("created"), true);
  assert.equal(known("updated"), true);
  assert.equal(known("approved"), false);
  assert.equal(known("published"), false);
});

test("state events are anchored to the last-change time (updated_at)", () => {
  const events = deriveActivityEvents(
    snap({ createdAt: CREATED, updatedAt: UPDATED, approval: "Approved", platformStatus: "shopify" }),
  );
  assert.equal(events.find((e) => e.kind === "approved")!.at, UPDATED);
  assert.equal(events.find((e) => e.kind === "published")!.at, UPDATED);
});

test("a brand-new product (only created_at) yields exactly one 'created' event", () => {
  const events = deriveActivityEvents(snap({ createdAt: CREATED }));
  assert.deepEqual(events.map((e) => e.kind), ["created"]);
  assert.equal(events[0]!.at, CREATED);
});

test("no 'updated' event when updated_at equals created_at (no genuine later edit)", () => {
  const events = deriveActivityEvents(snap({ createdAt: CREATED, updatedAt: CREATED, approval: "Approved" }));
  // approved is anchored to the (equal) time and sorts above created on the tie.
  assert.deepEqual(events.map((e) => e.kind), ["approved", "created"]);
});

test("approval text maps to the right kind (approved / rejected / sent_to_ai)", () => {
  assert.equal(deriveActivityEvents(snap({ createdAt: CREATED, approval: "Approved" })).some((e) => e.kind === "approved"), true);
  assert.equal(deriveActivityEvents(snap({ createdAt: CREATED, approval: "Rejected" })).some((e) => e.kind === "rejected"), true);
  assert.equal(deriveActivityEvents(snap({ createdAt: CREATED, approval: "SentAI" })).some((e) => e.kind === "sent_to_ai"), true);
  // an unknown approval string produces NO approval event (never guessed).
  assert.equal(deriveActivityEvents(snap({ createdAt: CREATED, approval: "Whatever" })).some((e) => e.kind === "approved"), false);
});

test("publish event appears only when platform_status is non-empty", () => {
  assert.equal(deriveActivityEvents(snap({ createdAt: CREATED, platformStatus: "shopify" })).some((e) => e.kind === "published"), true);
  assert.equal(deriveActivityEvents(snap({ createdAt: CREATED, platformStatus: "" })).some((e) => e.kind === "published"), false);
  assert.equal(deriveActivityEvents(snap({ createdAt: CREATED, platformStatus: "   " })).some((e) => e.kind === "published"), false);
});

// ── honest unknowns / empty ───────────────────────────────────────────────────

test("a snapshot with no timestamps and no state derives an EMPTY timeline (never guessed)", () => {
  assert.deepEqual(deriveActivityEvents(snap()), []);
});

test("an unparseable created_at produces no 'created' event", () => {
  const events = deriveActivityEvents(snap({ createdAt: "not-a-date", updatedAt: UPDATED }));
  assert.equal(events.some((e) => e.kind === "created"), false);
  assert.equal(events.some((e) => e.kind === "updated"), true);
});

test("an empty product id yields an empty timeline", () => {
  assert.deepEqual(deriveActivityEvents(snap({ id: "", createdAt: CREATED })), []);
});

// ── ordering + determinism ────────────────────────────────────────────────────

test("events are ordered newest-first across distinct timestamps", () => {
  const events = deriveActivityEvents(snap({ createdAt: CREATED, updatedAt: UPDATED }));
  assert.deepEqual(events.map((e) => e.kind), ["updated", "created"]);
});

test("sortActivityEvents is deterministic, idempotent, and non-mutating", () => {
  const derived = deriveActivityEvents(
    snap({ createdAt: CREATED, updatedAt: UPDATED, approval: "Approved", platformStatus: "shopify" }),
  );
  // Shuffle a copy, then re-sort → identical to the engine's order.
  const shuffled: ActivityEvent[] = [derived[2]!, derived[0]!, derived[3]!, derived[1]!];
  const before = shuffled.map((e) => e.id);
  const resorted = sortActivityEvents(shuffled);
  assert.deepEqual(resorted.map((e) => e.id), derived.map((e) => e.id));
  assert.deepEqual(sortActivityEvents(resorted).map((e) => e.id), resorted.map((e) => e.id), "idempotent");
  assert.deepEqual(shuffled.map((e) => e.id), before, "does not mutate the input");
});

test("deriving twice over the same snapshot returns identical events", () => {
  const s = snap({ createdAt: CREATED, updatedAt: UPDATED, approval: "Rejected", platformStatus: "talabat" });
  assert.deepEqual(deriveActivityEvents(s), deriveActivityEvents(s));
});
