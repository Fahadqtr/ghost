// INT.2C — Snoonu package PLAN tests (pure).
// node --conditions=react-server --experimental-strip-types --test lib/export/snoonu/package.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { buildSnoonuPreview, type SnoonuPreviewProduct, type SnoonuMappingEvidence } from "./preview.ts";
import {
  resolveSnoonuGenerationSet,
  planRowImages,
  toPackageRow,
  buildSnoonuXlsxAoa,
  checkReferentialIntegrity,
  buildManifest,
  previewGenerationPlan,
  previewRowKey,
  SNOONU_PACKAGE_COLUMNS,
  type PackagedFile,
} from "./package.ts";
import { SNOONU_HEADERS } from "../../exporters.ts";

function product(over: Partial<SnoonuPreviewProduct> = {}): SnoonuPreviewProduct {
  return {
    id: "p1", sku: "MK1", barcode: "6291041500213", nameEn: "Serum", nameAr: "سيروم",
    category: "Skincare", subCategory: "Face", price: 75, discountPrice: 65,
    descriptionEn: "Bright.", descriptionAr: "مشرق.", keywordsEn: "serum", keywordsAr: "سيروم",
    imageUrl: "https://cdn.example.com/mk1.jpg", imageFilename: null,
    galleryImageUrls: ["https://cdn.example.com/mk1-2.png"], imageCount: 2,
    lifecycleState: "ACTIVE", platformStatus: "Active", ...over,
  };
}
const resolved = (spi: string): SnoonuMappingEvidence => ({ status: "resolved", externalId: spi, exportedSku: "MK1", productId: "p1" });
const rows = (input: Parameters<typeof buildSnoonuPreview>[0]) => buildSnoonuPreview(input).rows;

// ── modes: all / new / updates / selected — never blocked ─────────────────────
test("mode 'new' = unmapped; 'updates' = mapped; 'all' = both; blocked never included", () => {
  const a = product({ id: "a", sku: "A", barcode: "6291041500001" }); // will be mapped
  const b = product({ id: "b", sku: "B", barcode: "6291041500002" }); // unmapped (new)
  const c = product({ id: "c", sku: null }); // blocked (missing sku)
  const all = rows({ storefrontKey: "snoonu:malikas", products: [a, b, c], mappingBySku: { a: { status: "resolved", externalId: "SPI-A", exportedSku: "A", productId: "a" } } });

  const allSet = resolveSnoonuGenerationSet(all, { mode: "all" });
  assert.equal(allSet.included.length, 2, "a + b (c is blocked)");
  assert.equal(allSet.excludedBlocked.length, 1);

  const newSet = resolveSnoonuGenerationSet(all, { mode: "new" });
  assert.deepEqual(newSet.included.map((r) => r.sku), ["B"], "only the unmapped product");

  const updSet = resolveSnoonuGenerationSet(all, { mode: "updates" });
  assert.deepEqual(updSet.included.map((r) => r.sku), ["A"], "only the mapped product");
});

test("selected mode never leaks a blocked row even if its key is selected", () => {
  const good = product({ id: "g", sku: "G", barcode: "6291041500010" });
  const bad = product({ id: "x", sku: null });
  const all = rows({ storefrontKey: "snoonu:malikas", products: [good, bad] });
  const badKey = previewRowKey(all.find((r) => r.status === "BLOCKED")!);
  const goodKey = previewRowKey(all.find((r) => r.status !== "BLOCKED")!);
  const set = resolveSnoonuGenerationSet(all, { mode: "selected", selectedKeys: [badKey, goodKey] });
  assert.equal(set.included.length, 1);
  assert.equal(previewRowKey(set.included[0]), goodKey);
});

// ── XLSX columns REUSE the canonical Snoonu template exactly ──────────────────
test("package columns are exactly the canonical Snoonu template", () => {
  assert.deepEqual([...SNOONU_PACKAGE_COLUMNS], [...SNOONU_HEADERS]);
  const r = rows({ storefrontKey: "snoonu:malikas", products: [product()], mappingBySku: { mk1: resolved("SPI-1") } })[0];
  const aoa = buildSnoonuXlsxAoa([toPackageRow(r, "MK1.jpg")]);
  assert.deepEqual(aoa[0], [...SNOONU_HEADERS]);
});

