// CH.6C — Snoonu availability sync unit tests (pure modules + source port).
// node --conditions=react-server --experimental-strip-types --test lib/adapters/snoonu/availability/snoonu-availability.test.ts

import test from "node:test";
import assert from "node:assert/strict";

import {
  normalizeSnoonuAvailability,
  toEngineState,
  type SnoonuAvailability,
} from "./snoonu-availability-normalize.ts";
import {
  diffAvailabilityRow,
  buildAvailabilityDiff,
  summarizeDiff,
  type ResolvedProduct,
} from "./snoonu-availability-diff.ts";
import { planAvailabilityApply } from "./snoonu-availability-plan.ts";
import { createSnoonuAvailabilitySource } from "./availability-source.server.ts";

const SF = "snoonu:pure_seoul" as const;

// ── normalize ────────────────────────────────────────────────────────────────
test("normalize maps overlay/export/variant tokens to tri-state; unknown → UNKNOWN", () => {
  for (const t of ["InStock", "in stock", "in_stock", "available", "TRUE", "in"]) {
    assert.equal(normalizeSnoonuAvailability(t), "IN_STOCK", t);
  }
  for (const t of ["OutOfStock", "out of stock", "unavailable", "false", "out", "sold out"]) {
    assert.equal(normalizeSnoonuAvailability(t), "OUT_OF_STOCK", t);
  }
  for (const t of ["", "maybe", null, undefined, 3, {}, "backorder"]) {
    assert.equal(normalizeSnoonuAvailability(t), "UNKNOWN", String(t));
  }
});

test("toEngineState maps tri-state to the engine's explicit states; UNKNOWN → null", () => {
  assert.equal(toEngineState("IN_STOCK"), "In Stock");
  assert.equal(toEngineState("OUT_OF_STOCK"), "Out of Stock");
  assert.equal(toEngineState("UNKNOWN"), null);
});

// ── diffAvailabilityRow (safety skips + change classification) ────────────────
const baseRow = {
  productId: "p1", sku: "SKU1", storefront: SF, spi: "spi1",
  currentInternal: "In Stock" as const, lifecycle: "Active" as const, mappingActive: true,
};

test("no active mapping → NEEDS_REVIEW, never actionable", () => {
  const r = diffAvailabilityRow({ ...baseRow, snoonu: "OUT_OF_STOCK", mappingActive: false });
  assert.equal(r.action, "NEEDS_REVIEW");
  assert.equal(r.actionable, false);
  assert.equal(r.targetState, null);
});

test("Draft / Archived lifecycle → SKIPPED (checked after mapping)", () => {
  for (const lc of ["Draft", "Archived"] as const) {
    const r = diffAvailabilityRow({ ...baseRow, snoonu: "OUT_OF_STOCK", lifecycle: lc });
    assert.equal(r.action, "SKIPPED", lc);
    assert.equal(r.actionable, false);
  }
});

test("UNKNOWN Snoonu availability never changes internal state", () => {
  const r = diffAvailabilityRow({ ...baseRow, snoonu: "UNKNOWN" });
  assert.equal(r.action, "UNKNOWN");
  assert.equal(r.actionable, false);
  assert.equal(r.targetState, null);
});

test("equal state → UNCHANGED; differing → CHANGE_TO_* actionable", () => {
  assert.equal(diffAvailabilityRow({ ...baseRow, snoonu: "IN_STOCK" }).action, "UNCHANGED");

  const toOut = diffAvailabilityRow({ ...baseRow, snoonu: "OUT_OF_STOCK" });
  assert.equal(toOut.action, "CHANGE_TO_OUT");
  assert.equal(toOut.targetState, "Out of Stock");
  assert.equal(toOut.actionable, true);

  const toIn = diffAvailabilityRow({ ...baseRow, currentInternal: "Out of Stock", snoonu: "IN_STOCK" });
  assert.equal(toIn.action, "CHANGE_TO_IN");
  assert.equal(toIn.targetState, "In Stock");
  assert.equal(toIn.actionable, true);
});

test("unset internal + Snoonu OUT → actionable CHANGE_TO_OUT", () => {
  const r = diffAvailabilityRow({ ...baseRow, currentInternal: null, snoonu: "OUT_OF_STOCK" });
  assert.equal(r.action, "CHANGE_TO_OUT");
  assert.equal(r.actionable, true);
});

// ── buildAvailabilityDiff (resolver: SPI → ECL → product) ─────────────────────
function resolved(productId: string, current: "In Stock" | "Out of Stock" | null, lifecycle: "Active" | "Draft" | "Archived" | null = "Active"): ResolvedProduct {
  return { productId, sku: `sku-${productId}`, currentInternal: current, lifecycle };
}

