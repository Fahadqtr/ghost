// STEP RAFEEQ 01 — Rafeeq's 156-product missing-images request.
//
// PRODUCTION, 2026-09-10. Rafeeq sent "Malikas Univers Trading _27206 - missing
// images.xlsx": sheet "data", 156 rows, product_id / product_name_english /
// barcode, with OUR SKUs in the barcode column. Verified against the live
// catalogue:
//
//   156/156 SKUs matched exactly one product   0 ambiguous   0 not found
//   156/156 held a usable primary image        227 usable images in total
//   0/156 Rafeeq product_ids appear in our channel mapping — ours are an older
//         691300xxx generation, theirs are 698933xxx–698934xxx
//   37/156 stored URLs end ".jpg" over PNG bytes
//
// That last line is why the extension may never come from the URL, and the line
// before it is why the delivered filename carries BOTH keys.
//
// node --conditions=react-server --experimental-strip-types --test lib/export/rafeeq/missing-images.test.ts

import test from "node:test";
import assert from "node:assert/strict";

import {
  auditMissingImagesRequest,
  decideMissingImages,
  missingImageFilename,
  planMissingImagePackage,
  buildMissingImagesManifest,
  buildMissingImagesReview,
  verifyMissingImagesPackage,
  MISSING_IMAGES_MANIFEST_HEADERS,
  MISSING_IMAGES_REVIEW_HEADERS,
  type RafeeqMissingImagesRow,
  type RafeeqMissingImagesCandidate,
} from "./missing-images.ts";

const ROW = (over: Partial<RafeeqMissingImagesRow> = {}): RafeeqMissingImagesRow => ({
  rafeeqProductId: 698933247,
  productNameEnglish: "Transparent Shoulder & Collarbone Lifting Body Tape",
  barcode: "mk860",
  ...over,
});

const CAND = (over: Partial<RafeeqMissingImagesCandidate> = {}): RafeeqMissingImagesCandidate => ({
  productId: "7e1d9f9a-cec2-409e-9a63-3dcc444845ef",
  sku: "mk860",
  nameEn: "Body Lifting Tape",
  imageUrls: ["https://example.test/product-images/mk860.jpg"],
  ...over,
});

const JPG = () => "jpg";

// ── identity ────────────────────────────────────────────────────────────────

test("1. an exact SKU match is MATCHED and ready", () => {
  const [d] = decideMissingImages([ROW()], [CAND()]);
  assert.equal(d.matchStatus, "MATCHED");
  assert.equal(d.ourProductId, "7e1d9f9a-cec2-409e-9a63-3dcc444845ef");
  assert.equal(d.ourProductTitle, "Body Lifting Tape");
  assert.equal(d.action, "READY_FOR_IMAGE_DELIVERY");
  assert.equal(d.reason, null);
});

test("2. SKU matching ignores case and surrounding spaces, nothing else", () => {
  const [d] = decideMissingImages([ROW({ barcode: "  MK860 " })], [CAND()]);
  assert.equal(d.matchStatus, "MATCHED");
  // the row keeps the SKU AS RAFEEQ WROTE IT, trimmed — never rewritten to ours
  assert.equal(d.rafeeqSku, "MK860");
});

test("3. two of our products on one SKU is AMBIGUOUS — never auto-packaged", () => {
  const [d] = decideMissingImages([ROW()], [
    CAND({ productId: "aaa" }), CAND({ productId: "bbb", nameEn: "Other" }),
  ]);
  assert.equal(d.matchStatus, "AMBIGUOUS");
  assert.equal(d.action, "MANUAL_REVIEW");
  assert.equal(d.ourProductId, null, "an ambiguous row names NO product id");
  assert.match(d.reason ?? "", /2 of our products/);
});

test("4. no canonical product for the SKU is NOT_FOUND", () => {
  const [d] = decideMissingImages([ROW({ barcode: "mk9999" })], [CAND()]);
  assert.equal(d.matchStatus, "NOT_FOUND");
  assert.equal(d.action, "MANUAL_REVIEW");
  assert.equal(d.primaryImageAvailable, false);
});

