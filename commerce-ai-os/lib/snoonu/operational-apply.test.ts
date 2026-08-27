// SNOONU COMBINED OPERATIONAL APPLY — owner regression proofs (10).
//
// The combined apply is the OPERATIONAL half of the two-source model: BULK
// decides stock / price / SKU / barcode, and nothing else may travel this
// path. These tests pin the write boundary from both sides — what the plan
// emits, and what the server module is even capable of calling.
//
// node --conditions=react-server --experimental-strip-types --test lib/snoonu/operational-apply.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { parseStockCell, type SnoonuCanonicalRecord, type SnoonuListingRecord, type SnoonuSyncRow } from "./sync.ts";
import {
  planSnoonuCombined,
  selectSnoonuOperationalApply,
  SNOONU_OPERATIONAL_FIELDS,
  SNOONU_CONTENT_FIELDS,
  isOperationalField,
} from "./two-source.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
/** Source with comments stripped — these guards assert on CODE, so prose that
 *  merely NAMES a banned symbol (the write-boundary comment does, on purpose)
 *  can never satisfy or break them. */
const code = (rel: string) =>
  read(rel).replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
const SERVER = "lib/snoonu/two-source.server.ts";

const SPI_A = "67d388e5b4436ea067f36cb5";
const SPI_B = "67e71be43c4a71b97c93330e";
const SPI_C = "6808a6983675a42ccf1997de";
const SPI_NEW = "6a78d7c6664c24f7a3f9be34";

function row(spi: string, over: Partial<SnoonuSyncRow> = {}): SnoonuSyncRow {
  return { rowNum: 2, spi, nameEn: null, nameAr: null, descriptionEn: null, descriptionAr: null,
    sku: null, barcode: null, price: null, availability: null, stockState: null,
    availabilitySource: null, warnings: [], ...over };
}
const fullRow = (spi: string, available: boolean | null, over: Partial<SnoonuSyncRow> = {}) =>
  row(spi, { availability: available, availabilitySource: available === null ? null : "availability_column", ...over });
const bulkRow = (spi: string, cell: unknown, over: Partial<SnoonuSyncRow> = {}) => {
  const st = parseStockCell(cell);
  return row(spi, { stockState: st, availability: st === null ? null : st === "IN",
    availabilitySource: st === null ? null : "stock_column", ...over });
};
const product = (id: string, sku: string, over: Partial<SnoonuCanonicalRecord> = {}): SnoonuCanonicalRecord => ({
  id, sku, barcode: null, nameEn: "Canonical EN", nameAr: "الاسم", descriptionEn: "desc", descriptionAr: "وصف",
  price: 10, stockStatus: "In Stock", lifecycleState: "ACTIVE", ...over });
const listing = (productId: string, externalId: string): SnoonuListingRecord =>
  ({ productId, externalId, mappingStatus: "active", variantGrain: false });

const CANON = [product("p1", "mk1992"), product("p2", "mk1976"), product("p3", "mk1952")];
const LIST = [listing("p1", SPI_A), listing("p2", SPI_B), listing("p3", SPI_C)];
const src = (rows: SnoonuSyncRow[]) => ({ rows, emptySpiRows: [] as number[] });
const build = (full: SnoonuSyncRow[] | null, bulk: SnoonuSyncRow[] | null, canonical = CANON) =>
  selectSnoonuOperationalApply(planSnoonuCombined({
    full: full ? src(full) : null, bulk: bulk ? src(bulk) : null, canonical, listings: LIST,
  }));

// ── 1. BULK stock is what the apply writes ──────────────────────────────────

