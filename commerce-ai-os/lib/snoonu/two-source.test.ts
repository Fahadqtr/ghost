// SNOONU TWO-SOURCE SYNC — owner regression proofs (15).
//
// The two files carry different authority and a row's ABSENCE means something
// different in each. These tests pin that asymmetry: BULK can never reach the
// removal path, FULL keeps its removal/new/zero-price/collision behaviour, and
// when the two disagree about stock the disagreement is SURFACED rather than
// silently resolved.
//
// node --conditions=react-server --experimental-strip-types --test lib/snoonu/two-source.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { parseStockCell, type SnoonuCanonicalRecord, type SnoonuListingRecord, type SnoonuSyncRow } from "./sync.ts";
import {
  planSnoonuCombined,
  SNOONU_COMBINED_AUTHORITY,
  SNOONU_BULK_FORBIDDEN,
  SNOONU_STOCK_SOURCE_MISMATCH,
  SNOONU_STOCK_SOURCE_MISMATCH_AR,
  isBulkAuthoritative,
} from "./two-source.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

const SPI_A = "67d388e5b4436ea067f36cb5";
const SPI_B = "67e71be43c4a71b97c93330e";
const SPI_C = "6808a6983675a42ccf1997de";

function row(spi: string, over: Partial<SnoonuSyncRow> = {}): SnoonuSyncRow {
  return {
    rowNum: 2, spi, nameEn: null, nameAr: null, descriptionEn: null, descriptionAr: null,
    sku: null, barcode: null, price: null, availability: null, stockState: null,
    availabilitySource: null, warnings: [], ...over,
  };
}
/** a FULL row states availability via its boolean column. */
const fullRow = (spi: string, available: boolean | null, over: Partial<SnoonuSyncRow> = {}) =>
  row(spi, { availability: available, availabilitySource: available === null ? null : "availability_column", ...over });
/** a BULK row states stock via the store's quantity column. */
const bulkRow = (spi: string, cell: unknown, over: Partial<SnoonuSyncRow> = {}) => {
  const st = parseStockCell(cell);
  return row(spi, { stockState: st, availability: st === null ? null : st === "IN", availabilitySource: st === null ? null : "stock_column", ...over });
};

const product = (id: string, sku: string, over: Partial<SnoonuCanonicalRecord> = {}): SnoonuCanonicalRecord => ({
  id, sku, barcode: null, nameEn: "n", nameAr: "ن", descriptionEn: "d", descriptionAr: "و",
  price: 10, stockStatus: "In Stock", lifecycleState: "ACTIVE", ...over,
});
const listing = (productId: string, externalId: string): SnoonuListingRecord =>
  ({ productId, externalId, mappingStatus: "active", variantGrain: false });

const CANON = [product("p1", "mk1992"), product("p2", "mk1976"), product("p3", "mk1952")];
const LIST = [listing("p1", SPI_A), listing("p2", SPI_B), listing("p3", SPI_C)];
const src = (rows: SnoonuSyncRow[]) => ({ rows, emptySpiRows: [] as number[] });

// ── 1. SPI-only join ────────────────────────────────────────────────────────

test("1. the join is SPI-only — identical SKU/barcode/name never matches across files", () => {
  // same SKU + barcode + name on BOTH sides, but DIFFERENT SPIs.
  const plan = planSnoonuCombined({
    full: src([fullRow(SPI_A, true, { sku: "mk1992", barcode: "111", nameEn: "Same Name" })]),
    bulk: src([bulkRow(SPI_B, "0", { sku: "mk1992", barcode: "111", nameEn: "Same Name" })]),
    canonical: CANON, listings: LIST,
  });
  assert.equal(plan.counts.matchedInBoth, 0, "identical SKU/barcode/name must NOT create a match");
  assert.equal(plan.counts.fullOnly, 1);
  assert.equal(plan.counts.bulkOnly, 1);
  assert.equal(plan.counts.stockMismatches, 0, "no join ⇒ no comparison ⇒ no mismatch");
});

// ── 2/3/4. BULK stock encoding ──────────────────────────────────────────────

test("2. BULK 0 ⇒ OUT of stock", () => {
  assert.equal(parseStockCell(0), "OUT");
  assert.equal(parseStockCell("0"), "OUT");
  const p = planSnoonuCombined({ full: null, bulk: src([bulkRow(SPI_A, "0")]), canonical: CANON, listings: LIST });
  assert.equal(p.counts.bulkOutOfStock, 1);
  assert.equal(p.counts.bulkInStock, 0);
});

