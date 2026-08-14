// P5 — Malak add_product routed through createProductCore. Two things:
//   1. a STATEFUL fake-client proof that the mechanism Malak now relies on leaves
//      NO orphan product when the inventory seed fails (product is rolled back);
//   2. source guards + characterization pinning that commitAddProduct delegates to
//      the core while every preserved behavior (auth, token, idempotency, SKU
//      re-check + ms-suffix, no-barcode, row content, success message, audit) is
//      unchanged, and failures map to fixed Arabic strings (never a raw DB error).
//
// PURE — no DB, no network, no React. Runtime proof uses a scripted fake client;
// the route .tsx/.ts is verified by source scan (node cannot execute the handler).
//
// Run: node --conditions=react-server --experimental-strip-types --test lib/products/malak-create-core.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { createProductCore } from "./product-create.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

// ── 1. Stateful "no orphan" proof (the P5 fix) ────────────────────────────────
// A fake client backed by real Maps: products.insert adds a row, inventory.insert
// is injected to fail, products.delete removes the row. This models exactly what
// Malak now does — createProductCore(sb, row, []) — and proves the compensating
// rollback empties the products store on inventory failure.
function statefulClient(opts: { failInventory: boolean }) {
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
                if (opts.failInventory) return Promise.resolve({ error: { message: "inv down" } }).then(onOk, onErr);
                const v = values as Record<string, unknown>;
                inventory.set(String(v.product_id), v);
                return Promise.resolve({ error: null }).then(onOk, onErr);
              }
              return Promise.resolve({ error: null }).then(onOk, onErr);
            },
          };
        },
        delete() {
          return {
            filter(column: string, _op: string, value: string) {
              if (table === "products" && column === "id") products.delete(value);
              if (table === "inventory" && column === "product_id") inventory.delete(value);
              return Promise.resolve({ error: null });
            },
          };
        },
      };
    },
  };
  return { client, products, inventory };
}

const MALAK_ROW = {
  sku: "mk9",
  name_en: "Serum",
  name_ar: "سيروم",
  platform_status: "Draft",
  stock_quantity: 0,
  stock_status: "Out of Stock",
  notes: "أُضيف عبر ملاك (Malak) — الصورة تُرفع لاحقًا من صفحة التعديل.",
};

test("inventory failure → product rolled back → NO orphan remains", async () => {
  const { client, products, inventory } = statefulClient({ failInventory: true });
  const res = await createProductCore(client, MALAK_ROW, []);
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.equal(res.stage, "inventory_insert");
    assert.equal(res.cleanup, "done");
  }
  assert.equal(products.size, 0, "the product was deleted — no orphan");
  assert.equal(inventory.size, 0, "no inventory row lingers");
});

test("happy path → exactly one product + one inventory row, no variants", async () => {
  const { client, products, inventory } = statefulClient({ failInventory: false });
  const res = await createProductCore(client, MALAK_ROW, []);
  assert.ok(res.ok);
  if (res.ok) assert.equal(res.productId, "p1");
  assert.equal(products.size, 1);
  assert.equal(inventory.size, 1);
  const inv = [...inventory.values()][0];
  assert.deepEqual(inv, { product_id: "p1", stock_quantity: 0, low_stock_threshold: 5, sold_quantity: 0 });
});

// ── 2. Malak route source guards + characterization ───────────────────────────

const ROUTE = read("app/api/malak/commit/route.ts");
// commitAddProduct body only (so commitStock's own inventory insert isn't caught).
const ADD_BODY = ROUTE.slice(
  ROUTE.indexOf("async function commitAddProduct"),
  ROUTE.indexOf("async function commitSetImage"),
);

test("commitAddProduct delegates product+inventory to createProductCore", () => {
  assert.ok(ADD_BODY.length > 0, "located commitAddProduct");
  assert.ok(/createProductCore\(sb, row, \[\]\)/.test(ADD_BODY), "calls createProductCore(sb, row, [])");
  assert.ok(ROUTE.includes('from "@/lib/products/product-create"'), "imports the core");
});

