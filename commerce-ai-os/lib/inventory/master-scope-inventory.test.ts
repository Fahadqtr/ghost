// STEP 37 — Inventory Center master-membership proofs.
//
// The Inventory Center is a CURRENT OPERATIONAL surface: its product universe
// is the active `snoonu:malikas` membership. These tests prove the scoping
// behaviour and — just as importantly — that scoping is a READ concern that
// never touches quantity, stock_status, availability or the stored rows.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { scopeRows, buildMasterScope, UNAVAILABLE_SCOPE, type MasterScope } from "../home/master-scope.ts";
import { isAvailable } from "../availability/read.ts";

const strip = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const src = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");
const MAIN = "../../app/(app)/inventory/page.tsx";
const OOS = "../../app/(app)/inventory/out-of-stock/page.tsx";

/** An inventory row as the page builds it. */
function row(product_id: string | null, stock_status: string | null, stock_quantity: number | null) {
  return { id: `inv-${product_id}`, product_id, stock_status, stock_quantity };
}

/** Membership built the same way production builds it — from ECL rows. */
const scopeOf = (...ids: string[]): MasterScope =>
  buildMasterScope(ids.map((product_id) => ({ product_id })));

const idOf = (r: { product_id: string | null }) => r.product_id;

// ── 1. every master member remains visible ───────────────────────────────────

test("all master members are visible in the current operational universe", () => {
  const ids = Array.from({ length: 50 }, (_, i) => `m${i}`);
  const rows = ids.map((id) => row(id, "In Stock", 5));
  const scoped = scopeRows(rows, idOf, scopeOf(...ids));
  assert.equal(scoped.length, ids.length, "no member is dropped");
  assert.deepEqual(scoped.map(idOf), ids, "order preserved");
});

// ── 2. outside-master rows are excluded ──────────────────────────────────────

test("outside-master inventory rows are excluded from the current universe", () => {
  const scope = scopeOf("m1", "m2");
  const rows = [row("m1", "In Stock", 1), row("outside", "In Stock", 1), row("m2", "Out of Stock", 0)];
  const scoped = scopeRows(rows, idOf, scope);
  assert.equal(scoped.length, 2);
  assert.equal(scoped.some((r) => r.product_id === "outside"), false);
});

test("an inventory row with a null product_id is never treated as a member", () => {
  assert.equal(scopeRows([row(null, "In Stock", 1)], idOf, scopeOf("m1")).length, 0);
});

// ── 3 & 4. outside-master rows cannot inflate either availability bucket ─────

test("an outside-master In Stock row does not inflate Available", () => {
  const scope = scopeOf("m1");
  const rows = [row("m1", "Out of Stock", 0), row("outside", "In Stock", 99)];
  const scoped = scopeRows(rows, idOf, scope);
  const available = scoped.filter((r) => isAvailable(r.stock_status)).length;
  assert.equal(available, 0, "the outside In Stock row is not counted");
  assert.equal(scoped.length - available, 1);
});

test("an outside-master Out of Stock row does not inflate OOS", () => {
  const scope = scopeOf("m1");
  const rows = [row("m1", "In Stock", 3), row("outside", "Out of Stock", 0)];
  const scoped = scopeRows(rows, idOf, scope);
  const oos = scoped.filter((r) => !isAvailable(r.stock_status)).length;
  assert.equal(oos, 0, "the outside Out of Stock row is not counted");
});

test("AVAILABLE + OUT_OF_STOCK === TOTAL over the scoped set", () => {
  const scope = scopeOf("a", "b", "c", "d");
  const rows = [
    row("a", "In Stock", 1), row("b", "Out of Stock", 0),
    row("c", "In Stock", 0), row("d", null, 7), row("outside", "In Stock", 1),
  ];
  const scoped = scopeRows(rows, idOf, scope);
  const available = scoped.filter((r) => isAvailable(r.stock_status)).length;
  const oos = scoped.length - available;
  assert.equal(available + oos, scoped.length);
  assert.equal(scoped.length, scope.total, "full coverage of the master");
});

// ── 5 & 6. availability semantics are untouched ──────────────────────────────

test("stock_status is never rewritten or recalculated by scoping", () => {
  const rows = [row("m1", "Out of Stock", 500), row("m2", "In Stock", 0)];
  const before = rows.map((r) => r.stock_status);
  const scoped = scopeRows(rows, idOf, scopeOf("m1", "m2"));
  assert.deepEqual(scoped.map((r) => r.stock_status), before, "values pass through verbatim");
  assert.deepEqual(rows.map((r) => r.stock_status), before, "source rows unmutated");
  // The row objects themselves are the SAME references — nothing is rebuilt.
  assert.equal(scoped[0], rows[0]);
});

test("quantity=0 does not affect membership, nor imply Out of Stock", () => {
  const scope = scopeOf("m1");
  const zero = row("m1", "In Stock", 0);
  const scoped = scopeRows([zero], idOf, scope);
  assert.equal(scoped.length, 1, "quantity 0 is still a member");
  assert.equal(isAvailable(scoped[0].stock_status), true, "explicit status wins over quantity");
});

test("a non-zero quantity does not imply availability either", () => {
  assert.equal(isAvailable(row("m1", "Out of Stock", 42).stock_status), false);
});

// ── 7 & 8. one scoped set feeds cards, rows, filters and pagination ──────────

