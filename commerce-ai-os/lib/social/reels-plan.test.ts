// Tests for the weekly Reels engine.
// Run: node --experimental-strip-types --test lib/social/reels-plan.test.ts

import test from "node:test";
import assert from "node:assert/strict";

import {
  REEL_FORMATS, REELS_PER_WEEK, weeklyFormatSequence, buildWeeklyReelsPlan, reelSlotUtc,
} from "./reels-plan.ts";

const products = Array.from({ length: 5 }, (_, i) => ({ sku: `mk${i}`, name_en: `Product ${i}` }));
const from = new Date("2026-07-13T09:00:00Z"); // a Monday

test("formats sum to 14 (3/3/3/3/2)", () => {
  assert.equal(REEL_FORMATS.reduce((n, f) => n + f.perWeek, 0), REELS_PER_WEEK);
});

test("weekly sequence has the right per-format counts and length", () => {
  const seq = weeklyFormatSequence();
  assert.equal(seq.length, 14);
  const count = (k: string) => seq.filter((x) => x === k).length;
  assert.equal(count("entertainment"), 3);
  assert.equal(count("review"), 3);
  assert.equal(count("asmr"), 2);
});

test("sequence interleaves — no format appears twice in a row", () => {
  const seq = weeklyFormatSequence();
  for (let i = 1; i < seq.length; i++) assert.notEqual(seq[i], seq[i - 1]);
});

test("plan has 14 items, English prompts, rotates products, growth CTA by default", () => {
  const plan = buildWeeklyReelsPlan(products, from);
  assert.equal(plan.length, 14);
  assert.ok(plan.every((it) => /Vertical 9:16/.test(it.promptEn)));
  assert.ok(plan.every((it) => !/[؀-ۿ]/.test(it.promptEn))); // no Arabic in the prompt
  assert.equal(plan[0].sku, "mk0");
  assert.equal(plan[5].sku, "mk0"); // 5 products → index 5 wraps to first
  assert.ok(plan.every((it) => it.ctaType === "growth"));
});

test("slots map to 13:00 and 20:00 Doha (10:00 / 17:00 UTC), day 0 = tomorrow", () => {
  const plan = buildWeeklyReelsPlan(products, from);
  // index 0 → day0 slot0 → tomorrow 13:00 Doha = 10:00 UTC on 2026-07-14
  assert.equal(plan[0].scheduledAtIso, "2026-07-14T10:00:00.000Z");
  assert.equal(plan[1].scheduledAtIso, "2026-07-14T17:00:00.000Z"); // 20:00 Doha
  assert.equal(plan[2].scheduledAtIso, "2026-07-15T10:00:00.000Z"); // next day 13:00
  assert.equal(plan[13].dayOffset, 6); // 14 items over 7 days
});

test("conversionRatio mixes in conversion CTAs", () => {
  const all = buildWeeklyReelsPlan(products, from, { conversionRatio: 1 });
  assert.ok(all.every((it) => it.ctaType === "conversion"));
  const half = buildWeeklyReelsPlan(products, from, { conversionRatio: 0.5 });
  assert.ok(half.some((it) => it.ctaType === "conversion") && half.some((it) => it.ctaType === "growth"));
});

test("reelSlotUtc clamps an out-of-range slot", () => {
  const d = reelSlotUtc(from, 0, 9);
  assert.equal(d.toISOString(), "2026-07-14T17:00:00.000Z"); // clamps to last slot (20:00)
});