test("1. the combined apply uses BULK stock — not FULL availability", () => {
  // FULL says available on every row; BULK contradicts two of them.
  const plan = build(
    [fullRow(SPI_A, true), fullRow(SPI_B, true), fullRow(SPI_C, true)],
    [bulkRow(SPI_A, "0"), bulkRow(SPI_B, "unavailable"), bulkRow(SPI_C, "12")],
  );
  const bySpi = new Map(plan.rows.map((r) => [r.spi, r]));
  assert.equal(bySpi.get(SPI_A)?.stockTo, "Out of Stock", "0 ⇒ OUT, over FULL's available");
  assert.equal(bySpi.get(SPI_B)?.stockTo, "Out of Stock", "unavailable ⇒ OUT, over FULL's available");
  // p3 is already In Stock canonically, so a positive quantity is a no-change.
  assert.equal(plan.counts.stockToOut, 2);
  assert.equal(plan.counts.stockToIn, 0);

  // and a genuine IN transition IS emitted when canonical is currently out.
  const backIn = build(null, [bulkRow(SPI_A, "7")], [product("p1", "mk1992", { stockStatus: "Out of Stock" }), CANON[1], CANON[2]]);
  assert.equal(backIn.counts.stockToIn, 1);
  assert.equal(backIn.rows[0]?.stockTo, "In Stock");

  // blank / unreadable never produce a stock write.
  const blank = build(null, [bulkRow(SPI_A, ""), bulkRow(SPI_B, "n/a")]);
  assert.equal(blank.counts.stockToIn + blank.counts.stockToOut, 0, "blank/unreadable ⇒ no stock change");
});

// ── 2. FULL content never travels this path ─────────────────────────────────

test("2. FULL content is NOT written by the combined apply", () => {
  const plan = build(
    [fullRow(SPI_A, true, { nameEn: "FULL New Name", nameAr: "اسم جديد", descriptionEn: "FULL desc" })],
    [bulkRow(SPI_A, "0", { nameEn: "BULK Name", nameAr: "اسم Bulk" })],
  );
  // the combined preview still REPORTS FULL content changes...
  const combined = planSnoonuCombined({
    full: src([fullRow(SPI_A, true, { nameEn: "FULL New Name", nameAr: "اسم جديد", descriptionEn: "FULL desc" })]),
    bulk: src([bulkRow(SPI_A, "0", { nameEn: "BULK Name" })]), canonical: CANON, listings: LIST,
  });
  assert.ok(combined.counts.contentChanges > 0, "content changes are still SURFACED in the preview");
  // ...but the operational plan carries no content field at all.
  for (const r of plan.rows) {
    for (const k of Object.keys(r)) assert.ok(!["nameEn", "nameAr", "descriptionEn", "descriptionAr"].includes(k));
  }
  for (const f of SNOONU_CONTENT_FIELDS) assert.ok(!isOperationalField(f), `${f} is never operational`);
  assert.deepEqual([...SNOONU_OPERATIONAL_FIELDS], ["availability", "price", "sku", "barcode"]);
  // and the writer literally cannot set a content column.
  const server = code(SERVER);
  for (const col of ["name_en", "name_ar", "description_en", "description_ar", "category"]) {
    assert.ok(!server.includes(col), `the operational server must never write ${col}`);
  }
});

// ── 3. absence never removes ────────────────────────────────────────────────

test("3. BULK absence creates NO removal", () => {
  // BULK covers one of three mapped products.
  const plan = build(null, [bulkRow(SPI_A, "0")]);
  assert.equal(plan.counts.removals, 0);
  assert.equal(plan.rows.length, 1, "only the row physically present is touched");
  // even alongside a FULL file that WOULD classify removals.
  const withFull = planSnoonuCombined({
    full: src([fullRow(SPI_A, true)]), bulk: src([bulkRow(SPI_A, "0")]), canonical: CANON, listings: LIST,
  });
  assert.ok(withFull.counts.removalCandidates > 0, "FULL still surfaces its own removal candidates");
  assert.equal(selectSnoonuOperationalApply(withFull).counts.removals, 0,
    "but the OPERATIONAL apply carries none of them");
  const server = code(SERVER);
  assert.ok(server.includes('error: "removal_guard"'), "a removal fails the whole run closed");
  assert.ok(!server.includes("transitionProductLifecycle") && !server.includes("lifecycle_state"),
    "no lifecycle writer is reachable");
});

// ── 4/5. blocked rows ───────────────────────────────────────────────────────

