// RAFEEQ.FULLSYNC.1 — pure file-sync plan tests (spec scenarios 1–14).
// node --conditions=react-server --experimental-strip-types --test lib/export/rafeeq/fullsync.test.ts

import test from "node:test";
import assert from "node:assert/strict";

import { buildRafeeqPreview, type RafeeqPreviewProduct, type RafeeqMappingEvidence } from "./preview.ts";
import { toPackageRow, planRowImages, primaryFilenameFor, checkReferentialIntegrity, RAFEEQ_NEW_MARKER, type PackagedFile } from "./package.ts";
import {
  isFullIncludable,
  isNeedsReviewIncluded,
  resolveFullSyncSet,
  pendingNewRows,
  sentSellableKeySet,
  sellableKeyOfRow,
  hasSentBaseline,
  fullSyncRafeeqId,
  applyFullSyncRafeeqId,
  rowFingerprint,
  packageFingerprint,
  fullSyncZipName,
  fullSyncXlsxName,
  fullSyncImageEntryName,
  buildFullSyncManifest,
  type RafeeqPackageRecord,
  type RafeeqPackageItemRecord,
} from "./fullsync.ts";

// ── fixtures (through the CERTIFIED preview — statuses/reasons are real) ──────

let barcodeSeq = 100000;
function product(id: string, sku: string, over: Partial<RafeeqPreviewProduct> = {}): RafeeqPreviewProduct {
  barcodeSeq += 1;
  return {
    id,
    sku,
    barcode: String(barcodeSeq),
    nameEn: `Product ${sku}`,
    nameAr: `منتج ${sku}`,
    category: "Face Care",
    price: 100,
    discountPrice: null,
    descriptionEn: "en",
    descriptionAr: "ar",
    imageUrl: `https://cdn.example.com/${sku}.jpg`,
    imageFilename: `${sku}.jpg`,
    imageCount: 1,
    ...over,
  };
}

function mapping(productId: string, sku: string, over: Partial<RafeeqMappingEvidence> = {}): RafeeqMappingEvidence {
  return { status: "resolved", externalId: "555001", exportedSku: sku, productId, ...over };
}

function pkg(id: string, over: Partial<RafeeqPackageRecord> = {}): RafeeqPackageRecord {
  return {
    id,
    mode: "FULL",
    outputFilename: "rafeeq-full-2026-08-24.zip",
    productCount: 0,
    imageCount: 0,
    generatedAt: "2026-08-24T09:00:00.000Z",
    generatedBy: "owner@example.com",
    sentAt: null,
    sentBy: null,
    ...over,
  };
}
const item = (packageId: string, productId: string, variantId: string | null = null, sku = ""): RafeeqPackageItemRecord => ({ packageId, productId, variantId, sku });

function previewOf(products: RafeeqPreviewProduct[], mappingBySku: Record<string, RafeeqMappingEvidence> = {}) {
  return buildRafeeqPreview({ products, mappingBySku });
}

// A standard mixed dataset:
//   p1 READY unmapped · p2 WARNING (missing barcode) mapped id=777 ·
//   p3 BLOCKED (missing image) · p4 BLOCKED only by IDENTITY_NEEDS_REVIEW
function mixedPreview() {
  const products = [
    product("p1", "mk1001"),
    product("p2", "mk1002", { barcode: null }),
    product("p3", "mk1003", { imageUrl: null, imageFilename: null, imageCount: 0 }),
    product("p4", "mk1004"),
  ];
  const mappings: Record<string, RafeeqMappingEvidence> = {
    mk1002: mapping("p2", "mk1002", { externalId: "777" }),
    mk1004: mapping("p4", "mk1004", { status: "needs_review", externalId: null }),
  };
  return previewOf(products, mappings);
}

// ── 1) FULL includes every exportable product ─────────────────────────────────
test("1: FULL includes every exportable product (READY + WARNING)", () => {
  const pv = mixedPreview();
  const set = resolveFullSyncSet(pv.rows, "FULL", new Set());
  const ids = set.included.map((r) => r.internalProductId);
  assert.ok(ids.includes("p1"), "READY row included");
  assert.ok(ids.includes("p2"), "WARNING row included");
  assert.equal(set.counts.includedRows, 3); // p1 + p2 + p4 (needs_review-only)
});

