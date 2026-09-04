// STEP 60 — the Talabat export universe is the CURRENT MASTER.
//
// Before this, loadTalabatPreview read EVERY canonical product, so the deployed
// preview and package operated on 1665 sellable rows of which 211 belonged to
// products outside the active snoonu:malikas membership. Worse, the duplicate
// SKU / barcode checks run across the WHOLE flattened dataset, so an
// out-of-master twin BLOCKED its in-master counterpart — six real master rows
// were blocked that way by six non-master products.
//
// These tests pin the wiring and the behaviour. Any literal count here is a
// TEST FIXTURE, never runtime logic — the exporter derives its universe from
// the membership it is handed.
//
// node --conditions=react-server --experimental-strip-types --test lib/export/talabat/step60-master-scope.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { buildTalabatPreview, type TalabatPreviewProduct } from "./preview.ts";
import { buildMasterScope, scopeRows } from "../../home/master-scope.ts";
import { CATALOG_STOREFRONT_KEY, CATALOG_MAPPING_STATUS } from "../../catalog-v2/master-membership.ts";

/** Strip comments so a source scan asserts on CODE, never on prose. */
const strip = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const SERVER = "./preview.server.ts";
const src = (): string => strip(readFileSync(new URL(SERVER, import.meta.url), "utf8"));

function product(over: Partial<TalabatPreviewProduct> & { id: string; sku: string }): TalabatPreviewProduct {
  return {
    barcode: "1234567890123",
    nameEn: `EN ${over.sku}`,
    nameAr: `ع ${over.sku}`,
    price: 50,
    discountPrice: null,
    category: "Makeup",
    descriptionEn: "d",
    descriptionAr: "و",
    imageUrl: `https://example.test/${over.sku}.jpg`,
    imageFilename: `${over.sku}.jpg`,
    galleryImageUrls: [],
    imageCount: 1,
    approved: true,
    lifecycleState: "ACTIVE",
    variants: [],
    ...over,
  };
}

// ── the source universe is the membership, not the catalogue ─────────────────

test("1: only master members reach the Talabat export universe", () => {
  const all = [
    product({ id: "p1", sku: "mk1", barcode: "1111111111111" }),
    product({ id: "p2", sku: "mk2", barcode: "2222222222222" }),
    product({ id: "outside", sku: "mk999", barcode: "9999999999999" }),
  ];
  // membership built exactly as production builds it — from ECL rows
  const scope = buildMasterScope([{ product_id: "p1" }, { product_id: "p2" }]);
  const res = buildTalabatPreview({ products: all.filter((p) => scope.ids.has(p.id)) });
  assert.equal(res.counts.productCount, 2, "outside-master product excluded");
  assert.equal(res.rows.some((r) => r.sku === "mk999"), false, "no outside-master row");
  assert.equal(scope.total, 2, "master size is derived, never assumed");
});

test("2: sellable rows are flattened over the SCOPED universe only", () => {
  const opt = (sku: string, id: string, n: number) => product({
    id, sku,
    variants: Array.from({ length: n }, (_, i) => ({
      id: `${id}-v${i}`, sku: `${sku}-${i}`, barcode: `77777777777${i}`,
      nameEn: null, nameAr: `o${i}`, price: 50,
    })),
  });
  const all = [
    product({ id: "s1", sku: "mkS1", barcode: "1111111111111" }),
    opt("mkO1", "o1", 3),
    opt("mkOutside", "outside", 4),
  ];
  const scope = buildMasterScope([{ product_id: "s1" }, { product_id: "o1" }]);
  const res = buildTalabatPreview({ products: all.filter((p) => scope.ids.has(p.id)) });
  assert.equal(res.counts.productCount, 2, "the outside option product is not a product");
  assert.equal(res.counts.variantCount, 3, "its 4 options are not counted either");
  assert.equal(res.counts.sellableRowCount, 1 + 3, "1 simple row + 3 option rows, no parent row");
  assert.equal(res.rows.some((r) => r.sku.startsWith("mkoutside")), false);
});

// ── the defect this step exists to remove ────────────────────────────────────

test("3: an out-of-master barcode twin can no longer block an in-master row", () => {
  // the exact production shape: mk2218 (master) and mk1730 (outside) share a barcode
  const SHARED = "0429766714844";
  const all = [
    product({ id: "inMaster", sku: "mk2218", barcode: SHARED }),
    product({ id: "outside", sku: "mk1730", barcode: SHARED }),
  ];

  // BEFORE — unscoped: the dataset-wide duplicate check blocks BOTH
  const unscoped = buildTalabatPreview({ products: all });
  const beforeRow = unscoped.rows.find((r) => r.sku === "mk2218")!;
  assert.equal(beforeRow.status, "BLOCKED", "unscoped, the master row is blocked");
  assert.ok(beforeRow.reasons.some((x) => x.code === "DUPLICATE_BARCODE"),
    "and specifically by the outside twin's barcode");

  // AFTER — scoped to the master: the twin is not in the dataset at all
  const scope = buildMasterScope([{ product_id: "inMaster" }]);
  const scoped = buildTalabatPreview({ products: all.filter((p) => scope.ids.has(p.id)) });
  const afterRow = scoped.rows.find((r) => r.sku === "mk2218")!;
  assert.equal(afterRow.reasons.some((x) => x.code === "DUPLICATE_BARCODE"), false,
    "scoped, no duplicate-barcode reason survives");
  assert.equal(scoped.rows.length, 1, "only the master row remains");
});

