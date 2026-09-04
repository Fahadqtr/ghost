// STEP 72 — ONE Talabat selling-price policy, shared by the workbook and the
// mapping snapshot.
//
//   simple  : channelPrice ?? productPrice
//   variant : variantPrice(>0) ?? channelPrice ?? productPrice
//
// products.discount_price is EXCLUDED from precedence (and is not even an
// argument to the resolver). The canonical column is never modified.
//
// node --conditions=react-server --experimental-strip-types --test lib/export/talabat/step72-price-policy.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveTalabatSellingPrice, talabatSellingPrice, positivePrice } from "./price-policy.ts";
import { buildTalabatPreview, type TalabatPreviewProduct } from "./preview.ts";
import { toPackageRow } from "./package.ts";
import { buildTalabatExport } from "../../talabat/export.ts";

const HERE = join(fileURLToPath(new URL(".", import.meta.url)));
const APP_ROOT = join(HERE, "../../..");
const code = (rel: string): string =>
  readFileSync(join(APP_ROOT, rel), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

function product(over: Partial<TalabatPreviewProduct> & { id: string; sku: string }): TalabatPreviewProduct {
  return {
    barcode: "1234567890123", nameEn: `EN ${over.sku}`, nameAr: `ع ${over.sku}`,
    price: 100, discountPrice: null, channelPrice: null, category: "Face Care",
    descriptionEn: "d", descriptionAr: "و", imageUrl: "https://x.test/a.jpg",
    imageFilename: `${over.sku}.jpg`, galleryImageUrls: [], imageCount: 1,
    approved: true, lifecycleState: "ACTIVE", variants: [], ...over,
  };
}
const priceOf = (p: TalabatPreviewProduct, sku?: string): number | null => {
  const rows = buildTalabatPreview({ products: [p] }).rows;
  return (sku ? rows.find((r) => r.sku === sku)! : rows[0]).price;
};
/** the exporter that feeds the MAPPING SNAPSHOT */
const exp = (o: Record<string, unknown>, vs: Record<string, unknown>[] = []) =>
  buildTalabatExport(
    [{ id: "p", sku: "mk1", barcode: "1234567890123", name_en: "E", name_ar: "ع",
       main_category: "Face Care", description_en: "d", description_ar: "و",
       image_filename: "mk1.jpg", image_url: "https://x.test/a.jpg", ...o }] as never,
    vs as never,
  );

// ── 1 & 2: simple products ───────────────────────────────────────────────────

test("1: a simple product uses channel_price when present", () => {
  assert.equal(priceOf(product({ id: "p", sku: "mk1", price: 100, channelPrice: 120 })), 120);
  assert.equal(resolveTalabatSellingPrice({ productPrice: 100, channelPrice: 120 }).source, "channel");
});

test("2: a simple product falls back to products.price when no channel price", () => {
  assert.equal(priceOf(product({ id: "p", sku: "mk1", price: 100, channelPrice: null })), 100);
  assert.equal(resolveTalabatSellingPrice({ productPrice: 100, channelPrice: null }).source, "product");
});

// ── 3: discount_price can never lower a Talabat price ────────────────────────

test("3: discount_price NEVER lowers the Talabat selling price", () => {
  // the real shapes STEP 70 flagged: mk1547 241/72.25, mk965 128/12.75
  assert.equal(priceOf(product({ id: "p", sku: "mk1547", price: 241, discountPrice: 72.25 })), 241);
  assert.equal(priceOf(product({ id: "p", sku: "mk965", price: 128, discountPrice: 12.75, channelPrice: 128 })), 128);
  // and it is not even accepted as an argument
  assert.equal("discountPrice" in ({} as Parameters<typeof resolveTalabatSellingPrice>[0]), false);
  const src = code("lib/export/talabat/price-policy.ts");
  assert.equal(/discount/i.test(src), false, "the resolver's CODE never mentions discount");
});

// ── 4-7: variant precedence ──────────────────────────────────────────────────

test("4: a variant price outranks the product-grain channel price", () => {
  const p = product({
    id: "p", sku: "mk1", price: 100, channelPrice: 95,
    variants: [{ id: "v", sku: "mk1-1-gold", barcode: "1234567890124", nameEn: "Gold", nameAr: "ذهبي", price: 178 }],
  });
  assert.equal(priceOf(p, "mk1-1-gold"), 178);
});

test("5: a null variant price falls back to the channel price", () => {
  const p = product({
    id: "p", sku: "mk1", price: 100, channelPrice: 95,
    variants: [{ id: "v", sku: "mk1-1-a", barcode: "1234567890124", nameEn: "A", nameAr: "أ", price: null }],
  });
  assert.equal(priceOf(p, "mk1-1-a"), 95);
});

test("6: a zero or negative variant price falls back to the channel price", () => {
  for (const bad of [0, -5]) {
    const p = product({
      id: "p", sku: "mk1", price: 100, channelPrice: 95,
      variants: [{ id: "v", sku: "mk1-1-a", barcode: "1234567890124", nameEn: "A", nameAr: "أ", price: bad }],
    });
    assert.equal(priceOf(p, "mk1-1-a"), 95, `variant price ${bad} is treated as absent`);
  }
  assert.equal(positivePrice(0), null);
  assert.equal(positivePrice(-1), null);
});

test("7: with no channel price the variant falls back to products.price", () => {
  const p = product({
    id: "p", sku: "mk1", price: 100, channelPrice: null,
    variants: [{ id: "v", sku: "mk1-1-a", barcode: "1234567890124", nameEn: "A", nameAr: "أ", price: null }],
  });
  assert.equal(priceOf(p, "mk1-1-a"), 100);
});

// ── 8: mk1121 — channel_price 0 must not erase real option prices ────────────

test("8: mk1121-style options survive a channel_price of 0", () => {
  const p = product({
    id: "p", sku: "mk1121", price: 69, channelPrice: 0, // Snoonu records 0 for this product
    variants: [
      { id: "v1", sku: "mk1121-1-rose-finch", barcode: "5508424872688-1", nameEn: "Rose Finch", nameAr: "روز", price: 68 },
      { id: "v2", sku: "mk1121-2-peony-ballet", barcode: "5508424872688-2", nameEn: "Peony Ballet", nameAr: "بيوني", price: 69 },
    ],
  });
  assert.equal(priceOf(p, "mk1121-1-rose-finch"), 68);
  assert.equal(priceOf(p, "mk1121-2-peony-ballet"), 69);
  // a zero channel price is never emitted, and never blocks
  assert.equal(buildTalabatPreview({ products: [p] }).rows.every((r) => (r.price ?? 0) > 0), true);
});

// ── 9: the workbook and the mapping snapshot agree, always ───────────────────

test("9: workbook and mapping-snapshot prices are identical", () => {
  const cases = [
    { price: 100, channel: 120, variant: null },
    { price: 100, channel: null, variant: null },
    { price: 241, channel: 241, variant: null },   // mk1547 shape
    { price: 100, channel: 95, variant: 178 },     // option-specific
    { price: 69, channel: 0, variant: 68 },        // mk1121 shape
    { price: 239, channel: null, variant: 0 },     // unpriced option
  ];
  for (const c of cases) {
    const p = product({
      id: "p", sku: "mk1", price: c.price, discountPrice: 9.99, channelPrice: c.channel,
      variants: c.variant === null ? [] :
        [{ id: "v", sku: "mk1-1-a", barcode: "1234567890124", nameEn: "A", nameAr: "أ", price: c.variant }],
    });
    const previewRow = buildTalabatPreview({ products: [p] }).rows.at(-1)!;
    const workbook = toPackageRow(previewRow, "mk1.jpg").priceQar;

    const snapshot = exp(
      { price: c.price, discount_price: 9.99, channel_price: c.channel },
      c.variant === null ? [] :
        [{ parent_product_id: "p", sku: "mk1-1-a", barcode: "1234567890124", variant_name: "A", variant_name_en: "A", price: c.variant }],
    ).rows.at(-1)!.priceQar;

    assert.equal(String(workbook), snapshot, `workbook ${workbook} vs snapshot ${snapshot} for ${JSON.stringify(c)}`);
  }
});

// ── 10: every discount shape ignores discount_price, in BOTH paths ───────────

test("10: all 24 STEP 70 discount products ignore discount_price in both paths", () => {
  // the real (price, discount) pairs from the STEP 70 census
  const real: [number, number][] = [
    [250, 87.5], [84.25, 25.25], [110, 33], [560, 168], [560, 168], [560, 168],
    [676, 202.75], [412, 123.5], [331.5, 132.5], [306, 126.5], [379, 151.5],
    [400, 120], [360, 144], [589, 235.5], [146, 47], [341.75, 102.5], [241, 72.25],
    [219, 87.5], [309, 92.75], [400, 160], [320, 160], [128, 12.75], [128, 12.75], [128, 12.75],
  ];
  assert.equal(real.length, 24);
  for (const [base, disc] of real) {
    assert.equal(priceOf(product({ id: "p", sku: "mk1", price: base, discountPrice: disc })), base);
    assert.equal(exp({ price: base, discount_price: disc }).rows[0].priceQar, String(base));
    assert.notEqual(priceOf(product({ id: "p", sku: "mk1", price: base, discountPrice: disc })), disc);
  }
});

// ── 11: no price becomes zero, negative or non-numeric ───────────────────────

test("11: a resolved price is always a positive finite number or null", () => {
  for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, null, undefined, "abc"]) {
    assert.equal(positivePrice(bad), null, `${String(bad)} is not a usable price`);
  }
  assert.equal(talabatSellingPrice({ productPrice: 0, channelPrice: 0, variantPrice: 0 }), null);
  assert.equal(resolveTalabatSellingPrice({ productPrice: null, channelPrice: null }).source, "none");
  // a row with no usable price warns (never silently ships 0)
  const res = buildTalabatPreview({ products: [product({ id: "p", sku: "mk1", price: 0, channelPrice: 0 })] });
  assert.equal(res.rows[0].price, null);
  assert.ok(res.rows[0].reasons.some((x) => x.code === "MISSING_PRICE"));
  // numeric strings resolve
  assert.equal(positivePrice("12.5"), 12.5);
});

