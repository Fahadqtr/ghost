// UX.4C-3 — Advanced media controls: pure reorder planner + source-of-truth
// invariant + source-scan guards for set-primary / reorder actions and the
// per-item editor controls.
//
// Run: node --conditions=react-server --experimental-strip-types --test lib/products/product-media-advanced.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { planReorder, toProductMediaState, type ProductMediaState } from "./product-media.ts";

const IMG = (n: string) => `https://x/product-images/${n}.jpg`;

function stateOf(extraIds: string[]): ProductMediaState {
  const primary = { id: "P", url: IMG("p"), filename: "p.jpg", isPrimary: true, sortOrder: 0 };
  const images = [
    primary,
    ...extraIds.map((id, i) => ({ id, url: IMG(id), filename: `${id}.jpg`, isPrimary: false, sortOrder: i })),
  ];
  return { primary, images };
}

// ── planReorder (pure) ───────────────────────────────────────────────────────

test("reorder: move down swaps with the next extra and renumbers 0..n-1", () => {
  const plan = planReorder(stateOf(["a", "b", "c"]), "a", "down");
  assert.deepEqual(plan, [
    { id: "b", sortOrder: 0 },
    { id: "a", sortOrder: 1 },
    { id: "c", sortOrder: 2 },
  ]);
});

test("reorder: move up swaps with the previous extra", () => {
  const plan = planReorder(stateOf(["a", "b", "c"]), "c", "up");
  assert.deepEqual(plan, [
    { id: "a", sortOrder: 0 },
    { id: "c", sortOrder: 1 },
    { id: "b", sortOrder: 2 },
  ]);
});

test("reorder: moving past an edge is a no-op", () => {
  assert.deepEqual(planReorder(stateOf(["a", "b", "c"]), "a", "up"), []);
  assert.deepEqual(planReorder(stateOf(["a", "b", "c"]), "c", "down"), []);
});

test("reorder: the primary is never moved and never appears in the plan", () => {
  assert.deepEqual(planReorder(stateOf(["a", "b"]), "P", "down"), [], "primary id → no-op");
  const plan = planReorder(stateOf(["a", "b"]), "a", "down");
  assert.equal(plan.some((p) => p.id === "P"), false, "plan touches extras only");
});

test("reorder: an unknown id is a no-op", () => {
  assert.deepEqual(planReorder(stateOf(["a", "b"]), "zzz", "down"), []);
});

test("reorder: deterministic — same input yields the same plan", () => {
  const s = stateOf(["a", "b", "c"]);
  assert.deepEqual(planReorder(s, "b", "down"), planReorder(s, "b", "down"));
});

// ── source-of-truth invariant (reducer) ──────────────────────────────────────

test("invariant: exactly one primary even if several rows claim is_primary", () => {
  const rows = [
    { id: "r1", url: IMG("a"), is_primary: true, sort_order: 0 },
    { id: "r2", url: IMG("b"), is_primary: true, sort_order: 1 },
    { id: "r3", url: IMG("c"), is_primary: true, sort_order: 2 },
  ];
  const s = toProductMediaState(IMG("b"), "b.jpg", rows);
  const primaries = s.images.filter((i) => i.isPrimary);
  assert.equal(primaries.length, 1, "one primary only");
  assert.equal(primaries[0].url, IMG("b"), "image_url is the source of truth");
});

test("invariant: no image_url → exactly one primary via the is_primary fallback", () => {
  const rows = [
    { id: "r1", url: IMG("a"), is_primary: true, sort_order: 0 },
    { id: "r2", url: IMG("b"), is_primary: true, sort_order: 1 },
  ];
  const s = toProductMediaState(null, null, rows);
  assert.equal(s.images.filter((i) => i.isPrimary).length, 1);
});

test("invariant: no images → primary null (matches products.image_url = null)", () => {
  const s = toProductMediaState(null, null, []);
  assert.equal(s.primary, null);
  assert.equal(s.images.length, 0);
});

// ── source-scan guards ───────────────────────────────────────────────────────

function src(rel: string): string {
  return readFileSync(new URL(rel, import.meta.url), "utf8");
}
const ACTIONS = src("../../app/(v2)/v2/catalog/media-actions.ts");
const EDITOR = src("../../components/v2/catalog/ProductMediaEditor.tsx");

test("set-primary action: product-scoped, verifies ownership, syncs the pointer", () => {
  assert.ok(ACTIONS.includes("export async function setPrimaryProductMedia"), "action exists");
  assert.ok(ACTIONS.includes("isSignedIn"), "auth gated");
  assert.ok(ACTIONS.includes(".eq(\"product_id\", validId)"), "writes scoped to this product");
  assert.ok(ACTIONS.includes(".eq(\"id\", imageId)"), "targets the chosen image");
  assert.ok(ACTIONS.includes("image_url: target.url"), "syncs products.image_url");
  assert.ok(ACTIONS.includes("image_filename: target.filename"), "syncs products.image_filename");
  assert.ok(ACTIONS.includes("is_primary: false"), "clears other primaries");
  assert.ok(ACTIONS.includes("is_primary: true"), "sets the chosen primary");
});

test("reorder action: reuses the pure planner and writes ONLY sort_order", () => {
  assert.ok(ACTIONS.includes("export async function reorderProductMedia"), "action exists");
  assert.ok(ACTIONS.includes("planReorder"), "uses the pure planner");
  assert.ok(ACTIONS.includes("sort_order: sortOrder"), "writes sort_order");
  // reorder must not touch the primary pointer or the primary flag.
  const fn = ACTIONS.slice(ACTIONS.indexOf("export async function reorderProductMedia"));
  assert.equal(/image_url|is_primary/.test(fn), false, "reorder never changes primary/image_url");
});

test("actions: admin is server-side, no RPC, no schema change, no storage cleanup", () => {
  assert.ok(ACTIONS.includes("createAdminClient"), "admin client (server-side only)");
  assert.equal(ACTIONS.includes(".rpc("), false, "no RPC");
  assert.equal(/create\s+table|alter\s+table/i.test(ACTIONS), false, "no DDL");
  // Orphan-storage policy unchanged: the actions add NO storage object deletion.
  assert.equal(ACTIONS.includes(".remove("), false, "no storage cleanup added");
});

test("editor: per-image set-primary, delete, and up/down controls; no client DB/storage", () => {
  assert.ok(EDITOR.includes("setPrimaryProductMedia"), "wired to set-primary");
  assert.ok(EDITOR.includes("reorderProductMedia"), "wired to reorder");
  assert.ok(EDITOR.includes("removeProductMedia"), "wired to delete");
  assert.ok(EDITOR.includes("تعيين رئيسية"), "set-primary control");
  assert.ok(EDITOR.includes("renderItemActions"), "per-item actions via the shared display");
  assert.ok(EDITOR.includes("window.confirm"), "confirm before delete");
  for (const bad of [".storage", ".upload(", "@supabase/", "createClient", "createAdminClient"]) {
    assert.equal(EDITOR.includes(bad), false, `editor must not contain ${bad}`);
  }
});