test("commitAddProduct performs NO direct product/inventory insert anymore", () => {
  assert.equal(/from\(["']inventory["']\)\s*\.insert/.test(ADD_BODY), false, "no direct inventory insert");
  assert.equal(/from\(["']products["']\)\s*\.insert/.test(ADD_BODY), false, "no direct products insert");
});

test("failures map to fixed Arabic strings — no raw DB error surfaced", () => {
  assert.equal(/error\?\.message/.test(ADD_BODY), false, "no raw error?.message returned");
  assert.equal(/error\.message/.test(ADD_BODY), false, "no raw error.message returned");
  assert.ok(ADD_BODY.includes("رقم SKU لم يعد متاحًا"), "duplicateIdentity → fixed SKU message");
  assert.ok(ADD_BODY.includes("تم التراجع عن العملية بالكامل"), "inventory_insert → rolled-back message");
  assert.ok(ADD_BODY.includes("تعذّر التراجع الكامل"), "cleanup failed → manual-review message");
  assert.ok(/return \{ error: "تعذّر إنشاء المنتج\." \}/.test(ADD_BODY), "product_insert → fixed create-failure message");
});

test("failure mapping order: cleanup-failed before duplicate before inventory stage", () => {
  const iCleanup = ADD_BODY.indexOf('core.cleanup === "failed"');
  const iDup = ADD_BODY.indexOf("core.duplicateIdentity");
  const iInv = ADD_BODY.indexOf('core.stage === "inventory_insert"');
  assert.ok(iCleanup > 0 && iDup > iCleanup && iInv > iDup, "checks are ordered cleanup → duplicate → inventory");
});

test("success behavior preserved: byte-identical message, core.productId, add_product field", () => {
  assert.ok(
    ADD_BODY.includes('`تمت إضافة المنتج "${pr.name_en}" (SKU ${sku}) بحالة Draft.`'),
    "success message unchanged",
  );
  assert.ok(/productId: core\.productId/.test(ADD_BODY), "outcome uses core.productId");
  assert.ok(/field: "add_product"/.test(ADD_BODY), "field stays add_product");
  assert.ok(/newValue: sku/.test(ADD_BODY), "newValue stays the sku");
});

test("SKU re-check + millisecond suffix-on-clash preserved", () => {
  assert.ok(/select\("id"\)\.eq\("sku", sku\)/.test(ADD_BODY), "SKU uniqueness re-check kept");
  assert.ok(/\$\{sku\}-\$\{Date\.now\(\)\.toString\(\)\.slice\(-3\)\}/.test(ADD_BODY), "ms suffix-on-clash kept");
});

test("no barcode is added by Malak add_product; row content unchanged", () => {
  assert.equal(/barcode:/.test(ADD_BODY), false, "row has no barcode key");
  assert.ok(/platform_status: pr\.platform_status \|\| "Draft"/.test(ADD_BODY), "platform_status default Draft");
  assert.ok(/stock_quantity: 0/.test(ADD_BODY), "stock_quantity 0");
  assert.ok(/stock_status: "Out of Stock"/.test(ADD_BODY), "stock_status Out of Stock");
  assert.ok(/notes: "أُضيف عبر ملاك/.test(ADD_BODY), "Malak provenance note kept");
});

test("auth / token / idempotency / audit / admin-client flow unchanged", () => {
  assert.ok(/requireMalakWriter\(\)/.test(ROUTE), "auth gate kept");
  assert.ok(/verifyAction\(token\)/.test(ROUTE), "token verification kept");
  assert.ok(/consumeOnce\(`tok:\$\{token\}`/.test(ROUTE), "single-use consumeOnce kept");
  assert.ok(/isRecentDuplicate\(sb, action\)/.test(ROUTE), "30s idempotency kept");
  assert.ok(/const sb = createAdminClient\(\)/.test(ROUTE), "admin client still constructed");
  assert.ok(/writeAudit\(sb, action, out\)/.test(ROUTE), "audit still runs");
  assert.ok(/out\.productId/.test(ROUTE), "audit still receives the productId");
  assert.ok(/return Response\.json\(\{ ok: true, message: out\.message, audit \}\)/.test(ROUTE), "success response shape unchanged");
});
