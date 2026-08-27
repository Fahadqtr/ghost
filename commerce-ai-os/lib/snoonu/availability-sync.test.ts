// SNOONU AVAILABILITY SYNC — owner regression proofs (16).
//
// The rule under test is membership, not measurement: presence in the BULK
// workbook is the ENTIRE availability signal. Several of these tests exist
// specifically to prove the old numeric model is gone — the same fixture with
// wildly different stock cells and opposite FULL availability booleans must
// produce an identical plan.
//
// node --conditions=react-server --experimental-strip-types --test lib/snoonu/availability-sync.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { SnoonuCanonicalRecord, SnoonuListingRecord, SnoonuSyncRow } from "./sync.ts";
import {
  planSnoonuAvailability,
  selectAvailabilityWrites,
  AVAILABLE,
  UNAVAILABLE,
  SNOONU_AVAILABILITY_RULE_AR,
} from "./availability-sync.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
/** Source with comments stripped — these guards assert on CODE, so prose that
 *  merely names a banned symbol cannot satisfy or break them. */
const code = (rel: string) =>
  read(rel).replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

const SERVER = "lib/snoonu/availability-sync.server.ts";
const PURE = "lib/snoonu/availability-sync.ts";
const ACTIONS = "app/(v2)/v2/catalog/snoonu-sync/actions.ts";
const UI = "components/v2/catalog/SnoonuSync.tsx";

const spi = (n: number) => n.toString(16).padStart(24, "0");
const A = spi(1), B = spi(2), C = spi(3), D = spi(4);

function row(id: string, over: Partial<SnoonuSyncRow> = {}): SnoonuSyncRow {
  return { rowNum: 2, spi: id, nameEn: null, nameAr: null, descriptionEn: null, descriptionAr: null,
    sku: null, barcode: null, price: null, availability: null, stockState: null,
    availabilitySource: null, warnings: [], ...over };
}
const product = (id: string, sku: string, stockStatus: string | null): SnoonuCanonicalRecord => ({
  id, sku, barcode: null, nameEn: `EN ${sku}`, nameAr: `ع ${sku}`, descriptionEn: "d", descriptionAr: "و",
  price: 10, stockStatus, lifecycleState: "ACTIVE" });
const listing = (productId: string, externalId: string, over: Partial<SnoonuListingRecord> = {}): SnoonuListingRecord =>
  ({ productId, externalId, mappingStatus: "active", variantGrain: false, ...over });

// p1..p4 all currently In Stock unless a test says otherwise.
const CANON = [product("p1", "mk001", "In Stock"), product("p2", "mk002", "In Stock"),
               product("p3", "mk003", "In Stock"), product("p4", "mk004", "Out of Stock")];
const LIST = [listing("p1", A), listing("p2", B), listing("p3", C), listing("p4", D)];
const plan = (full: SnoonuSyncRow[], bulk: SnoonuSyncRow[], canonical = CANON, listings = LIST) =>
  planSnoonuAvailability({ full, bulk, canonical, listings });

// ── 1..3 the rule ───────────────────────────────────────────────────────────

test("1. the FULL + BULK join uses SPI only", () => {
  // matching SKU/barcode/name on both sides, but DIFFERENT SPIs.
  const p = plan(
    [row(A, { sku: "mk002", barcode: "111", nameEn: "Same" })],
    [row(B, { sku: "mk002", barcode: "111", nameEn: "Same" })],
  );
  assert.equal(p.counts.matchedSpi, 0, "identical SKU/barcode/name must not join");
  assert.equal(p.rows.find((r) => r.spi === A)?.target, AVAILABLE, "A is FULL-only ⇒ in stock");
  assert.equal(p.counts.bulkOnly, 1, "B is BULK-only ⇒ a review item, not a match");
  const pure = code(PURE);
  for (const bad of ["nameEn ===", "sku ===", "barcode ===", "levenshtein", "similar", "fuzzy"]) {
    assert.ok(!pure.includes(bad), `no ${bad} matching anywhere`);
  }
});

test("2. an SPI present in BULK becomes OUT of stock", () => {
  const p = plan([row(A), row(B), row(C)], [row(A), row(C)]);
  const by = new Map(p.rows.map((r) => [r.spi, r]));
  assert.equal(by.get(A)?.target, UNAVAILABLE);
  assert.equal(by.get(C)?.target, UNAVAILABLE);
  assert.equal(p.counts.outOfStock, 2);
});

