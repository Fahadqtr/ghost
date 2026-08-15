// CH.1 — channel schema baseline guard. PURE static scan of repo migrations +
// loose SQL. Proves the channel-domain schema is now captured in versioned,
// idempotent migrations that reproduce production, without introducing new
// schema or treating stale order-deduction SQL as authoritative.
//
// Run: node --conditions=react-server --experimental-strip-types --test lib/platforms/ch1-schema-baseline-guard.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
const MIGRATIONS_DIR = "supabase/migrations";
const CH1 = `${MIGRATIONS_DIR}/20260816120000_ch1_channel_schema_baseline.sql`;

const allMigrations = () =>
  readdirSync(join(ROOT, MIGRATIONS_DIR))
    .filter((f) => f.endsWith(".sql"))
    .map((f) => read(`${MIGRATIONS_DIR}/${f}`))
    .join("\n");

const CH1_SQL = read(CH1);

const CHANNEL_TABLES = ["channels", "channel_products", "channel_variant_mappings", "platform_status", "platform_snapshots"];
const EXTERNAL_ID_COLS = ["snoonu_id", "rafeeq_product_id", "pure_seoul_id"];

test("every channel table is captured by a versioned migration via CREATE TABLE IF NOT EXISTS", () => {
  for (const t of CHANNEL_TABLES) {
    const re = new RegExp(`CREATE TABLE IF NOT EXISTS public\\.${t}\\b`);
    assert.ok(re.test(CH1_SQL), `${t} captured with CREATE TABLE IF NOT EXISTS`);
  }
});

test("channel external-id product columns are tracked via ADD COLUMN IF NOT EXISTS", () => {
  for (const c of EXTERNAL_ID_COLS) {
    const re = new RegExp(`ALTER TABLE public\\.products ADD COLUMN IF NOT EXISTS ${c}\\b`);
    assert.ok(re.test(CH1_SQL), `products.${c} tracked idempotently`);
  }
});

test("channel_stock NULL enforcement (shared inventory pool) is captured and documented", () => {
  assert.ok(/channel_products_no_per_channel_stock/.test(CH1_SQL), "CHECK constraint present");
  assert.ok(/CHECK \(channel_stock IS NULL\)/.test(CH1_SQL), "channel_stock forced NULL");
  assert.ok(/COMMENT ON CONSTRAINT channel_products_no_per_channel_stock/.test(CH1_SQL), "policy documented");
});

test("channel_variant_mappings durable-identity contract is preserved (SKU-keyed, not variant id)", () => {
  assert.ok(
    /channel_variant_mappings_identity_uk[\s\S]*channel_id, master_product_id, COALESCE\(master_variant_sku/.test(CH1_SQL),
    "durable identity unique index on (channel_id, master_product_id, coalesce(master_variant_sku,''))",
  );
  assert.equal(/REFERENCES public\.product_variants/.test(CH1_SQL), false, "mappings do not FK to product_variants (SKU-keyed, ids unstable)");
});

test("the two 'platform_status' concepts are documented as distinct (not renamed in CH.1)", () => {
  assert.ok(/COMMENT ON TABLE\s+public\.platform_status/.test(CH1_SQL), "platform_status TABLE commented");
  assert.ok(/DISTINCT from the products\.platform_status COLUMN/.test(CH1_SQL), "collision documented");
  // CH.1 must not rename either concept.
  assert.equal(/ALTER TABLE[^\n]*RENAME/.test(CH1_SQL), false, "no rename in CH.1");
});

test("migration is additive + idempotent: no destructive DROP, no bare channel CREATE TABLE", () => {
  assert.equal(/\bDROP\s+(TABLE|COLUMN|CONSTRAINT|INDEX|POLICY|TYPE)\b/i.test(CH1_SQL.replace(/DROP POLICY IF EXISTS/g, "")), false, "no destructive DROP");
  for (const t of CHANNEL_TABLES) {
    // no CREATE TABLE without IF NOT EXISTS for a channel table
    const bad = new RegExp(`CREATE TABLE public\\.${t}\\b`);
    assert.equal(bad.test(CH1_SQL), false, `${t} is never created without IF NOT EXISTS`);
  }
  // constraints/policies are guarded
  assert.ok(/IF NOT EXISTS \(SELECT 1 FROM pg_constraint/.test(CH1_SQL), "constraints guarded");
  assert.ok(/IF NOT EXISTS \(SELECT 1 FROM pg_policies/.test(CH1_SQL), "policies guarded");
});

test("platform_snapshots uniqueness is DEFERRED, not forced (CH.0 §4 stop)", () => {
  assert.ok(/DEFERRED[\s\S]*platform_snapshots uniqueness/.test(CH1_SQL), "deferral documented with rationale");
  // no UNIQUE index/constraint on platform_snapshots beyond its pkey
  assert.equal(
    /CREATE UNIQUE INDEX[^\n]*ON public\.platform_snapshots/.test(CH1_SQL),
    false,
    "no unique index added on platform_snapshots in CH.1",
  );
});

test("stale order-deduction loose SQL is marked SUPERSEDED and is NOT in the migrations dir", () => {
  for (const f of ["supabase/shopify_synced_orders_deduction.sql", "supabase/talabat_order_atomic_processing.sql"]) {
    assert.ok(/SUPERSEDED — DO NOT RUN/.test(read(f)), `${f} marked superseded`);
  }
  // the migrations directory (authoritative history) must not contain these stale bodies
  const migs = readdirSync(join(ROOT, MIGRATIONS_DIR));
  assert.equal(migs.some((f) => f.includes("shopify_synced_orders_deduction") || f.includes("talabat_order_atomic_processing")), false,
    "stale deduction SQL is not tracked as a migration");
});

test("no NEW untracked channel table/column is introduced casually (registry lock)", () => {
  // The set of channel tables created in migrations equals the known registry —
  // adding a channel table elsewhere without updating this guard fails here.
  const migrations = allMigrations();
  const created = new Set<string>();
  for (const m of migrations.matchAll(/CREATE TABLE IF NOT EXISTS public\.([a-z_]+)/g)) {
    const t = m[1];
    if (t.startsWith("channel") || t.startsWith("platform_")) created.add(t);
  }
  assert.deepEqual([...created].sort(), [...CHANNEL_TABLES].sort(), "exactly the known channel tables are migration-tracked");
});