test("3. BULK \"unavailable\" ⇒ OUT of stock", () => {
  assert.equal(parseStockCell("unavailable"), "OUT");
  assert.equal(parseStockCell("UNAVAILABLE"), "OUT");
  const p = planSnoonuCombined({ full: null, bulk: src([bulkRow(SPI_A, "unavailable")]), canonical: CANON, listings: LIST });
  assert.equal(p.counts.bulkOutOfStock, 1);
});

test("4. BULK positive quantity ⇒ IN stock; blank/unreadable ⇒ NO stock update", () => {
  for (const v of [1, "1", 7, "100", "49"]) assert.equal(parseStockCell(v), "IN", `${v} is in stock`);
  for (const v of ["", null, undefined, "n/a", "غير معروف"]) assert.equal(parseStockCell(v), null, `${JSON.stringify(v)} states nothing`);
  const p = planSnoonuCombined({
    full: null,
    bulk: src([bulkRow(SPI_A, "100"), bulkRow(SPI_B, ""), bulkRow(SPI_C, "n/a")]),
    canonical: CANON, listings: LIST,
  });
  assert.equal(p.counts.bulkInStock, 1);
  assert.equal(p.counts.bulkOutOfStock, 0);
  const blanks = p.resolutions.filter((r) => r.bulk === null);
  assert.equal(blanks.length, 2, "blank and unreadable state nothing at all");
  assert.ok(blanks.every((r) => r.effective === null), "and therefore drive no stock value");
});

// ── 5/6. absence asymmetry — the core safety rule ───────────────────────────

test("5. BULK absence can NEVER produce a removal — even when it omits the whole catalog", () => {
  // BULK mentions ONE of three mapped products; the other two are absent.
  const p = planSnoonuCombined({
    full: null, bulk: src([bulkRow(SPI_A, "5")]), canonical: CANON, listings: LIST,
  });
  assert.equal(p.counts.removalCandidates, 0, "absence from BULK removes nothing");
  assert.equal(p.bulk?.mode, "PARTIAL", "BULK is planned in PARTIAL mode, always");
  assert.equal(p.bulk?.removals.length, 0);
  assert.equal(p.full, null, "no FULL uploaded ⇒ no removal source exists at all");
  assert.equal(SNOONU_COMBINED_AUTHORITY.removal, "FULL");
  assert.ok(SNOONU_BULK_FORBIDDEN.includes("removal") && SNOONU_BULK_FORBIDDEN.includes("catalog_presence"));
  assert.ok(!isBulkAuthoritative("removal") && !isBulkAuthoritative("catalog_presence"));
});

test("6. FULL absence CAN create a removal candidate — and only FULL can", () => {
  // the SAME one-row coverage, but through the FULL slot this time.
  const p = planSnoonuCombined({
    full: src([fullRow(SPI_A, true)]), bulk: null, canonical: CANON, listings: LIST,
  });
  assert.equal(p.full?.mode, "FULL");
  assert.equal(p.counts.removalCandidates, 2, "the two SPIs absent from FULL are removal candidates");
  assert.deepEqual(p.full?.removals.map((r) => r.spi).sort(), [SPI_C, SPI_B].sort());

  // and the identical coverage through BULK yields zero — proving the source,
  // not the data, decides whether absence means anything.
  const viaBulk = planSnoonuCombined({ full: null, bulk: src([bulkRow(SPI_A, "5")]), canonical: CANON, listings: LIST });
  assert.equal(viaBulk.counts.removalCandidates, 0);
});

// ── 7/8/9/10. stock authority + mismatch visibility ─────────────────────────

test("7. BULK stock overrides FULL Availability operationally when both exist", () => {
  const p = planSnoonuCombined({
    full: src([fullRow(SPI_A, true)]),      // catalog says available
    bulk: src([bulkRow(SPI_A, "0")]),       // bulk says zero on hand
    canonical: CANON, listings: LIST,
  });
  const r = p.resolutions.find((x) => x.spi === SPI_A);
  assert.equal(r?.full, "IN");
  assert.equal(r?.bulk, "OUT");
  assert.equal(r?.effective, "OUT", "the operational value is BULK's");
  assert.equal(r?.source, "BULK");
  assert.equal(SNOONU_COMBINED_AUTHORITY.stock, "BULK");
  assert.ok(isBulkAuthoritative("stock") && isBulkAuthoritative("price") && isBulkAuthoritative("sku") && isBulkAuthoritative("barcode"));
  // FULL keeps the catalog half.
  for (const k of ["catalog_presence", "removal", "name_en", "name_ar", "description_en", "description_ar"] as const) {
    assert.equal(SNOONU_COMBINED_AUTHORITY[k], "FULL", `${k} stays with FULL`);
  }
});

