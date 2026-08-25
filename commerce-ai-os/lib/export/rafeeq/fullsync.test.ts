// RAFEEQ FULLSYNC — pure file-sync plan tests (native-option delivery model).
// node --conditions=react-server --experimental-strip-types --test lib/export/rafeeq/fullsync.test.ts

import test from "node:test";
import assert from "node:assert/strict";

import { buildRafeeqPreview, type RafeeqPreviewProduct, type RafeeqMappingEvidence } from "./preview.ts";
import { toPackageRow, planRowImages, primaryFilenameFor, checkReferentialIntegrity, type PackagedFile } from "./package.ts";
import {
  isFullIncludable,
  isNeedsReviewIncluded,
  resolveFullSyncSet,
  pendingRows,
  pendingKindOf,
  sentProductBaseline,
  deliveryKeyOfRow,
  hasSentBaseline,
  fullSyncProductIdCell,
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

function product(id: string, sku: string, over: Partial<RafeeqPreviewProduct> = {}): RafeeqPreviewProduct {
  return {
    id,
    sku,
    barcode: null,
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

function variantProduct(
  id: string,
  sku: string,
  variants: { id: string; sku: string; price?: number | null; nameEn?: string }[],
  over: Partial<RafeeqPreviewProduct> = {},
): RafeeqPreviewProduct {
  return product(id, sku, {
    ...over,
    variants: variants.map((v) => ({
      id: v.id,
      sku: v.sku,
      barcode: null,
      nameEn: v.nameEn ?? `Option ${v.sku}`,
      nameAr: `خيار ${v.sku}`,
      price: v.price ?? null,
    })),
  });
}

function mapping(productId: string, sku: string, over: Partial<RafeeqMappingEvidence> = {}): RafeeqMappingEvidence {
  return { status: "resolved", externalId: "691300001", exportedSku: sku, productId, ...over };
}

function pkg(id: string, over: Partial<RafeeqPackageRecord> = {}): RafeeqPackageRecord {
  return {
    id,
    mode: "FULL",
    outputFilename: "rafeeq-full-2026-08-25.zip",
    productCount: 0,
    imageCount: 0,
    generatedAt: "2026-08-25T09:00:00.000Z",
    generatedBy: "owner@example.com",
    sentAt: null,
    sentBy: null,
    ...over,
  };
}
const item = (packageId: string, productId: string, fingerprint: string | null = null, variantId: string | null = null, sku = ""): RafeeqPackageItemRecord =>
  ({ packageId, productId, variantId, sku, fingerprint });

function previewOf(products: RafeeqPreviewProduct[], mappingBySku: Record<string, RafeeqMappingEvidence> = {}) {
  return buildRafeeqPreview({ products, mappingBySku });
}

// A standard mixed dataset:
//   p1 READY unmapped · p2 WARNING (missing category) mapped id=691300777 ·
//   p3 BLOCKED (missing image) · p4 BLOCKED only by IDENTITY_NEEDS_REVIEW
function mixedPreview() {
  const products = [
    product("p1", "mk1001"),
    product("p2", "mk1002", { category: null }),
    product("p3", "mk1003", { imageUrl: null, imageFilename: null, imageCount: 0 }),
    product("p4", "mk1004"),
  ];
  const mappings: Record<string, RafeeqMappingEvidence> = {
    mk1002: mapping("p2", "mk1002", { externalId: "691300777" }),
    mk1004: mapping("p4", "mk1004", { status: "needs_review", externalId: null }),
  };
  return previewOf(products, mappings);
}
const EMPTY = new Map<string, string | null>();

// ── 1) FULL includes every exportable product ─────────────────────────────────
test("1: FULL includes every exportable product (READY + WARNING + needs_review-only)", () => {
  const pv = mixedPreview();
  const set = resolveFullSyncSet(pv.rows, "FULL", EMPTY);
  const ids = set.included.map((r) => r.internalProductId);
  assert.ok(ids.includes("p1"), "READY product included");
  assert.ok(ids.includes("p2"), "WARNING product included");
  assert.equal(set.counts.includedRows, 3); // p1 + p2 + p4 (needs_review-only)
});

// ── 2) needs_review products ship with a BLANK product_id ─────────────────────
test("2: a product blocked ONLY by IDENTITY_NEEDS_REVIEW is included in FULL with a BLANK product_id", () => {
  const pv = mixedPreview();
  const p4 = pv.rows.find((r) => r.internalProductId === "p4")!;
  assert.equal(p4.status, "BLOCKED");
  assert.equal(isFullIncludable(p4), true);
  assert.equal(isNeedsReviewIncluded(p4), true);
  assert.equal(p4.rafeeqId, null, "the contested id is NOT surfaced");
  assert.equal(fullSyncProductIdCell(p4, "FULL"), "", "blank id — never invented, never the contested one");
  const packaged = applyFullSyncRafeeqId(toPackageRow(p4, "mk1004.jpg"), p4, "FULL");
  assert.equal(packaged.rafeeqId, "");
});

// ── 3) FULL preserves valid resolved Rafeeq ids ───────────────────────────────
test("3: FULL preserves an existing resolved Rafeeq id", () => {
  const pv = mixedPreview();
  const p2 = pv.rows.find((r) => r.internalProductId === "p2")!;
  assert.equal(p2.rafeeqId, "691300777");
  assert.equal(fullSyncProductIdCell(p2, "FULL"), "691300777");
});

// ── 4) genuine blockers stay excluded from FULL ───────────────────────────────
test("4: true blockers (missing image / missing SKU / duplicate parent SKU / stopped / option missing its price) are excluded", () => {
  const pv = previewOf([
    product("b1", "mk2001", { imageUrl: null, imageFilename: null, imageCount: 0 }), // MISSING_IMAGE
    product("b2", "", {}),                                                           // MISSING_SKU + MISSING_BARCODE
    variantProduct("b3", "mk2003", [{ id: "b3v", sku: "mk2003-1" }]),                // DUPLICATE (parent sku claimed twice)
    product("b4", "mk2003"),                                                          // DUPLICATE
    product("b5", "mk2005", { lifecycleState: "STOPPED" }),                          // LIFECYCLE
    // one option priced, one without ANY effective price (no parent price either)
    variantProduct("b6", "mk2006", [{ id: "x1", sku: "mk2006-1", price: 10 }, { id: "x2", sku: "mk2006-2" }], { price: null }), // MISSING_PRICE (blocking)
    // differing VALID prices are NOT a blocker any more (PRICE ON SELECTION)
    variantProduct("ok2", "mk2008", [{ id: "y1", sku: "mk2008-1", price: 10 }, { id: "y2", sku: "mk2008-2", price: 20 }]),
    product("ok", "mk2007"),
  ]);
  const set = resolveFullSyncSet(pv.rows, "FULL", EMPTY);
  assert.deepEqual(set.included.map((r) => r.internalProductId).sort(), ["ok", "ok2"]);
  assert.equal(set.counts.trueBlockers, 6);
  for (const r of set.excludedBlocked) assert.equal(isFullIncludable(r), false);
  const okDiffering = set.included.find((r) => r.internalProductId === "ok2")!;
  assert.equal(okDiffering.priceOnSelection, true, "differing-price product ships with the sentinel encoding");
});

// ── 5) generating a package does NOT mark anything sent ───────────────────────
test("5: an unsent (generated-only) package contributes nothing to the sent baseline", () => {
  const packages = [pkg("pk1", { sentAt: null })];
  const items = [item("pk1", "p1", "aa"), item("pk1", "p2", "bb")];
  assert.equal(sentProductBaseline(packages, items).size, 0);
  assert.equal(hasSentBaseline(packages), false);
});

// ── 6) only the explicit sent state establishes the baseline ──────────────────
test("6: marking the package sent establishes the durable product baseline (with fingerprints)", () => {
  const packages = [pkg("pk1", { sentAt: "2026-08-25T10:00:00.000Z", sentBy: "clanqtr@gmail.com" })];
  const items = [item("pk1", "p1", "fp-1"), item("pk1", "p2", "fp-2")];
  const baseline = sentProductBaseline(packages, items);
  assert.deepEqual([...baseline.entries()].sort(), [["p1", "fp-1"], ["p2", "fp-2"]]);
  assert.equal(hasSentBaseline(packages), true);
});

// ── 7) after the FULL package is sent, pending = 0 ────────────────────────────
test("7: a sent FULL package covering all exportable products at current fingerprints empties the pending queue", () => {
  const pv = mixedPreview();
  const set = resolveFullSyncSet(pv.rows, "FULL", EMPTY);
  const packages = [pkg("pk1", { sentAt: "2026-08-25T10:00:00.000Z" })];
  const items = set.included.map((r) => item("pk1", r.internalProductId, rowFingerprint(r)));
  const baseline = sentProductBaseline(packages, items);
  assert.equal(pendingRows(pv.rows, baseline).length, 0);
});

// ── 8) a newly eligible product becomes pending NEW ───────────────────────────
test("8: adding one new exportable product makes pending = exactly that product, kind NEW", () => {
  const pv1 = mixedPreview();
  const baseline = sentProductBaseline(
    [pkg("pk1", { sentAt: "2026-08-25T10:00:00.000Z" })],
    resolveFullSyncSet(pv1.rows, "FULL", EMPTY).included.map((r) => item("pk1", r.internalProductId, rowFingerprint(r))),
  );
  const pv2 = previewOf([
    product("p1", "mk1001"),
    product("p2", "mk1002", { category: null }),
    product("p4", "mk1004"),
    product("p5", "mk1005"),
  ], { mk1002: mapping("p2", "mk1002", { externalId: "691300777" }), mk1004: mapping("p4", "mk1004", { status: "needs_review", externalId: null }) });
  const pending = pendingRows(pv2.rows, baseline);
  assert.deepEqual(pending.map((p) => [p.row.internalProductId, p.kind]), [["p5", "NEW"]]);
});

// ── 9) NEW package contents + naming + referential integrity ──────────────────
test("9: the NEW set contains the pending product; layout names + parent-SKU image pass integrity", () => {
  const pv = previewOf([product("p5", "mk1005")]);
  const set = resolveFullSyncSet(pv.rows, "NEW", EMPTY);
  assert.equal(set.included.length, 1);
  const row = set.included[0];
  const plan = planRowImages(row);
  assert.ok(plan.primary, "pending product has a primary image planned");
  const filename = primaryFilenameFor(row.sku, "jpg");
  assert.equal(filename, "mk1005.jpg");
  const packageRow = applyFullSyncRafeeqId(toPackageRow(row, filename), row, "NEW", set.includedKinds.get(deliveryKeyOfRow(row)));
  assert.equal(packageRow.rafeeqId, "", "NEW-kind product ships with a blank product_id");
  const packaged: PackagedFile[] = [{ name: filename, kind: "primary" }];
  assert.equal(checkReferentialIntegrity([packageRow.imageName], packaged).ok, true);
  assert.equal(fullSyncXlsxName("NEW"), "rafeeq_new_products.xlsx");
  assert.equal(fullSyncImageEntryName(filename), "images/mk1005.jpg");
});

// ── 10) generating the NEW package does not clear the pending queue ───────────
test("10: recording a generated (unsent) NEW package leaves the pending queue unchanged", () => {
  const pv = previewOf([product("p5", "mk1005")]);
  assert.equal(pendingRows(pv.rows, sentProductBaseline([], [])).length, 1);
  const packages = [pkg("pkN", { mode: "NEW", sentAt: null })];
  const items = [item("pkN", "p5", rowFingerprint(pv.rows[0]))];
  assert.equal(pendingRows(pv.rows, sentProductBaseline(packages, items)).length, 1, "generation/download never clears the queue");
});

// ── 11) marking the NEW package sent clears its products ──────────────────────
test("11: marking the NEW package sent removes its products from pending", () => {
  const pv = previewOf([product("p5", "mk1005"), product("p6", "mk1006")]);
  const p5 = pv.rows.find((r) => r.internalProductId === "p5")!;
  const packages = [pkg("pkN", { mode: "NEW", sentAt: "2026-08-26T08:00:00.000Z", sentBy: "clanqtr@gmail.com" })];
  const items = [item("pkN", "p5", rowFingerprint(p5))];
  const pending = pendingRows(pv.rows, sentProductBaseline(packages, items));
  assert.deepEqual(pending.map((p) => p.row.internalProductId), ["p6"]);
});

// ── 12) ECL identity does not define pending ──────────────────────────────────
test("12: pending is delivery-derived — a mapped product can be pending, a sent product is not", () => {
  const pv = previewOf(
    [product("m1", "mk4001"), product("u1", "mk4002")],
    { mk4001: mapping("m1", "mk4001", { externalId: "691300888" }) },
  );
  const u1 = pv.rows.find((r) => r.internalProductId === "u1")!;
  const baseline = sentProductBaseline(
    [pkg("pk1", { sentAt: "2026-08-25T10:00:00.000Z" })],
    [item("pk1", "u1", rowFingerprint(u1))],
  );
  const pending = pendingRows(pv.rows, baseline);
  assert.deepEqual(pending.map((p) => p.row.internalProductId), ["m1"], "mapped-but-unsent IS pending; unmapped-but-sent is NOT");
});

// ── 13) OPTION UPDATE: option-set change re-queues the PARENT, never a new product ──
test("13: adding an option to a SENT product re-queues the parent as OPTION_UPDATE — never a separate new product", () => {
  // baseline: product P sent with options v1 + v2
  const pv1 = previewOf([variantProduct("P", "mk500", [{ id: "v1", sku: "mk500-1" }, { id: "v2", sku: "mk500-2" }])]);
  const sentFp = rowFingerprint(pv1.rows[0]);
  const baseline = sentProductBaseline(
    [pkg("pkF", { sentAt: "2026-08-26T08:00:00.000Z" })],
    [item("pkF", "P", sentFp)],
  );
  assert.equal(pendingRows(pv1.rows, baseline).length, 0, "unchanged option set ⇒ not pending");

  // later: a THIRD option is created on the already-sent product
  const pv2 = previewOf([variantProduct("P", "mk500", [{ id: "v1", sku: "mk500-1" }, { id: "v2", sku: "mk500-2" }, { id: "v3", sku: "mk500-3" }])]);
  const pending = pendingRows(pv2.rows, baseline);
  assert.deepEqual(pending.map((p) => [p.row.internalProductId, p.kind]), [["P", "OPTION_UPDATE"]],
    "ONE pending entry — the parent product, kind OPTION_UPDATE");
  // the NEW package carries the parent WITH its resolved id so Rafeeq updates it
  const pvMapped = previewOf(
    [variantProduct("P", "mk500", [{ id: "v1", sku: "mk500-1" }, { id: "v2", sku: "mk500-2" }, { id: "v3", sku: "mk500-3" }])],
    { mk500: mapping("P", "mk500", { externalId: "691300500" }) },
  );
  const set = resolveFullSyncSet(pvMapped.rows, "NEW", baseline);
  assert.deepEqual(set.included.map((r) => r.internalProductId), ["P"]);
  assert.equal(set.counts.optionUpdates, 1);
  const cell = fullSyncProductIdCell(set.included[0], "NEW", set.includedKinds.get("P"));
  assert.equal(cell, "691300500", "OPTION_UPDATE keeps the resolved product_id — never a duplicate new product");
});

// ── 14) option rename/reprice also re-queues the parent ───────────────────────
test("14: renaming or repricing an option changes the delivery fingerprint and re-queues the parent", () => {
  const before = previewOf([variantProduct("P", "mk500", [{ id: "v1", sku: "mk500-1", nameEn: "Red" }])]).rows[0];
  const renamed = previewOf([variantProduct("P", "mk500", [{ id: "v1", sku: "mk500-1", nameEn: "Crimson" }])]).rows[0];
  const repriced = previewOf([variantProduct("P", "mk500", [{ id: "v1", sku: "mk500-1", price: 55 }])]).rows[0];
  assert.notEqual(rowFingerprint(before), rowFingerprint(renamed));
  assert.notEqual(rowFingerprint(before), rowFingerprint(repriced));
  const baseline = new Map([["P", rowFingerprint(before)]]);
  assert.equal(pendingKindOf(renamed, baseline), "OPTION_UPDATE");
});

// ── 15) legacy variant-grain sent records ⇒ safe re-baseline ──────────────────
test("15: legacy variant-grain sent items surface the product as OPTION_UPDATE (unknown fingerprint) — never silently current", () => {
  const baseline = sentProductBaseline(
    [pkg("pkOld", { sentAt: "2026-08-26T08:00:00.000Z" })],
    [item("pkOld", "P", "legacy-fp", "v1", "mk500-1"), item("pkOld", "P", "legacy-fp", "v2", "mk500-2")],
  );
  assert.equal(baseline.get("P"), null, "variant-grain evidence degrades to unknown fingerprint");
  const pv = previewOf([variantProduct("P", "mk500", [{ id: "v1", sku: "mk500-1" }, { id: "v2", sku: "mk500-2" }])]);
  assert.deepEqual(pendingRows(pv.rows, baseline).map((p) => p.kind), ["OPTION_UPDATE"]);
});

// ── naming, fingerprints, manifest ────────────────────────────────────────────
test("zip/xlsx naming follows the rafeeq-full / rafeeq-new-products convention", () => {
  const now = new Date("2026-08-25T15:30:00Z");
  assert.equal(fullSyncZipName("FULL", now), "rafeeq-full-2026-08-25.zip");
  assert.equal(fullSyncZipName("NEW", now), "rafeeq-new-products-2026-08-25.zip");
  assert.equal(fullSyncXlsxName("FULL"), "rafeeq_catalog.xlsx");
});

test("delivery fingerprints are deterministic, option-sensitive, and identity-insensitive", () => {
  const a = previewOf([variantProduct("P", "mk1", [{ id: "v1", sku: "mk1-1" }])]).rows[0];
  const b = previewOf([variantProduct("P", "mk1", [{ id: "v1", sku: "mk1-1" }])]).rows[0];
  assert.equal(rowFingerprint(a), rowFingerprint(b), "deterministic");
  assert.match(rowFingerprint(a), /^[0-9a-f]{16}$/);
  // resolving the identity is NOT a content change
  const mapped = previewOf([variantProduct("P", "mk1", [{ id: "v1", sku: "mk1-1" }])], { mk1: mapping("P", "mk1", { externalId: "691300123" }) }).rows[0];
  assert.equal(rowFingerprint(a), rowFingerprint(mapped), "mapping id excluded from the delivery fingerprint");
  assert.equal(packageFingerprint("FULL", ["aa", "bb"]), packageFingerprint("FULL", ["bb", "aa"]));
  assert.notEqual(packageFingerprint("FULL", ["aa"]), packageFingerprint("NEW", ["aa"]));
});

test("fullsync manifest carries the identity/physical/option counts + fingerprint", () => {
  const m = buildFullSyncManifest({
    storefrontKey: "rafeeq:malikas",
    mode: "FULL",
    generatedAt: "2026-08-25T15:30:00.000Z",
    actor: "clanqtr@gmail.com",
    productRowCount: 1419,
    physicalRowCount: 1554,
    productsWithOptions: 62,
    optionCount: 197,
    optionUpdateCount: 0,
    imageCount: 2535,
    mappedIdCount: 0,
    newMarkerCount: 1419,
    needsReviewIncluded: 4,
    trueBlockersExcluded: 0,
    outputFilename: "rafeeq-full-2026-08-25.zip",
    xlsxFilename: "rafeeq_catalog.xlsx",
    packageFingerprint: "deadbeef00000000",
  });
  assert.equal(m.schema, "rafeeq-fullsync-manifest/2");
  assert.equal(m.product_identity_count, 1419, "the business count is PRODUCT identities");
  assert.equal(m.physical_row_count, 1554, "physical rows reported separately");
  assert.equal(m.products_with_options, 62);
  assert.equal(m.option_count, 197);
  assert.equal(m.package_fingerprint, "deadbeef00000000");
});
