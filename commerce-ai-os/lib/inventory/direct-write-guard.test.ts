// INV.6A — direct numeric/structural inventory-write guard (V2).
//
// A SOURCE SCAN of the current runtime plus an EXACT CLASSIFIED REGISTRY. Every
// runtime file that directly mutates numeric inventory state — OR structurally
// changes it — MUST appear in the registry, and the scanned set must match the
// registry's direct entries exactly.
//
// Protected state (V2 — now includes STRUCTURAL variant writers):
//   inventory (stock_quantity / sold_quantity / location) — any insert/update/
//     upsert/delete; a variable-payload inventory.update is opaque → protected;
//   product_variants.stock_quantity — an update whose payload sets stock_quantity;
//   product_variants INSERT / DELETE — STRUCTURAL inventory state: inserting or
//     deleting a variant changes the parent rollup (stock defaults matter) even
//     when the payload names no stock column;
//   shelf_stock / variant_shelf_stock — any insert/update/upsert/delete.
// Availability writes (product_variants.stock_status) are NOT numeric and are
// deliberately excluded.
//
// After INV.6B runtime convergence: legacy-direct = 0 AND create-seed = 0 — there
// are ZERO direct numeric/structural inventory writers left in the runtime. Every
// create path now delegates its fresh inventory (+ variant) rows to the service-role
// initializer RPCs (inv_initialize_product_state / inv_initialize_simple_products),
// so the two create cores insert ONLY the products row; every live mutation goes
// through the Inventory Engine RPCs. products.stock_quantity is a RETIRED mirror
// (INV.4E) — not an inventory table and never written.
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