test("5. a matching NAME never matches — identity is the SKU alone", () => {
  const [d] = decideMissingImages(
    [ROW({ barcode: "mk9999" })],
    [CAND({ sku: "mk111", nameEn: "Transparent Shoulder & Collarbone Lifting Body Tape" })]);
  assert.equal(d.matchStatus, "NOT_FOUND",
    "the titles are identical and it still does not match");
});

// ── image availability ──────────────────────────────────────────────────────

test("6. a primary image alone counts as one usable image, zero gallery", () => {
  const [d] = decideMissingImages([ROW()], [CAND()]);
  assert.equal(d.primaryImageAvailable, true);
  assert.equal(d.galleryImageCount, 0);
  assert.equal(d.totalUsableImages, 1);
});

test("7. gallery images are counted but the first stays the primary", () => {
  const [d] = decideMissingImages([ROW()], [CAND({
    imageUrls: ["https://e.test/a.jpg", "https://e.test/b.jpg", "https://e.test/c.png"],
  })]);
  assert.equal(d.galleryImageCount, 2);
  assert.equal(d.totalUsableImages, 3);
  assert.equal(d.action, "READY_FOR_IMAGE_DELIVERY");
});

test("8. a matched product with no image is NOT ready, and says why", () => {
  const [d] = decideMissingImages([ROW()], [CAND({ imageUrls: [] })]);
  assert.equal(d.matchStatus, "MATCHED");
  assert.equal(d.action, "NO_IMAGE_IN_OUR_CATALOG");
  assert.equal(d.primaryImageAvailable, false);
  assert.match(d.reason ?? "", /no usable image/);
  // blank strings are not images either
  const [e] = decideMissingImages([ROW()], [CAND({ imageUrls: ["", "   "] })]);
  assert.equal(e.action, "NO_IMAGE_IN_OUR_CATALOG");
});

// ── naming ──────────────────────────────────────────────────────────────────

test("9. the filename carries BOTH keys, and the extension comes from the bytes", () => {
  assert.equal(missingImageFilename(698933247, "mk860", "jpg"), "698933247__mk860.jpg");
  // the 37-file case: a ".jpg" URL over PNG bytes ships as .png
  assert.equal(missingImageFilename(698933247, "mk860", "png"), "698933247__mk860.png");
  assert.equal(missingImageFilename(698933247, "mk860", ".PNG"), "698933247__mk860.png");
  assert.equal(missingImageFilename(698933247, "mk860", ""), "698933247__mk860.jpg");
});

test("10. a SKU with filesystem-hostile characters is sanitized, not renamed", () => {
  assert.equal(missingImageFilename(1, "mk 86/0", "jpg"), "1__mk-86-0.jpg");
});

// ── package plan ────────────────────────────────────────────────────────────

const THREE = [
  ROW({ rafeeqProductId: 1, barcode: "mk1" }),
  ROW({ rafeeqProductId: 2, barcode: "mk2" }),
  ROW({ rafeeqProductId: 3, barcode: "mkX" }), // not in our catalogue
];
const THREE_CANDS = [
  CAND({ productId: "p1", sku: "mk1", imageUrls: ["https://e.test/1.jpg"] }),
  CAND({ productId: "p2", sku: "mk2", imageUrls: ["https://e.test/2.jpg", "https://e.test/2b.jpg"] }),
  CAND({ productId: "p9", sku: "mk9", imageUrls: ["https://e.test/9.jpg"] }), // NOT requested
];

test("11. the package holds one file per ready product — primary only", () => {
  const decisions = decideMissingImages(THREE, THREE_CANDS);
  const { entries } = planMissingImagePackage(decisions, (d) =>
    THREE_CANDS.find((c) => c.productId === d.ourProductId)?.imageUrls[0] ?? null, JPG);
  assert.deepEqual(entries.map((e) => e.filename), ["1__mk1.jpg", "2__mk2.jpg"]);
  assert.equal(entries.length, 2, "mk2's second image does NOT add a second file");
});