test("8. a disagreement is classified SNOONU_STOCK_SOURCE_MISMATCH with both readings", () => {
  const p = planSnoonuCombined({
    full: src([fullRow(SPI_A, true), fullRow(SPI_B, false)]),
    bulk: src([bulkRow(SPI_A, "0"), bulkRow(SPI_B, "unavailable")]),
    canonical: CANON, listings: LIST,
  });
  assert.equal(p.counts.stockMismatches, 1, "only the genuine disagreement counts");
  assert.equal(p.counts.stockMatches, 1, "agreement (both OUT) is not a mismatch");
  const m = p.mismatches[0];
  assert.equal(m.spi, SPI_A);
  assert.equal(m.code, SNOONU_STOCK_SOURCE_MISMATCH);
  assert.equal(m.messageAr, SNOONU_STOCK_SOURCE_MISMATCH_AR);
  assert.equal(m.messageAr, "اختلاف حالة التوفر بين ملف الكتالوج وملف Bulk");
  assert.equal(m.full, "IN");
  assert.equal(m.bulk, "OUT");
});

test("9. the mismatch is VISIBLE in the preview — both values side by side, in the UI", () => {
  const p = planSnoonuCombined({
    full: src([fullRow(SPI_A, true)]), bulk: src([bulkRow(SPI_A, "0")]), canonical: CANON, listings: LIST,
  });
  const m = p.mismatches[0];
  // the plan carries BOTH readings, labelled, not just the winner.
  assert.equal(m.fullLabel, "متوفر");
  assert.equal(m.bulkLabel, "غير متوفر");
  assert.ok(m.fullRowNum > 0 && m.bulkRowNum > 0, "each side is traceable to its row");
  // and the client surface actually renders them.
  const ui = read("components/v2/catalog/SnoonuSync.tsx");
  assert.ok(ui.includes("SNOONU_STOCK_SOURCE_MISMATCH_AR"), "the Arabic classification is shown");
  assert.ok(ui.includes("m.fullLabel") && ui.includes("m.bulkLabel"), "BOTH values are rendered");
  assert.ok(ui.includes("ملف الكتالوج") && ui.includes("ملف Bulk"), "each column is labelled by source");
  assert.ok(ui.includes("combined.plan.counts.stockMismatches"), "the mismatch count is a preview card");
});

test("10. no silent stock choice — every resolution names its source", () => {
  const p = planSnoonuCombined({
    full: src([fullRow(SPI_A, true), fullRow(SPI_B, true), fullRow(SPI_C, false)]),
    bulk: src([bulkRow(SPI_A, "0"), bulkRow(SPI_B, "9")]),
    canonical: CANON, listings: LIST,
  });
  for (const r of p.resolutions) {
    if (r.effective !== null) assert.ok(r.source === "BULK" || r.source === "FULL", `${r.spi} must name its source`);
    // a disagreement is never merely resolved — it is also reported.
    if (r.mismatch) assert.ok(p.mismatches.some((m) => m.spi === r.spi), `${r.spi} disagreement must surface`);
  }
  assert.equal(p.mismatches.length, 1);
  // SPI_C is FULL-only: its source is FULL, and that is stated, not assumed.
  const c = p.resolutions.find((x) => x.spi === SPI_C);
  assert.equal(c?.source, "FULL");
  assert.equal(c?.bulk, null);
  assert.equal(c?.mismatch, false, "one-sided data is not a disagreement");
});

// ── 11/12/13. FULL behaviours are preserved ─────────────────────────────────

test("11. FULL-only NEW product behaviour is preserved", () => {
  const NEW_SPI = "6a78d7c6664c24f7a3f9be34";
  const p = planSnoonuCombined({
    full: src([fullRow(SPI_A, true), fullRow(NEW_SPI, true, { nameEn: "Brand New", price: 25 })]),
    bulk: src([bulkRow(SPI_A, "5")]),
    canonical: CANON, listings: LIST,
  });
  assert.equal(p.counts.newProducts, 1, "an unmapped SPI in FULL is NEW");
  assert.equal(p.full?.news[0]?.spi, NEW_SPI);
  // BULK never creates products, whatever it contains.
  const bulkOnly = planSnoonuCombined({
    full: null, bulk: src([bulkRow(NEW_SPI, "5", { nameEn: "Brand New" })]), canonical: CANON, listings: LIST,
  });
  assert.equal(bulkOnly.counts.newProducts, 0, "catalog presence is FULL's alone");
});

