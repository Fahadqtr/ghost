import test from "node:test";
import assert from "node:assert/strict";

import { parseTalabatOrder, orderSummary } from "./order-compute.ts";

test("parseTalabatOrder reads a flat payload", () => {
  const p = parseTalabatOrder({
    code: "TB-1001", status: "RECEIVED", currency: "QAR", grandTotal: 118,
    items: [
      { sku: "mk1000", name: "Nasal Strips", quantity: 2, price: 38 },
      { sku: "mk1001", name: "Sakura Cream", qty: 1, unitPrice: 42 },
    ],
    customer: { firstName: "Sara", lastName: "A" },
    createdAt: "2026-07-15T21:00:00Z",
  });
  assert.equal(p.orderId, "TB-1001");
  assert.equal(p.status, "RECEIVED");
  assert.equal(p.items.length, 2);
  assert.deepEqual(p.items[0], { sku: "mk1000", name: "Nasal Strips", quantity: 2, price: 38 });
  assert.equal(p.items[1].quantity, 1);       // qty alias
  assert.equal(p.items[1].price, 42);          // unitPrice alias
  assert.equal(p.total, 118);
  assert.equal(p.currency, "QAR");
  assert.equal(p.customerName, "Sara");
  assert.equal(p.placedAt, "2026-07-15T21:00:00Z");
});

test("parseTalabatOrder reads a nested {order:{...}} payload with alt keys", () => {
  const p = parseTalabatOrder({
    order: {
      orderId: "9988", orderStatus: "READY_FOR_PICKUP", currencyCode: "QAR",
      products: [{ vendorProductId: "mk1266", title: "Shaver", count: 3, totalPrice: 60 }],
      totalValue: 60, consumer: { name: "أحمد" },
    },
  });
  assert.equal(p.orderId, "9988");
  assert.equal(p.status, "READY_FOR_PICKUP");
  assert.equal(p.items[0].sku, "mk1266");
  assert.equal(p.items[0].quantity, 3);
  assert.equal(p.customerName, "أحمد");
});

test("parseTalabatOrder never throws on junk / empty", () => {
  const p = parseTalabatOrder(null);
  assert.equal(p.orderId, "");
  assert.equal(p.status, "RECEIVED");
  assert.deepEqual(p.items, []);
  assert.equal(p.total, null);
});

test("orderSummary is a concise line", () => {
  const line = orderSummary({ orderId: "TB-1", status: "RECEIVED", items: [{ sku: "x", name: "y", quantity: 2, price: 5 }], total: 10, currency: "QAR", customerName: "", placedAt: null });
  assert.match(line, /TB-1/);
  assert.match(line, /RECEIVED/);
  assert.match(line, /10 QAR/);
});
