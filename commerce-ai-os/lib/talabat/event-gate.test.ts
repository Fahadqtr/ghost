// Pure tests for the Talabat auto-deduct feature gate. No Supabase, no network.
// Run: node --conditions=react-server --experimental-strip-types --test lib/talabat/event-gate.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { normalizeEvent, parseEventAllowlist, isAutoDeductEnabled, evaluateDeductGate } from "./event-gate.ts";

test("normalizeEvent is deterministic (trim/collapse/lowercase)", () => {
  assert.equal(normalizeEvent("  Order.Placed  "), "order.placed");
  assert.equal(normalizeEvent("ORDER   PLACED"), "order placed");
  assert.equal(normalizeEvent(normalizeEvent("Order.Created")), normalizeEvent("order.created"));
  assert.equal(normalizeEvent(null), "");
  assert.equal(normalizeEvent(undefined), "");
});

test("parseEventAllowlist splits on commas, normalizes, drops empties, de-dupes", () => {
  assert.deepEqual(parseEventAllowlist("order.placed, Order.Confirmed ,, order.placed"), ["order.placed", "order.confirmed"]);
  assert.deepEqual(parseEventAllowlist(""), []);
  assert.deepEqual(parseEventAllowlist("   "), []);
  assert.deepEqual(parseEventAllowlist(null), []);
});

test("the flag is ON only when it is EXACTLY \"true\"", () => {
  assert.equal(isAutoDeductEnabled("true"), true);
  assert.equal(isAutoDeductEnabled(" true "), true);
  for (const v of ["false", "1", "yes", "TRUE", "", undefined, null, "truthy"]) {
    assert.equal(isAutoDeductEnabled(v), false, `flag ${String(v)}`);
  }
});

test("flag off/absent → store_only (never deduct)", () => {
  assert.deepEqual(evaluateDeductGate({ enabledFlag: undefined, allowlistRaw: "order.placed", event: "order.placed" }), { action: "store_only" });
  assert.deepEqual(evaluateDeductGate({ enabledFlag: "false", allowlistRaw: "order.placed", event: "order.placed" }), { action: "store_only" });
});

test("flag true + empty/invalid allowlist → manual_review auto_deduct_misconfigured", () => {
  assert.deepEqual(evaluateDeductGate({ enabledFlag: "true", allowlistRaw: "", event: "order.placed" }), { action: "manual_review", reason: "auto_deduct_misconfigured" });
  assert.deepEqual(evaluateDeductGate({ enabledFlag: "true", allowlistRaw: "  , ,", event: "order.placed" }), { action: "manual_review", reason: "auto_deduct_misconfigured" });
});

test("flag true + event missing / not in list → event_not_allowed", () => {
  assert.deepEqual(evaluateDeductGate({ enabledFlag: "true", allowlistRaw: "order.placed", event: null }), { action: "manual_review", reason: "event_not_allowed" });
  assert.deepEqual(evaluateDeductGate({ enabledFlag: "true", allowlistRaw: "order.placed", event: "order.cancelled" }), { action: "manual_review", reason: "event_not_allowed" });
});

test("substring / fuzzy event is rejected — only EXACT normalized match deducts", () => {
  // "order.placed.late" contains "order.placed" but must NOT match.
  assert.deepEqual(evaluateDeductGate({ enabledFlag: "true", allowlistRaw: "order.placed", event: "order.placed.late" }), { action: "manual_review", reason: "event_not_allowed" });
  // "order" is a prefix of "order.placed" but must NOT match either direction.
  assert.deepEqual(evaluateDeductGate({ enabledFlag: "true", allowlistRaw: "order", event: "order.placed" }), { action: "manual_review", reason: "event_not_allowed" });
});

test("flag true + exact (normalized) event match → deduct", () => {
  assert.deepEqual(evaluateDeductGate({ enabledFlag: "true", allowlistRaw: "order.placed, order.confirmed", event: " Order.Placed " }), { action: "deduct" });
});
