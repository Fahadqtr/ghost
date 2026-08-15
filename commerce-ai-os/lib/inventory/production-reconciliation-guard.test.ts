// Production-Reconciliation — static guard for the one-time repair migration.
//
// Pins that the reconciliation migration is a NARROW, safe, all-or-nothing data
// repair: it mutates ONLY the four approved columns (+ malak_audit insert), has
// exact before-state preconditions, rowcount guards, an audit trail, and internal
// postconditions — and NEVER touches the retired mirror, availability, sold, the
// sales ledgers, product/variant stock authority, or the NULL manual blocker.
//
// PURE — source scan only. Run:
// node --conditions=react-server --experimental-strip-types --test lib/inventory/production-reconciliation-guard.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const MIG_DIR = join(ROOT, "supabase", "migrations");
const migFile = readdirSync(MIG_DIR).find((f) => /inventory_production_reconciliation\.sql$/.test(f));
const RAW = migFile ? readFileSync(join(MIG_DIR, migFile), "utf8") : "";
const CODE = RAW.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--[^\n]*/g, "");
const lc = CODE.toLowerCase();

test("migration exists and is a transactional DO block", () => {
  assert.ok(migFile, "inventory_production_reconciliation.sql present");
  assert.ok(/do\s+\$\$/i.test(CODE) && /end\s+\$\$;/i.test(CODE), "wrapped in a DO $$ … END $$ block");
});

// ── only approved mutation targets ─────────────────────────────────────────────

test("mutates ONLY the four approved columns (+ malak_audit insert)", () => {
  // UPDATE targets: shelf_stock, variant_shelf_stock, inventory only.
  const updates = [...lc.matchAll(/update\s+(public\.)?([a-z_]+)\s+set\s+([^;]*)/g)].map((m) => ({ table: m[2], set: m[3] }));
  for (const u of updates) {
    assert.ok(["shelf_stock", "variant_shelf_stock", "inventory"].includes(u.table), `unexpected UPDATE target: ${u.table}`);
    if (u.table === "inventory") {
      // inventory updates only touch stock_quantity or location (+ updated_at).
      assert.ok(/stock_quantity|location/.test(u.set), "inventory update sets stock_quantity/location");
      assert.equal(/sold_quantity|stock_status/.test(u.set), false, "inventory update never touches sold_quantity/stock_status");
    }
  }
  // INSERTs only into malak_audit.
  const inserts = [...lc.matchAll(/insert\s+into\s+(public\.)?([a-z_]+)/g)].map((m) => m[2]).filter((t) => t !== "_simple_shelf" && t !== "_variant_shelf");
  for (const t of inserts) assert.equal(t, "malak_audit", `unexpected INSERT target: ${t}`);
});

test("never writes the retired mirror, availability, sold, or authority guesses", () => {
  assert.equal(/update\s+(public\.)?products\b/i.test(CODE), false, "never updates products (retired mirror)");
  assert.equal(/stock_status/i.test(CODE), false, "never touches availability");
  assert.equal(/set[^;]*sold_quantity/i.test(CODE), false, "never writes sold_quantity");
  assert.equal(/update\s+(public\.)?product_variants\b/i.test(CODE), false, "never rewrites variant stock authority");
  // no sales ledger / order tables / DELETE of catalog rows
  assert.equal(/shopify_synced_orders|talabat_orders|inv_sell|process_shopify|process_talabat/i.test(CODE), false, "no sales/order replay");
  assert.equal(/delete\s+from\s+(public\.)?(products|product_variants|inventory|shelf_stock|variant_shelf_stock)/i.test(CODE), false, "no catalog DELETE");
});

test("never guesses the NULL manual blocker variant", () => {
  // The blocker variant/product must NOT appear as an UPDATE/target in the repair.
  assert.equal(/9c44f181-a263-4b2f-bb7f-6780f0773c18/.test(CODE), false, "blocker variant id absent");
  assert.equal(/mk1550/.test(CODE), false, "blocker sku absent");
});

// ── safety scaffolding present ─────────────────────────────────────────────────

test("has exact before-state preconditions that RAISE on mismatch", () => {
  assert.ok(/precondition/i.test(CODE), "precondition checks present");
  assert.ok((lc.match(/raise exception/g) ?? []).length >= 8, "multiple RAISE guards (all-or-nothing)");
  // exact expected before-values are asserted
  assert.ok(/stock_quantity = 1/.test(CODE), "simple/rollup before-stock = 1 checked");
  assert.ok(/= 41/.test(CODE) && /= 14/.test(CODE) && /= 100/.test(CODE), "expected variant sums / stock checked");
  assert.ok(/location = 'A2'/.test(CODE), "stale location before-value checked");
});

test("has deterministic locks + rowcount guards", () => {
  assert.ok(/order by id for update/i.test(CODE), "inventory/shelf locked deterministically");
  assert.ok(/order by variant_id, id for update/i.test(CODE), "variant shelf locked deterministically");
  assert.ok((lc.match(/get diagnostics v_rows = row_count/g) ?? []).length >= 4, "rowcount checked on critical updates");
});

test("has an immutable audit trail with the right agent/action", () => {
  assert.ok(/'inventory_reconcile'/.test(CODE), "action_type inventory_reconcile");
  assert.ok(/system:production-reconciliation/.test(CODE), "agent tag");
  assert.ok(/'immutable',\s*true/.test(CODE), "audit rows immutable");
  assert.ok(/'authoritativeSource'/.test(CODE), "records the authoritative source");
  // audit fields cover each mutation kind
  for (const f of ["shelf_stock.quantity", "variant_shelf_stock.quantity", "stock_quantity", "location"]) {
    assert.ok(CODE.includes(`'${f}'`), `audit field ${f}`);
  }
});

test("has internal postconditions before commit", () => {
  assert.ok(/postcondition/i.test(CODE), "postcondition checks present");
  assert.ok(/of 9/.test(CODE) && /of 3/.test(CODE), "re-verifies the 9 simple + 3 variant shelves");
  assert.ok(/parent <> 41|<> 41/.test(CODE) && /<> 14/.test(CODE), "re-verifies both parent rollups");
  assert.ok(/location not null|location is not null/i.test(CODE), "re-verifies location nulled");
});