test("12. an unrequested product is never packaged, however available it is", () => {
  const decisions = decideMissingImages(THREE, THREE_CANDS);
  const { entries } = planMissingImagePackage(decisions, (d) =>
    THREE_CANDS.find((c) => c.productId === d.ourProductId)?.imageUrls[0] ?? null, JPG);
  assert.equal(entries.some((e) => e.sku === "mk9"), false);
});

test("13. an ambiguous or unmatched row is never packaged", () => {
  const rows = [ROW({ rafeeqProductId: 7, barcode: "dup" }), ROW({ rafeeqProductId: 8, barcode: "gone" })];
  const cands = [CAND({ productId: "x", sku: "dup" }), CAND({ productId: "y", sku: "dup" })];
  const decisions = decideMissingImages(rows, cands);
  assert.deepEqual(decisions.map((d) => d.matchStatus), ["AMBIGUOUS", "NOT_FOUND"]);
  const { entries } = planMissingImagePackage(decisions, () => "https://e.test/a.jpg", JPG);
  assert.deepEqual(entries, [], "neither may reach the archive");
});

test("14. an image whose bytes cannot be identified is dropped, never guessed", () => {
  const decisions = decideMissingImages([ROW()], [CAND()]);
  const { entries, droppedUnreadable } = planMissingImagePackage(decisions, (d) =>
    d.ourProductId ? "https://e.test/x" : null, () => null);
  assert.deepEqual(entries, []);
  assert.equal(droppedUnreadable, 1);
});

// ── manifest and review ─────────────────────────────────────────────────────

test("15. every manifest filename exists in the archive, and vice versa", () => {
  const decisions = decideMissingImages(THREE, THREE_CANDS);
  const { entries } = planMissingImagePackage(decisions, (d) =>
    THREE_CANDS.find((c) => c.productId === d.ourProductId)?.imageUrls[0] ?? null, JPG);
  const manifest = buildMissingImagesManifest(entries);
  assert.equal(manifest.length, 2);
  assert.equal(MISSING_IMAGES_MANIFEST_HEADERS.length, manifest[0].length);
  const named = manifest.map((r) => String(r[3]));
  assert.deepEqual(verifyMissingImagesPackage(THREE, decisions, entries, named), []);
});

test("16. the manifest never names an additional file the archive lacks", () => {
  const decisions = decideMissingImages(THREE, THREE_CANDS);
  const { entries } = planMissingImagePackage(decisions, (d) =>
    THREE_CANDS.find((c) => c.productId === d.ourProductId)?.imageUrls[0] ?? null, JPG);
  for (const row of buildMissingImagesManifest(entries)) {
    assert.equal(row[4], "", "ADDITIONAL_IMAGE_FILENAMES is blank under primary-only");
    assert.equal(row[5], 1);
  }
});

test("17. the review reports one row per REQUESTED item, servable or not", () => {
  const decisions = decideMissingImages(THREE, THREE_CANDS);
  const review = buildMissingImagesReview(decisions);
  assert.equal(review.length, THREE.length, "the row we cannot serve is still reported");
  assert.equal(review[0].length, MISSING_IMAGES_REVIEW_HEADERS.length);
  assert.deepEqual(review.map((r) => r[9]),
    ["READY_FOR_IMAGE_DELIVERY", "READY_FOR_IMAGE_DELIVERY", "MANUAL_REVIEW"]);
});

// ── the audit ───────────────────────────────────────────────────────────────

