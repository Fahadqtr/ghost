// Product Timeline view-layer tests (Phase UI.7.4). PURE — no db/network/clock.
// Run:
// node --conditions=react-server --experimental-strip-types --test lib/operations/timeline/activity-view.test.ts

import test from "node:test";
import assert from "node:assert/strict";

import {
  mapActivityRow,
  filterActivityEvents,
  searchActivityEvents,
  parseActivityControls,
  selectActivityEvents,
  summarizeActivity,
  formatActivityDate,
  activityWidgetEvents,
  ACTIVITY_FILTER_VALUES,
  ACTIVITY_FILTER_LABELS,
  ACTIVITY_ICONS,
  ACTIVITY_KIND_LABELS,
} from "./activity-view.ts";
import { deriveActivityEvents } from "./activity-engine.ts";
import type { ActivityEvent, ActivityEventKind, ActivityProductSnapshot } from "../shared/models.ts";

let seq = 0;
function ev(over: Partial<ActivityEvent> = {}): ActivityEvent {
  seq += 1;
  return {
    id: over.id ?? `k${seq}`,
    productId: over.productId ?? "p1",
    kind: over.kind ?? "created",
    at: over.at ?? "2026-08-01T10:00:00.000Z",
    atKnown: over.atKnown ?? true,
    title: over.title ?? "عنوان",
    description: over.description ?? "وصف",
  };
}

// ── row mapping ───────────────────────────────────────────────────────────────

test("mapActivityRow copies whitelisted fields and blanks become null", () => {
  const s = mapActivityRow({
    id: "p1", sku: "mk1", barcode: "  ", name_ar: "اسم", name_en: "", image_url: "u",
    approval: "Approved", platform_status: "shopify", created_at: "2026-08-01T10:00:00Z", updated_at: "2026-08-05T12:00:00Z",
    stock_quantity: 99, // never copied
  });
  assert.equal(s.id, "p1");
  assert.equal(s.sku, "mk1");
  assert.equal(s.barcode, null, "whitespace-only → null");
  assert.equal(s.nameAr, "اسم");
  assert.equal(s.nameEn, null, "empty string → null");
  assert.equal(s.approval, "Approved");
  assert.equal(s.platformStatus, "shopify");
  assert.equal(s.createdAt, "2026-08-01T10:00:00Z");
  assert.equal(s.updatedAt, "2026-08-05T12:00:00Z");
  assert.ok(!("stock_quantity" in (s as object)), "no non-whitelisted field leaks");
});

test("mapActivityRow tolerates a malformed row (non-string id → empty id)", () => {
  const s = mapActivityRow({ id: 123 as unknown as string });
  assert.equal(s.id, "");
  assert.equal(s.createdAt, null);
});

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
  assert.deepEqual(filterActivityEvents(items, "all").map((e) => e.id), ["c", "u", "a", "r", "s", "p"]);
  assert.deepEqual(filterActivityEvents(items, "created").map((e) => e.id), ["c"]);
  assert.deepEqual(filterActivityEvents(items, "updated").map((e) => e.id), ["u"]);
  assert.deepEqual(filterActivityEvents(items, "approval").map((e) => e.id), ["a", "r", "s"]);
  assert.deepEqual(filterActivityEvents(items, "platform").map((e) => e.id), ["p"]);
});

test("filterActivityEvents is order-preserving and non-mutating", () => {
  const items = [ev({ id: "a", kind: "approved" }), ev({ id: "c", kind: "created" })];
  const before = items.map((e) => e.id);
  filterActivityEvents(items, "all");
  assert.deepEqual(items.map((e) => e.id), before);
});

// ── search ────────────────────────────────────────────────────────────────────

test("searchActivityEvents matches title/description case-insensitively; blank = passthrough", () => {
  const items = [
    ev({ id: "1", title: "أُنشئ المنتج", description: "تمت الإضافة" }),
    ev({ id: "2", title: "منشور على منصة", description: "Shopify push" }),
  ];
  assert.equal(searchActivityEvents(items, "منصة").length, 1);
  assert.equal(searchActivityEvents(items, "shopify").length, 1);
  assert.equal(searchActivityEvents(items, "SHOPIFY").length, 1);
  assert.equal(searchActivityEvents(items, "   ").length, 2, "whitespace-only query is a passthrough");
  assert.equal(searchActivityEvents(items, "nomatch").length, 0);
});

// ── controls ──────────────────────────────────────────────────────────────────

