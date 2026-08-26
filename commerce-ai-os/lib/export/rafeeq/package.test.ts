// Rafeeq native package PLAN tests (pure).
// node --conditions=react-server --experimental-strip-types --test lib/export/rafeeq/package.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { buildRafeeqPreview, type RafeeqPreviewProduct, type RafeeqMappingEvidence } from "./preview.ts";
import {
  resolveRafeeqGenerationSet,
  planRowImages,
  toPackageRow,
  buildRafeeqXlsxAoa,
  physicalRowCount,
  detectFilenameCollisions,
  checkReferentialIntegrity,
  buildManifest,
  previewGenerationPlan,
  previewRowKey,
  RAFEEQ_PACKAGE_COLUMNS,
  RAFEEQ_UPDATES_SUPPORTED,
  type PackagedFile,
} from "./package.ts";
import { RAFEEQ_NATIVE_HEADERS, NATIVE_COL } from "./native-template.ts";

function product(over: Partial<RafeeqPreviewProduct> = {}): RafeeqPreviewProduct {
  return {
    id: "p1", sku: "MK1", barcode: "6291041500213", nameEn: "Serum", nameAr: "سيروم",
    category: "Makeup", price: 75, discountPrice: 65, descriptionEn: "Bright.", descriptionAr: "مشرق.",
    imageUrl: "https://cdn.example.com/mk1.jpg", imageFilename: null,
    galleryImageUrls: ["https://cdn.example.com/mk1-2.png"], imageCount: 2,
    lifecycleState: "ACTIVE", platformStatus: "Active", ...over,
  };
}
const resolved = (id: string): RafeeqMappingEvidence => ({ status: "resolved", externalId: id, exportedSku: "MK1", productId: "p1" });
const rows = (input: Parameters<typeof buildRafeeqPreview>[0]) => buildRafeeqPreview(input).rows;

test("Updates mode is UNSUPPORTED for the legacy selector (fullsync OPTION_UPDATE has its own proven path)", () => {
  assert.equal(RAFEEQ_UPDATES_SUPPORTED, false);
});

test("modes: all / new / selected — blocked never included", () => {
  const a = product({ id: "a", sku: "A" });
  const b = product({ id: "b", sku: "B" });
  const c = product({ id: "c", sku: null });
  const all = rows({ products: [a, b, c], mappingBySku: { a: { status: "resolved", externalId: "691300100", exportedSku: "A", productId: "a" } } });
  assert.equal(resolveRafeeqGenerationSet(all, { mode: "all" }).included.length, 2);
  assert.deepEqual(resolveRafeeqGenerationSet(all, { mode: "new" }).included.map((r) => r.sku), ["B"]);
  const bKey = previewRowKey(all.find((r) => r.sku === "B")!);
  assert.deepEqual(resolveRafeeqGenerationSet(all, { mode: "selected", selectedKeys: [bKey] }).included.map((r) => r.sku), ["B"]);
});

test("columns are EXACTLY the audited native template", () => {
  assert.deepEqual([...RAFEEQ_PACKAGE_COLUMNS], [...RAFEEQ_NATIVE_HEADERS]);
  const r = rows({ products: [product()], mappingBySku: { mk1: resolved("691300055") } })[0];
  assert.deepEqual(buildRafeeqXlsxAoa([toPackageRow(r, "MK1.jpg")])[0], [...RAFEEQ_NATIVE_HEADERS]);
});

test("AoA cells: audited category registry, TEXT product_price, parent-SKU barcode, resolved id or blank", () => {
  const mapped = rows({ products: [product({ category: "Makeup" })], mappingBySku: { mk1: resolved("691300055") } })[0];
  const m = buildRafeeqXlsxAoa([toPackageRow(mapped, "MK1.jpg")])[1];
  assert.equal(m[NATIVE_COL.categoryId], 3708643);
  assert.equal(m[NATIVE_COL.categoryNameEn], "Makeup");
  assert.equal(m[NATIVE_COL.categoryNameAr], "المكياج");
  assert.equal(m[NATIVE_COL.subcategoryNameEn], "ALL");
  assert.equal(m[NATIVE_COL.productPrice], "65", "product_price as TEXT (audited), discount wins");
  assert.equal(m[NATIVE_COL.barcode], "MK1", "barcode = parent SKU, never the EAN");
  assert.equal(m[NATIVE_COL.productImage], "MK1.jpg");
  assert.equal(m[NATIVE_COL.productId], "691300055", "resolved ECL id fills product_id");

  const unmapped = rows({ products: [product()] })[0];
  const u = buildRafeeqXlsxAoa([toPackageRow(unmapped, "MK1.jpg")])[1];
  assert.equal(u[NATIVE_COL.productId], "", "new record → BLANK product_id (never a fabricated id)");
});

