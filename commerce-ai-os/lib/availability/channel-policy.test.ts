// INV.2D — channel availability policy + Shopify push-list contract.
//
// PURE — no DB/network. Run:
// node --conditions=react-server --experimental-strip-types --test lib/availability/channel-policy.test.ts

import test from "node:test";
import assert from "node:assert/strict";

import {
  channelAvailabilityMode,
  noopChannelAvailabilityPush,
  shopifyOosZeroPushList,
  type ProductAvailabilityLite,
} from "./channel-policy.ts";

test("Shopify is the only live outbound push; Talabat is export-flag", () => {
  assert.equal(channelAvailabilityMode("shopify"), "push_zero_on_oos");
  assert.equal(channelAvailabilityMode("talabat"), "export_flag");
});

test("Snoonu / Pure Seoul / Rafeeq have NO outbound availability (mode none)", () => {
  for (const p of ["snoonu", "pure_seoul", "rafeeq"]) {
    assert.equal(channelAvailabilityMode(p), "none", `${p} is no-op outbound`);
  }
  assert.equal(channelAvailabilityMode("whatever"), "none", "unknown platform defaults to none");
});

test("no-op adapter performs no push and explains why", () => {
  const r = noopChannelAvailabilityPush("snoonu");
  assert.equal(r.pushed, false);
  assert.equal(r.platform, "snoonu");
  assert.ok(r.reason.length > 0);
});

// ── Shopify push list: OOS → 0; In-Stock omitted; derived from stock_status ──

const P = (id: string, stock_status: string | null): ProductAvailabilityLite => ({ id, sku: `sku-${id}`, name_en: id, stock_status });

test("Shopify push list contains ONLY Out-of-Stock products, each at quantity 0", () => {
  const list = shopifyOosZeroPushList([P("a", "In Stock"), P("b", "Out of Stock"), P("c", "In Stock")]);
  assert.deepEqual(list, [{ id: "b", sku: "sku-b", name_en: "b", stock: 0 }]);
});

test("In-Stock products are never pushed (Shopify quantity left untouched)", () => {
  const list = shopifyOosZeroPushList([P("a", "In Stock"), P("b", "In Stock")]);
  assert.equal(list.length, 0);
});

test("unknown / null availability is treated as OOS (pushed to 0), never a quantity guess", () => {
  const list = shopifyOosZeroPushList([P("a", null), P("b", "Low Stock"), P("c", "")]);
  assert.equal(list.length, 3);
  assert.ok(list.every((x) => x.stock === 0));
});
