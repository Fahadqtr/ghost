// Timeline view-layer tests (Phase UI.7.4). PURE — no db/network/clock.
// Run:
// node --conditions=react-server --experimental-strip-types --test lib/operations/timeline/timeline-view.test.ts

import test from "node:test";
import assert from "node:assert/strict";

import {
  filterTimelineEvents,
  searchTimelineEvents,
  parseTimelineControls,
  selectTimelineEvents,
  summarizeTimeline,
  formatTimelineDate,
  timelineWidgetEvents,
  TIMELINE_FILTER_VALUES,
  TIMELINE_FILTER_LABELS,
  TIMELINE_ICONS,
  TIMELINE_KIND_LABELS,
} from "./timeline-view.ts";
import { buildTimeline } from "./timeline-engine.ts";
import { createSnapshotTimelineProvider } from "./providers/snapshot-provider.ts";
import type { TimelineEvent, TimelineEventKind, TimelineProductSnapshot } from "../shared/models.ts";

let seq = 0;
function ev(over: Partial<TimelineEvent> = {}): TimelineEvent {
  seq += 1;
  return {
    id: over.id ?? `snapshot:created:k${seq}`,
    source: over.source ?? "snapshot",
    productId: over.productId ?? "p1",
    kind: over.kind ?? "created",
    at: over.at ?? "2026-08-01T10:00:00.000Z",
    atKnown: over.atKnown ?? true,
    title: over.title ?? "عنوان",
    description: over.description ?? "وصف",
  };
}

// ── filters ───────────────────────────────────────────────────────────────────

test("filters select exactly the matching kinds; approval groups all approval kinds", () => {
  const items = [
    ev({ id: "c", kind: "created" }),
    ev({ id: "u", kind: "updated" }),
    ev({ id: "a", kind: "approved" }),
    ev({ id: "r", kind: "rejected" }),
    ev({ id: "s", kind: "sent_to_ai" }),
    ev({ id: "p", kind: "published" }),
  ];
  assert.deepEqual(filterTimelineEvents(items, "all").map((e) => e.id), ["c", "u", "a", "r", "s", "p"]);
  assert.deepEqual(filterTimelineEvents(items, "created").map((e) => e.id), ["c"]);
  assert.deepEqual(filterTimelineEvents(items, "updated").map((e) => e.id), ["u"]);
  assert.deepEqual(filterTimelineEvents(items, "approval").map((e) => e.id), ["a", "r", "s"]);
  assert.deepEqual(filterTimelineEvents(items, "platform").map((e) => e.id), ["p"]);
});

test("filterTimelineEvents is order-preserving and non-mutating", () => {
  const items = [ev({ id: "a", kind: "approved" }), ev({ id: "c", kind: "created" })];
  const before = items.map((e) => e.id);
  filterTimelineEvents(items, "all");
  assert.deepEqual(items.map((e) => e.id), before);
});

// ── search ────────────────────────────────────────────────────────────────────

test("searchTimelineEvents matches title/description case-insensitively; blank = passthrough", () => {
  const items = [
    ev({ id: "1", title: "أُنشئ المنتج", description: "تمت الإضافة" }),
    ev({ id: "2", title: "منشور على منصة", description: "Shopify push" }),
  ];
  assert.equal(searchTimelineEvents(items, "منصة").length, 1);
  assert.equal(searchTimelineEvents(items, "shopify").length, 1);
  assert.equal(searchTimelineEvents(items, "SHOPIFY").length, 1);
  assert.equal(searchTimelineEvents(items, "   ").length, 2, "whitespace-only query is a passthrough");
  assert.equal(searchTimelineEvents(items, "nomatch").length, 0);
});

// ── controls ──────────────────────────────────────────────────────────────────

test("parseTimelineControls validates the filter, trims + caps the query, handles arrays/null", () => {
  assert.deepEqual(parseTimelineControls({ filter: "approval", query: "hello" }), { query: "hello", filter: "approval" });
  assert.deepEqual(parseTimelineControls({ filter: "bogus" }), { query: "", filter: "all" });
  assert.equal(parseTimelineControls({ query: ["first", "second"] }).query, "first", "array param → first value");
  assert.equal(parseTimelineControls(undefined).filter, "all");
  assert.equal(parseTimelineControls(null).query, "");
  assert.equal(parseTimelineControls({ query: "x".repeat(200) }).query.length, 80, "query is length-capped");
});