test("18. a file for a product Rafeeq never asked about is caught", () => {
  const decisions = decideMissingImages(THREE, THREE_CANDS);
  const { entries } = planMissingImagePackage(decisions, (d) =>
    THREE_CANDS.find((c) => c.productId === d.ourProductId)?.imageUrls[0] ?? null, JPG);
  const smuggled = [...entries, {
    rafeeqProductId: 99, sku: "mk9", productName: "Not requested",
    sourceUrl: "https://e.test/9.jpg", filename: "99__mk9.jpg",
  }];
  const blocks = verifyMissingImagesPackage(THREE, decisions, smuggled,
    smuggled.map((e) => e.filename));
  assert.ok(blocks.includes("unrequested_file_in_package"));
  assert.ok(blocks.includes("unmatched_product_in_package"));
});

test("19. a requested id paired with the WRONG SKU is still unrequested", () => {
  const decisions = decideMissingImages(THREE, THREE_CANDS);
  const tampered = [{
    rafeeqProductId: 1, sku: "mk2", productName: "x",
    sourceUrl: "https://e.test/2.jpg", filename: "1__mk2.jpg",
  }];
  assert.ok(verifyMissingImagesPackage(THREE, decisions, tampered, ["1__mk2.jpg"])
    .includes("unrequested_file_in_package"), "both keys must agree, not just one");
});

test("20. duplicate paths and manifest/archive drift are caught", () => {
  const decisions = decideMissingImages(THREE, THREE_CANDS);
  const dup = [
    { rafeeqProductId: 1, sku: "mk1", productName: "a", sourceUrl: "u", filename: "1__mk1.jpg" },
    { rafeeqProductId: 1, sku: "mk1", productName: "a", sourceUrl: "u", filename: "1__MK1.JPG" },
  ];
  assert.ok(verifyMissingImagesPackage(THREE, decisions, dup, dup.map((e) => e.filename))
    .includes("duplicate_package_path"), "case-folded, because archives collide that way");

  const one = [{ rafeeqProductId: 1, sku: "mk1", productName: "a", sourceUrl: "u", filename: "1__mk1.jpg" }];
  assert.ok(verifyMissingImagesPackage(THREE, decisions, one, [])
    .includes("manifest_file_missing_from_archive"));
  assert.ok(verifyMissingImagesPackage(THREE, decisions, one, ["1__mk1.jpg", "stray.jpg"])
    .includes("archive_file_missing_from_manifest"));
});

// ── the request file itself ─────────────────────────────────────────────────

test("21. the request audit reports duplicates and blanks before matching", () => {
  const a = auditMissingImagesRequest([
    ROW({ rafeeqProductId: 1, barcode: "mk1" }),
    ROW({ rafeeqProductId: 1, barcode: "mk1" }),
    ROW({ rafeeqProductId: 2, barcode: "", productNameEnglish: "" }),
  ]);
  assert.equal(a.rows, 3);
  assert.deepEqual(a.duplicateProductIds, [1]);
  assert.deepEqual(a.duplicateSkus, ["mk1"]);
  assert.equal(a.missingSkus, 1);
  assert.equal(a.missingNames, 1);
  assert.equal(a.missingProductIds, 0);
});

test("22. the real 2026-09-10 request audits clean", () => {
  // the shape actually received: 156 rows, no duplicate on either key, no blanks
  const rows = Array.from({ length: 156 }, (_, i) =>
    ROW({ rafeeqProductId: 698933247 + i, barcode: `mk${1000 + i}` }));
  const a = auditMissingImagesRequest(rows);
  assert.equal(a.rows, 156);
  assert.deepEqual(a.duplicateProductIds, []);
  assert.deepEqual(a.duplicateSkus, []);
  assert.equal(a.missingProductIds + a.missingSkus + a.missingNames, 0);
});

// ── blast radius ────────────────────────────────────────────────────────────

test("23. this module sends nothing, writes nothing, fetches nothing", async () => {
  const src = await import("node:fs").then((fs) =>
    fs.readFileSync(new URL("./missing-images.ts", import.meta.url), "utf8"));
  for (const forbidden of ["fetch(", "sendMail", "createAdminClient", "from(\"products\")",
    "lifecycle_state", ".remove(", "external_channel_listings", "putObject"]) {
    assert.equal(src.includes(forbidden), false, `must not ${forbidden}`);
  }
});
