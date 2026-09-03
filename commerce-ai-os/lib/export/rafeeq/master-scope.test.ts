// STEP 48 — the Rafeeq FULL export universe is the CURRENT MASTER.
//
// The Rafeeq replacement catalogue must contain exactly the active
// snoonu:malikas membership. Before this, loadRafeeqPreview read every
// canonical product (1530) and the deployed page offered to export all of
// them to the marketplace.
//
// These tests pin the wiring and the behaviour. The literal counts that appear
// here are TEST FIXTURES, never runtime logic — the exporter derives its
// universe from the membership it is given.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { buildRafeeqPreview, rafeeqExportDiscountPrice, RAFEEQ_SNOONU_ALIGNED_PRICING,
         type RafeeqPreviewProduct } from "./preview.ts";
import { buildMasterScope, scopeRows } from "../../home/master-scope.ts";
import { CATALOG_STOREFRONT_KEY, CATALOG_MAPPING_STATUS } from "../../catalog-v2/master-membership.ts";

const strip = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const SERVER = "./preview.server.ts";

function product(over: Partial<RafeeqPreviewProduct> & { id: string; sku: string }): RafeeqPreviewProduct {
  return {
    barcode: "1234567890123", nameEn: `EN ${over.sku}`, nameAr: `ع ${over.sku}`,
    category: "Makeup", price: 50, discountPrice: null, descriptionEn: "d", descriptionAr: "و",
    imageUrl: `https://example.test/${over.sku}.jpg`, imageFilename: `${over.sku}.jpg`,
    galleryImageUrls: [], imageCount: 1, variants: [], ...over,
  };
}

// ── the source universe is the membership, not the catalogue ─────────────────

test("only master members reach the Rafeeq export universe", () => {
  const all = [product({ id: "p1", sku: "mk1" }), product({ id: "p2", sku: "mk2" }),
               product({ id: "outside", sku: "mk999" })];
  // membership built exactly as production builds it — from ECL rows
  const scope = buildMasterScope([{ product_id: "p1" }, { product_id: "p2" }]);
  const scoped = all.filter((p) => scope.ids.has(p.id));
  const res = buildRafeeqPreview({ products: scoped });
  assert.equal(res.counts.productCount, 2, "outside-master product excluded");
  assert.equal(res.rows.some((r) => r.sku === "mk999"), false);
  assert.equal(scope.total, 2, "master size is derived, never assumed");
});

test("options and physical rows are counted over the SCOPED universe only", () => {
  const opt = (sku: string, n: number) => product({
    id: sku, sku,
    variants: Array.from({ length: n }, (_, i) => ({ id: `${sku}-v${i}`, sku: `${sku}-${i}`,
      barcode: null, nameEn: null, nameAr: `o${i}`, price: 50 })),
  });
  const all = [product({ id: "s1", sku: "mkS1" }), opt("mkO1", 3), opt("mkOutside", 4)];
  const scope = buildMasterScope([{ product_id: "s1" }, { product_id: "mkO1" }]);
  const res = buildRafeeqPreview({ products: all.filter((p) => scope.ids.has(p.id)) });
  assert.equal(res.counts.productCount, 2);
  assert.equal(res.counts.productsWithOptions, 1, "the outside option product is not counted");
  assert.equal(res.counts.optionCount, 3, "its 4 options are not counted either");
  assert.equal(res.counts.physicalRowCount, 1 + 3, "1 simple row + 3 option rows");
});

test("an outside-master product missing an image cannot block the export", () => {
  const all = [product({ id: "good", sku: "mkGood" }),
               product({ id: "bad", sku: "mkBad", imageUrl: null, imageFilename: null, imageCount: 0 })];
  const scope = buildMasterScope([{ product_id: "good" }]);
  const res = buildRafeeqPreview({ products: all.filter((p) => scope.ids.has(p.id)) });
  assert.equal(res.rows.filter((r) => !r.hasImage).length, 0, "no missing-image row survives scoping");
});

test("scopeRows fails CLOSED — an unreadable membership yields no products", () => {
  const all = [product({ id: "p1", sku: "mk1" })];
  const dead = { ok: false as const, ids: new Set<string>(), total: 0 };
  assert.deepEqual(scopeRows(all, (p) => p.id, dead), [], "never falls back to the full catalogue");
});

// ── the real app path is wired to the shared seam ────────────────────────────

test("loadRafeeqPreview scopes its product read to the shared master seam", () => {
  const src = strip(readFileSync(new URL(SERVER, import.meta.url), "utf8"));
  assert.ok(/loadMasterScope\(\)/.test(src), "uses the shared membership loader");
  assert.ok(/const productRows = allProductRows\.filter\(/.test(src),
    "the product universe is the scoped projection");
  assert.ok(/scope\.ids\.has\(p\.id\)/.test(src), "scoped by canonical product id");
  assert.ok(/if \(!scope\.ok\) return null;/.test(src), "fails closed");
  // nothing downstream may read the unscoped array
  assert.equal((src.match(/allProductRows/g) ?? []).length, 2,
    "allProductRows is only destructured and then scoped — never used downstream");
});

test("the Rafeeq exporter does not define its own master rule", () => {
  const src = strip(readFileSync(new URL(SERVER, import.meta.url), "utf8"));
  assert.equal(new RegExp(CATALOG_STOREFRONT_KEY).test(src), false,
    "must not restate the storefront key — the shared seam owns it");
  assert.equal(/buildMasterScope|mapping_status\s*===/.test(src), false,
    "must not rebuild membership locally");
  assert.equal(CATALOG_MAPPING_STATUS, "active");
});

test("no master/catalogue size is hardcoded as runtime logic", () => {
  for (const rel of [SERVER, "./preview.ts"]) {
    const src = strip(readFileSync(new URL(rel, import.meta.url), "utf8"));
    for (const nlit of ["1343", "1530", "1454", "187", "162"]) {
      assert.equal(new RegExp(`\\b${nlit}\\b`).test(src), false, `${rel} must not hardcode ${nlit}`);
    }
  }
});

// ── STEP 47 pricing must survive ─────────────────────────────────────────────

test("Snoonu-aligned pricing remains enabled and leak-free after scoping", () => {
  assert.equal(RAFEEQ_SNOONU_ALIGNED_PRICING, true);
  assert.equal(rafeeqExportDiscountPrice(235.5), null);
  const scope = buildMasterScope([{ product_id: "d1" }]);
  const all = [product({ id: "d1", sku: "mkDisc", price: 589, discountPrice: 235.5 })];
  const res = buildRafeeqPreview({
    products: all.filter((p) => scope.ids.has(p.id))
      .map((p) => ({ ...p, discountPrice: rafeeqExportDiscountPrice(p.discountPrice) })),
  });
  assert.equal(res.rows[0].price, 589, "exports the Snoonu price, not the discount");
});

test("the scoped reader still writes nothing", () => {
  const src = strip(readFileSync(new URL(SERVER, import.meta.url), "utf8"));
  for (const re of [/\.update\s*\(/, /\.insert\s*\(/, /\.upsert\s*\(/, /\.delete\s*\(/, /\.rpc\s*\(/]) {
    assert.equal(re.test(src), false, "the exporter must remain read-only");
  }
});