// ── 12: category / barcode / master-scope behaviour unchanged ────────────────

test("12: category, barcode and master-scope behaviour are unchanged", () => {
  const p = product({ id: "p", sku: "mk1", category: "Toys", barcode: "8719783947424-1", channelPrice: 120 });
  const r = buildTalabatPreview({ products: [p] }).rows[0];
  assert.equal(r.talabatCategory, "✨Toys", "STEP 64 registry intact");
  assert.equal(r.talabatBarcode, "87197839474241", "STEP 68 alias intact");
  assert.equal(r.approved, true);
  assert.equal(r.reasons.some((x) => x.code === "LIFECYCLE_NOT_ELIGIBLE"), false);
  // STEP 60 master scoping + STEP 62 no-approval-gate still live in the adapter
  const server = code("lib/export/talabat/preview.server.ts");
  assert.match(server, /loadMasterScope\(\)/);
  assert.match(server, /if \(!scope\.ok\) return null/);
  // an unapproved product is still exportable (STEP 62)
  const un = buildTalabatPreview({ products: [product({ id: "p", sku: "mk2", approved: false, channelPrice: 50 })] });
  assert.equal(un.rows[0].status !== "BLOCKED", true);
});

// ── the single-policy invariant ─────────────────────────────────────────────

test("13: exactly one price policy exists — no path re-derives its own", () => {
  for (const f of ["lib/export/talabat/preview.ts", "lib/talabat/export.ts"]) {
    const c = code(f);
    assert.match(c, /resolveTalabatSellingPrice\(/, `${f} uses the shared resolver`);
    assert.equal(/positive\(p\.discountPrice\)|positive\(p\.discount_price\)/.test(c), false,
      `${f} must not put discount into price precedence`);
  }
  // the certified adapter actually supplies a channel price
  const server = code("lib/export/talabat/preview.server.ts");
  assert.match(server, /channelPrice: channelPrices\.get\(id\) \?\? null/);
  assert.match(server, /resolveExactChannelId\(/, "the EXACT talabat channel, never a %talabat% sibling");
  // the workbook Discount column stays blank (no invented contract)
  assert.match(code("lib/export/talabat/package.ts"), /discount: "",/);
});