test("3. an SPI in FULL but NOT in BULK becomes IN stock", () => {
  const p = plan([row(A), row(B), row(C)], [row(A)]);
  const by = new Map(p.rows.map((r) => [r.spi, r]));
  assert.equal(by.get(B)?.target, AVAILABLE);
  assert.equal(by.get(C)?.target, AVAILABLE);
  assert.equal(p.counts.inStock, 2);
  assert.equal(p.counts.fullOnly, 2);
});

// ── 4..5 the old model is genuinely gone ────────────────────────────────────

test("4. stock numeric values are ignored entirely", () => {
  // identical membership, wildly different stock cells on both sides.
  const quiet = plan([row(A), row(B)], [row(A)]);
  const noisy = plan(
    [row(A, { stockState: "IN" }), row(B, { stockState: "OUT" })],
    [row(A, { stockState: "IN" })],
  );
  assert.equal(noisy.fingerprint, quiet.fingerprint, "stock cells change nothing at all");
  // A is IN the bulk file with stockState "IN" — membership still wins.
  assert.equal(noisy.rows.find((r) => r.spi === A)?.target, UNAVAILABLE);
  assert.equal(noisy.rows.find((r) => r.spi === B)?.target, AVAILABLE);
  const pure = code(PURE);
  for (const bad of ["parseStockCell", "stockState", "unavailable", '"0"']) {
    assert.ok(!pure.includes(bad), `the planner must not consult ${bad}`);
  }
});

test("5. the FULL availability boolean is ignored entirely", () => {
  const quiet = plan([row(A), row(B)], [row(A)]);
  // FULL says the OPPOSITE of what membership says, on both rows.
  const contrary = plan(
    [row(A, { availability: true, availabilitySource: "availability_column" }),
     row(B, { availability: false, availabilitySource: "availability_column" })],
    [row(A)],
  );
  assert.equal(contrary.fingerprint, quiet.fingerprint, "the boolean changes nothing");
  assert.equal(contrary.rows.find((r) => r.spi === A)?.target, UNAVAILABLE, "in BULK wins over availability=true");
  assert.equal(contrary.rows.find((r) => r.spi === B)?.target, AVAILABLE, "absent from BULK wins over availability=false");
  const pure = code(PURE);
  assert.ok(!pure.includes("r.availability") && !pure.includes(".availabilitySource"),
    "the planner never reads the availability column");
});

// ── 6..7 blocked / fail-closed ──────────────────────────────────────────────

test("6. a BULK-only SPI is blocked for review, never applied", () => {
  const unknown = spi(99);
  const p = plan([row(A)], [row(A), row(unknown)]);
  assert.equal(p.counts.bulkOnly, 1);
  const b = p.blocked.find((x) => x.spi === unknown);
  assert.equal(b?.reason, "BULK_ONLY");
  assert.ok(!p.rows.some((r) => r.spi === unknown), "it never becomes an availability write");
  // an unmapped FULL SPI is blocked too, rather than guessed at.
  const unmapped = plan([row(A), row(spi(77))], []);
  assert.equal(unmapped.blocked.find((x) => x.spi === spi(77))?.reason, "UNMAPPED");
});

test("7. a duplicate SPI blocks the whole apply", () => {
  const dupFull = plan([row(A), row(A), row(B)], [row(A)]);
  assert.ok(dupFull.applyBlocked, "a duplicate in FULL blocks");
  assert.deepEqual(dupFull.duplicateSpis, [A]);
  const dupBulk = plan([row(A), row(B)], [row(A), row(A)]);
  assert.ok(dupBulk.applyBlocked, "a duplicate in BULK blocks too");
  const clean = plan([row(A), row(B)], [row(A)]);
  assert.equal(clean.applyBlocked, false);
  assert.ok(code(SERVER).includes('if (plan.applyBlocked) return { ok: false, error: "apply_blocked" };'),
    "the server refuses a blocked plan before writing");
});

// ── 8..13 the write boundary ────────────────────────────────────────────────

test("8. no removals — ever", () => {
  // BULK omits almost everything; FULL omits a mapped product entirely.
  const p = plan([row(A)], [row(A)]);
  assert.equal(p.counts.removals, 0);
  // no MECHANISM by which a product could be removed, stopped or unlisted.
  const server = code(SERVER);
  for (const bad of ["archive", "mapping_status", "external_channel_listings",
                     "transitionProductLifecycle", "lifecycle_state", ".delete("]) {
    assert.ok(!server.includes(bad), `no ${bad} path exists`);
  }
  // and the audit records the absence positively, rather than staying silent.
  assert.ok(/removals:\s*\[\]/.test(server), "the audit states removals: []");
  assert.ok(code(PURE).includes("removals: 0"), "the plan pins removals to a literal 0");
});

