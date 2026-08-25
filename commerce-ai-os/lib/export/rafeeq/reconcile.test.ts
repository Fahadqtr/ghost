// RAFEEQ native returned-file reconciliation tests — PARENT-PRODUCT grain.
// The returned workbook is the native 40-column "data" sheet; the returned
// product_id binds to ONE canonical parent product (option rows collapse).
// Matching is barcode(parent SKU)/image-filename evidence ONLY — nothing is
// auto-resolved, no fuzzy/title matching of any kind.
// node --conditions=react-server --experimental-strip-types --test lib/export/rafeeq/reconcile.test.ts

import test from "node:test";
import assert from "node:assert/strict";

import { RAFEEQ_NATIVE_HEADERS, NATIVE_COL } from "./native-template.ts";
import {
  parseReturnedSheet,
  skuTokenFromImageName,
  buildReconcilePlan,
  type ReturnedProduct,
  type ReconcileCatalogProduct,
  type ReconcileMappingEvidence,
} from "./reconcile.ts";

// ── fixtures ──────────────────────────────────────────────────────────────────

const cat = (productId: string, sku: string, barcode: string | null = null): ReconcileCatalogProduct => ({ productId, sku, barcode });
const map = (productId: string, sku: string, externalId: string | null, status: "resolved" | "needs_review" = "resolved"): ReconcileMappingEvidence =>
  ({ productId, sku, externalId, status });
let rowSeq = 1;
const ret = (barcode: string | null, rafeeqId: string, imageName = ""): ReturnedProduct =>
  ({ rowNumber: ++rowSeq, barcode, imageName, rafeeqId, rowCount: 1, inconsistentId: false });

/** Build a native AoA row with only the identity cells filled. */
function nativeRow(productId: string, barcode: string, imageName = ""): unknown[] {
  const row: unknown[] = new Array(RAFEEQ_NATIVE_HEADERS.length).fill("");
  row[NATIVE_COL.productId] = productId;
  row[NATIVE_COL.barcode] = barcode;
  row[NATIVE_COL.productImage] = imageName;
  return row;
}

// ── sheet parsing (native template) ───────────────────────────────────────────

test("parseReturnedSheet locates the native columns by HEADER NAME and collapses repeated option rows to ONE product", () => {
  const aoa = [
    [...RAFEEQ_NATIVE_HEADERS],
    nativeRow("691301147", "mk175", "mk175.jpg"), // option row 1
    nativeRow("691301147", "mk175", "mk175.jpg"), // option row 2 — same product
    nativeRow("691301147", "mk175", "mk175.jpg"), // option row 3 — same product
    nativeRow("691300001", "mk42", "mk42.jpg"),   // simple product
    new Array(RAFEEQ_NATIVE_HEADERS.length).fill(""), // blank row skipped
  ];
  const parsed = parseReturnedSheet(aoa);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.products.length, 2, "repeated option rows collapse to one product");
  assert.equal(parsed.products[0].barcode, "mk175");
  assert.equal(parsed.products[0].rafeeqId, "691301147");
  assert.equal(parsed.products[0].rowCount, 3);
  assert.equal(parsed.products[0].inconsistentId, false);
  assert.equal(parsed.products[1].barcode, "mk42");
});

test("repeated rows disagreeing about the product_id are surfaced as inconsistent (refused)", () => {
  const aoa = [
    [...RAFEEQ_NATIVE_HEADERS],
    nativeRow("691301147", "mk175"),
    nativeRow("691309999", "mk175"), // same barcode, DIFFERENT id
  ];
  const parsed = parseReturnedSheet(aoa);
  assert.equal(parsed.products.length, 1);
  assert.equal(parsed.products[0].inconsistentId, true);
  const plan = buildReconcilePlan({ returned: parsed.products, catalog: [cat("p1", "mk175")], mappings: [] });
  assert.equal(plan.entries[0].status, "inconsistent_rows");
  assert.equal(plan.apply.length, 0);
});

test("a sheet without the identity columns is rejected; reordered/extra columns are fine (header-name contract)", () => {
  assert.deepEqual(parseReturnedSheet([["A", "B"], ["1", "2"]]), { ok: false, error: "missing_columns", products: [] });
  assert.deepEqual(parseReturnedSheet([]), { ok: false, error: "empty", products: [] });
  // reordered subset with the identity headers still parses
  const aoa = [
    ["product_id", "EXTRA", "barcode", "product_image"],
    ["691300001", "x", "mk1", "mk1.jpg"],
  ];
  const parsed = parseReturnedSheet(aoa);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.products[0].rafeeqId, "691300001");
});

test("skuTokenFromImageName strips only the extension; Rafeeq asset-JSON blobs yield no token", () => {
  assert.equal(skuTokenFromImageName("mk1001.jpg"), "mk1001");
  assert.equal(skuTokenFromImageName("images/mk1001.jpg"), "mk1001");
  assert.equal(skuTokenFromImageName('{"appbanner":"vendors/x.jpg"}'), null, "platform JSON is never a sku token");
  assert.equal(skuTokenFromImageName(""), null);
});

// ── clean matches (parent grain) ──────────────────────────────────────────────

test("a clean parent-SKU barcode match with no existing mapping plans a PRODUCT-grain INSERT", () => {
  const plan = buildReconcilePlan({
    returned: [ret("mk1001", "691309001", "mk1001.jpg")],
    catalog: [cat("p1", "mk1001", "6291041500213")],
    mappings: [],
  });
  assert.equal(plan.entries[0].status, "matched_insert");
  assert.equal(plan.entries[0].matchedBy, "barcode");
  assert.deepEqual(plan.apply, [{ action: "insert", productId: "p1", variantId: null, sku: "mk1001", barcode: "6291041500213", externalId: "691309001" }]);
});