// `\s*` tolerates the newline some call sites put between `.from(...)` and the op.
const INV_UPDATE_VAR = /\.from\(\s*["']inventory["']\s*\)\s*\.update\(\s*[A-Za-z_$]/;
const INV_UPDATE_STOCK = /\.from\(\s*["']inventory["']\s*\)\s*\.update\(\s*\{[^}]*(stock_quantity|sold_quantity|location)/;
const INV_ROW_WRITE = /\.from\(\s*["']inventory["']\s*\)\s*\.(insert|upsert|delete)/;
const SHELF_WRITE = /\.from\(\s*["'](shelf_stock|variant_shelf_stock)["']\s*\)\s*\.(update|insert|upsert|delete)/;
// product_variants numeric update (stock_quantity). stock_status is excluded.
const PV_STOCK_WRITE = /\.from\(\s*["']product_variants["']\s*\)\s*\.update\(\s*\{[^}]*stock_quantity/;
// INV.6A — product_variants INSERT / DELETE is STRUCTURAL inventory state.
const PV_STRUCT_WRITE = /\.from\(\s*["']product_variants["']\s*\)\s*\.(insert|delete)/;

function isDirectNumericWriter(src: string): boolean {
  return INV_UPDATE_VAR.test(src) || INV_UPDATE_STOCK.test(src) || INV_ROW_WRITE.test(src)
    || SHELF_WRITE.test(src) || PV_STOCK_WRITE.test(src) || PV_STRUCT_WRITE.test(src);
}

type Classification = "engine" | "approved-rpc" | "converged" | "create-seed-exempt" | "structural-writer" | "legacy-direct";

interface Entry {
  file: string;
  classification: Classification;
  /** true = the file itself directly writes/structurally mutates inventory today. */
  direct: boolean;
  note: string;
}

// The authoritative registry at INV.6B. legacy-direct = 0 AND create-seed = 0:
// every daily runtime writer is converged onto the Inventory Engine RPCs, and the
// two create cores now delegate their fresh seed inserts to the service-role
// initializer RPCs. NO runtime file directly writes numeric/structural inventory.
const REGISTRY: Entry[] = [
  // ── converged create cores: delegate the fresh seed to the initializer RPC ────
  {
    file: "lib/products/product-create.ts",
    classification: "converged",
    direct: false,
    note: "INV.6B: createProductCore inserts ONLY the products row and delegates the FRESH inventory seed + variant " +
      "rows to the injected service-role initializer (inv_initialize_product_state) — no direct inventory/variant " +
      "write remains. Compensation deletes ONLY the product row (FK cascade removes the children). The parent seed is " +
      "the authoritative Σ variants for a variant product (top-level stock ignored); a malformed variant/simple seed " +
      "fails closed before any insert. products.stock_quantity (retired mirror, INV.4E) is never written. Pinned by " +
      "product-create / product-stock-mirror-guard / inv-6b-strict-enforcement-guard tests.",
  },
  {
    file: "lib/products/product-create-batch.ts",
    classification: "converged",
    direct: false,
    note: "INV.6B: createProductsBatchCore inserts ONLY product rows (chunked) and delegates the batch fresh inventory " +
      "seed to the injected service-role initializer (inv_initialize_simple_products) — no direct inventory write " +
      "remains. Every seed is a validated non-negative int4; products.stock_quantity (retired mirror) is never written.",
  },
  // ── converged: fully migrated — no direct numeric/structural write remains ────
  {
    file: "lib/inventory/movements.ts",
    classification: "converged",
    direct: false,
    note: "INV.6A: the manual product-grain movement engine is CONVERGED onto the atomic Inventory Engine RPCs " +
      "(recordProductMovement / editProductMovement / deleteProductMovement / reverseMovement). ZERO direct " +
      "inventory writes, no JS numeric read-modify-write, no clamp — the RPCs own stock + sold + the audit ledger " +
      "atomically. Pinned no-direct-write by inv-6a-runtime-closure-guard.test.ts.",
  },
  {
    file: "app/staff/actions.ts",
    classification: "converged",
    direct: false,
    note: "INV.6A: the staff lazy inventory-row seed is REMOVED (a missing inventory row now fails closed — no " +
      "INSERT), and staffAddProduct routes options THROUGH createProductCore (parent seed = Σ variants) instead of " +
      "a direct per-variant insert loop. staffMoveVariant / recordStaffMovement go through the Inventory Engine. No " +
      "direct inventory/variant/shelf write remains. Pinned by inv-6a-runtime-closure-guard.test.ts.",
  },
  {
    file: "app/(app)/inventory/actions.ts",
    classification: "converged",
    direct: false,
    note: "FULLY MIGRATED to the Inventory Engine across INV.4A/4B/4C. INV.6A: upsertVariants no longer INSERTs a " +
      "new option (structural) — it fails closed and requires the full editor; only metadata (name/barcode) updates " +
      "and low_stock_threshold updates remain, neither of which is numeric/structural inventory state.",
  },
  {
    file: "lib/products/product-save.ts",
    classification: "converged",
    direct: false,
    note: "INV.4D: the product editor writes no inventory — a simple product's stock goes through the Engine " +
      "(setAbsolute) and a variant product's parent is the atomic Σ-variants rollup inside sync_product_variants. " +
      "products.stock_quantity is a RETIRED mirror (INV.4E), not written. Pinned by inv-4d-writer-guard.test.ts.",
  },
  {
    file: "app/api/malak/commit/route.ts",
    classification: "converged",
    direct: false,
    note: "INV.4D: Malak commitStock resolves the inventory row read-only (FAIL CLOSED if missing) and sets stock " +
      "through the Inventory Engine (setAbsolute). products.stock_quantity is a RETIRED mirror (INV.4E), never written.",
  },
  {
    file: "app/(app)/products/actions.ts",
    classification: "converged",
    direct: false,
    note: "INV.6A: deleteProduct now deletes ONLY the product row and lets ON DELETE CASCADE remove every numeric " +
      "dependent (inventory → shelf_stock, product_variants → variant_shelf_stock, channel_products). No manual " +
      "child-delete chain, no retired shelf-cleanup helper.",
  },
  {
    file: "app/(app)/catalog/health/actions.ts",
    classification: "converged",
    direct: false,
    note: "INV.6A: deleteProductById mirrors deleteProduct — product-row delete only, FK cascade owns the children.",
  },
  {
    file: "app/(app)/products/archive/actions.ts",
    classification: "approved-rpc",
    direct: false,
    note: "INV.4E: archive/restore are the atomic archive_product_bundle / restore_product_archive RPCs " +
      "(service-role only); the action performs NO direct inventory/variant/shelf/channel/product write. " +
      "Pinned by inv-4e-writer-guard.test.ts.",
  },
  // ── engine: the facade — calls RPCs, never a direct table write ──────────────
  {
    file: "lib/inventory/engine.ts",
    classification: "engine",
    direct: false,
    note: "Inventory Engine facade. Mutates ONLY through the INV.3C/4A/4B/4C/5/6A atomic RPCs (.rpc), never a " +
      "direct table write, and never availability.",
  },
];

const directFiles = REGISTRY.filter((e) => e.direct).map((e) => e.file);

// ── 1. exact registry: scanned direct writers == registered direct entries ────

test("every direct numeric/structural inventory writer is a classified registry entry (exact)", () => {
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
      `${e.file}: direct flag (${e.direct}) must match whether it actually writes/structurally mutates inventory`,
    );
  }
});

// ── 3. classifications valid; legacy-direct = 0 AND direct writers = 0 (INV.6B) ─

test("classifications are valid and there are ZERO direct numeric/structural writers", () => {
  const allowed = new Set<Classification>(["engine", "approved-rpc", "converged", "create-seed-exempt", "structural-writer", "legacy-direct"]);
  for (const e of REGISTRY) assert.ok(allowed.has(e.classification), `${e.file}: valid classification`);
  assert.equal(REGISTRY.filter((e) => e.classification === "legacy-direct").length, 0, "no legacy-direct writers remain");
  // INV.6B: no runtime file directly writes numeric/structural inventory anymore.
  assert.deepEqual(REGISTRY.filter((e) => e.direct), [], "zero direct numeric/structural inventory writers remain");
  // The create cores + daily runtime writers are all converged.
  for (const f of [
    "lib/products/product-create.ts",
    "lib/products/product-create-batch.ts",
    "lib/inventory/movements.ts",
    "app/staff/actions.ts",
    "app/(app)/inventory/actions.ts",
  ]) {
    assert.equal(REGISTRY.find((e) => e.file === f)?.classification, "converged", `${f} is converged`);
  }
});

// ── 3b. matcher precision ─────────────────────────────────────────────────────

test("threshold-only inventory update is not a protected numeric-stock write", () => {
  assert.equal(isDirectNumericWriter(`admin.from("inventory").update({ low_stock_threshold: 5, updated_at: x })`), false);
  assert.equal(isDirectNumericWriter(`admin.from("inventory").update({ stock_quantity: 3 })`), true);
  assert.equal(isDirectNumericWriter(`admin.from("inventory").update({ sold_quantity: 3 })`), true);
  assert.equal(isDirectNumericWriter(`admin.from("inventory").update({ location: "A1" })`), true);
  assert.equal(isDirectNumericWriter(`admin.from("inventory").update(patch).eq("id", x)`), true);
  assert.equal(isDirectNumericWriter(`admin.from("inventory").insert({ product_id: p })`), true);
  assert.equal(isDirectNumericWriter(`admin.from("inventory").delete().eq("id", x)`), true);
});

test("product_variants INSERT/DELETE is structural (protected); metadata/availability update is not", () => {
  // INV.6A structural writers.
  assert.equal(isDirectNumericWriter(`admin.from("product_variants").insert({ parent_product_id: p })`), true);
  assert.equal(isDirectNumericWriter(`admin.from("product_variants").delete().eq("id", x)`), true);
  // numeric stock update is protected …
  assert.equal(isDirectNumericWriter(`admin.from("product_variants").update({ stock_quantity: 3 })`), true);
  // … but a metadata-only update (name/barcode) or an availability update is NOT.
  assert.equal(isDirectNumericWriter(`admin.from("product_variants").update({ variant_name: n, barcode: b })`), false);
  assert.equal(isDirectNumericWriter(`admin.from("product_variants").update({ stock_status: s })`), false);
});

test("inventory/actions.ts, movements.ts, and staff/actions.ts perform no direct numeric/structural write", () => {
  for (const f of ["app/(app)/inventory/actions.ts", "lib/inventory/movements.ts", "app/staff/actions.ts"]) {
    assert.equal(isDirectNumericWriter(read(f)), false, `${f} routes every stock change through the Inventory Engine after INV.6A`);
  }
});

// ── 4. engine boundary: facade writes no numeric table directly, no availability

test("the Inventory Engine facade uses RPCs only — no direct write, no availability", () => {
  const raw = read("lib/inventory/engine.ts");
  assert.equal(isDirectNumericWriter(raw), false, "engine.ts performs no direct numeric/structural table write");
  const code = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
  assert.equal(/stock_status/.test(code), false, "engine.ts never touches stock_status (availability boundary)");
  assert.equal(/from\(["']products["']\)/.test(code), false, "engine.ts never touches the products table (no stale mirror)");
  assert.equal(/availability\//.test(code), false, "engine.ts imports no availability module");
  assert.ok(/\.rpc\(\s*["']inv_record_product_movement["']/.test(code), "engine.ts drives the INV.6A movement RPCs");
});

// ── 5. the availability engine is NOT a numeric writer (regression) ───────────

test("availability engine is not mis-flagged as a numeric inventory writer", () => {
  assert.equal(isDirectNumericWriter(read("lib/availability/engine.ts")), false);
});