// ── 2) FULL includes needs_review rows with the "new product" marker ──────────
test("2: a row blocked ONLY by IDENTITY_NEEDS_REVIEW is included in FULL with the new-product marker", () => {
  const pv = mixedPreview();
  const p4 = pv.rows.find((r) => r.internalProductId === "p4")!;
  assert.equal(p4.status, "BLOCKED");
  assert.ok(p4.reasons.some((x) => x.code === "IDENTITY_NEEDS_REVIEW" && x.blocking));
  assert.equal(isFullIncludable(p4), true);
  assert.equal(isNeedsReviewIncluded(p4), true);
  // the contested id is NOT surfaced; the file carries the literal marker
  assert.equal(p4.rafeeqId, null);
  assert.equal(fullSyncRafeeqId(p4, "FULL"), RAFEEQ_NEW_MARKER);
  const packaged = applyFullSyncRafeeqId(toPackageRow(p4, "mk1004.jpg"), p4, "FULL");
  assert.equal(packaged.rafeeqId, "new product");
});

// ── 3) FULL preserves valid resolved Rafeeq ids ───────────────────────────────
test("3: FULL preserves an existing resolved Rafeeq id (never overwritten with the marker)", () => {
  const pv = mixedPreview();
  const p2 = pv.rows.find((r) => r.internalProductId === "p2")!;
  assert.equal(p2.rafeeqId, "777");
  assert.equal(fullSyncRafeeqId(p2, "FULL"), "777");
  const packaged = applyFullSyncRafeeqId(toPackageRow(p2, "mk1002.jpg"), p2, "FULL");
  assert.equal(packaged.rafeeqId, "777");
});

// ── 4) genuine blockers stay excluded from FULL ───────────────────────────────
test("4: true blockers (missing image / missing SKU / duplicate barcode / stopped) are excluded from FULL", () => {
  const dupBarcode = "222333";
  const pv = previewOf([
    product("b1", "mk2001", { imageUrl: null, imageFilename: null, imageCount: 0 }), // MISSING_IMAGE
    product("b2", "", {}),                                                           // MISSING_SKU
    product("b3", "mk2003", { barcode: dupBarcode }),                                // DUPLICATE_BARCODE
    product("b4", "mk2004", { barcode: dupBarcode }),                                // DUPLICATE_BARCODE
    product("b5", "mk2005", { lifecycleState: "STOPPED" }),                          // LIFECYCLE
    product("ok", "mk2006"),
  ]);
  const set = resolveFullSyncSet(pv.rows, "FULL", new Set());
  assert.deepEqual(set.included.map((r) => r.internalProductId), ["ok"]);
  assert.equal(set.counts.trueBlockers, 5);
  for (const r of set.excludedBlocked) assert.equal(isFullIncludable(r), false);
  // a row with the identity review PLUS a true blocker is NOT includable
  const both = previewOf(
    [product("x1", "mk3001", { imageUrl: null, imageFilename: null, imageCount: 0 })],
    { mk3001: mapping("x1", "mk3001", { status: "needs_review", externalId: null }) },
  ).rows[0];
  assert.equal(both.status, "BLOCKED");
  assert.equal(isFullIncludable(both), false);
});

// ── 5) generating a package does NOT mark anything sent ───────────────────────
test("5: an unsent (generated-only) package contributes nothing to the sent baseline", () => {
  const packages = [pkg("pk1", { sentAt: null })];
  const items = [item("pk1", "p1"), item("pk1", "p2")];
  assert.equal(sentSellableKeySet(packages, items).size, 0);
  assert.equal(hasSentBaseline(packages), false);
});

// ── 6) only the explicit sent state establishes the baseline ──────────────────
test("6: marking the package sent establishes the durable baseline", () => {
  const packages = [pkg("pk1", { sentAt: "2026-08-24T10:00:00.000Z", sentBy: "clanqtr@gmail.com" })];
  const items = [item("pk1", "p1"), item("pk1", "p2")];
  const sent = sentSellableKeySet(packages, items);
  assert.deepEqual([...sent].sort(), ["p1", "p2"]);
  assert.equal(hasSentBaseline(packages), true);
});

// ── 7) after the FULL package is sent, pending = 0 ────────────────────────────
test("7: after a sent FULL package covering all exportable products, the pending queue is empty", () => {
  const pv = mixedPreview();
  const set = resolveFullSyncSet(pv.rows, "FULL", new Set());
  const packages = [pkg("pk1", { sentAt: "2026-08-24T10:00:00.000Z" })];
  const items = set.included.map((r) => item("pk1", r.internalProductId, r.variantId, r.sku));
  const sent = sentSellableKeySet(packages, items);
  assert.equal(pendingNewRows(pv.rows, sent).length, 0);
});