test("AoA maps SPI/SKU/barcode to text, price numeric; new product → blank Snoonu ID", () => {
  const mapped = rows({ storefrontKey: "snoonu:malikas", products: [product()], mappingBySku: { mk1: resolved("SPI-777") } })[0];
  const m = buildSnoonuXlsxAoa([toPackageRow(mapped, "MK1.jpg")])[1];
  assert.equal(m[0], "SPI-777");        // Snoonu ID = ECL SPI
  assert.equal(m[1], "MK1");            // SKU
  assert.equal(m[2], "6291041500213");  // Barcode (string, not scientific)
  assert.equal(typeof m[7], "number");  // Price numeric
  assert.equal(m[7], 65);               // discount-aware effective price
  assert.equal(m[11], "https://cdn.example.com/mk1.jpg"); // Image URL preserved

  const unmapped = rows({ storefrontKey: "snoonu:malikas", products: [product()] })[0];
  const u = buildSnoonuXlsxAoa([toPackageRow(unmapped, "MK1.jpg")])[1];
  assert.equal(u[0], "", "new product → blank Snoonu ID (SPI never invented)");
});

// ── image plan: SKU-based primary + gallery ───────────────────────────────────
test("image plan is SKU-based (primary + numbered gallery)", () => {
  const r = rows({ storefrontKey: "snoonu:malikas", products: [product({ sku: "mk9" })] })[0];
  const plan = planRowImages(r);
  assert.equal(plan.primary?.filename, "mk9.jpg");
  assert.deepEqual(plan.gallery.map((g) => g.filename), ["mk9_2.png"]);
});

test("a path-traversal SKU is sanitized in the packaged filename", () => {
  const r = rows({ storefrontKey: "snoonu:malikas", products: [product({ sku: "../../etc/passwd" })] })[0];
  const name = planRowImages(r).primary?.filename ?? "";
  assert.equal(/[\\/]|\.\./.test(name), false);
  assert.ok(name.endsWith(".jpg"));
});

// ── referential integrity ─────────────────────────────────────────────────────
test("integrity passes when rows ↔ packaged files agree; fails on mismatch", () => {
  const ok = checkReferentialIntegrity(["mk1.jpg"], [{ name: "mk1.jpg", kind: "primary" }, { name: "mk1_2.png", kind: "gallery", ownerPrimary: "mk1.jpg" }] as PackagedFile[]);
  assert.equal(ok.ok, true);
  const missing = checkReferentialIntegrity(["mk2.jpg"], []);
  assert.deepEqual(missing.missingForRows, ["mk2.jpg"]);
});

// ── pre-generation plan counts ────────────────────────────────────────────────
test("plan reports mapped/unmapped/included/images/blockers for the mode", () => {
  const a = product({ id: "a", sku: "A", barcode: "6291041500001" });
  const b = product({ id: "b", sku: "B", barcode: "6291041500002" });
  const c = product({ id: "c", sku: null });
  const all = rows({ storefrontKey: "snoonu:malikas", products: [a, b, c], mappingBySku: { a: { status: "resolved", externalId: "SPI-A", exportedSku: "A", productId: "a" } } });
  const plan = previewGenerationPlan(all, { mode: "all" });
  assert.equal(plan.products, 3);
  assert.equal(plan.blocked, 1);
  assert.equal(plan.mapped, 1);
  assert.equal(plan.unmapped, 2);
  assert.equal(plan.rowsIncluded, 2);
  assert.equal(plan.blockersByReason.MISSING_SKU, 1);
});

// ── manifest ──────────────────────────────────────────────────────────────────
test("manifest carries storefront + counts + no secrets", () => {
  const m = buildManifest({
    storefrontKey: "snoonu:pure_seoul", mode: "new", generatedAt: "2026-08-17T09:00:00.000Z", actor: "owner@example.com",
    productRowCount: 5, mappedCount: 0, unmappedCount: 5, imageCount: 8, warningCount: 1, excludedBlockedCount: 2,
    outputFilename: "snoonu-pure-seoul-export-2026.zip", previewReference: { product_count: 7 },
  });
  assert.equal(m.destination, "snoonu:pure_seoul");
  assert.equal(m.mode, "new");
  assert.equal(m.unmapped_count, 5);
  const json = JSON.stringify(m).toLowerCase();
  for (const secret of ["service_role", "supabase_", "authorization", "bearer ", "password", "secret"]) {
    assert.equal(json.includes(secret), false);
  }
});