test("parseActivityControls validates the filter, trims + caps the query, handles arrays/null", () => {
  assert.deepEqual(parseActivityControls({ filter: "approval", query: "hello" }), { query: "hello", filter: "approval" });
  assert.deepEqual(parseActivityControls({ filter: "bogus" }), { query: "", filter: "all" });
  assert.equal(parseActivityControls({ query: ["first", "second"] }).query, "first", "array param → first value");
  assert.equal(parseActivityControls(undefined).filter, "all");
  assert.equal(parseActivityControls(null).query, "");
  assert.equal(parseActivityControls({ query: "x".repeat(200) }).query.length, 80, "query is length-capped");
});

test("selectActivityEvents runs filter → search together (order preserved)", () => {
  const items = [
    ev({ id: "a", kind: "approved", title: "اعتماد keep" }),
    ev({ id: "c", kind: "created", title: "إنشاء keep" }),
    ev({ id: "r", kind: "rejected", title: "رفض drop" }),
  ];
  const out = selectActivityEvents(items, { query: "keep", filter: "approval" });
  assert.deepEqual(out.map((e) => e.id), ["a"], "approval filter + 'keep' search leaves only the approved event");
});

// ── summary ───────────────────────────────────────────────────────────────────

test("summarizeActivity counts over the WHOLE set", () => {
  const items = [
    ev({ kind: "created" }), ev({ kind: "updated" }),
    ev({ kind: "approved" }), ev({ kind: "rejected" }), ev({ kind: "published" }),
  ];
  assert.deepEqual(summarizeActivity(items), { total: 5, created: 1, updated: 1, approval: 2, platform: 1 });
});

test("summarizeActivity on an empty set is all zeros", () => {
  assert.deepEqual(summarizeActivity([]), { total: 0, created: 0, updated: 0, approval: 0, platform: 0 });
});

// ── date formatting (pure, clock-free) ────────────────────────────────────────

test("formatActivityDate renders an absolute Arabic date; unknown/invalid → dash", () => {
  assert.equal(formatActivityDate("2026-08-07T12:34:56.000Z"), "7 أغسطس 2026");
  assert.equal(formatActivityDate("2026-01-01"), "1 يناير 2026");
  assert.equal(formatActivityDate(null), "—");
  assert.equal(formatActivityDate("not-a-date"), "—");
  assert.equal(formatActivityDate("2026-13-40"), "—", "out-of-range month/day → dash");
});

test("formatActivityDate is deterministic (same input → same output)", () => {
  assert.equal(formatActivityDate("2026-08-05T00:00:00Z"), formatActivityDate("2026-08-05T23:59:59Z"));
});

// ── labels / icons cover every value ──────────────────────────────────────────

test("every filter value has a label", () => {
  for (const f of ACTIVITY_FILTER_VALUES) {
    assert.equal(typeof ACTIVITY_FILTER_LABELS[f], "string");
    assert.ok(ACTIVITY_FILTER_LABELS[f].length > 0);
  }
});

test("every event kind has an icon key and a kind label", () => {
  const kinds: ActivityEventKind[] = ["created", "updated", "approved", "rejected", "sent_to_ai", "published"];
  for (const k of kinds) {
    assert.equal(typeof ACTIVITY_ICONS[k], "string");
    assert.ok(ACTIVITY_ICONS[k].length > 0);
    assert.equal(typeof ACTIVITY_KIND_LABELS[k], "string");
    assert.ok(ACTIVITY_KIND_LABELS[k].length > 0);
  }
});

// ── widget ────────────────────────────────────────────────────────────────────

test("activityWidgetEvents shows the first N and reports the remainder", () => {
  const items = Array.from({ length: 5 }, (_, i) => ev({ id: `w${i}` }));
  const { shown, remaining } = activityWidgetEvents(items, 3);
  assert.equal(shown.length, 3);
  assert.equal(remaining, 2);
  assert.deepEqual(shown.map((e) => e.id), ["w0", "w1", "w2"]);

  const few = activityWidgetEvents(items.slice(0, 2), 3);
  assert.equal(few.shown.length, 2);
  assert.equal(few.remaining, 0, "never negative");
});

// ── end-to-end with the real engine ───────────────────────────────────────────

test("view pipeline composes with the real engine output", () => {
  const snapshot: ActivityProductSnapshot = {
    id: "p1", sku: "mk1", barcode: null, nameAr: "اسم", nameEn: null, imageUrl: null,
    approval: "Approved", platformStatus: "shopify",
    createdAt: "2026-08-01T10:00:00.000Z", updatedAt: "2026-08-05T12:00:00.000Z",
  };
  const events = deriveActivityEvents(snapshot);
  assert.deepEqual(summarizeActivity(events), { total: 4, created: 1, updated: 1, approval: 1, platform: 1 });
  assert.deepEqual(
    selectActivityEvents(events, { query: "", filter: "platform" }).map((e) => e.kind),
    ["published"],
  );
});