// ── 8) a newly eligible product becomes pending ───────────────────────────────
test("8: adding one new exportable product makes pending = exactly that product", () => {
  const pv1 = mixedPreview();
  const sent = sentSellableKeySet(
    [pkg("pk1", { sentAt: "2026-08-24T10:00:00.000Z" })],
    resolveFullSyncSet(pv1.rows, "FULL", new Set()).included.map((r) => item("pk1", r.internalProductId, r.variantId)),
  );
  // the catalog grows by one product after the baseline
  const pv2 = previewOf([
    product("p1", "mk1001"),
    product("p2", "mk1002", { barcode: null }),
    product("p4", "mk1004"),
    product("p5", "mk1005"),
  ]);
  const pending = pendingNewRows(pv2.rows, sent);
  assert.deepEqual(pending.map((r) => r.internalProductId), ["p5"]);
});

// ── 9) the NEW package contains the pending product + its SKU-named image ─────
test("9: the NEW set contains the pending product and its packaged image passes referential integrity", () => {
  const pv = previewOf([product("p5", "mk1005")]);
  const set = resolveFullSyncSet(pv.rows, "NEW", new Set());
  assert.equal(set.included.length, 1);
  const row = set.included[0];
  const plan = planRowImages(row);
  assert.ok(plan.primary, "pending product has a primary image planned");
  const filename = primaryFilenameFor(row.sku, "jpg");
  assert.equal(filename, "mk1005.jpg");
  const packageRow = applyFullSyncRafeeqId(toPackageRow(row, filename), row, "NEW");
  const packaged: PackagedFile[] = [{ name: filename, kind: "primary" }];
  const integrity = checkReferentialIntegrity([packageRow.imageName], packaged);
  assert.equal(integrity.ok, true);
  // ZIP layout helpers: root xlsx + images/ entries
  assert.equal(fullSyncXlsxName("NEW"), "rafeeq_new_products.xlsx");
  assert.equal(fullSyncImageEntryName(filename), "images/mk1005.jpg");
});

// NEW forces the marker on EVERY row — even one that carries a resolved id.
test("9b: NEW mode forces the new-product marker even for a mapped row", () => {
  const pv = previewOf([product("p2", "mk1002")], { mk1002: mapping("p2", "mk1002", { externalId: "777" }) });
  const row = pv.rows[0];
  assert.equal(row.rafeeqId, "777");
  assert.equal(fullSyncRafeeqId(row, "NEW"), RAFEEQ_NEW_MARKER);
});

// ── 10) generating the NEW package does not clear the pending queue ───────────
test("10: recording a generated (unsent) NEW package leaves the pending queue unchanged", () => {
  const pv = previewOf([product("p5", "mk1005")]);
  const before = pendingNewRows(pv.rows, sentSellableKeySet([], []));
  assert.equal(before.length, 1);
  // NEW package generated + recorded but NOT sent
  const packages = [pkg("pkN", { mode: "NEW", sentAt: null })];
  const items = [item("pkN", "p5", null, "mk1005")];
  const after = pendingNewRows(pv.rows, sentSellableKeySet(packages, items));
  assert.equal(after.length, 1, "generation/download never clears the queue");
});

// ── 11) marking the NEW package sent clears its products ──────────────────────
test("11: marking the NEW package sent removes its products from pending", () => {
  const pv = previewOf([product("p5", "mk1005"), product("p6", "mk1006")]);
  const packages = [pkg("pkN", { mode: "NEW", sentAt: "2026-08-25T08:00:00.000Z", sentBy: "clanqtr@gmail.com" })];
  const items = [item("pkN", "p5", null, "mk1005")];
  const pending = pendingNewRows(pv.rows, sentSellableKeySet(packages, items));
  assert.deepEqual(pending.map((r) => r.internalProductId), ["p6"]);
});

