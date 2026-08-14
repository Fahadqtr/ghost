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

// A file directly writes numeric inventory state if it matches ANY of these.
// `\s*` tolerates the newline some call sites put between `.from(...)` and the op.
const INV_WRITE = /\.from\(\s*["']inventory["']\s*\)\s*\.(update|insert|upsert|delete)/;
const SHELF_WRITE = /\.from\(\s*["'](shelf_stock|variant_shelf_stock)["']\s*\)\s*\.(update|insert|upsert|delete)/;
// product_variants ONLY when the update payload sets stock_quantity (numeric).
// `stock_status` (availability) writes are deliberately excluded.
const PV_STOCK_WRITE = /\.from\(\s*["']product_variants["']\s*\)\s*\.update\(\s*\{[^}]*stock_quantity/;

function isDirectNumericWriter(src: string): boolean {
  return INV_WRITE.test(src) || SHELF_WRITE.test(src) || PV_STOCK_WRITE.test(src);
}

type Classification = "engine" | "approved-rpc" | "legacy-direct" | "exempt";

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
    file: "app/(app)/inventory/actions.ts",
    classification: "legacy-direct",
    direct: true,
    note: "INV.4A migrated the product-grain writers → engine.setAbsolute (updateInventory, bulkUpdateInventory, " +
      "importInventoryBySku, applyStocktake). INV.4B migrated the variant writers → engine.adjustVariantMovement / " +
      "setVariantAbsolute + authoritative transition (recordVariantMovement, applyVariantStocktake) — no direct " +
      "product_variants.stock_quantity / parent rollup / sold_quantity write. STILL legacy-direct because the SAME " +
      "FILE retains the shelf writers — setLocation / applyShelfCounts / saveShelfStock / saveVariantShelfStock / " +
      "moveShelfStock / removeFromShelf / bulkAssignShelf / bulkAssignVariantShelf (shelf_stock / variant_shelf_stock " +
      "→ INV.4C). The migrated functions are pinned no-direct-write by inv-4a-writer-guard.test.ts (4A) and " +
      "inv-4b-writer-guard.test.ts (4B).",
  },
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
  // ── engine: the facade — calls RPCs, never a direct table write ──────────────
  {
    file: "lib/inventory/engine.ts",
    classification: "engine",
    direct: false,
    note: "Inventory Engine facade. Mutates ONLY through the INV.3C atomic RPCs (.rpc), never a direct table " +
      "write, and never availability. Not wired to any runtime writer yet (INV.4A+).",
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
  const allowed = new Set<Classification>(["engine", "approved-rpc", "legacy-direct", "exempt"]);
  for (const e of REGISTRY) assert.ok(allowed.has(e.classification), `${e.file}: valid classification`);
  // The known daily numeric writers MUST be visible as legacy-direct so INV.4A+
  // can reduce them — they can never be quietly reclassified exempt.
  for (const f of [
    "app/(app)/inventory/actions.ts",
    "app/staff/actions.ts",
    "app/api/malak/commit/route.ts",
    "lib/inventory/movements.ts",
    "lib/products/product-save.ts",
  ]) {
    assert.equal(REGISTRY.find((e) => e.file === f)?.classification, "legacy-direct", `${f} stays legacy-direct`);
  }
  // At least one legacy-direct writer still exists (nothing migrated yet in 3D).
  assert.ok(REGISTRY.some((e) => e.classification === "legacy-direct"), "legacy writers present");
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