test("4. zero-price rows are BLOCKED unless the owner explicitly approves them", () => {
  const plan = build(null, [bulkRow(SPI_A, "5", { price: 0 })]);
  assert.equal(plan.counts.blockedZeroPrice, 1);
  assert.equal(plan.blockedZeroPrice[0]?.spi, SPI_A);
  assert.ok(!plan.rows.some((r) => r.price === 0), "a zero price is never an automatic change");
  assert.equal(plan.counts.priceChanges, 0);
  const server = code(SERVER);
  assert.ok(server.includes("zeroPriceOverrides"), "only an explicit override list can write a zero");
  assert.ok(server.includes("if (!review) continue;"), "and only for a row the REBUILT plan flagged");
});

test("5. identity collisions never write identifiers", () => {
  // the row claims a SKU owned by a different product.
  const plan = build(null, [bulkRow(SPI_A, "5", { sku: "mk1976" })]);
  assert.equal(plan.counts.blockedIdentityCollisions, 1);
  assert.equal(plan.blockedIdentityCollisions[0]?.colliding.productId, "p2");
  assert.equal(plan.counts.skuChanges, 0, "the colliding SKU is NOT applied");
  assert.ok(!plan.rows.some((r) => r.sku === "mk1976"));
  // a clean identifier still flows.
  const ok = build(null, [bulkRow(SPI_A, "5", { barcode: "999888777" })]);
  assert.equal(ok.counts.barcodeChanges, 1);
  assert.equal(ok.rows[0]?.barcode, "999888777");
});

// ── 6/7. apply-time protection ──────────────────────────────────────────────

test("6. the server REBUILDS the plan and refuses on fingerprint drift", () => {
  const server = code(SERVER);
  const start = server.indexOf("export async function applySnoonuOperational");
  const body = server.slice(start);
  assert.ok(body.indexOf("planSnoonuCombined(") > 0, "the plan is rebuilt server-side");
  assert.ok(body.indexOf("selectSnoonuOperationalApply(") > 0);
  assert.ok(body.includes('if (plan.fingerprint !== input.expectedFingerprint) return { ok: false, error: "plan_changed" };'),
    "drift fails closed");
  // the rebuild must happen BEFORE any write.
  const firstWrite = Math.min(...[".update(", "writeProductAvailability("].map((w) => {
    const i = body.indexOf(w); return i < 0 ? Number.MAX_SAFE_INTEGER : i;
  }));
  assert.ok(body.indexOf("planSnoonuCombined(") < firstWrite, "rebuild precedes every write");
  assert.ok(body.indexOf("expectedFingerprint") < firstWrite, "so does the fingerprint check");

  // drift is real: a changed catalog changes the fingerprint.
  const a = build(null, [bulkRow(SPI_A, "0")]);
  // p1 is ALREADY out of stock ⇒ the same BULK row now yields no transition,
  // so the rebuilt plan — and its fingerprint — genuinely differ.
  const b = selectSnoonuOperationalApply(planSnoonuCombined({
    full: null, bulk: src([bulkRow(SPI_A, "0")]),
    canonical: [product("p1", "mk1992", { stockStatus: "Out of Stock" }), CANON[1], CANON[2]], listings: LIST,
  }));
  assert.equal(b.counts.stockToOut, 0, "the catalog moved, so the plan moved");
  assert.notEqual(a.fingerprint, b.fingerprint, "a catalog change moves the fingerprint");
  assert.equal(a.fingerprint, build(null, [bulkRow(SPI_A, "0")]).fingerprint, "and is otherwise stable");
});