test("12. zero-price review safety is preserved (never auto-accepted)", () => {
  const p = planSnoonuCombined({
    full: src([fullRow(SPI_A, true, { price: 0 })]), bulk: null, canonical: CANON, listings: LIST,
  });
  assert.equal(p.counts.zeroPriceReviews, 1, "a zero price is held for review");
  const z = p.full?.zeroPriceReviews[0];
  assert.equal(z?.spi, SPI_A);
  // the price change is NOT silently applied alongside the review.
  assert.ok(!p.full?.matched.some((m) => m.spi === SPI_A && m.changes.some((c) => c.field === "price")),
    "a zero price never becomes an automatic price change");
});

test("13. identity-collision safety is preserved (never auto-resolved)", () => {
  // SPI_A's row claims a SKU that already belongs to a DIFFERENT product.
  const p = planSnoonuCombined({
    full: src([fullRow(SPI_A, true, { sku: "mk1976" })]), bulk: null, canonical: CANON, listings: LIST,
  });
  assert.equal(p.counts.identityCollisions, 1);
  const c = p.full?.identityCollisions[0];
  assert.equal(c?.spi, SPI_A);
  assert.equal(c?.identifier, "sku", "the colliding identifier KIND");
  assert.equal(c?.proposed.sku, "mk1976", "the value the workbook proposed");
  assert.equal(c?.colliding.productId, "p2", "the owning product is named, not overwritten");
  assert.ok(!p.full?.matched.some((m) => m.spi === SPI_A && m.changes.some((x) => x.field === "sku")),
    "no automatic SKU reassignment");
});

// ── 14/15. the combined preview is inert ────────────────────────────────────

test("14. the combined preview is READ-ONLY and deterministic", () => {
  const mk = () => planSnoonuCombined({
    full: src([fullRow(SPI_A, true)]), bulk: src([bulkRow(SPI_A, "0")]), canonical: CANON, listings: LIST,
  });
  assert.equal(mk().fingerprint, mk().fingerprint, "same inputs ⇒ same fingerprint (no clock, no randomness)");

  const pure = read("lib/snoonu/two-source.ts");
  for (const banned of [".update(", ".insert(", ".upsert(", ".delete(", "createAdminClient", "Date.now" + "(", "Math.random" + "("]) {
    assert.ok(!pure.includes(banned), `the pure planner must not contain ${banned}`);
  }
  const server = read("lib/snoonu/two-source.server.ts");
  for (const banned of [".update(", ".insert(", ".upsert(", ".delete(", "applySnoonuSyncPlan", "applySnoonuRepair"]) {
    assert.ok(!server.includes(banned), `the combined server adapter must not contain ${banned}`);
  }
  assert.ok(server.includes("loadSnoonuSyncContext"), "it only READS the catalog");
});

test("15. nothing in the combined path can write — no apply is reachable from it", () => {
  const actions = read("app/(v2)/v2/catalog/snoonu-sync/actions.ts");
  const start = actions.indexOf("export async function previewSnoonuCombinedAction");
  assert.ok(start > 0, "the combined action exists");
  const slice = actions.slice(start, actions.indexOf("// ── SCOPED REPAIR", start));
  for (const banned of ["applySnoonuSyncPlan", "applySnoonuRepair", ".update(", ".insert(", ".upsert(", ".delete("]) {
    assert.ok(!slice.includes(banned), `the combined preview action must not reach ${banned}`);
  }
  assert.ok(slice.includes("previewSnoonuCombined"), "it calls the read-only preview only");
  // the return-file builders keep each workbook on its OWN schema.
  const sync = read("lib/snoonu/sync.ts");
  assert.ok(sync.includes("SNOONU_RETURN_HEADERS"), "the FULL return workbook keeps the FULL schema");
  const pure = read("lib/snoonu/two-source.ts");
  assert.ok(!pure.includes("SNOONU_RETURN_HEADERS") && !pure.includes("buildSnoonuReturnAoa"),
    "the combined planner never rewrites either workbook's schema");
});
