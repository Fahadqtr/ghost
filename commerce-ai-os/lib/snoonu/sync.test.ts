// SNOONU CATALOG SYNC — owner regression proofs 1–15 (pure plan engine).
// node --conditions=react-server --experimental-strip-types --test lib/snoonu/sync.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import {
  detectSnoonuSyncColumns,
  parseSnoonuSyncRows,
  planSnoonuSync,
  buildSnoonuReturnAoa,
  pendingSkuForSpi,
  isPendingSku,
  availabilityToStockStatus,
  SNOONU_RETURN_HEADERS,
  SNOONU_SYNC_FIELD_LABEL,
  type SnoonuCanonicalRecord,
  type SnoonuListingRecord,
  type SnoonuSyncRow,
} from "./sync.ts";

const HEADERS = [
  "SPI(UniqueIdentifier)",
  "Product Name (En)(Update)",
  "Product Name (Ar)(Update)",
  "Product Description (En)(Update)",
  "Product Description (Ar)(Update)",
  "SKU(Update)",
  "Barcode(Update)",
  "Price Global(Update)",
  "Availability for Malikas Universe Beauty Ali Bin Abdullah Street(Update)",
];

const SPI_A = "69e40de66040178fae1cc001";
const SPI_B = "69e40de66040178fae1cc002";
const SPI_C = "69e40de66040178fae1cc003";
const SPI_NEW = "69e40de66040178fae1cc999";

function product(id: string, sku: string, over: Partial<SnoonuCanonicalRecord> = {}): SnoonuCanonicalRecord {
  return {
    id, sku, barcode: "6291041500213",
    nameEn: `Product ${sku}`, nameAr: `منتج ${sku}`,
    descriptionEn: "en", descriptionAr: "ar",
    price: 100, stockStatus: "In Stock", lifecycleState: "ACTIVE",
    ...over,
  };
}
function listing(productId: string, externalId: string, over: Partial<SnoonuListingRecord> = {}): SnoonuListingRecord {
  return { productId, externalId, mappingStatus: "active", variantGrain: false, ...over };
}
function row(spi: string, over: Partial<SnoonuSyncRow> = {}): SnoonuSyncRow {
  return {
    rowNum: 2, spi, nameEn: null, nameAr: null, descriptionEn: null, descriptionAr: null,
    sku: null, barcode: null, price: null, availability: null, warnings: [], ...over,
  };
}
const base = () => ({
  canonical: [product("p1", "mk10"), product("p2", "mk20"), product("p3", "mk30")],
  listings: [listing("p1", SPI_A), listing("p2", SPI_B), listing("p3", SPI_C)],
  emptySpiRows: [] as number[],
});

test("column detection: SPI is primary, every (Update) column maps, availability is التوفر في سنونو — never غير مستخدم", () => {
  const cols = detectSnoonuSyncColumns(HEADERS);
  assert.deepEqual(
    cols.map((c) => c.field),
    ["spi", "name_en", "name_ar", "description_en", "description_ar", "sku", "barcode", "price", "availability"],
  );
  assert.ok(cols.every((c) => c.status === "auto"), "all nine columns auto-recognized");
  assert.equal(SNOONU_SYNC_FIELD_LABEL.availability, "التوفر في سنونو / حالة التوفر");
});

test("1: Availability=True → canonical AVAILABLE (In Stock)", () => {
  const plan = planSnoonuSync({ ...base(), rows: [row(SPI_A, { availability: true })], canonical: [product("p1", "mk10", { stockStatus: "Out of Stock" })].concat([product("p2", "mk20"), product("p3", "mk30")]) });
  const m = plan.matched.find((x) => x.spi === SPI_A)!;
  assert.deepEqual(m.changes, [{ field: "availability", from: "Out of Stock", to: "In Stock" }]);
  assert.equal(availabilityToStockStatus(true), "In Stock");
  assert.equal(plan.counts.availabilityFalseToTrue, 1);
});

test("2: Availability=False → unavailable — NEVER an archive/removal", () => {
  const plan = planSnoonuSync({ ...base(), rows: [row(SPI_A, { availability: false }), row(SPI_B, { availability: true }), row(SPI_C, { availability: true })] });
  const m = plan.matched.find((x) => x.spi === SPI_A)!;
  assert.deepEqual(m.changes, [{ field: "availability", from: "In Stock", to: "Out of Stock" }]);
  assert.equal(plan.counts.availabilityTrueToFalse, 1);
  assert.equal(plan.removals.length, 0, "availability=false does not remove/archive anything");
});

test("3: a row with blank SKU AND blank barcode is still a NEW product — classified WAITING FOR SKU/BARCODE", () => {
  const plan = planSnoonuSync({ ...base(), rows: [row(SPI_A), row(SPI_B), row(SPI_C), row(SPI_NEW, { nameEn: "New Serum", price: 55, availability: true })] });
  assert.equal(plan.news.length, 1);
  const n = plan.news[0];
  assert.equal(n.spi, SPI_NEW);
  assert.equal(n.klass, "NEW_WAITING_SKU_BARCODE");
  assert.equal(n.blocked, null, "blank identifiers never block creation");
  assert.equal(plan.counts.newProducts, 1);
  assert.equal(plan.counts.newMissingBoth, 1);
  assert.ok(isPendingSku(pendingSkuForSpi(SPI_NEW)), "the stored sentinel is explicitly a pending marker");
});

