// INV.4E — products.stock_quantity MIRROR retirement guard.
//
// The products.stock_quantity column is a retired, frozen legacy mirror. After
// INV.4E NOTHING in the runtime may:
//   • WRITE it — no .from("products").insert/update/upsert whose payload sets
//     stock_quantity (inline literal), and the known product-create cores must
//     STRIP it from the product row before insert (proven by running them);
//   • READ it as authority / a fallback — no `?? product.stock_quantity` style
//     rescue of a missing inventory quantity.
//
// What is explicitly STILL allowed (and must not be mis-flagged):
//   • ProductInput.stock_quantity / VariantInput.stock_quantity — FORM request
//     fields (they seed the authoritative inventory / variant rows, never the
//     products mirror);
//   • inventory.stock_quantity and product_variants.stock_quantity — the real
//     authoritative columns;
//   • the historical archive bundle JSON (a snapshot may contain the old key);
//   • historical migrations / this and other tests.
//
// PURE — source scan + running the pure create cores. Run:
// node --conditions=react-server --experimental-strip-types --test lib/inventory/product-stock-mirror-guard.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createProductCore } from "../products/product-create.ts";
import { createProductsBatchCore } from "../products/product-create-batch.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
function strip(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

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

// A products-table write whose payload sets stock_quantity (inline object
// literal). `[^}]*` spans newlines up to the first closing brace, so a
// multi-line literal is caught too. Anchored to the exact "products" string, so
// product_variants / product_images / product_archive never match.
const PRODUCTS_MIRROR_WRITE =
  /\.from\(\s*["']products["']\s*\)\s*\.(update|insert|upsert)\(\s*\{[^}]*\bstock_quantity\b/;

// A read that rescues a missing authoritative quantity from the products mirror.
const MIRROR_READ_FALLBACK = /\?\?\s*[A-Za-z_$][\w$]*\.stock_quantity/;

// ── 1. zero runtime mirror WRITES (inline literal) across app + lib ────────────

test("no runtime writes products.stock_quantity (inline literal payload)", () => {
  const offenders = runtimeFiles(["app", "lib"]).filter((rel) => PRODUCTS_MIRROR_WRITE.test(strip(read(rel))));
  assert.deepEqual(offenders, [], "products.stock_quantity mirror is retired — no runtime write may set it");
});

// ── 2. the matcher is precise (regression) ────────────────────────────────────

test("matcher flags a products mirror write but not the authoritative columns", () => {
  assert.equal(PRODUCTS_MIRROR_WRITE.test(`sb.from("products").update({ stock_quantity: n })`), true);
  assert.equal(PRODUCTS_MIRROR_WRITE.test(`sb.from("products").insert({ sku, stock_quantity: 0 })`), true);
  // authoritative / unrelated tables must NOT match
  assert.equal(PRODUCTS_MIRROR_WRITE.test(`sb.from("inventory").update({ stock_quantity: n })`), false);
  assert.equal(PRODUCTS_MIRROR_WRITE.test(`sb.from("product_variants").update({ stock_quantity: n })`), false);
  assert.equal(PRODUCTS_MIRROR_WRITE.test(`sb.from("products").update({ price: 9 })`), false);
  // a form field / read is not a DB write
  assert.equal(PRODUCTS_MIRROR_WRITE.test(`const stock_quantity = input.stock_quantity`), false);
});

// ── 3. no authoritative READ fallback to the mirror across app + lib ───────────

test("no runtime read rescues a missing quantity from the products mirror", () => {
  const offenders = runtimeFiles(["app", "lib"])
    .filter((rel) => MIRROR_READ_FALLBACK.test(strip(read(rel))))
    // inv?.stock_quantity ?? 0 is fine; only a fallback onto ANOTHER .stock_quantity is suspect
    .filter((rel) => {
      const s = strip(read(rel));
      // Allow `?? 0`, `?? null`; flag `?? something.stock_quantity`.
      return MIRROR_READ_FALLBACK.test(s);
    });
  assert.deepEqual(offenders, [], "authoritative stock reads must not fall back to products.stock_quantity");
});

test("read-fallback matcher precision", () => {
  assert.equal(MIRROR_READ_FALLBACK.test(`inv?.stock_quantity ?? product.stock_quantity`), true);
  assert.equal(MIRROR_READ_FALLBACK.test(`inv?.stock_quantity ?? p.stock_quantity ?? 0`), true);
  assert.equal(MIRROR_READ_FALLBACK.test(`inv?.stock_quantity ?? 0`), false);
});

// ── 4. product editor + Malak never write the mirror ──────────────────────────

test("product-save updateProductCore never writes products.stock_quantity", () => {
  const s = strip(read("lib/products/product-save.ts"));
  assert.equal(PRODUCTS_MIRROR_WRITE.test(s), false, "editor writes products for METADATA only");
  assert.equal(/stock_quantity:\s*stockAfter/.test(s), false, "no mirror write of the authoritative final stock");
});

test("Malak commitStock never writes products.stock_quantity", () => {
  const s = strip(read("app/api/malak/commit/route.ts"));
  assert.equal(PRODUCTS_MIRROR_WRITE.test(s), false, "Malak stock update writes only the inventory engine");
  assert.equal(/stock_quantity:\s*newVal/.test(s), false, "no mirror write after setAbsolute");
});

// ── 5. the create cores STRIP the mirror before insert (characterization) ──────

function makeCreateClient() {
  const inserts: { table: string; values: any }[] = [];
  const client: any = {
    from(table: string) {
      return {
        insert(values: any) {
          inserts.push({ table, values });
          const p: any = Promise.resolve({ error: null });
          p.select = (_c: string) => ({ single: () => Promise.resolve({ data: { id: "p1" }, error: null }) });
          return p;
        },
        delete() {
          return { filter: () => Promise.resolve({ error: null }) };
        },
      };
    },
  };
  return { client, inserts };
}

test("createProductCore strips stock_quantity from the product row; the seed goes to the initializer", async () => {
  const { client, inserts } = makeCreateClient();
  let seenSeed: number | null = null;
  const initialize = async ({ simpleStock }: { simpleStock: number }) => {
    seenSeed = simpleStock;
    return { ok: true } as const;
  };
  const res = await createProductCore(client, { sku: "mk9", name_ar: "x", stock_quantity: 17 }, [], initialize);
  assert.ok(res.ok);
  const prod = inserts.find((i) => i.table === "products")!.values;
  assert.ok(!("stock_quantity" in prod), "product insert has NO stock_quantity mirror");
  assert.equal(inserts.some((i) => i.table === "inventory"), false, "no direct inventory insert through the client");
  assert.equal(seenSeed, 17, "the initializer receives the requested quantity");
});

function makeBatchClient() {
  const inserts: { table: string; values: any[] }[] = [];
  const client: any = {
    from(table: string) {
      return {
        insert(values: any[]) {
          inserts.push({ table, values });
          const p: any = Promise.resolve({ error: null });
          p.select = (_c: string) =>
            Promise.resolve({ data: values.map((_, i) => ({ id: `p${i}` })), error: null });
          return p;
        },
        delete() {
          return { in: () => Promise.resolve({ error: null }) };
        },
      };
    },
  };
  return { client, inserts };
}

test("createProductsBatchCore strips stock_quantity from every product row; the seeds go to the initializer", async () => {
  const { client, inserts } = makeBatchClient();
  const targetsSeen: { productId: string; stockQuantity: number }[] = [];
  const initializeSimple = async (targets: { productId: string; stockQuantity: number }[]) => {
    targetsSeen.push(...targets);
    return { ok: true } as const;
  };
  const rows = [
    { sku: "a", stock_quantity: 17 },
    { sku: "b", stock_quantity: 3 },
  ];
  const res = await createProductsBatchCore(client, rows, initializeSimple);
  assert.equal(res.added, 2);
  const productInsert = inserts.find((i) => i.table === "products")!.values;
  for (const r of productInsert) assert.ok(!("stock_quantity" in r), "each product insert row strips the mirror");
  assert.equal(inserts.some((i) => i.table === "inventory"), false, "no direct inventory insert through the client");
  assert.deepEqual(targetsSeen.map((t) => t.stockQuantity), [17, 3], "initializer targets seed from the requested quantities");
  // caller rows not mutated (mirror still present on the inputs)
  assert.equal(rows[0].stock_quantity, 17);
});

// ── 6. ProductInput.stock_quantity stays a legitimate FORM request field ───────

test("ProductInput / VariantInput keep stock_quantity as a request field (not a DB mirror write)", () => {
  const s = read("lib/products/product-save.ts");
  assert.ok(/interface ProductInput[\s\S]*?stock_quantity:\s*string/.test(s), "ProductInput.stock_quantity request field kept");
  assert.ok(/interface VariantInput[\s\S]*?stock_quantity:\s*string/.test(s), "VariantInput.stock_quantity request field kept");
});