test("an option product's collapsed rows resolve to the ONE parent product identity", () => {
  const collapsed: ReturnedProduct = { rowNumber: 2, barcode: "mk1822", imageName: "mk1822.jpg", rafeeqId: "691301822", rowCount: 6, inconsistentId: false };
  const plan = buildReconcilePlan({
    returned: [collapsed],
    catalog: [cat("P", "mk1822")],
    mappings: [],
  });
  assert.equal(plan.entries[0].status, "matched_insert");
  assert.equal(plan.entries[0].productId, "P");
  assert.equal(plan.apply[0].variantId, null, "parent grain — never a per-variant identity");
});

test("a clean match against a needs_review mapping plans resolve_needs_review", () => {
  const plan = buildReconcilePlan({
    returned: [ret("mk898", "691309002")],
    catalog: [cat("p898", "mk898")],
    mappings: [map("p898", "mk898", null, "needs_review")],
  });
  assert.equal(plan.entries[0].status, "resolve_needs_review");
  assert.equal(plan.counts.needsReviewResolved, 1);
});

test("a resolved mapping without an id gets a plain update; the same id again is a no-op", () => {
  const plan = buildReconcilePlan({
    returned: [ret("mk1", "691309003"), ret("mk2", "691309004")],
    catalog: [cat("p1", "mk1"), cat("p2", "mk2")],
    mappings: [map("p1", "mk1", null), map("p2", "mk2", "691309004")],
  });
  assert.equal(plan.entries[0].status, "matched_update");
  assert.equal(plan.entries[1].status, "already_mapped");
  assert.equal(plan.apply.length, 1);
});

test("the image-filename sku token is the ONLY fallback (blank barcode), corroborated when both exist", () => {
  // blank barcode, parent-SKU image filename → matched via the image token
  const viaImage = buildReconcilePlan({
    returned: [ret(null, "691309005", "mk7.jpg")],
    catalog: [cat("p7", "mk7")],
    mappings: [],
  });
  assert.equal(viaImage.entries[0].status, "matched_insert");
  assert.equal(viaImage.entries[0].matchedBy, "image_sku");
  // both present and DISAGREEING product evidence ⇒ refused
  const disagree = buildReconcilePlan({
    returned: [ret("mk9", "691309006", "mk7.jpg")],
    catalog: [cat("p7", "mk7")],
    mappings: [],
  });
  assert.equal(disagree.entries[0].status, "barcode_mismatch");
  assert.equal(disagree.apply.length, 0);
});

// ── refusals (nothing auto-resolved) ──────────────────────────────────────────

test("duplicate returned external ids are rejected — every duplicated product is excluded", () => {
  const plan = buildReconcilePlan({
    returned: [ret("mk1", "691309100"), ret("mk2", "691309100"), ret("mk3", "691309101")],
    catalog: [cat("p1", "mk1"), cat("p2", "mk2"), cat("p3", "mk3")],
    mappings: [],
  });
  assert.equal(plan.entries[0].status, "duplicate_external_id");
  assert.equal(plan.entries[1].status, "duplicate_external_id");
  assert.equal(plan.entries[2].status, "matched_insert");
  assert.deepEqual(plan.apply.map((a) => a.externalId), ["691309101"]);
});

test("missing / malformed ids and unknown SKUs are surfaced, never applied", () => {
  const plan = buildReconcilePlan({
    returned: [
      ret("mk1", ""),                    // missing_id
      ret("mk3", "=cmd|9|x"),            // invalid_id (formula lead-in)
      ret("ghost-sku", "691309200"),     // unknown_sku
      ret(null, "691309201"),            // unmatchable (no barcode, no image)
    ],
    catalog: [cat("p1", "mk1"), cat("p3", "mk3")],
    mappings: [],
  });
  assert.deepEqual(
    plan.entries.map((e) => e.status),
    ["missing_id", "invalid_id", "unknown_sku", "unmatchable"],
  );
  assert.equal(plan.apply.length, 0);
});

test("conflicts are refused: id owned by another product, mapping resolved to a different id", () => {
  const plan = buildReconcilePlan({
    returned: [
      ret("mk1", "691309300"),           // id already belongs to p9 → conflict_external_id
      ret("mk2", "691309301"),           // p2 already resolved to another id → conflict_existing_mapping
    ],
    catalog: [cat("p1", "mk1"), cat("p2", "mk2")],
    mappings: [map("p9", "mk9", "691309300"), map("p2", "mk2", "691309999")],
  });
  assert.deepEqual(plan.entries.map((e) => e.status), ["conflict_external_id", "conflict_existing_mapping"]);
  assert.equal(plan.apply.length, 0);
});

test("a parent SKU carried by two catalog products is ambiguous and refused", () => {
  const plan = buildReconcilePlan({
    returned: [ret("mk1", "691309400")],
    catalog: [cat("p1", "mk1"), cat("p1b", "mk1")],
    mappings: [],
  });
  assert.equal(plan.entries[0].status, "ambiguous_sku");
  assert.equal(plan.apply.length, 0);
});

// ── no fuzzy/title evidence at all ────────────────────────────────────────────

test("the reconcile input carries no title/name evidence — matching is barcode/image-filename only", () => {
  const c = cat("p1", "mk1", "6291041500213") as Record<string, unknown>;
  const r = ret("mk1", "691309500", "mk1.jpg") as unknown as Record<string, unknown>;
  for (const k of Object.keys(c)) assert.ok(["productId", "sku", "barcode"].includes(k));
  for (const k of Object.keys(r)) assert.ok(["rowNumber", "barcode", "imageName", "rafeeqId", "rowCount", "inconsistentId"].includes(k));
});
