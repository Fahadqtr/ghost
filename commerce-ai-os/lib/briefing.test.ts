// Tests for Malak's morning-briefing composer.
// Run: node --conditions=react-server --experimental-strip-types --test lib/briefing.test.ts

import test from "node:test";
import assert from "node:assert/strict";

import { composeBriefing, partOfDayFromHour, type BriefingAlert } from "./briefing.ts";

const alerts: BriefingAlert[] = [
  { ar: "منتجان مفتوحان في المهام", severity: "low" },
  { ar: "3 منتجات نافدة من المخزون", severity: "high" },
  { ar: "5 منتجات ناقصة صورة", severity: "med" },
];

test("greeting reflects part of day and owner name", () => {
  assert.equal(composeBriefing({ partOfDay: "morning", ownerName: "فهد" }).greetingAr, "صباح الخير يا فهد");
  assert.equal(composeBriefing({ partOfDay: "evening" }).greetingAr, "مساء الخير");
});

test("all-clear when there are no high/med alerts", () => {
  const b = composeBriefing({ alerts: [{ ar: "3 مهام مفتوحة", severity: "low" }] });
  assert.equal(b.allClear, true);
  assert.match(b.headlineAr, /ممتاز/);
  assert.match(b.speak, /ما عندك شي عاجل/);
});

test("prioritizes the first high-severity alert and counts only actionable items", () => {
  const b = composeBriefing({ ownerName: "فهد", alerts });
  assert.equal(b.allClear, false);
  assert.equal(b.priorityAr, "3 منتجات نافدة من المخزون"); // high wins over med/low
  assert.equal(b.headlineAr, "عندك 2 بنود تحتاج انتباهك.");  // high + med (low excluded)
  assert.deepEqual(b.linesAr, [                              // sorted most-urgent first
    "3 منتجات نافدة من المخزون",
    "5 منتجات ناقصة صورة",
    "منتجان مفتوحان في المهام",
  ]);
  assert.match(b.speak, /الأهم: 3 منتجات نافدة من المخزون/);
});

test("falls back to the first alert when none are high", () => {
  const b = composeBriefing({ alerts: [{ ar: "5 منتجات ناقصة صورة", severity: "med" }] });
  assert.equal(b.priorityAr, "5 منتجات ناقصة صورة");
});

test("adds a sales line only when there were sales", () => {
  assert.equal(composeBriefing({ sales: { units: 0 } }).salesLineAr, null);
  const b = composeBriefing({ sales: { units: 12, revenue: 340, topSeller: "Medicube Serum" } });
  assert.equal(b.salesLineAr, "مبيعات: 12 قطعة بقيمة 340، الأكثر مبيعًا Medicube Serum");
  assert.match(b.speak, /مبيعات: 12 قطعة/);
});

test("speak text is TTS-safe: no emoji, no repeated dots", () => {
  const b = composeBriefing({ alerts: [{ ar: "⛔ 3 منتجات نافدة 🔥", severity: "high" }] });
  assert.doesNotMatch(b.speak, /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/u);
  assert.doesNotMatch(b.speak, /\.\./);
});

test("partOfDayFromHour buckets the day", () => {
  assert.equal(partOfDayFromHour(8), "morning");
  assert.equal(partOfDayFromHour(13), "afternoon");
  assert.equal(partOfDayFromHour(20), "evening");
});