test("4: the same holds for a duplicate SKU introduced from outside the master", () => {
  const all = [
    product({ id: "inMaster", sku: "mkDup", barcode: "1111111111111" }),
    product({ id: "outside", sku: "mkDup", barcode: "2222222222222" }),
  ];
  assert.ok(
    buildTalabatPreview({ products: all }).rows
      .find((r) => r.internalProductId === "inMaster")!
      .reasons.some((x) => x.code === "DUPLICATE_SKU"),
    "unscoped, the master row is blocked by the outside duplicate",
  );
  const scope = buildMasterScope([{ product_id: "inMaster" }]);
  assert.equal(
    buildTalabatPreview({ products: all.filter((p) => scope.ids.has(p.id)) }).rows[0]
      .reasons.some((x) => x.code === "DUPLICATE_SKU"),
    false,
    "scoped, the block is gone",
  );
});

test("5: an outside-master product's missing image/title cannot pollute the summary", () => {
  const all = [
    product({ id: "good", sku: "mkGood", barcode: "1111111111111" }),
    product({ id: "bad", sku: "mkBad", barcode: "2222222222222",
              imageUrl: null, imageFilename: null, imageCount: 0, nameEn: null, nameAr: null }),
  ];
  const scope = buildMasterScope([{ product_id: "good" }]);
  const res = buildTalabatPreview({ products: all.filter((p) => scope.ids.has(p.id)) });
  assert.equal(res.rows.filter((r) => !r.hasImage).length, 0, "no missing-image row survives scoping");
  assert.equal(res.summary.blocked, 0, "the outside-master blocker is not counted");
});

// ── fail closed ──────────────────────────────────────────────────────────────

test("6: an unreadable membership yields NO products — never the whole catalogue", () => {
  const all = [product({ id: "p1", sku: "mk1" })];
  const dead = { ok: false as const, ids: new Set<string>(), total: 0 };
  assert.deepEqual(scopeRows(all, (p) => p.id, dead), [], "never falls back to the full catalogue");
  assert.ok(/if \(!scope\.ok\) return null;/.test(src()), "the server adapter returns null, not a fallback");
});

// ── the real app path is wired to the shared seam ────────────────────────────

test("7: loadTalabatPreview scopes its product read to the shared master seam", () => {
  const s = src();
  assert.ok(/loadMasterScope\(\)/.test(s), "uses the shared membership loader");
  assert.ok(/const productRows = allProductRows\.filter\(/.test(s),
    "the product universe is the scoped projection");
  assert.ok(/scope\.ids\.has\(p\.id\)/.test(s), "scoped by canonical product id");
  // nothing downstream may read the unscoped array
  assert.equal((s.match(/allProductRows/g) ?? []).length, 2,
    "allProductRows is only destructured and then scoped — never used downstream");
});

test("8: the Talabat exporter does not define its own master rule", () => {
  const s = src();
  assert.equal(new RegExp(CATALOG_STOREFRONT_KEY).test(s), false,
    "must not restate the storefront key — the shared seam owns it");
  assert.equal(/buildMasterScope|mapping_status\s*===/.test(s), false,
    "must not rebuild membership locally");
  assert.equal(CATALOG_MAPPING_STATUS, "active");
});

test("9: no master/catalogue size is hardcoded as runtime logic", () => {
  for (const rel of [SERVER, "./preview.ts"]) {
    const s = strip(readFileSync(new URL(rel, import.meta.url), "utf8"));
    for (const nlit of ["1343", "1530", "1454", "1665", "1357", "211"]) {
      assert.equal(new RegExp(`\\b${nlit}\\b`).test(s), false, `${rel} must not hardcode ${nlit}`);
    }
  }
});

// ── STEP 60 changes the universe and NOTHING else ────────────────────────────

test("10: approval, price, category, image and lifecycle rules are untouched", () => {
  const s = src();
  // the approval overlay still reads platform_status via the certified helper
  assert.ok(/isApprovedForTalabat\(s\(a\.approval\)\)/.test(s), "approval logic unchanged");
  assert.ok(/s\(a\.platform\)\?\.toLowerCase\(\) !== "talabat"/.test(s), "still the talabat overlay only");
  // products.approval is NOT consulted here — that source belongs to the diff path
  assert.equal(/p\.approval/.test(s), false, "does not switch to products.approval");
  // the projection still passes the same fields through untransformed
  for (const frag of ["category: s(p.main_category)", "price: n(p.price)",
                      "discountPrice: n(p.discount_price)", "lifecycleState: p.lifecycle_state"]) {
    assert.ok(s.includes(frag), `${frag} unchanged`);
  }
});

test("11: scoping does not alter how an in-master row is evaluated", () => {
  const only = [product({ id: "p1", sku: "mk1", barcode: "1111111111111" })];
  const scope = buildMasterScope([{ product_id: "p1" }]);
  const unscoped = buildTalabatPreview({ products: only });
  const scoped = buildTalabatPreview({ products: only.filter((p) => scope.ids.has(p.id)) });
  assert.deepEqual(scoped.rows, unscoped.rows, "identical rows when the universe is identical");
  assert.equal(scoped.destination, "talabat:malikas", "destination unchanged");
  assert.equal(scoped.preview.grain, "SELLABLE_LISTING", "grain unchanged");
});

test("12: the scoped reader still writes nothing", () => {
  const s = src();
  for (const re of [/\.update\s*\(/, /\.insert\s*\(/, /\.upsert\s*\(/, /\.delete\s*\(/, /\.rpc\s*\(/]) {
    assert.equal(re.test(s), false, "the exporter must remain read-only");
  }
});