test("4+5: blank Excel SKU/barcode NEVER erase real canonical identifiers", () => {
  const plan = planSnoonuSync({ ...base(), rows: [row(SPI_A, { sku: "   ", barcode: "" }), row(SPI_B, { sku: null, barcode: null }), row(SPI_C)] });
  for (const m of [...plan.matched, ...plan.unchanged]) {
    assert.ok(!m.changes.some((c) => c.field === "sku"), "no sku change from blank");
    assert.ok(!m.changes.some((c) => c.field === "barcode"), "no barcode change from blank");
  }
  assert.equal(plan.counts.skuChanges, 0);
  assert.equal(plan.counts.barcodeChanges, 0);
});

test("6: the later SPI+SKU/Barcode workbook updates the SAME product (sentinel replaced, price path intact)", () => {
  // after the first apply, the NEW product exists with a pending sentinel SKU
  // and an active SPI listing — the second workbook matches by SPI.
  const created = product("p9", pendingSkuForSpi(SPI_NEW), { barcode: null, nameEn: "New Serum", price: 55 });
  const plan = planSnoonuSync({
    canonical: [...base().canonical, created],
    listings: [...base().listings, listing("p9", SPI_NEW)],
    emptySpiRows: [],
    rows: [row(SPI_A), row(SPI_B), row(SPI_C), row(SPI_NEW, { sku: "mk3001", barcode: "6291041509999", price: 60 })],
  });
  assert.equal(plan.news.length, 0, "no duplicate creation — SPI matched the existing product");
  const m = plan.matched.find((x) => x.spi === SPI_NEW)!;
  assert.deepEqual(m.changes.map((c) => [c.field, c.to]).sort(), [["barcode", "6291041509999"], ["price", "60"], ["sku", "mk3001"]]);
  const skuChange = m.changes.find((c) => c.field === "sku")!;
  assert.equal(skuChange.from, null, "the pending sentinel is presented as MISSING, not as a real prior SKU");
});

test("7: a mapped Snoonu SPI absent from the workbook → REMOVED FROM SNOONU, listed explicitly", () => {
  const plan = planSnoonuSync({ ...base(), rows: [row(SPI_A), row(SPI_B)] }); // SPI_C absent
  assert.equal(plan.removals.length, 1);
  assert.deepEqual(plan.removals[0], { productId: "p3", spi: SPI_C, productSku: "mk30", displayName: "Product mk30" });
  assert.equal(plan.counts.removedFromSnoonu, 1);
});

test("8: an UNMAPPED canonical product absent from the workbook is NOT removed", () => {
  const plan = planSnoonuSync({
    canonical: [...base().canonical, product("p4", "mk40")], // p4 has NO snoonu listing
    listings: base().listings,
    emptySpiRows: [],
    rows: [row(SPI_A), row(SPI_B), row(SPI_C)],
  });
  assert.equal(plan.removals.length, 0, "unmapped products are untouched");
});

test("8b: needs_review and non-SPI-shaped mappings never trigger removal (fail closed)", () => {
  const plan = planSnoonuSync({
    canonical: base().canonical,
    listings: [
      listing("p1", SPI_A),
      listing("p2", SPI_B, { mappingStatus: "needs_review" }), // absent but needs_review
      listing("p3", "mk30"), // placeholder external id — not SPI-shaped
    ],
    emptySpiRows: [],
    rows: [row(SPI_A)],
  });
  assert.equal(plan.removals.length, 0, "neither needs_review nor placeholder mappings are removed");
});

test("9: an SPI mapped to more than one product FAILS CLOSED as a conflict", () => {
  const plan = planSnoonuSync({
    canonical: base().canonical,
    listings: [listing("p1", SPI_A), listing("p2", SPI_A), listing("p3", SPI_C)],
    emptySpiRows: [],
    rows: [row(SPI_A, { availability: false }), row(SPI_C)],
  });
  assert.equal(plan.matched.length + plan.unchanged.filter((u) => u.spi === SPI_A).length, 0, "the ambiguous row updates nothing");
  assert.equal(plan.conflicts.filter((c) => c.spi === SPI_A).length, 1);
  assert.equal(plan.counts.conflicts >= 1, true);
});

test("10: a duplicate SPI inside the workbook BLOCKS the whole apply", () => {
  const plan = planSnoonuSync({ ...base(), rows: [row(SPI_A, { availability: false }), row(SPI_A, { rowNum: 3, availability: true }), row(SPI_B), row(SPI_C)] });
  assert.equal(plan.applyBlocked, true);
  assert.deepEqual(plan.duplicateSpis, [SPI_A.toLowerCase()]);
  assert.equal(plan.matched.length, 0, "duplicate rows are excluded from the plan, not merged");
});

