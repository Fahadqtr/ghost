// Tests for the Talabat order-line parser + deterministic dedup key. Pure — NO
// Supabase, NO network.
// Run: node --conditions=react-server --experimental-strip-types --test lib/talabat/order-lines.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { parseTalabatOrderLines, buildTalabatDedupKey } from "./order-lines.ts";

test("1: parsing keeps channelProductId, SKU and barcode separate (never merged)", () => {
  const parsed = parseTalabatOrderLines({
    order: { code: "OC1", items: [{ vendorProductId: "CP1", sku: "S1", barcode: "B1", name: "Widget", quantity: 2, price: 10 }] },
  });
  const l = parsed.lines[0];
  assert.equal(l.channelProductId, "CP1");
  assert.equal(l.sku, "S1");
  assert.equal(l.barcode, "B1");
  assert.equal(l.title, "Widget");
  assert.equal(l.quantity, 2);
  assert.equal(l.invalidQuantity, false);
  const only = parseTalabatOrderLines({ items: [{ vendorProductId: "CPX", quantity: 1 }] }).lines[0];
  assert.equal(only.channelProductId, "CPX");
  assert.equal(only.sku, null);
  assert.equal(only.barcode, null);
});

test("2: an invalid quantity is flagged (never floored / defaulted to 1)", () => {
  for (const q of [0, -1, 1.5, "1.5", "abc", null, undefined, Infinity, NaN, true]) {
    const l = parseTalabatOrderLines({ items: [{ sku: "S", quantity: q }] }).lines[0];
    assert.equal(l.invalidQuantity, true, `qty ${String(q)} must be invalid`);
    assert.equal(l.quantity, 0);
  }
  assert.equal(parseTalabatOrderLines({ items: [{ sku: "S", quantity: 3 }] }).lines[0].invalidQuantity, false);
});

test("3: the same order_code yields the same (strong) dedup key", () => {
  const a = buildTalabatDedupKey(parseTalabatOrderLines({ order: { code: "OC-9", items: [{ sku: "A", quantity: 1 }] } }));
  const b = buildTalabatDedupKey(parseTalabatOrderLines({ order: { code: " oc-9 ", items: [{ sku: "Z", quantity: 9 }] } }));
  assert.deepEqual(a, { key: "talabat:oc-9", confidence: "strong" });
  assert.deepEqual(b, { key: "talabat:oc-9", confidence: "strong" });
});

test("fallback: the hash is SHA-256 (64 hex)", () => {
  const k = buildTalabatDedupKey(parseTalabatOrderLines({ reference: "REF-1", items: [{ sku: "A", quantity: 1 }] }));
  assert.match(k.key, /^talabat:h:[0-9a-f]{64}$/);
  assert.equal(k.confidence, "strong"); // a merchant reference is a trusted id
});

test("4: JSON key order and line order do not change the fallback hash; price does", () => {
  const p1 = buildTalabatDedupKey(parseTalabatOrderLines({ reference: "R", items: [{ sku: "A", quantity: 1, price: 5 }, { sku: "B", quantity: 2, price: 7 }] }));
  const p2 = buildTalabatDedupKey(parseTalabatOrderLines({ reference: "R", items: [{ price: 7, quantity: 2, sku: "B" }, { price: 5, quantity: 1, sku: "A" }] }));
  assert.equal(p1.key, p2.key);
  const p3 = buildTalabatDedupKey(parseTalabatOrderLines({ reference: "R", items: [{ sku: "A", quantity: 1, price: 5 }, { sku: "B", quantity: 2, price: 99 }] }));
  assert.notEqual(p1.key, p3.key);
});

test("weak: an order with no trusted identifier (cart only) is confidence=weak", () => {
  const k = buildTalabatDedupKey(parseTalabatOrderLines({ items: [{ sku: "A", quantity: 1 }] }));
  assert.equal(k.confidence, "weak");
  const k2 = buildTalabatDedupKey(parseTalabatOrderLines({ items: [{ sku: "A", quantity: 1 }] }));
  assert.equal(k.key, k2.key); // two independent same-cart orders collide → hence weak
});

test("5: the dedup key never contains customer name / phone / address", () => {
  const k = buildTalabatDedupKey(parseTalabatOrderLines({
    items: [{ sku: "A", quantity: 1 }],
    customer: { name: "Fatima", phone: "+97455512345", address: "Doha" },
  }));
  assert.ok(!/Fatima|55512345|Doha/i.test(k.key));
});