test("9. no price write is reachable", () => {
  const server = code(SERVER);
  // the only appearance of "price" is the audit flag saying none was applied.
  assert.ok(!/update\([\s\S]{0,160}price/.test(server), "no update sets a price");
  assert.ok(!/price:\s*[^f]/.test(server), "no price VALUE is ever assigned");
  assert.ok(server.includes("priceApplied: false"), "the audit records that no price was applied");
  const pure = code(PURE);
  assert.ok(!pure.includes("price:"), "the plan carries no price field");
  assert.ok(pure.includes("priceChanges: 0"), "and pins price changes to a literal 0");
});

test("10. no SKU write is reachable", () => {
  const server = code(SERVER);
  assert.ok(!/update\([\s\S]{0,120}sku/.test(server), "no update sets a sku");
  // the plan exposes productSku for DISPLAY only — never as a write target.
  const p = plan([row(A)], []);
  assert.equal(p.rows[0]?.productSku, "mk001");
  assert.ok(!code(SERVER).includes("productSku:"), "the sku is not written back anywhere");
});

test("11. no barcode write is reachable", () => {
  const server = code(SERVER);
  assert.ok(!server.includes("barcode"), "barcode appears nowhere in the server code");
  assert.ok(!/update\([\s\S]{0,160}barcode/.test(server), "no update sets a barcode");
  const pure = code(PURE);
  // the plan names it once, to pin the count at zero — never as a value.
  assert.ok(!/barcode:\s*[^0]/.test(pure), "the plan assigns no barcode value");
  assert.ok(pure.includes("barcodeChanges: 0"), "and pins barcode changes to a literal 0");
});

test("12. no content write is reachable", () => {
  const server = code(SERVER);
  for (const col of ["name_en", "name_ar", "description_en", "description_ar", "category", "nameEn", "nameAr"]) {
    assert.ok(!server.includes(col), `the server must not touch ${col}`);
  }
});

test("13. no lifecycle or external_channel_listings write is reachable", () => {
  const server = code(SERVER);
  for (const bad of ["transitionProductLifecycle", "lifecycle_state", "external_channel_listings", "createProductCore"]) {
    assert.ok(!server.includes(bad), `no ${bad}`);
  }
  // the COMPLETE write surface: the availability engine plus the audit row.
  assert.equal([...server.matchAll(/\.update\(/g)].length, 0, "there is no products.update at all");
  assert.equal([...server.matchAll(/\.insert\(/g)].length, 1, "exactly one insert: the audit");
  assert.ok(server.includes('from("snoonu_sync_audits").insert'), "and it targets the audit table");
  assert.ok(server.includes("writeProductAvailability"), "availability goes through the certified engine");
  assert.deepEqual([...new Set([...server.matchAll(/from\("([a-z_]+)"\)/g)].map((m) => m[1]))],
    ["snoonu_sync_audits"], "the ONLY table this module names is the audit table");
});

// ── 14..15 preview + drift ──────────────────────────────────────────────────

test("14. the preview is read-only and the page's preview action writes nothing", () => {
  const pure = code(PURE);
  for (const bad of ["createAdminClient", "fetch(", ".insert(", ".update(", ".delete(", ".rpc("]) {
    assert.ok(!pure.includes(bad), `the pure planner is I/O-free (${bad})`);
  }
  const server = code(SERVER);
  const previewBody = server.slice(server.indexOf("export async function previewSnoonuAvailability"),
                                   server.indexOf("export interface SnoonuAvailabilityApplyResult"));
  for (const bad of [".insert(", ".update(", "writeProductAvailability", "createAdminClient"]) {
    assert.ok(!previewBody.includes(bad), `preview performs no write (${bad})`);
  }
  const actions = code(ACTIONS);
  const pv = actions.slice(actions.indexOf("export async function previewSnoonuAvailabilityAction"),
                           actions.indexOf("export async function applySnoonuAvailabilityAction"));
  assert.ok(pv.includes("requireMalakWriter"), "preview is writer-gated");
  assert.ok(!pv.includes("applySnoonuAvailability("), "and cannot reach the apply");
});

test("15. fingerprint drift blocks the apply, and the rebuild precedes every write", () => {
  const server = code(SERVER);
  const body = server.slice(server.indexOf("export async function applySnoonuAvailability"));
  assert.ok(body.includes('if (plan.fingerprint !== input.expectedFingerprint) return { ok: false, error: "plan_changed" };'),
    "drift fails closed");
  const rebuild = body.indexOf("planSnoonuAvailability(");
  const firstWrite = body.indexOf("writeProductAvailability(");
  assert.ok(rebuild > 0 && rebuild < firstWrite, "the plan is rebuilt server-side before any write");
  assert.ok(body.indexOf("expectedFingerprint") < firstWrite, "and the check precedes the write too");
  // drift is real: a catalog change moves the fingerprint.
  const before = plan([row(A), row(B)], [row(A)]);
  const after = planSnoonuAvailability({
    full: [row(A), row(B)], bulk: [row(A)],
    canonical: [product("p1", "mk001", "Out of Stock"), CANON[1], CANON[2], CANON[3]], listings: LIST,
  });
  assert.notEqual(before.fingerprint, after.fingerprint);
  assert.equal(before.fingerprint, plan([row(A), row(B)], [row(A)]).fingerprint, "otherwise stable");

  // owner gate + the page's confirmation.
  const actions = code(ACTIONS);
  const ap = actions.slice(actions.indexOf("export async function applySnoonuAvailabilityAction"));
  assert.ok(ap.includes("requireOwner()"), "apply is OWNER-only");
  assert.ok(ap.indexOf("requireOwner()") < ap.indexOf("parseBoth"), "gated before any work");
  const ui = read(UI);
  assert.ok(ui.includes("تطبيق حالة التوفر من Bulk"), "the button carries the exact label");
  assert.ok(ui.includes("تطبيق الآن (نهائي)") && ui.includes("setConfirming"), "a second explicit confirmation runs it");
  assert.ok(ui.includes("preview.plan.fingerprint"), "the previewed fingerprint travels with the apply");
});

// ── 16 the real shape, from a fixture ───────────────────────────────────────

test("16. a FULL universe minus the BULK selection yields the expected OUT / IN split", () => {
  // sizes are derived from the fixture, never hardcoded into behaviour.
  const FULL_N = 1365;
  const BULK_N = 172;
  const canonical: SnoonuCanonicalRecord[] = [];
  const listings: SnoonuListingRecord[] = [];
  const full: SnoonuSyncRow[] = [];
  for (let i = 0; i < FULL_N; i += 1) {
    const id = spi(1000 + i);
    canonical.push(product(`p${i}`, `mk${i}`, "In Stock"));
    listings.push(listing(`p${i}`, id));
    // deliberately noisy: alternating stock readings and availability booleans
    // that CONTRADICT the membership answer, to prove they are never consulted.
    full.push(row(id, { stockState: i % 2 === 0 ? "IN" : "OUT", availability: i % 3 === 0 }));
  }
  const bulk = full.slice(0, BULK_N).map((r) => row(r.spi, { stockState: "IN", availability: true }));

  const p = planSnoonuAvailability({ full, bulk, canonical, listings });
  assert.equal(p.counts.fullRows, FULL_N);
  assert.equal(p.counts.bulkRows, BULK_N);
  assert.equal(p.counts.outOfStock, BULK_N, "everything in BULK is out of stock");
  assert.equal(p.counts.inStock, FULL_N - BULK_N, "the remainder of the catalog is in stock");
  assert.equal(p.counts.outOfStock + p.counts.inStock, FULL_N, "every catalog product is classified exactly once");
  assert.equal(p.counts.matchedSpi, BULK_N);
  assert.equal(p.counts.fullOnly, FULL_N - BULK_N);
  assert.equal(p.counts.bulkOnly, 0);
  assert.equal(p.counts.blocked, 0);
  assert.equal(p.counts.removals, 0);

  // all products start In Stock, so only the BULK set actually moves.
  const { toUnavailable, toAvailable } = selectAvailabilityWrites(p);
  assert.equal(toUnavailable.length, BULK_N);
  assert.equal(toAvailable.length, 0);
  assert.equal(p.counts.unchanged, FULL_N - BULK_N);
  assert.ok(SNOONU_AVAILABILITY_RULE_AR.includes("لا يتم استخدام أرقام المخزون نهائياً"));
});