test("11: price updates flow through the same audited plan", () => {
  const plan = planSnoonuSync({ ...base(), rows: [row(SPI_A, { price: 125.5 }), row(SPI_B), row(SPI_C)] });
  const m = plan.matched.find((x) => x.spi === SPI_A)!;
  assert.deepEqual(m.changes, [{ field: "price", from: "100", to: "125.5" }]);
  assert.equal(plan.counts.priceChanges, 1);
});

test("12: planning is pure and write-free — inputs are not mutated, output is deterministic", () => {
  const input = { ...base(), rows: [row(SPI_A, { price: 125 }), row(SPI_B), row(SPI_C)] };
  const snapshot = JSON.stringify(input);
  const a = planSnoonuSync(input);
  const b = planSnoonuSync(input);
  assert.equal(JSON.stringify(input), snapshot, "inputs untouched");
  assert.equal(a.fingerprint, b.fingerprint, "same input → same fingerprint (apply verifies it)");
  const src = String(planSnoonuSync);
  for (const bad of ["fetch(", ".insert(", ".update(", ".delete(", ".rpc("]) assert.ok(!src.includes(bad), `no I/O in the planner (${bad})`);
});

test("13/14 shape: content updates diff exactly; second-upload matching can never duplicate (SPI is the only creation key)", () => {
  const plan = planSnoonuSync({ ...base(), rows: [row(SPI_A, { nameEn: "Renamed", descriptionAr: "وصف جديد" }), row(SPI_B), row(SPI_C)] });
  const m = plan.matched.find((x) => x.spi === SPI_A)!;
  assert.deepEqual(m.changes.map((c) => c.field).sort(), ["description_ar", "name_en"]);
  assert.equal(plan.counts.contentChanges, 1);
  // creation is keyed EXCLUSIVELY by "no active listing for the SPI":
  assert.equal(plan.news.length, 0, "every listed SPI matched — nothing creates");
});

test("15: the return/update workbook preserves the exact Snoonu schema and never invents values", () => {
  const aoa = buildSnoonuReturnAoa([
    { spi: SPI_NEW, product: product("p9", pendingSkuForSpi(SPI_NEW), { barcode: null, price: null, stockStatus: null }) },
    { spi: SPI_A, product: product("p1", "mk10", { stockStatus: "Out of Stock" }) },
  ]);
  assert.deepEqual(aoa[0], [...SNOONU_RETURN_HEADERS], "header row is the Snoonu template verbatim");
  const pending = aoa[1];
  assert.equal(pending[0], SPI_NEW);
  assert.equal(pending[5], "", "a PENDING sentinel SKU exports as BLANK — never sent to Snoonu");
  assert.equal(pending[6], "", "missing barcode stays blank — never invented");
  assert.equal(pending[8], "", "unknown availability stays blank");
  const real = aoa[2];
  assert.deepEqual([real[0], real[5], real[6], real[7], real[8]], [SPI_A, "mk10", "6291041500213", 100, "False"]);
});

test("counts: the exact owner-required census over a mixed workbook", () => {
  const rows = [
    row(SPI_A, { availability: false }),           // TRUE->FALSE
    row(SPI_B, { price: 70 }),                     // price change
    row(SPI_C),                                    // unchanged
    row(SPI_NEW, { nameAr: "منتج جديد" }),         // NEW missing both
  ];
  const plan = planSnoonuSync({ ...base(), rows, emptySpiRows: [9] });
  assert.deepEqual(plan.counts, {
    totalExcelRows: 5,
    matchedExisting: 3,
    unchanged: 1,
    availabilityTrueToFalse: 1,
    availabilityFalseToTrue: 0,
    priceChanges: 1,
    contentChanges: 0,
    skuChanges: 0,
    barcodeChanges: 0,
    newProducts: 1,
    newMissingSku: 1,
    newMissingBarcode: 1,
    newMissingBoth: 1,
    removedFromSnoonu: 0,
    conflicts: 0,
    blocked: 1,
  });
});

test("parsing: availability/price cells coerce safely; blank-SPI rows are surfaced, never guessed", () => {
  const aoa = [
    HEADERS,
    [SPI_A, "Name", "", "", "", "", "", "99.5", "TRUE"],
    ["", "Ghost row", "", "", "", "", "", "", "True"],
    [SPI_B, "", "", "", "", " mk20 ", " 6291041500213 ", "not-a-price", "FALSE"],
  ];
  const cols = detectSnoonuSyncColumns(HEADERS);
  const { rows, emptySpiRows } = parseSnoonuSyncRows(aoa, cols);
  assert.deepEqual(emptySpiRows, [3]);
  assert.equal(rows[0].availability, true);
  assert.equal(rows[0].price, 99.5);
  assert.equal(rows[1].availability, false);
  assert.equal(rows[1].price, null);
  assert.ok(rows[1].warnings.includes("سعر غير مقروء"));
  assert.equal(rows[1].sku, "mk20", "identifier cells are trimmed");
});
