// Snapshot Timeline Provider tests (Phase UI.7.4). PURE — no db/network/clock.
// Run:
// node --conditions=react-server --experimental-strip-types --test lib/operations/timeline/providers/snapshot-provider.test.ts

import test from "node:test";
import assert from "node:assert/strict";

import {
  createSnapshotTimelineProvider,
  deriveSnapshotEvents,
  mapSnapshotRow,
} from "./snapshot-provider.ts";
import type { TimelineProductSnapshot } from "../../shared/models.ts";

function snap(over: Partial<TimelineProductSnapshot> = {}): TimelineProductSnapshot {
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

/** kinds as a sorted set (derivation order is not the provider's concern). */
const kindSet = (evs: { kind: string }[]) => [...evs.map((e) => e.kind)].sort();

// ── provider shape ────────────────────────────────────────────────────────────

test("the provider reports source 'snapshot' and getEvents returns its derivation", () => {
  const p = createSnapshotTimelineProvider(snap({ createdAt: CREATED, approval: "Approved" }));
  assert.equal(p.source, "snapshot");
  assert.deepEqual(kindSet(p.getEvents()), kindSet(deriveSnapshotEvents(snap({ createdAt: CREATED, approval: "Approved" }))));
  for (const e of p.getEvents()) assert.equal(e.source, "snapshot");
});

// ── derivation ────────────────────────────────────────────────────────────────

test("a fully-processed product derives created + updated + approved + published", () => {
  const events = deriveSnapshotEvents(
    snap({ createdAt: CREATED, updatedAt: UPDATED, approval: "Approved", platformStatus: "shopify" }),
  );
  assert.deepEqual(kindSet(events), ["approved", "created", "published", "updated"]);
});

test("event ids are deterministic `snapshot:<kind>:<productId>` and stamped with source", () => {
  const events = deriveSnapshotEvents(snap({ createdAt: CREATED, approval: "Approved" }));
  const byKind = new Map(events.map((e) => [e.kind, e]));
  assert.equal(byKind.get("created")!.id, "snapshot:created:p1");
  assert.equal(byKind.get("approved")!.id, "snapshot:approved:p1");
  assert.equal(byKind.get("created")!.source, "snapshot");
});

test("atKnown is true only for created/updated, false for state events", () => {
  const events = deriveSnapshotEvents(
    snap({ createdAt: CREATED, updatedAt: UPDATED, approval: "Approved", platformStatus: "shopify" }),
  );
  const known = (k: string) => events.find((e) => e.kind === k)!.atKnown;
  assert.equal(known("created"), true);
  assert.equal(known("updated"), true);
  assert.equal(known("approved"), false);
  assert.equal(known("published"), false);
});

test("state events are anchored to the last-change time (updated_at)", () => {
  const events = deriveSnapshotEvents(
    snap({ createdAt: CREATED, updatedAt: UPDATED, approval: "Approved", platformStatus: "shopify" }),
  );
  assert.equal(events.find((e) => e.kind === "approved")!.at, UPDATED);
  assert.equal(events.find((e) => e.kind === "published")!.at, UPDATED);
});

test("a brand-new product (only created_at) yields exactly one 'created' event", () => {
  const events = deriveSnapshotEvents(snap({ createdAt: CREATED }));
  assert.deepEqual(kindSet(events), ["created"]);
  assert.equal(events[0]!.at, CREATED);
});

test("no 'updated' event when updated_at equals created_at (no genuine later edit)", () => {
  const events = deriveSnapshotEvents(snap({ createdAt: CREATED, updatedAt: CREATED, approval: "Approved" }));
  assert.deepEqual(kindSet(events), ["approved", "created"]);
});

test("approval text maps to the right kind (approved / rejected / sent_to_ai)", () => {
  assert.ok(deriveSnapshotEvents(snap({ createdAt: CREATED, approval: "Approved" })).some((e) => e.kind === "approved"));
  assert.ok(deriveSnapshotEvents(snap({ createdAt: CREATED, approval: "Rejected" })).some((e) => e.kind === "rejected"));
  assert.ok(deriveSnapshotEvents(snap({ createdAt: CREATED, approval: "SentAI" })).some((e) => e.kind === "sent_to_ai"));
  assert.ok(!deriveSnapshotEvents(snap({ createdAt: CREATED, approval: "Whatever" })).some((e) => e.kind === "approved"));
});

test("publish event appears only when platform_status is non-empty", () => {
  assert.ok(deriveSnapshotEvents(snap({ createdAt: CREATED, platformStatus: "shopify" })).some((e) => e.kind === "published"));
  assert.ok(!deriveSnapshotEvents(snap({ createdAt: CREATED, platformStatus: "" })).some((e) => e.kind === "published"));
  assert.ok(!deriveSnapshotEvents(snap({ createdAt: CREATED, platformStatus: "   " })).some((e) => e.kind === "published"));
});

// ── honest unknowns / empty ───────────────────────────────────────────────────

test("a snapshot with no timestamps and no state derives an EMPTY set (never guessed)", () => {
  assert.deepEqual(deriveSnapshotEvents(snap()), []);
});

test("an unparseable created_at produces no 'created' event", () => {
  const events = deriveSnapshotEvents(snap({ createdAt: "not-a-date", updatedAt: UPDATED }));
  assert.ok(!events.some((e) => e.kind === "created"));
  assert.ok(events.some((e) => e.kind === "updated"));
});

test("an empty product id yields no events", () => {
  assert.deepEqual(deriveSnapshotEvents(snap({ id: "", createdAt: CREATED })), []);
});

test("deriving twice over the same snapshot returns identical events", () => {
  const s = snap({ createdAt: CREATED, updatedAt: UPDATED, approval: "Rejected", platformStatus: "talabat" });
  assert.deepEqual(deriveSnapshotEvents(s), deriveSnapshotEvents(s));
});

// ── row mapping (snapshot-source-specific) ────────────────────────────────────

test("mapSnapshotRow copies whitelisted fields and blanks become null", () => {
  const s = mapSnapshotRow({
    id: "p1", sku: "mk1", barcode: "  ", name_ar: "اسم", name_en: "", image_url: "u",
    approval: "Approved", platform_status: "shopify", created_at: CREATED, updated_at: UPDATED,
    stock_quantity: 99, // never copied
  });
  assert.equal(s.id, "p1");
  assert.equal(s.sku, "mk1");
  assert.equal(s.barcode, null, "whitespace-only → null");
  assert.equal(s.nameAr, "اسم");
  assert.equal(s.nameEn, null, "empty string → null");
  assert.equal(s.approval, "Approved");
  assert.equal(s.platformStatus, "shopify");
  assert.equal(s.createdAt, CREATED);
  assert.equal(s.updatedAt, UPDATED);
  assert.ok(!("stock_quantity" in (s as object)), "no non-whitelisted field leaks");
});

test("mapSnapshotRow tolerates a malformed row (non-string id → empty id)", () => {
  const s = mapSnapshotRow({ id: 123 as unknown as string });
  assert.equal(s.id, "");
  assert.equal(s.createdAt, null);
});