// ── 12) ECL identity does not define pending ──────────────────────────────────
test("12: pending is delivery-derived — a mapped product can be pending, a sent product is not (mapped or not)", () => {
  const pv = previewOf(
    [product("m1", "mk4001"), product("u1", "mk4002")],
    { mk4001: mapping("m1", "mk4001", { externalId: "888" }) }, // m1 mapped, u1 unmapped
  );
  // u1 (UNMAPPED) was sent; m1 (MAPPED) was never sent.
  const packages = [pkg("pk1", { sentAt: "2026-08-24T10:00:00.000Z" })];
  const items = [item("pk1", "u1", null, "mk4002")];
  const pending = pendingNewRows(pv.rows, sentSellableKeySet(packages, items));
  assert.deepEqual(pending.map((r) => r.internalProductId), ["m1"], "mapped-but-unsent IS pending; unmapped-but-sent is NOT");
});

// ── 13) a pre-baseline product becoming eligible later becomes pending ────────
test("13: a product that was blocked at baseline time becomes pending once it turns exportable", () => {
  const blocked = product("p7", "mk1007", { imageUrl: null, imageFilename: null, imageCount: 0 });
  const pv1 = previewOf([product("p1", "mk1001"), blocked]);
  const set = resolveFullSyncSet(pv1.rows, "FULL", new Set());
  assert.deepEqual(set.included.map((r) => r.internalProductId), ["p1"], "blocked row not in the baseline package");
  const sent = sentSellableKeySet(
    [pkg("pk1", { sentAt: "2026-08-24T10:00:00.000Z" })],
    set.included.map((r) => item("pk1", r.internalProductId, r.variantId)),
  );
  assert.equal(pendingNewRows(pv1.rows, sent).length, 0, "still blocked ⇒ not pending");
  // the product later gets its image → exportable → pending
  const pv2 = previewOf([product("p1", "mk1001"), product("p7", "mk1007")]);
  assert.deepEqual(pendingNewRows(pv2.rows, sent).map((r) => r.internalProductId), ["p7"]);
});

// ── 14) image ↔ ZIP referential integrity with the fullsync layout ────────────
test("14: referential integrity fails when a row's image is missing from the package", () => {
  const rows = ["mk1.jpg", "mk2.jpg"];
  const okPackaged: PackagedFile[] = [
    { name: "mk1.jpg", kind: "primary" },
    { name: "mk2.jpg", kind: "primary" },
    { name: "mk2_2.jpg", kind: "gallery", ownerPrimary: "mk2.jpg" },
  ];
  assert.equal(checkReferentialIntegrity(rows, okPackaged).ok, true);
  const missing = checkReferentialIntegrity(rows, okPackaged.slice(1));
  assert.equal(missing.ok, false);
  assert.deepEqual(missing.missingForRows, ["mk1.jpg"]);
  const orphan = checkReferentialIntegrity(["mk1.jpg"], okPackaged);
  assert.equal(orphan.ok, false, "packaged files without rows are orphans");
});

// ── naming, fingerprints, manifest ────────────────────────────────────────────
test("zip/xlsx naming follows the rafeeq-full / rafeeq-new-products convention", () => {
  const now = new Date("2026-08-24T15:30:00Z");
  assert.equal(fullSyncZipName("FULL", now), "rafeeq-full-2026-08-24.zip");
  assert.equal(fullSyncZipName("NEW", now), "rafeeq-new-products-2026-08-24.zip");
  assert.equal(fullSyncXlsxName("FULL"), "rafeeq_catalog.xlsx");
});

test("row/package fingerprints are deterministic and order-insensitive at package level", () => {
  const fixed = { barcode: "123456789" };
  const pv = previewOf([product("p1", "mk1001", fixed)]);
  const f1 = rowFingerprint(pv.rows[0]);
  const f2 = rowFingerprint(previewOf([product("p1", "mk1001", fixed)]).rows[0]);
  assert.equal(f1, f2);
  assert.match(f1, /^[0-9a-f]{16}$/);
  assert.equal(packageFingerprint("FULL", ["aa", "bb"]), packageFingerprint("FULL", ["bb", "aa"]));
  assert.notEqual(packageFingerprint("FULL", ["aa"]), packageFingerprint("NEW", ["aa"]));
});

test("fullsync manifest carries the exact counts + fingerprint", () => {
  const m = buildFullSyncManifest({
    storefrontKey: "rafeeq:malikas",
    mode: "NEW",
    generatedAt: "2026-08-24T15:30:00.000Z",
    actor: "clanqtr@gmail.com",
    productRowCount: 3,
    imageCount: 4,
    mappedIdCount: 0,
    newMarkerCount: 3,
    needsReviewIncluded: 1,
    trueBlockersExcluded: 2,
    outputFilename: "rafeeq-new-products-2026-08-24.zip",
    xlsxFilename: "rafeeq_new_products.xlsx",
    packageFingerprint: "deadbeef00000000",
  });
  assert.equal(m.schema, "rafeeq-fullsync-manifest/1");
  assert.equal(m.mode, "NEW");
  assert.equal(m.product_row_count, 3);
  assert.equal(m.image_count, 4);
  assert.equal(m.new_marker_count, 3);
  assert.equal(m.xlsx_filename, "rafeeq_new_products.xlsx");
  assert.equal(m.package_fingerprint, "deadbeef00000000");
});

