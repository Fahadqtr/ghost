// Tests for the CRM customer compute core.
// Run: node --experimental-strip-types --test lib/crm/customer-compute.test.ts

import test from "node:test";
import assert from "node:assert/strict";

import { normalizePhone, computeSegment, segmentCounts, daysSince } from "./customer-compute.ts";

const NOW = new Date("2026-07-10T00:00:00Z");

test("normalizePhone strips symbols and the Qatar country code", () => {
  assert.equal(normalizePhone("+974 3312 4567"), "33124567");
  assert.equal(normalizePhone("00974-3312-4567"), "33124567"); // 12 digits → last 8
  assert.equal(normalizePhone("33124567"), "33124567");
  assert.equal(normalizePhone(""), "");
  assert.equal(normalizePhone(null), "");
});

test("no orders → lead", () => {
  assert.equal(computeSegment({ orders: 0, spent: 0, now: NOW }), "lead");
});

test("high spend → vip regardless of order count", () => {
  assert.equal(computeSegment({ orders: 1, spent: 1500, lastOrderAt: "2026-07-01", now: NOW }), "vip");
});

test("2+ recent orders under the VIP threshold → repeat", () => {
  assert.equal(computeSegment({ orders: 3, spent: 400, lastOrderAt: "2026-07-05", now: NOW }), "repeat");
});

test("single recent order → new", () => {
  assert.equal(computeSegment({ orders: 1, spent: 120, lastOrderAt: "2026-07-08", now: NOW }), "new");
});

test("last order older than the lapsed window → lapsed", () => {
  assert.equal(computeSegment({ orders: 2, spent: 300, lastOrderAt: "2026-03-01", now: NOW }), "lapsed");
});

test("daysSince computes whole days and tolerates null", () => {
  assert.equal(daysSince("2026-07-05T00:00:00Z", NOW), 5);
  assert.equal(daysSince(null, NOW), null);
});

test("segmentCounts tallies each bucket", () => {
  const c = segmentCounts([{ segment: "vip" }, { segment: "vip" }, { segment: "lead" }]);
  assert.equal(c.vip, 2);
  assert.equal(c.lead, 1);
  assert.equal(c.repeat, 0);
});
