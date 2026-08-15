// Staff convergence guards. INV.6A: staffAddProduct now hands its options THROUGH
// createProductCore (so the parent inventory seed = Σ variants and the whole
// create is all-or-nothing) instead of a tolerant per-variant insert loop. Two
// things:
//   1. a stateful proof of the spine contract — product ok + inventory fail →
//      product rolled back (no orphan), seeded from seedQuantity;
//   2. source guards that staffAddProduct builds variantRows (own 200-barcodes),
//      passes them to the core, keeps gallery + staff_tasks + response, and skips
//      all side effects on core failure.
//
// PURE — no DB, no network, no React. Stateful fake client + source scan.
//
// Run: node --conditions=react-server --experimental-strip-types --test lib/products/staff-create-core.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { createProductCore } from "./product-create.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

// ── 1. Spine contract: seedQuantity seeds inventory; inventory failure rolls back ─
function statefulClient(failInventory: boolean) {
  const products = new Map<string, Record<string, unknown>>();
  const inventory = new Map<string, Record<string, unknown>>();
  let seq = 0;
  const client = {
    from(table: string) {
      return {
        insert(values: Record<string, unknown> | Record<string, unknown>[]) {
          return {
            select(_c: string) {
              return {
                single() {
                  const id = `p${++seq}`;
                  products.set(id, { id, ...(values as Record<string, unknown>) });
                  return Promise.resolve({ data: { id }, error: null });
                },
              };
            },
            then<T>(onOk: (v: { error: unknown }) => T, onErr?: (e: unknown) => T) {
              if (table === "inventory") {
                if (failInventory) return Promise.resolve({ error: { message: "inv down" } }).then(onOk, onErr);
                const v = values as Record<string, unknown>;
                inventory.set(String(v.product_id), v);
              }
              return Promise.resolve({ error: null }).then(onOk, onErr);
            },
          };
        },
        delete() {
          return {
            filter(column: string, _op: string, value: string) {
              if (table === "products" && column === "id") products.delete(value);
              return Promise.resolve({ error: null });
            },
          };
        },
      };
    },
  };
  return { client, products, inventory };
}

// Staff row shape: NO stock_quantity on the product row — stock rides seedQuantity.
const STAFF_ROW = { sku: "mk5", barcode: "2001234567890", name_en: "Serum", platform_status: "Draft", approval: null };

test("spine: product row carries no stock_quantity; inventory seeded from seedQuantity", async () => {
  const { client, products, inventory } = statefulClient(false);
  const res = await createProductCore(client, STAFF_ROW, [], { seedQuantity: 12 });
  assert.ok(res.ok);
  const prod = [...products.values()][0];
  assert.ok(!("stock_quantity" in prod), "product row keeps no stock_quantity");
  assert.deepEqual([...inventory.values()][0], { product_id: "p1", stock_quantity: 12, low_stock_threshold: 5, sold_quantity: 0 });
});

test("spine: inventory failure rolls the product back — no orphan", async () => {
  const { client, products } = statefulClient(true);
  const res = await createProductCore(client, STAFF_ROW, [], { seedQuantity: 12 });
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.stage, "inventory_insert");
  assert.equal(products.size, 0, "product deleted — no orphan");
});

// ── 2. staffAddProduct source guards ──────────────────────────────────────────

const SRC = read("app/staff/actions.ts");
const FN = SRC.slice(SRC.indexOf("export async function staffAddProduct"), SRC.indexOf("\nexport ", SRC.indexOf("export async function staffAddProduct") + 1));

test("options are delegated to createProductCore (parent seed = Σ variants), not a separate loop", () => {
  assert.ok(FN.length > 0, "located staffAddProduct");
  assert.ok(/createProductCore\(admin, row, variantRows, \{ seedQuantity: stock \}\)/.test(FN), "calls the core with the built variantRows");
  assert.ok(SRC.includes('from "@/lib/products/product-create"'), "imports the single-product core");
  assert.ok(/const id = core\.productId/.test(FN), "uses core.productId");
});