test("7. the apply is OWNER-gated behind an explicit confirmation", () => {
  const actions = read("app/(v2)/v2/catalog/snoonu-sync/actions.ts");
  const start = actions.indexOf("export async function applySnoonuOperationalAction");
  assert.ok(start > 0);
  const body = actions.slice(start, actions.indexOf("// ── SCOPED REPAIR", start));
  assert.ok(body.includes("await requireOwner()"), "OWNER only — a writer is not enough");
  assert.ok(body.indexOf("requireOwner") < body.indexOf("applySnoonuOperational("), "gated before any work");
  // the preview action stays at writer level; only the apply is owner-gated.
  const preview = actions.slice(actions.indexOf("export async function previewSnoonuCombinedAction"));
  assert.ok(preview.slice(0, 400).includes("requireMalakWriter"));

  const ui = read("components/v2/catalog/SnoonuSync.tsx");
  assert.ok(ui.includes("تطبيق التحديث التشغيلي من Bulk"), "the owner button exists, with the exact label");
  assert.ok(ui.includes("setOpConfirm(true)"), "the button opens a confirmation rather than applying");
  assert.ok(ui.includes("تأكيد التطبيق"), "a second explicit confirmation runs it");
  assert.ok(ui.includes("{isOwner && operational"), "the whole block is owner-only");
  // the confirmation breaks the counts out SEPARATELY.
  for (const line of ["counts.stockToOut", "counts.stockToIn", "counts.priceChanges",
                      "counts.skuChanges", "counts.barcodeChanges", "counts.blockedZeroPrice",
                      "counts.blockedIdentityCollisions", "counts.removals"]) {
    assert.ok(ui.includes(`operational.${line}`), `the confirmation shows ${line} separately`);
  }
  assert.ok(ui.includes("لا حذف إطلاقاً"), "and states plainly that nothing is removed");
});

// ── 8/9. what the writer cannot do ──────────────────────────────────────────

test("8. no product is ever created from BULK", () => {
  // an unmapped SPI present ONLY in BULK.
  const plan = build(null, [bulkRow(SPI_NEW, "5", { sku: "mkNEW", barcode: "123" })]);
  assert.equal(plan.rows.length, 0, "an unmapped SPI produces no operational row");
  assert.equal(plan.counts.rows, 0);
  const server = code(SERVER);
  for (const banned of ["createProductCore", 'from("products").insert', "makeInventoryInitializer"]) {
    assert.ok(!server.includes(banned), `the operational server must not reach ${banned}`);
  }
});

test("9. no lifecycle or listing write is reachable", () => {
  const server = code(SERVER);
  assert.ok(!server.includes("external_channel_listings"), "listings are never written or archived");
  assert.ok(!server.includes("mapping_status"), "no mapping status is touched");
  assert.ok(!server.includes("transitionProductLifecycle"), "no lifecycle transition");
  // the COMPLETE write boundary: product updates, the availability engine, the audit.
  const updates = [...server.matchAll(/\.update\(/g)].length;
  assert.equal(updates, 2, "exactly two update sites: operational fields + the approved zero price");
  const inserts = [...server.matchAll(/\.insert\(/g)].length;
  assert.equal(inserts, 1, "exactly one insert: the audit row");
  assert.ok(server.includes('from("snoonu_sync_audits").insert'), "and it targets the audit table");
  assert.ok(server.includes("writeProductAvailability"), "stock goes through the certified engine");
  const tables = [...server.matchAll(/from\("([a-z_]+)"\)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(tables)].sort(), ["products", "snoonu_sync_audits"], "only two tables, ever");
});

// ── 10. preview stays inert ─────────────────────────────────────────────────

test("10. the preview path remains READ-ONLY and the selector is pure", () => {
  const pure = code("lib/snoonu/two-source.ts");
  for (const banned of [".update(", ".insert(", ".upsert(", ".delete(", "createAdminClient", "writeProductAvailability"]) {
    assert.ok(!pure.includes(banned), `the pure module must not contain ${banned}`);
  }
  // the read-only preview function does not reach the apply.
  const server = code(SERVER);
  const previewBody = server.slice(server.indexOf("export async function previewSnoonuCombined"),
                                   server.indexOf("export interface SnoonuOperationalApplyRow"));
  for (const banned of [".update(", ".insert(", "writeProductAvailability", "createAdminClient"]) {
    assert.ok(!previewBody.includes(banned), `preview must not contain ${banned}`);
  }
  // and the selector never mutates the plan it is handed.
  const combined = planSnoonuCombined({
    full: src([fullRow(SPI_A, true)]), bulk: src([bulkRow(SPI_A, "0")]), canonical: CANON, listings: LIST,
  });
  const before = JSON.stringify(combined);
  selectSnoonuOperationalApply(combined);
  selectSnoonuOperationalApply(combined);
  assert.equal(JSON.stringify(combined), before, "selecting the apply leaves the preview untouched");
});