test("selectTimelineEvents runs filter → search together (order preserved)", () => {
  const items = [
    ev({ id: "a", kind: "approved", title: "اعتماد keep" }),
    ev({ id: "c", kind: "created", title: "إنشاء keep" }),
    ev({ id: "r", kind: "rejected", title: "رفض drop" }),
  ];
  const out = selectTimelineEvents(items, { query: "keep", filter: "approval" });
  assert.deepEqual(out.map((e) => e.id), ["a"], "approval filter + 'keep' search leaves only the approved event");
});

// ── summary ───────────────────────────────────────────────────────────────────

test("summarizeTimeline counts over the WHOLE set", () => {
  const items = [
    ev({ kind: "created" }), ev({ kind: "updated" }),
    ev({ kind: "approved" }), ev({ kind: "rejected" }), ev({ kind: "published" }),
  ];
  assert.deepEqual(summarizeTimeline(items), { total: 5, created: 1, updated: 1, approval: 2, platform: 1 });
});

test("summarizeTimeline on an empty set is all zeros", () => {
  assert.deepEqual(summarizeTimeline([]), { total: 0, created: 0, updated: 0, approval: 0, platform: 0 });
});

// ── date formatting (pure, clock-free) ────────────────────────────────────────

test("formatTimelineDate renders an absolute Arabic date; unknown/invalid → dash", () => {
  assert.equal(formatTimelineDate("2026-08-07T12:34:56.000Z"), "7 أغسطس 2026");
  assert.equal(formatTimelineDate("2026-01-01"), "1 يناير 2026");
  assert.equal(formatTimelineDate(null), "—");
  assert.equal(formatTimelineDate("not-a-date"), "—");
  assert.equal(formatTimelineDate("2026-13-40"), "—", "out-of-range month/day → dash");
});

test("formatTimelineDate is deterministic (same input → same output)", () => {
  assert.equal(formatTimelineDate("2026-08-05T00:00:00Z"), formatTimelineDate("2026-08-05T23:59:59Z"));
});

// ── labels / icons cover every value ──────────────────────────────────────────

test("every filter value has a label", () => {
  for (const f of TIMELINE_FILTER_VALUES) {
    assert.equal(typeof TIMELINE_FILTER_LABELS[f], "string");
    assert.ok(TIMELINE_FILTER_LABELS[f].length > 0);
  }
});

test("every event kind has an icon key and a kind label", () => {
  const kinds: TimelineEventKind[] = ["created", "updated", "approved", "rejected", "sent_to_ai", "published"];
  for (const k of kinds) {
    assert.equal(typeof TIMELINE_ICONS[k], "string");
    assert.ok(TIMELINE_ICONS[k].length > 0);
    assert.equal(typeof TIMELINE_KIND_LABELS[k], "string");
    assert.ok(TIMELINE_KIND_LABELS[k].length > 0);
  }
});

// ── widget ────────────────────────────────────────────────────────────────────

test("timelineWidgetEvents shows the first N and reports the remainder", () => {
  const items = Array.from({ length: 5 }, (_, i) => ev({ id: `w${i}` }));
  const { shown, remaining } = timelineWidgetEvents(items, 3);
  assert.equal(shown.length, 3);
  assert.equal(remaining, 2);
  assert.deepEqual(shown.map((e) => e.id), ["w0", "w1", "w2"]);

  const few = timelineWidgetEvents(items.slice(0, 2), 3);
  assert.equal(few.shown.length, 2);
  assert.equal(few.remaining, 0, "never negative");
});

// ── end-to-end with the real engine + provider ────────────────────────────────

test("view pipeline composes with the engine's aggregated output", () => {
  const snapshot: TimelineProductSnapshot = {
    id: "p1", sku: "mk1", barcode: null, nameAr: "اسم", nameEn: null, imageUrl: null,
    approval: "Approved", platformStatus: "shopify",
    createdAt: "2026-08-01T10:00:00.000Z", updatedAt: "2026-08-05T12:00:00.000Z",
  };
  const events = buildTimeline([createSnapshotTimelineProvider(snapshot)]);
  assert.deepEqual(summarizeTimeline(events), { total: 4, created: 1, updated: 1, approval: 1, platform: 1 });
  assert.deepEqual(
    selectTimelineEvents(events, { query: "", filter: "platform" }).map((e) => e.kind),
    ["published"],
  );
});