test("image plan is PARENT-SKU based and PRIMARY ONLY — gallery is never planned (owner contract)", () => {
  const r = rows({ products: [product({ sku: "mk9" })] })[0];
  const plan = planRowImages(r);
  assert.equal(plan.primary?.filename, "mk9.jpg");
  assert.equal(plan.primary?.sourceUrl, r.primaryImageUrl, "the canonical primary URL is used VERBATIM — no thumbnail/resize variant");
  assert.deepEqual(plan.gallery, [], "gallery images are never exported to Rafeeq — even when canonical gallery URLs exist");
});

test("detectFilenameCollisions flags duplicate output filenames", () => {
  assert.deepEqual(detectFilenameCollisions(["a.jpg", "b.jpg"]), []);
  assert.deepEqual(detectFilenameCollisions(["a.jpg", "A.JPG", "b.jpg"]), ["a.jpg"]);
});

test("referential integrity: rows ↔ packaged files", () => {
  const ok = checkReferentialIntegrity(["mk1.jpg"], [{ name: "mk1.jpg", kind: "primary" }, { name: "mk1_2.png", kind: "gallery", ownerPrimary: "mk1.jpg" }] as PackagedFile[]);
  assert.equal(ok.ok, true);
  assert.deepEqual(checkReferentialIntegrity(["mk2.jpg"], []).missingForRows, ["mk2.jpg"]);
});

test("physicalRowCount: simple products count 1; option products count one per option", () => {
  const simple = rows({ products: [product({ id: "s", sku: "mk-s" })] })[0];
  const optioned = rows({ products: [product({ id: "o", sku: "mk-o", variants: [
    { id: "v1", sku: "mk-o-1", barcode: null, nameEn: "A", nameAr: "أ", price: null },
    { id: "v2", sku: "mk-o-2", barcode: null, nameEn: "B", nameAr: "ب", price: null },
  ] })] })[0];
  const pkgRows = [toPackageRow(simple, "mk-s.jpg"), toPackageRow(optioned, "mk-o.jpg")];
  assert.equal(physicalRowCount(pkgRows), 3);
  assert.equal(buildRafeeqXlsxAoa(pkgRows).length, 4, "header + 3 physical rows");
});

test("plan counts: mapped/unmapped/needsReview/included/images/blockers", () => {
  const a = product({ id: "a", sku: "A" });
  const b = product({ id: "b", sku: "B" });
  const c = product({ id: "c", sku: null });
  const all = rows({ products: [a, b, c], mappingBySku: {
    a: { status: "resolved", externalId: "691300100", exportedSku: "A", productId: "a" },
    b: { status: "needs_review", externalId: "691300101", exportedSku: "B", productId: "b" },
  } });
  const plan = previewGenerationPlan(all, { mode: "all" });
  assert.equal(plan.products, 3);
  assert.equal(plan.mapped, 1);      // only A is resolved
  assert.equal(plan.needsReview, 1); // B is needs_review (blocked)
  assert.equal(plan.blocked, 2);     // B (needs_review) + C (missing sku)
  assert.equal(plan.rowsIncluded, 1); // only A
  assert.equal(plan.blockersByReason.IDENTITY_NEEDS_REVIEW, 1);
  assert.equal(plan.blockersByReason.MISSING_SKU, 1);
});

test("manifest carries destination + counts + no secrets", () => {
  const m = buildManifest({
    storefrontKey: "rafeeq:malikas", mode: "new", generatedAt: "2026-08-17T09:00:00.000Z", actor: "owner@example.com",
    productRowCount: 5, mappedCount: 0, unmappedCount: 5, needsReviewExcluded: 2, imageCount: 8, warningCount: 1,
    excludedBlockedCount: 3, outputFilename: "rafeeq-malikas-export-2026.zip", previewReference: { product_count: 8 },
  });
  assert.equal(m.destination, "rafeeq:malikas");
  assert.equal(m.needs_review_excluded, 2);
  const json = JSON.stringify(m).toLowerCase();
  for (const secret of ["service_role", "supabase_", "authorization", "bearer ", "password", "secret"]) assert.equal(json.includes(secret), false);
});
