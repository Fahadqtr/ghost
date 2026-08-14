// INV.3D — direct numeric-inventory-write guard.
//
// Same philosophy as lib/products/create-paths-guard.test.ts: a SOURCE SCAN of
// the current runtime plus an EXACT CLASSIFIED REGISTRY. Every runtime file that
// directly mutates a numeric inventory table MUST appear in the registry, and the
// scanned set must match the registry exactly. This makes the migration of each
// legacy writer to the Inventory Engine (INV.4A+) a visible, reviewed change.
//
// Protected numeric-inventory state:
//   inventory (stock_quantity / sold_quantity / location) — any insert/update/
//     upsert/delete;
//   product_variants.stock_quantity — update whose payload sets stock_quantity
//     (availability writes of product_variants.stock_status are NOT numeric and
//     are excluded);
//   shelf_stock / variant_shelf_stock — any insert/update/upsert/delete.
//
// SQL migrations / RPC definitions are a SEPARATE layer (supabase/**) and are NOT
// part of this runtime TypeScript scan.
//
// PURE — source scan only. Run:
// node --conditions=react-server --experimental-strip-types --test lib/inventory/direct-write-guard.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

function runtimeFiles(dirs: readonly string[]): string[] {
  const out: string[] = [];
  for (const dir of dirs) {
    for (const entry of readdirSync(join(ROOT, dir), { recursive: true })) {
      const rel = join(dir, String(entry));
      if (!/\.(ts|tsx)$/.test(rel) || /\.test\.(ts|tsx)$/.test(rel)) continue;
      if (!statSync(join(ROOT, rel)).isFile()) continue;
      out.push(rel);
    }
  }
  return out;
}