test("summary cards and the row list are computed from the SAME scoped array", () => {
  const s = strip(src(MAIN));
  // The paged read fills `allRows`; every derived value must read `rows`,
  // which is the scoped array.
  assert.ok(/const\s+rows:\s*InventoryRow\[\]\s*=\s*scopeRows\(\s*allRows/.test(s),
    "rows is the scoped projection of allRows");
  assert.ok(/const\s+total\s*=\s*rows\.length/.test(s), "cards count the scoped rows");
  assert.ok(/rows\.filter\(\(r\) => !isAvailable\(r\.stock_status\)\)\.length/.test(s),
    "availability card counts the scoped rows");
  assert.ok(/<InventoryTable[\s\S]{0,400}rows=\{rows\}/.test(s), "the table renders the scoped rows");
  // The unscoped accumulator may appear ONLY three times: its declaration, the
  // push inside the paged read, and the scoping call itself. Any fourth use
  // would mean some derived value bypassed the membership filter.
  assert.equal((s.match(/allRows/g) ?? []).length, 3,
    "allRows is used only to accumulate and then scope — never downstream");
});

test("search, filters, sorting and pagination all run on the scoped universe", () => {
  const s = strip(src(MAIN));
  // categories (the filter universe) and the availability list are both derived
  // from `rows`, and InventoryTable receives only `rows` — so the client-side
  // search/filter/sort/pagination and the bulk-selection universe are scoped.
  assert.ok(/new Set\(\s*rows\.map\(\(r\) => r\.category\)/.test(s), "category filter universe is scoped");
  assert.ok(/const availabilityRows = rows\.map/.test(s), "availability list is scoped");
  assert.equal(/rows=\{allRows\}/.test(s), false, "no component receives the unscoped array");
});

// ── 9. membership failure fails closed ───────────────────────────────────────

test("membership failure yields NO rows — never an unscoped fallback", () => {
  const rows = [row("m1", "In Stock", 1), row("m2", "In Stock", 1)];
  assert.deepEqual(scopeRows(rows, idOf, UNAVAILABLE_SCOPE), [], "nothing leaks through");
});

test("both scoped pages branch on membership failure instead of rendering everything", () => {
  const main = strip(src(MAIN));
  assert.ok(/const scopeUnavailable = !masterScope\.ok/.test(main), "main page detects the failure");
  assert.ok(/scopeUnavailable \?/.test(main), "main page renders a dedicated fail-closed branch");
  const oos = strip(src(OOS));
  assert.ok(/if \(!masterScope\.ok\)/.test(oos), "out-of-stock detects the failure");
  assert.ok(/throw new Error\(/.test(oos), "out-of-stock surfaces the error card, not a full list");
});

// ── 10. no writes, no deletes — scoping is read-only ─────────────────────────

test("the scoped pages contain no inventory write, delete or RPC", () => {
  for (const rel of [MAIN, OOS]) {
    const s = strip(src(rel));
    for (const [re, label] of [
      [/\.update\s*\(/, ".update("],
      [/\.insert\s*\(/, ".insert("],
      [/\.upsert\s*\(/, ".upsert("],
      [/\.delete\s*\(/, ".delete("],
      [/\.rpc\s*\(/, ".rpc("],
    ] as const) {
      assert.equal(re.test(s), false, `${rel} must not contain ${label}`);
    }
  }
});

test("scoping reuses the shared membership seam — no second ECL query", () => {
  for (const rel of [MAIN, OOS]) {
    const s = strip(src(rel));
    assert.ok(/loadMasterScope/.test(s), `${rel} uses the shared membership loader`);
    assert.equal(/external_channel_listings/.test(s), false, `${rel} must not re-query ECL`);
    assert.equal(/snoonu:malikas/.test(s), false, `${rel} must not restate the storefront key`);
  }
});

// ── 11. no hardcoded counts ──────────────────────────────────────────────────

test("no literal inventory/master counts are used as runtime logic", () => {
  for (const rel of [MAIN, OOS]) {
    const s = strip(src(rel));
    for (const n of ["1343", "1166", "177", "1530", "1344", "186", "187"]) {
      assert.equal(new RegExp(`\\b${n}\\b`).test(s), false, `${rel} must not hardcode ${n}`);
    }
  }
});

// ── 12. historical / global inventory surfaces stay unscoped, deliberately ───

test("historical and physical-stock routes are NOT master-scoped", () => {
  // Movements and approvals are HISTORICAL_DETAIL; shelves, shelf labels,
  // stocktake and labels are GLOBAL_INVENTORY (physical warehouse work covers
  // stock that is outside the current master but still on the shelf).
  for (const rel of [
    "../../app/(app)/inventory/movements/page.tsx",
    "../../app/(app)/inventory/approvals/page.tsx",
    "../../app/(app)/inventory/reports/page.tsx",
    "../../app/(app)/inventory/shelves/page.tsx",
    "../../app/(app)/inventory/shelves/labels/page.tsx",
    "../../app/(app)/inventory/stocktake/page.tsx",
    "../../app/(app)/inventory/labels/page.tsx",
  ]) {
    const s = strip(src(rel));
    assert.equal(/loadMasterScope|scopeRows/.test(s), false, `${rel} stays global by design`);
  }
});

test("inventory write actions are untouched by this change", () => {
  const s = strip(src("../../app/(app)/inventory/actions.ts"));
  assert.equal(/loadMasterScope|scopeRows|master-scope/.test(s), false,
    "write paths must not import the membership seam");
});
