// OPS.8A — migration guard (source scan of the SQL). Since node:test has no DB,
// this asserts the migration's shape/contract: archive bundle v3 preserves images
// + ECL, restore is version-tolerant and conflict-safe, restore returns DRAFT,
// the lifecycle_state column is constrained to exactly {DRAFT,ACTIVE,STOPPED},
// the backfill maps Active→ACTIVE else DRAFT, and the change is additive.
// node --conditions=react-server --experimental-strip-types --test lib/lifecycle/ops8a-migration-guard.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const SQL = readFileSync(join(ROOT, "supabase/migrations/20260817000000_ops_8a_lifecycle_foundation.sql"), "utf8");
// strip line comments so rollback notes / prose don't create false positives
const code = SQL.replace(/(^|\n)\s*--[^\n]*/g, "$1");

// ── lifecycle_state column ────────────────────────────────────────────────────
test("adds products.lifecycle_state, NOT NULL, default DRAFT, CHECK exactly {DRAFT,ACTIVE,STOPPED}", () => {
  assert.ok(/add column if not exists lifecycle_state/i.test(code), "additive column add");
  assert.ok(/alter column lifecycle_state set default 'DRAFT'/i.test(code), "default DRAFT");
  assert.ok(/alter column lifecycle_state set not null/i.test(code), "NOT NULL");
  assert.ok(/products_lifecycle_state_check[\s\S]*?CHECK \(lifecycle_state = ANY \(ARRAY\['DRAFT','ACTIVE','STOPPED'\]\)\)/i.test(code), "CHECK domain is exactly the three");
});

test("no forbidden lifecycle value appears as a stored state", () => {
  for (const bad of ["'ARCHIVED'", "'READY'", "'PUBLISHED'", "'HIDDEN'", "'NOT_LISTED'"]) {
    assert.equal(code.includes(`lifecycle_state', ${bad}`) || code.includes(`lifecycle_state = ${bad}`), false, `${bad} must never be a lifecycle_state value`);
  }
});

// ── backfill mapping ──────────────────────────────────────────────────────────
test("backfill maps platform_status='Active' → ACTIVE, else DRAFT; no STOPPED", () => {
  assert.ok(/set lifecycle_state = CASE WHEN platform_status = 'Active' THEN 'ACTIVE' ELSE 'DRAFT' END/i.test(code), "exact backfill CASE");
  assert.ok(/where lifecycle_state is null/i.test(code), "only fills NULLs (re-run safe)");
  assert.equal(/set lifecycle_state = [^\n]*'STOPPED'/i.test(code), false, "no STOPPED backfill");
});

// ── archive bundle v3 ─────────────────────────────────────────────────────────
test("archive bundle is v3 and snapshots product_images + external_channel_listings", () => {
  assert.ok(/'version', 3/.test(code), "bundle version 3");
  assert.ok(/'product_images', v_images/.test(code), "images snapshotted into bundle");
  assert.ok(/'external_channel_listings', v_ecl/.test(code), "ECL snapshotted into bundle");
  assert.ok(/from public\.product_images pi where pi\.product_id = p_product_id/i.test(code), "reads product_images");
  assert.ok(/from public\.external_channel_listings e where e\.product_id = p_product_id/i.test(code), "reads ECL");
});

// ── restore: version-tolerant, images, conflict-safe ECL, DRAFT ───────────────
test("restore is version-tolerant (v1/v2 bundles still restorable)", () => {
  assert.ok(/coalesce\(v_bundle->'product_images', '\[\]'::jsonb\)/.test(code), "absent images → empty (old bundles)");
  assert.ok(/coalesce\(v_bundle->'external_channel_listings', '\[\]'::jsonb\)/.test(code), "absent ECL → empty (old bundles)");
  assert.ok(/coalesce\(nullif\(v_bundle->>'version', ''\)::integer, 1\)/.test(code), "version defaults to legacy 1");
});

test("restore inserts images de-duplicated by id (no duplicate insertion)", () => {
  assert.ok(/insert into public\.product_images[\s\S]*?where not exists \(select 1 from public\.product_images x where x\.id = r\.id\)/i.test(code), "image de-dup by id");
});

test("restore re-checks ECL uniqueness and never overwrites a live identity (needs_review)", () => {
  assert.ok(/insert into public\.external_channel_listings[\s\S]*?where not exists/i.test(code), "conditional ECL insert");
  assert.ok(/x\.storefront_key = r\.storefront_key[\s\S]*?x\.external_product_id = r\.external_product_id/i.test(code), "external identity conflict check (storefront-scoped)");
  assert.ok(/lower\(x\.exported_sku\) = lower\(r\.exported_sku\)/i.test(code), "exported SKU conflict check");
  assert.ok(/'eclConflicts', v_ecl_total - v_ecl_restored/.test(code), "reports conflicts for needs_review");
});

test("restore always returns the product as lifecycle_state='DRAFT' (never ACTIVE / auto-publish)", () => {
  assert.ok(/- 'lifecycle_state'\)\s*\|\|\s*jsonb_build_object\('lifecycle_state', 'DRAFT'\)/i.test(code), "forces DRAFT on restore");
  assert.ok(/'lifecycleState', 'DRAFT'/.test(code), "reports DRAFT");
});

// ── inventory model preserved (no business-logic change) ──────────────────────
test("certified reconciliation reason codes are preserved (inventory logic unchanged)", () => {
  for (const reason of ["parent_has_shelf_rows", "malformed_quantity", "inventory_row_invalid", "reference_mismatch"]) {
    assert.ok(code.includes(reason), `reconcile reason '${reason}' retained`);
  }
});

// ── additive + secure ─────────────────────────────────────────────────────────
test("migration is additive (no destructive drops) and touches no schema_migrations", () => {
  assert.equal(/drop table/i.test(code), false, "no DROP TABLE");
  assert.equal(/drop column/i.test(code), false, "no DROP COLUMN in the executed body");
  assert.equal(/schema_migrations/i.test(code), false, "no raw schema_migrations edit");
});

test("archive/restore RPCs stay service-role only", () => {
  assert.ok(/grant execute on function public\.archive_product_bundle\(uuid, text\) to service_role/i.test(code));
  assert.ok(/grant execute on function public\.restore_product_archive\(uuid\) to service_role/i.test(code));
  assert.ok(/revoke all on function public\.archive_product_bundle\(uuid, text\) from authenticated/i.test(code));
});