// ── RAFEEQ.FULLSYNC.2 — variant-grain pending (spec scenarios 14 + 15) ────────

function variantProduct(id: string, sku: string, variants: { id: string; sku: string; barcode?: string; price?: number | null }[]): RafeeqPreviewProduct {
  return product(id, sku, {
    variants: variants.map((v) => ({
      id: v.id,
      sku: v.sku,
      barcode: v.barcode ?? String((barcodeSeq += 1)),
      nameEn: `Option ${v.sku}`,
      nameAr: `خيار ${v.sku}`,
      price: v.price ?? null,
    })),
  });
}

test("14: a variant added AFTER the baseline becomes pending on its own", () => {
  // baseline: product P sent with variants v1 + v2
  const pv1 = previewOf([variantProduct("P", "mk500", [{ id: "v1", sku: "mk500-1" }, { id: "v2", sku: "mk500-2" }])]);
  const baselineItems = resolveFullSyncSet(pv1.rows, "FULL", new Set()).included
    .map((r) => item("pkF", r.internalProductId, r.variantId, r.sku));
  assert.equal(baselineItems.length, 2, "two variant rows, no parent row");
  const sent = sentSellableKeySet([pkg("pkF", { sentAt: "2026-08-25T08:00:00.000Z" })], baselineItems);

  // later: a THIRD variant is created on the already-sent product
  const pv2 = previewOf([variantProduct("P", "mk500", [{ id: "v1", sku: "mk500-1" }, { id: "v2", sku: "mk500-2" }, { id: "v3", sku: "mk500-3" }])]);
  const pending = pendingNewRows(pv2.rows, sent);
  assert.deepEqual(pending.map((r) => r.sku), ["mk500-3"], "ONLY the new variant is pending");
  const set = resolveFullSyncSet(pv2.rows, "NEW", sent);
  assert.deepEqual(set.included.map((r) => r.sku), ["mk500-3"], "the NEW package contains only the new variant");
  assert.equal(set.excludedAlreadySent.length, 2);
});

test("15: already-sent sibling variants stay non-pending (never re-queued by the new sibling)", () => {
  const pv1 = previewOf([variantProduct("P", "mk500", [{ id: "v1", sku: "mk500-1" }, { id: "v2", sku: "mk500-2" }])]);
  const sent = sentSellableKeySet(
    [pkg("pkF", { sentAt: "2026-08-25T08:00:00.000Z" })],
    resolveFullSyncSet(pv1.rows, "FULL", new Set()).included.map((r) => item("pkF", r.internalProductId, r.variantId, r.sku)),
  );
  const pv2 = previewOf([variantProduct("P", "mk500", [{ id: "v1", sku: "mk500-1" }, { id: "v2", sku: "mk500-2" }, { id: "v3", sku: "mk500-3" }])]);
  const pendingKeys = pendingNewRows(pv2.rows, sent).map((r) => sellableKeyOfRow(r));
  assert.equal(pendingKeys.includes("P::v1"), false, "sent sibling v1 stays cleared");
  assert.equal(pendingKeys.includes("P::v2"), false, "sent sibling v2 stays cleared");
  assert.deepEqual(pendingKeys, ["P::v3"]);
});

test("a legacy product-grain sent item is NEVER reinterpreted as covering the product's variants", () => {
  // the FULLSYNC.1 package recorded product P at product grain (variantId null)
  const sent = sentSellableKeySet(
    [pkg("pkOld", { sentAt: "2026-08-25T08:00:00.000Z" })],
    [item("pkOld", "P", null, "mk500")],
  );
  // the product NOW flattens to variant rows — every variant row is pending
  const pv = previewOf([variantProduct("P", "mk500", [{ id: "v1", sku: "mk500-1" }, { id: "v2", sku: "mk500-2" }])]);
  assert.deepEqual(pendingNewRows(pv.rows, sent).map((r) => r.sku), ["mk500-1", "mk500-2"]);
});
