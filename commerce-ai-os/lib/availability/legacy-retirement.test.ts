// INV.2F — characterization / regression tests for Legacy Availability Retirement.
//
// The engine write-path and read-model contract are proven in availability.test.ts;
// this file pins the ONE behavior INV.2F changes: availability is now the EXPLICIT
// stock_status and is fully DECOUPLED from quantity. It characterizes the exact
// point of divergence from the retired quantity-derived path, so a regression that
// silently reintroduces "quantity => availability" would fail here.
//
// PURE — read-model only. Run:
// node --conditions=react-server --experimental-strip-types --test lib/availability/legacy-retirement.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { isAvailable, allVariantsOut } from "./read.ts";

// The RETIRED legacy oracle: availability inferred from a quantity number.
// Kept ONLY as a reference to prove the new explicit path diverges from it.
const legacyQtyAvailable = (qty: number | null): boolean => (qty ?? 0) > 0;

// ── availability is decoupled from quantity (the whole point of INV.2F) ────────

test("explicit availability ignores quantity entirely", () => {
  // In stock with zero quantity → still available (backorder / not-yet-counted).
  assert.equal(isAvailable("In Stock"), true);
  assert.equal(legacyQtyAvailable(0), false); // retired path would have said "out"

  // Out of stock with plenty of quantity → still out (reserved / do-not-sell).
  assert.equal(isAvailable("Out of Stock"), false);
  assert.equal(legacyQtyAvailable(50), true); // retired path would have said "in"
});

test("the new explicit decision genuinely diverges from the retired quantity oracle", () => {
  // A matrix of (status, quantity) where the two paths must disagree at least
  // once — proving quantity is no longer the availability source.
  const cases: { status: string; qty: number; explicit: boolean }[] = [
    { status: "In Stock", qty: 0, explicit: true },
    { status: "Out of Stock", qty: 999, explicit: false },
  ];
  let diverged = 0;
  for (const c of cases) {
    assert.equal(isAvailable(c.status), c.explicit, `${c.status} → ${c.explicit}`);
    if (isAvailable(c.status) !== legacyQtyAvailable(c.qty)) diverged++;
  }
  assert.equal(diverged, cases.length, "explicit availability differs from the quantity oracle in every crafted case");
});

// ── NULL / unset is deterministic and NEVER inferred from quantity ────────────

test("unset availability is not-available regardless of quantity", () => {
  for (const qty of [0, 1, 5, 100, 10_000]) {
    // Whatever the quantity, an unset/unknown status is conservatively not-available.
    assert.equal(isAvailable(null), false, `null status stays out with qty=${qty}`);
    assert.equal(isAvailable(undefined), false);
    assert.equal(isAvailable("Low Stock"), false, "legacy 'Low Stock' is not silently promoted to In");
  }
});

test("unset availability is deterministic — same input, same answer", () => {
  const first = isAvailable(null);
  for (let i = 0; i < 100; i++) assert.equal(isAvailable(null), first);
  assert.equal(first, false);
});

// ── product & variant toggles round-trip through the two allowed states ────────

test("toggle round-trip: In → Out → In is stable and explicit", () => {
  let s: string = "In Stock";
  assert.equal(isAvailable(s), true);
  s = "Out of Stock";
  assert.equal(isAvailable(s), false);
  s = "In Stock";
  assert.equal(isAvailable(s), true);
});

// ── variant diagnostic never triggers on quantity ─────────────────────────────

test("allVariantsOut is an explicit-availability diagnostic, not a quantity sum", () => {
  // All variants explicitly out → true, even if some carried a positive quantity
  // (quantity is irrelevant to this diagnostic).
  assert.equal(allVariantsOut(["Out of Stock", "Out of Stock"]), true);
  // Any explicitly-in variant → false.
  assert.equal(allVariantsOut(["Out of Stock", "In Stock"]), false);
  // Unknown/unset variants count as not-available (never a quantity guess).
  assert.equal(allVariantsOut([null, "Low Stock"]), true);
  // No variants → nothing to diagnose.
  assert.equal(allVariantsOut([]), false);
});
