// P6 — Shopify import routed through createProductCore. Two things:
//   1. a STATEFUL fake-client proof of the per-row mechanism the import now uses:
//      product ok + inventory fail → ONLY that product is rolled back, and the
//      NEXT row still creates successfully (the import never aborts);
//   2. source guards + characterization pinning that importShopifyProducts
//      delegates to the core with {seedQuantity} WITHOUT adding stock_quantity to
//      the product row, advances created/dedup only on success, reports failures
//      in failed[] with fixed text, and leaves mapping/dedup/skipped/logging/
//      response shape unchanged.
//
// PURE — no DB, no network, no React. Source scan + scripted fake client.
//
// Run: node --conditions=react-server --experimental-strip-types --test lib/products/shopify-create-core.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { createProductCore, type InitializeInventoryState } from "./product-create.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

// ── 1. Per-row rollback + continuation (stateful fake client + initializer) ────
// The Maps persist across calls, modeling the import loop's shared admin client.
// The client owns the PRODUCT rows; the injected initializer owns the inventory it
// would create (via the atomic service-role RPC in production) and can be told to
// fail for a specific product id.
function statefulClient() {
  const products = new Map<string, Record<string, unknown>>();
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
  return { client, products };
}

function statefulInit(failFor: Set<string>) {
  const inventory = new Map<string, number>();
  const initialize: InitializeInventoryState = async ({ productId, simpleStock }) => {
    if (failFor.has(productId)) return { ok: false, reason: "not_a_pristine_seed" };
    inventory.set(productId, simpleStock);
    return { ok: true };
  };
  return { initialize, inventory };
}

test("row whose inventory init fails is rolled back; the next row still succeeds", async () => {
  // p1 (first insert) fails its inventory init; p2 succeeds.
  const { client, products } = statefulClient();
  const { initialize, inventory } = statefulInit(new Set(["p1"]));
  const rowA = { sku: "SH-A", name_en: "A", approval: "Approved" };
  const rowB = { sku: "SH-B", name_en: "B", approval: "Approved" };

  const a = await createProductCore(client, rowA, [], initialize, { seedQuantity: 5 });
  assert.equal(a.ok, false);
  if (!a.ok) assert.equal(a.stage, "inventory_insert");

  // The import loop would push failed[] and CONTINUE — model that by running row B.
  const b = await createProductCore(client, rowB, [], initialize, { seedQuantity: 3 });
  assert.ok(b.ok);

  // Only the good product survives; the rolled-back one left no orphan.
  assert.deepEqual([...products.values()].map((p) => p.sku), ["SH-B"], "no orphan from row A");
  assert.equal(inventory.size, 1, "only row B initialized inventory");
  assert.equal(inventory.get("p2"), 3, "row B inventory seeded from its seedQuantity");
});

test("the product row inserted carries NO stock_quantity (mapping unchanged)", async () => {
  const { client, products } = statefulClient();
  const { initialize } = statefulInit(new Set());
  const row = { sku: "SH-C", name_en: "C", approval: "Approved" }; // exactly mapShopifyToCatalogRow's shape
  await createProductCore(client, row, [], initialize, { seedQuantity: 12 });
  const stored = [...products.values()][0];
  assert.ok(!("stock_quantity" in stored), "no stock_quantity injected into the product row");
});

// ── 2. Import wrapper source guards + characterization ────────────────────────

const SRC = read("app/(app)/import-export/shopify-actions.ts");
const BODY = SRC.slice(
  SRC.indexOf("export async function importShopifyProducts"),
  SRC.indexOf("// ---- Missing store images"),
);

test("import delegates to createProductCore with seedQuantity; no direct product/inventory insert", () => {
  assert.ok(BODY.length > 0, "located importShopifyProducts");
  // Tolerate a TS cast on `row` (e.g. `row as unknown as Record<string, unknown>`).
  assert.ok(/createProductCore\(sb, row\b/.test(BODY), "delegates to the core with the mapped row");
  assert.ok(/\[\], makeInventoryInitializer\(sb\), \{ seedQuantity: qty \}\)/.test(BODY), "passes no variants + service-role initializer + seedQuantity = store qty");
  assert.ok(SRC.includes('from "@/lib/products/product-create"'), "imports the core");
  assert.ok(SRC.includes('from "@/lib/products/inventory-initializer"'), "imports the service-role initializer");
  assert.equal(/from\(["']products["']\)\s*\.insert/.test(BODY), false, "no direct products.insert");
  assert.equal(/from\(["']inventory["']\)\s*\.insert/.test(BODY), false, "no direct inventory.insert");
});

test("no stock_quantity is added to the Shopify product row", () => {
  // The only stock source is the Shopify variant qty; the product row keeps none.
  assert.equal(/stock_quantity/.test(BODY), false, "import body never references stock_quantity");
  assert.ok(/const qty = Math\.max\(0, Number\(p\.variants\[0\]\?\.inventoryQuantity/.test(BODY), "qty from store variant");
});

test("created++ and dedup-set updates happen only AFTER a successful core call", () => {
  const iGuard = BODY.indexOf("if (!core.ok)");
  const iCreated = BODY.indexOf("created++");
  const iName = BODY.indexOf("existingNames.add(normTitle(row.name_en))");
  const iSku = BODY.indexOf("existingSkus.add(skuKey)");
  assert.ok(iGuard > 0 && iCreated > iGuard, "created++ is after the !core.ok guard");
  assert.ok(iName > iGuard && iSku > iGuard, "dedup-set updates are after the guard");
});

test("failure path: fixed Arabic text in failed[], no raw DB error, then continue", () => {
  assert.ok(
    /failed\.push\(\{ name: row\.name_en, error: "تعذّر إنشاء المنتج في الكتالوج\." \}\)/.test(BODY),
    "failed[] uses fixed safe text",
  );
  assert.equal(/insErr/.test(BODY), false, "the old raw-error variable is gone");
  // Scope the raw-message check to the per-row failure block — the outer catch
  // (whole-import abort) legitimately keeps `error: e.message` and is unchanged.
  const guardBlock = BODY.slice(BODY.indexOf("if (!core.ok)"), BODY.indexOf("created++"));
  assert.equal(/\.message/.test(guardBlock), false, "no raw DB message in the per-row failure path");
  assert.ok(/continue;/.test(guardBlock), "failure continues to the next row");
});

test("preserved: mapping, dedup, skipped, per-row loop, logging, revalidate, response shape", () => {
  assert.ok(/const row = mapShopifyToCatalogRow\(p\)/.test(BODY), "mapShopifyToCatalogRow unchanged");
  assert.ok(/existingSkus\.has\(skuKey\)/.test(BODY) && /existingNames\.has\(normTitle\(row\.name_en\)\)/.test(BODY), "sku/title dedup kept");
  assert.ok(/skipped\+\+/.test(BODY), "skipped counting kept");
  assert.ok(/for \(const p of wanted\)/.test(BODY), "per-row loop kept");
  assert.ok(/logCatalogTask\(\{ action: "bulk"/.test(BODY), "logCatalogTask kept (created>0)");
  assert.ok(/revalidatePath\("\/import-export\/shopify-sync"\)/.test(BODY), "revalidatePath kept");
  assert.ok(/return \{ ok: true, created, skipped, failed \}/.test(BODY), "response shape unchanged");
  assert.ok(/createAdminClient\(\)/.test(BODY), "admin client unchanged");
});
