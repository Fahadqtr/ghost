// Tests for the weekly-plan scheduling math.
// Run: node --experimental-strip-types --test lib/social/schedule-compute.test.ts

import test from "node:test";
import assert from "node:assert/strict";

import { DAY_SLOTS, PLAN_DAYS, planSlots, slotTimeUtc, qatarDayKey, QATAR_UTC_OFFSET_H } from "./schedule-compute.ts";

test("a week plan is 7 days × 3 slots = 21 entries in order", () => {
  const slots = planSlots();
  assert.equal(slots.length, PLAN_DAYS * DAY_SLOTS.length);
  assert.deepEqual(slots[0], { dayOffset: 0, slot: 0 });
  assert.deepEqual(slots.at(-1), { dayOffset: 6, slot: 2 });
});

test("slot times land inside their Qatar windows, starting tomorrow", () => {
  const from = new Date("2026-07-06T20:00:00Z"); // 23:00 Qatar
  for (const { dayOffset, slot } of planSlots()) {
    const s = DAY_SLOTS[slot];
    const t0 = slotTimeUtc(from, dayOffset, slot, 0);
    const t1 = slotTimeUtc(from, dayOffset, slot, s.windowMinutes - 1);
    // Qatar local hour of the window start.
    const localH = (t0.getUTCHours() + QATAR_UTC_OFFSET_H) % 24;
    assert.equal(localH, s.startHour);
    assert.equal(t0.getUTCMinutes(), s.startMinute % 60);
    assert.ok(t1.getTime() - t0.getTime() === (s.windowMinutes - 1) * 60_000);
    assert.ok(t0.getTime() > from.getTime()); // never in the past
  }
});

test("day 0 means tomorrow in QATAR even when UTC has not rolled over", () => {
  // 22:30 Qatar on Jul 6 (19:30 UTC) → day 0 slot 0 must be Jul 7, 10:00 Qatar.
  const from = new Date("2026-07-06T19:30:00Z");
  const t = slotTimeUtc(from, 0, 0, 0);
  assert.equal(qatarDayKey(t.toISOString()), "2026-07-07");
});

test("jitter is clamped to the slot window", () => {
  const from = new Date("2026-07-06T08:00:00Z");
  const s = DAY_SLOTS[0];
  const over = slotTimeUtc(from, 0, 0, 10_000);
  const zero = slotTimeUtc(from, 0, 0, -5);
  assert.equal(over.getTime() - zero.getTime(), (s.windowMinutes - 1) * 60_000);
});

test("qatarDayKey groups by the Qatar-local calendar day", () => {
  assert.equal(qatarDayKey("2026-07-06T22:30:00Z"), "2026-07-07"); // 01:30 Qatar next day
  assert.equal(qatarDayKey("2026-07-06T12:00:00Z"), "2026-07-06");
  assert.equal(qatarDayKey("garbage"), "");
});