test("buildAvailabilityDiff resolves mapped SPIs and flags unmapped SPIs NEEDS_REVIEW", () => {
  const sourceBySpi = new Map<string, SnoonuAvailability>([
    ["spiA", "OUT_OF_STOCK"], // mapped, currently In → CHANGE_TO_OUT
    ["spiB", "IN_STOCK"],     // mapped, currently In → UNCHANGED
    ["spiC", "OUT_OF_STOCK"], // NOT mapped → NEEDS_REVIEW
    ["spiD", "UNKNOWN"],      // mapped but unknown → UNKNOWN
  ]);
  const productBySpi = new Map<string, ResolvedProduct>([
    ["spiA", resolved("pA", "In Stock")],
    ["spiB", resolved("pB", "In Stock")],
    ["spiD", resolved("pD", "In Stock")],
  ]);
  const rows = buildAvailabilityDiff({ storefront: SF, sourceBySpi, productBySpi });
  const byspi = new Map(rows.map((r) => [r.spi, r]));
  assert.equal(byspi.get("spiA")!.action, "CHANGE_TO_OUT");
  assert.equal(byspi.get("spiB")!.action, "UNCHANGED");
  assert.equal(byspi.get("spiC")!.action, "NEEDS_REVIEW");
  assert.equal(byspi.get("spiC")!.productId, ""); // unresolved — no product leaked
  assert.equal(byspi.get("spiD")!.action, "UNKNOWN");

  const s = summarizeDiff(rows);
  assert.deepEqual(
    { total: s.total, changeToOut: s.changeToOut, unchanged: s.unchanged, needsReview: s.needsReview, unknown: s.unknown },
    { total: 4, changeToOut: 1, unchanged: 1, needsReview: 1, unknown: 1 },
  );
});

test("cross-store isolation: another store's SPI is not resolved here → NEEDS_REVIEW", () => {
  // Pure-seoul scan given only pure-seoul mappings; a Malikas SPI leaking into the
  // source map has no mapping in THIS store's productBySpi → NEEDS_REVIEW (never
  // applied against a pure-seoul product).
  const sourceBySpi = new Map<string, SnoonuAvailability>([["malikas-spi", "OUT_OF_STOCK"]]);
  const productBySpi = new Map<string, ResolvedProduct>([["pure-spi", resolved("pPure", "In Stock")]]);
  const rows = buildAvailabilityDiff({ storefront: SF, sourceBySpi, productBySpi });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].action, "NEEDS_REVIEW");
  assert.equal(rows[0].actionable, false);
});

// ── planAvailabilityApply (selection + idempotency) ──────────────────────────
test("plan: only selected + actionable proceed; idempotent match → unchanged", () => {
  const sourceBySpi = new Map<string, SnoonuAvailability>([
    ["s1", "OUT_OF_STOCK"], // actionable CHANGE_TO_OUT
    ["s2", "IN_STOCK"],     // actionable CHANGE_TO_IN
    ["s3", "IN_STOCK"],     // UNCHANGED (not actionable)
  ]);
  const productBySpi = new Map<string, ResolvedProduct>([
    ["s1", resolved("p1", "In Stock")],
    ["s2", resolved("p2", "Out of Stock")],
    ["s3", resolved("p3", "In Stock")],
  ]);
  const rows = buildAvailabilityDiff({ storefront: SF, sourceBySpi, productBySpi });

  // Select p1 (apply), p2 (but internal already flipped to In Stock → unchanged),
  // p3 (not actionable → skip). p-missing not in rows.
  const plan = planAvailabilityApply({
    rows,
    selected: new Set(["p1", "p2", "p3"]),
    currentNow: new Map([
      ["p1", "In Stock"],
      ["p2", "In Stock"], // already the target → idempotent
      ["p3", "In Stock"],
    ]),
  });
  const byId = new Map(plan.map((p) => [p.productId, p]));
  assert.equal(byId.get("p1")!.action, "apply");
  assert.equal(byId.get("p1")!.targetState, "Out of Stock");
  assert.equal(byId.get("p2")!.action, "unchanged"); // stale-preview protection
  assert.equal(byId.get("p3")!.action, "skip");
});

test("plan: unselected rows are excluded entirely", () => {
  const rows = buildAvailabilityDiff({
    storefront: SF,
    sourceBySpi: new Map([["s1", "OUT_OF_STOCK"]]),
    productBySpi: new Map([["s1", resolved("p1", "In Stock")]]),
  });
  const plan = planAvailabilityApply({ rows, selected: new Set<string>(), currentNow: new Map() });
  assert.equal(plan.length, 0);
});

// ── source default (no live session → safe no-op) ────────────────────────────
test("default availability source reports session_required and yields no data", async () => {
  const src = createSnoonuAvailabilitySource(SF);
  assert.equal(src.storefront, SF);
  assert.equal(await src.state(), "session_required");
  assert.equal((await src.listAvailability()).size, 0);
});