// A file directly writes NUMERIC inventory state if it matches ANY of these.
// `\s*` tolerates the newline some call sites put between `.from(...)` and the op.
//
// INV.4C refinement (Phase 18): an inventory UPDATE is a protected numeric-stock
// write when it touches stock_quantity / sold_quantity / location. A threshold-only
// update (low_stock_threshold) is NOT numeric-stock state, so an inline literal that
// sets only that is NOT protected. But an UPDATE with a VARIABLE payload is opaque
// (can't prove it isn't stock/sold/location) → treated as protected, conservatively.
const INV_UPDATE_VAR = /\.from\(\s*["']inventory["']\s*\)\s*\.update\(\s*[A-Za-z_$]/;
const INV_UPDATE_STOCK = /\.from\(\s*["']inventory["']\s*\)\s*\.update\(\s*\{[^}]*(stock_quantity|sold_quantity|location)/;
// inventory row create/remove (create-seed / archive / product deletion).
const INV_ROW_WRITE = /\.from\(\s*["']inventory["']\s*\)\s*\.(insert|upsert|delete)/;
const SHELF_WRITE = /\.from\(\s*["'](shelf_stock|variant_shelf_stock)["']\s*\)\s*\.(update|insert|upsert|delete)/;
// product_variants ONLY when the update payload sets stock_quantity (numeric).
// `stock_status` (availability) writes are deliberately excluded.
const PV_STOCK_WRITE = /\.from\(\s*["']product_variants["']\s*\)\s*\.update\(\s*\{[^}]*stock_quantity/;

function isDirectNumericWriter(src: string): boolean {
  return INV_UPDATE_VAR.test(src) || INV_UPDATE_STOCK.test(src) || INV_ROW_WRITE.test(src)
    || SHELF_WRITE.test(src) || PV_STOCK_WRITE.test(src);
}

type Classification = "engine" | "approved-rpc" | "legacy-direct" | "exempt" | "converged";

interface Entry {
  file: string;
  classification: Classification;
  /** true = the file itself directly writes a numeric inventory table today. */
  direct: boolean;
  note: string;
}

// The authoritative registry, built from a fresh scan of master at INV.3D.
// legacy-direct = a real writer awaiting migration to the engine (INV.4A+).
// exempt        = create-seed / archive-restore / product-deletion semantics.
// engine        = the Inventory Engine facade (calls RPCs, never a table write).
const REGISTRY: Entry[] = [
  // ── legacy-direct: daily numeric writers, migrate one-by-one in INV.4A+ ──────
  {
    file: "app/staff/actions.ts",
    classification: "legacy-direct",
    direct: true,
    note: "INV.4B migrated staffMoveVariant → engine.adjustVariantMovement (soldDelta 0) + authoritative transition " +
      "(no direct product_variants.stock_quantity write, parent rollup now atomic via the RPC). STILL legacy-direct " +
      "because of the on-demand inventory-row seed in staffItemForProduct (a create-seed insert, not a live-quantity " +
      "mutation). staffMoveVariant is pinned no-direct-write by inv-4b-writer-guard.test.ts.",
  },
  {
    file: "app/api/malak/commit/route.ts",
    classification: "legacy-direct",
    direct: true,
    note: "Malak commitStock sets inventory.stock_quantity (+ the products.stock_quantity mirror). " +
      "Product create delegates to createProductCore (seed).",
  },
  {
    file: "lib/inventory/movements.ts",
    classification: "legacy-direct",
    direct: true,
    note: "applyMovement / editMovementQty / deleteMovement — product-grain stock + sold_quantity RMW " +
      "with audit + zero-crossing task. The existing movement engine.",
  },
  {
    file: "lib/products/product-save.ts",
    classification: "legacy-direct",
    direct: true,
    note: "Product editor overwrites inventory.stock_quantity from the form field (the INV.3 parent-rollup " +
      "drift generator) and seeds an inventory row when missing.",
  },
  // ── exempt: create-seed ─────────────────────────────────────────────────────
  {
    file: "lib/products/product-create.ts",
    classification: "exempt",
    direct: true,
    note: "createProductCore — inserts a FRESH inventory seed (never mutates an existing quantity), with " +
      "compensating rollback delete on seed failure. Create semantics, not a stock mutation.",
  },
  {
    file: "lib/products/product-create-batch.ts",
    classification: "exempt",
    direct: true,
    note: "createProductsBatchCore — batch fresh inventory seed insert (importers). Create semantics.",
  },
  // ── exempt: product deletion / archive-restore ──────────────────────────────
  {
    file: "app/(app)/products/actions.ts",
    classification: "exempt",
    direct: true,
    note: "deleteProduct — removes the inventory row as part of full product deletion (row removal, not a " +
      "quantity mutation).",
  },
  {
    file: "app/(app)/catalog/health/actions.ts",
    classification: "exempt",
    direct: true,
    note: "deleteProductById — mirrors deleteProduct (inventory row removal on full deletion).",
  },
  {
    file: "app/(app)/products/archive/actions.ts",
    classification: "exempt",
    direct: true,
    note: "Archive deletes the inventory row into a snapshot; restore re-inserts the archived rows verbatim " +
      "to preserve identity. Snapshot semantics — must not go through the create/engine paths.",
  },
  {
    file: "lib/products/shelf-cleanup.ts",
    classification: "exempt",
    direct: true,
    note: "deleteShelfStockForProduct — fail-closed deletion of variant_shelf_stock rows during FULL product " +
      "deletion (variant_shelf_stock has no FK, so it must be cleared explicitly). Deletion cleanup, not a " +
      "live-product quantity mutation. Surfaced fresh at INV.3D (extracted product-delete helper).",
  },
  // ── converged: fully migrated — no direct numeric-stock write remains ────────
  {
    file: "app/(app)/inventory/actions.ts",
    classification: "converged",
    direct: false,
    note: "FULLY MIGRATED to the Inventory Engine across INV.4A/4B/4C: product-grain (setAbsolute), variant " +
      "movement + stocktake (adjustVariantMovement / setVariantAbsolute), and ALL shelf writers — setLocation, " +
      "applyShelfCounts, saveShelfStock, saveVariantShelfStock, removeFromShelf, moveShelfStock, bulkAssignShelf, " +
      "bulkAssignVariantShelf, and the applyStocktake location side-path (placeOnShelf / replaceShelfDistribution / " +
      "assignFullShelf / moveShelf). deleteSlot / deleteShelf are fail-closed topology-only deletions (reject when a " +
      "slot is occupied; no placement auto-delete). The ONLY remaining inventory.update is low_stock_threshold " +
      "(not numeric-stock state). Pinned no-direct-write by inv-4a/4b/4c-writer-guard.test.ts.",
  },
  // ── engine: the facade — calls RPCs, never a direct table write ──────────────
  {
    file: "lib/inventory/engine.ts",
    classification: "engine",
    direct: false,
    note: "Inventory Engine facade. Mutates ONLY through the INV.3C/4A/4B/4C atomic RPCs (.rpc), never a direct " +
      "table write, and never availability.",
  },
];

const directFiles = REGISTRY.filter((e) => e.direct).map((e) => e.file);

// ── 1. exact registry: scanned direct writers == registered direct entries ────

test("every direct numeric-inventory writer is a classified registry entry (exact)", () => {
  const found = runtimeFiles(["app", "lib"]).filter((rel) => isDirectNumericWriter(read(rel)));
  assert.deepEqual(
    [...found].sort(),
    [...directFiles].sort(),
    "scanned direct-write files must exactly match the registry's direct entries — a new/removed/migrated writer needs a registry update",
  );
});

// ── 2. each entry's `direct` flag matches source reality ──────────────────────

test("registry direct flags match the source", () => {
  for (const e of REGISTRY) {
    assert.equal(
      isDirectNumericWriter(read(e.file)),
      e.direct,
      `${e.file}: direct flag (${e.direct}) must match whether it actually writes a numeric inventory table`,
    );
  }
});

// ── 3. classifications are valid, and legacy writers are visible (not hidden) ──

test("classifications are from the allowed set and no legacy writer is disguised as exempt", () => {
  const allowed = new Set<Classification>(["engine", "approved-rpc", "legacy-direct", "exempt", "converged"]);
  for (const e of REGISTRY) assert.ok(allowed.has(e.classification), `${e.file}: valid classification`);
  // These writers still hold un-migrated numeric-stock mutations and MUST stay
  // visible as legacy-direct (never quietly reclassified exempt/converged).
  for (const f of [
    "app/staff/actions.ts",
    "app/api/malak/commit/route.ts",
    "lib/inventory/movements.ts",
    "lib/products/product-save.ts",
  ]) {
    assert.equal(REGISTRY.find((e) => e.file === f)?.classification, "legacy-direct", `${f} stays legacy-direct`);
  }
  // INV.4C: the inventory actions file is fully migrated → converged (not exempt).
  assert.equal(REGISTRY.find((e) => e.file === "app/(app)/inventory/actions.ts")?.classification, "converged",
    "inventory/actions.ts is converged after INV.4C");
  assert.ok(REGISTRY.some((e) => e.classification === "legacy-direct"), "legacy writers still present (INV.4D+)");
});

// ── 3b. matcher precision: threshold-only update is NOT a numeric-stock write, but
//        a stock/sold/location update (inline or via a variable payload) IS ──────

test("threshold-only inventory update is not a protected numeric-stock write", () => {
  assert.equal(isDirectNumericWriter(`admin.from("inventory").update({ low_stock_threshold: 5, updated_at: x })`), false);
  // stock / sold / location inline literals ARE protected
  assert.equal(isDirectNumericWriter(`admin.from("inventory").update({ stock_quantity: 3 })`), true);
  assert.equal(isDirectNumericWriter(`admin.from("inventory").update({ sold_quantity: 3 })`), true);
  assert.equal(isDirectNumericWriter(`admin.from("inventory").update({ location: "A1" })`), true);
  // a variable payload is opaque → conservatively protected
  assert.equal(isDirectNumericWriter(`admin.from("inventory").update(patch).eq("id", x)`), true);
  // insert / delete of an inventory row is always protected (create/archive/delete)
  assert.equal(isDirectNumericWriter(`admin.from("inventory").insert({ product_id: p })`), true);
  assert.equal(isDirectNumericWriter(`admin.from("inventory").delete().eq("id", x)`), true);
});

test("inventory/actions.ts no longer performs any direct numeric-stock write", () => {
  assert.equal(isDirectNumericWriter(read("app/(app)/inventory/actions.ts")), false,
    "all stock_quantity / sold_quantity / location / shelf writes go through the engine after INV.4C");
});

// ── 4. engine boundary: facade writes no numeric table directly, no availability

test("the Inventory Engine facade uses RPCs only — no direct write, no availability", () => {
  const raw = read("lib/inventory/engine.ts");
  assert.equal(isDirectNumericWriter(raw), false, "engine.ts performs no direct numeric table write");
  const code = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
  assert.equal(/stock_status/.test(code), false, "engine.ts never touches stock_status (availability boundary)");
  assert.equal(/from\(["']products["']\)/.test(code), false, "engine.ts never touches the products table (no stale mirror)");
  assert.equal(/availability\//.test(code), false, "engine.ts imports no availability module");
  assert.ok(/\.rpc\(\s*["']inv_(adjust_variant|set_variant_absolute|place_shelf)["']/.test(code), "engine.ts drives the INV.3C RPCs");
});

// ── 5. the availability engine is NOT a numeric writer (regression) ───────────

test("availability engine is not mis-flagged as a numeric inventory writer", () => {
  // It writes products.stock_status / product_variants.stock_status only — the
  // numeric matchers must NOT catch it.
  assert.equal(isDirectNumericWriter(read("lib/availability/engine.ts")), false);
});
