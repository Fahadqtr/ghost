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
  assert.equal(l.unitPrice, 10);
  assert.equal(l.invalidQuantity, false);
  assert.equal(l.lineKey, "line-0");

  // A line that carries ONLY a vendor product id must not populate sku/barcode.
  const only = parseTalabatOrderLines({ items: [{ vendorProductId: "CPX", quantity: 1 }] }).lines[0];
  assert.equal(only.channelProductId, "CPX");
  assert.equal(only.sku, null);
  assert.equal(only.barcode, null);
});

test("2: an invalid quantity is flagged (never silently defaulted to 1)", () => {
  for (const q of [0, -1, 1.5, "abc", null, undefined]) {
    const l = parseTalabatOrderLines({ items: [{ sku: "S", quantity: q }] }).lines[0];
    assert.equal(l.invalidQuantity, true, `qty ${String(q)} must be invalid`);
    assert.equal(l.quantity, 0);
  }
  assert.equal(parseTalabatOrderLines({ items: [{ sku: "S", quantity: 3 }] }).lines[0].invalidQuantity, false);
});

test("3: the same order_code yields the same dedup key", () => {
  const a = buildTalabatDedupKey(parseTalabatOrderLines({ order: { code: "OC-9", items: [{ sku: "A", quantity: 1 }] } }));
  const b = buildTalabatDedupKey(parseTalabatOrderLines({ order: { code: " OC-9 ", items: [{ sku: "Z", quantity: 9 }] } }));
  assert.equal(a, "talabat:OC-9");
  assert.equal(b, "talabat:OC-9"); // trimmed; independent of the rest of the order
});

test("4: JSON key order and line order do not change the fallback hash", () => {
  const p1 = buildTalabatDedupKey(parseTalabatOrderLines({ items: [{ sku: "A", quantity: 1 }, { sku: "B", quantity: 2 }] }));
  const p2 = buildTalabatDedupKey(parseTalabatOrderLines({ items: [{ quantity: 2, sku: "B" }, { quantity: 1, sku: "A" }] }));
  assert.equal(p1, p2);
  assert.match(p1, /^talabat:h:[0-9a-f]{8}$/);
  // A genuinely different order (different quantity) → different key.
  const p3 = buildTalabatDedupKey(parseTalabatOrderLines({ items: [{ sku: "A", quantity: 5 }, { sku: "B", quantity: 2 }] }));
  assert.notEqual(p1, p3);
});

test("4b: the dedup key never contains customer name or phone", () => {
  const key = buildTalabatDedupKey(parseTalabatOrderLines({
    items: [{ sku: "A", quantity: 1 }],
    customer: { name: "Fatima", phone: "+97455512345" },
  }));
  assert.ok(!/Fatima/i.test(key) && !/55512345/.test(key));
});