test("no direct product/inventory insert remains in staffAddProduct", () => {
  assert.equal(/from\(["']products["']\)\s*\.insert/.test(FN), false, "no direct products.insert");
  assert.equal(/from\(["']inventory["']\)\s*\.insert/.test(FN), false, "no direct inventory.insert");
});

test("core failure: fixed messages, no raw DB error, no side effects", () => {
  const start = FN.indexOf("if (!core.ok)");
  const end = FN.indexOf("const id = core.productId");
  assert.ok(start > 0 && end > start, "located the failure block");
  const block = FN.slice(start, end);
  assert.ok(block.includes("core.duplicateIdentity"), "maps duplicateIdentity");
  assert.ok(block.includes("تعارض في الكود/الباركود"), "duplicate → existing conflict message");
  assert.ok(block.includes("تعذّر إنشاء المنتج"), "other → fixed safe message");
  assert.equal(/\.message/.test(block), false, "no raw DB message surfaced");
  // Post-create side-effects (gallery + task close) come AFTER the guard, so a
  // core failure returns before any of them.
  assert.ok(FN.indexOf('from("product_images")') > end, "gallery is after the core-success point");
  assert.ok(FN.indexOf('from("staff_tasks")') > end, "task close is after the core-success point");
});

test("options go through the core atomically (INV.6A) — no tolerant per-variant loop", () => {
  // Options are built into variantRows (each with its own 200-barcode) BEFORE the
  // atomic create and handed to the core, so the parent inventory seed = Σ variants
  // and the whole create is all-or-nothing — no direct per-variant insert.
  assert.ok(/const variantRows: CreateVariantRow\[\] = \[\]/.test(FN), "builds variantRows for the core");
  assert.ok(/barcode: await genUniqueBarcode\(admin\)/.test(FN), "each option gets its own barcode before the atomic create");
  assert.equal(/from\("product_variants"\)\.insert\(/.test(FN), false, "no direct variant insert in the wrapper");
  assert.ok(/createProductCore\(admin, row, variantRows/.test(FN), "variants ARE passed to the core");
  assert.ok(/createdVariants[^\n]*variantRows\.map/.test(FN), "response variants derived from the created rows");
});

test("Staff-specific behavior unchanged", () => {
  assert.ok(/currentStaff\(\)/.test(FN), "currentStaff auth kept");
  assert.ok(/hasPerm\(who\.perms, "add_product"\)/.test(FN), "add_product permission kept");
  assert.ok(/nextStaffSku\(admin\)/.test(FN), "nextStaffSku kept");
  assert.ok(/genUniqueBarcode\(admin\)/.test(FN), "product barcode via genUniqueBarcode kept");
  assert.ok(/from\("product_images"\)\.insert/.test(FN), "gallery kept");
  assert.ok(/from\("staff_tasks"\)/.test(FN) && /insertComment\(/.test(FN), "sourceTask close + comment kept");
  assert.ok(/notes: `staff-new:\$\{who\.name\}`/.test(FN), "provenance note kept");
  assert.ok(/return \{ product: \{/.test(FN) && /variants: createdVariants/.test(FN), "response shape unchanged");
  // 200-prefix barcode range (product + per-variant) lives in genUniqueBarcode.
  assert.ok(/"200" \+/.test(SRC), "200-prefix barcode range unchanged");
  // nextStaffSku delegates to the canonical nextMkSku.
  assert.ok(/nextMkSku\(/.test(SRC), "nextStaffSku still uses nextMkSku");
});

// ── 3. Regression: Archive restore stays exempt (spot-check) ──────────────────

test("Archive restore stays exempt — uses no create core", () => {
  const arch = read("app/(app)/products/archive/actions.ts");
  assert.equal(/createProductCore\(/.test(arch), false, "archive does not use the single core");
  assert.equal(/createProductsBatchCore/.test(arch), false, "archive does not use the batch core");
});
