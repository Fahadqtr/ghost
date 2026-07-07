// Tests for the Shopify orders shaping.
// Run: node --experimental-strip-types --test lib/shopify/orders-compute.test.ts

import test from "node:test";
import assert from "node:assert/strict";

import { ordersSummary, ordersWithin, morningOrdersLine, type ShopifyOrderLite } from "./orders-compute.ts";

const order = (over: Partial<ShopifyOrderLite>): ShopifyOrderLite => ({
  id: "gid://1", name: "#1001", createdAt: "2026-07-07T08:00:00Z",
  financial: "PAID", fulfillment: "UNFULFILLED", total: 100, currency: "QAR",
  customer: "Aisha", items: [{ title: "Serum", qty: 1 }], ...over,
});

test("summary adds up count and revenue, skipping NaN totals", () => {
  const s = ordersSummary([order({ total: 100 }), order({ total: 49.5 }), order({ total: NaN })]);
  assert.equal(s.count, 3);
  assert.equal(s.revenue, 149.5);
});

test("ordersWithin filters by the cutoff", () => {
  const now = new Date("2026-07-07T12:00:00Z");
  const recent = order({ createdAt: "2026-07-07T00:00:00Z" });
  const old = order({ createdAt: "2026-07-05T12:00:00Z" });
  const bad = order({ createdAt: "garbage" });
  assert.deepEqual(ordersWithin([recent, old, bad], 24, now), [recent]);
});

test("morning line summarizes the day or stays silent", () => {
  const now = new Date("2026-07-07T12:00:00Z");
  assert.equal(morningOrdersLine([], now), "");
  assert.equal(morningOrdersLine([order({ createdAt: "2026-07-01T00:00:00Z" })], now), "");
  const line = morningOrdersLine([order({ total: 100 }), order({ total: 58 })], now);
  assert.ok(line.includes("2 طلب"));
  assert.ok(line.includes("158 ر.ق"));
});
