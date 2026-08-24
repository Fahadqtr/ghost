// INT.2D — Rafeeq package PLAN tests (pure).
// node --conditions=react-server --experimental-strip-types --test lib/export/rafeeq/package.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { buildRafeeqPreview, type RafeeqPreviewProduct, type RafeeqMappingEvidence } from "./preview.ts";
import {
  resolveRafeeqGenerationSet,
  planRowImages,
  toPackageRow,
  buildRafeeqXlsxAoa,
  detectFilenameCollisions,
  checkReferentialIntegrity,
  buildManifest,
  previewGenerationPlan,
  previewRowKey,
  RAFEEQ_PACKAGE_COLUMNS,
  RAFEEQ_NEW_MARKER,
  RAFEEQ_UPDATES_SUPPORTED,
  type PackagedFile,
} from "./package.ts";
import { RAFEEQ_HEADERS, RAFEEQ_CATEGORIES } from "../../exporters.ts";

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

test("Updates mode is UNSUPPORTED for Rafeeq (no invented diffs)", () => {
  assert.equal(RAFEEQ_UPDATES_SUPPORTED, false);
});

test("modes: all / new / selected — blocked never included", () => {
  const a = product({ id: "a", sku: "A", barcode: "6291041500001" });
  const b = product({ id: "b", sku: "B", barcode: "6291041500002" });
  const c = product({ id: "c", sku: null });
  const all = rows({ products: [a, b, c], mappingBySku: { a: { status: "resolved", externalId: "RFQ-A", exportedSku: "A", productId: "a" } } });
  assert.equal(resolveRafeeqGenerationSet(all, { mode: "all" }).included.length, 2);
  assert.deepEqual(resolveRafeeqGenerationSet(all, { mode: "new" }).included.map((r) => r.sku), ["B"]);
  const bKey = previewRowKey(all.find((r) => r.sku === "B")!);
  assert.deepEqual(resolveRafeeqGenerationSet(all, { mode: "selected", selectedKeys: [bKey] }).included.map((r) => r.sku), ["B"]);
});

test("columns reuse the canonical Rafeeq template exactly", () => {
  assert.deepEqual([...RAFEEQ_PACKAGE_COLUMNS], [...RAFEEQ_HEADERS]);
  const r = rows({ products: [product()], mappingBySku: { mk1: resolved("RFQ-1") } })[0];
  assert.deepEqual(buildRafeeqXlsxAoa([toPackageRow(r, "MK1.jpg")])[0], [...RAFEEQ_HEADERS]);
});

test("AoA: category AR from RAFEEQ_CATEGORIES, price numeric, IMAGE NAME = packaged file, RAFEEQ ID from ECL / new marker", () => {
  const mapped = rows({ products: [product({ category: "Makeup" })], mappingBySku: { mk1: resolved("RFQ-55") } })[0];
  const m = buildRafeeqXlsxAoa([toPackageRow(mapped, "MK1.jpg")])[1];
  assert.equal(m[0], "Makeup");                       // CATEGORY EN
  assert.equal(m[1], RAFEEQ_CATEGORIES["Makeup"].ar); // CATEGORY AR
  assert.equal(typeof m[4], "number");                // PRICE numeric
  assert.equal(m[4], 65);
  assert.equal(m[7], "MK1.jpg");                       // IMAGE NAME = packaged file
  assert.equal(m[8], "MK1");                           // BARCODE (text) = parent SKU, never the EAN
  assert.equal(m[9], "RFQ-55");                        // RAFEEQ ID from ECL

  const unmapped = rows({ products: [product()] })[0];
  const u = buildRafeeqXlsxAoa([toPackageRow(unmapped, "MK1.jpg")])[1];
  assert.equal(u[9], RAFEEQ_NEW_MARKER, "new product → literal marker, never a fabricated id");
});

test("image plan is SKU-based (primary + numbered gallery)", () => {
  const r = rows({ products: [product({ sku: "mk9" })] })[0];
  const plan = planRowImages(r);
  assert.equal(plan.primary?.filename, "mk9.jpg");
  assert.deepEqual(plan.gallery.map((g) => g.filename), ["mk9_2.png"]);
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

test("plan counts: mapped/unmapped/needsReview/included/images/blockers", () => {
  const a = product({ id: "a", sku: "A", barcode: "6291041500001" });
  const b = product({ id: "b", sku: "B", barcode: "6291041500002" });
  const c = product({ id: "c", sku: null });
  const all = rows({ products: [a, b, c], mappingBySku: {
    a: { status: "resolved", externalId: "RFQ-A", exportedSku: "A", productId: "a" },
    b: { status: "needs_review", externalId: "RFQ-B?", exportedSku: "B", productId: "b" },
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
