// Migration safety tests (Phase UI.9.3): assert supabase/platform_snapshots.sql
// is idempotent, RLS-guarded, append-only, and indexed — and that the capture
// action is READ+INSERT only via the session client (no service role, no raw
// error leakage). Static source scans, no DB.
// Run: node --conditions=react-server --experimental-strip-types --test lib/platforms/core/migration.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const SQL = readFileSync(new URL("../../../supabase/platform_snapshots.sql", import.meta.url), "utf8");
const DOWN = readFileSync(new URL("../../../supabase/platform_snapshots_down.sql", import.meta.url), "utf8");
const ACTION = readFileSync(
  new URL("../../../app/(app)/import-export/pure-seoul-snapshot-actions.ts", import.meta.url),
  "utf8",
);

test("migration is idempotent (create/alter/index/policy guarded)", () => {
  assert.ok(/create table if not exists public\.platform_snapshots/.test(SQL));
  assert.ok(/create index if not exists platform_snapshots_latest_idx/.test(SQL));
  assert.ok(/create index if not exists platform_snapshots_platform_captured_idx/.test(SQL));
  // policies dropped before create so re-running never errors
  assert.ok(/drop policy if exists platform_snapshots_select/.test(SQL));
  assert.ok(/drop policy if exists platform_snapshots_insert/.test(SQL));
});

test("all contract columns are present", () => {
  for (const col of [
    "platform",
    "product_id",
    "external_id",
    "sku",
    "barcode",
    "status",
    "price",
    "availability",
    "title",
    "payload_hash",
    "snapshot_version",
    "captured_at",
    "metadata",
    "created_at",
  ]) {
    assert.ok(new RegExp(`\\b${col}\\b`).test(SQL), `missing column ${col}`);
  }
});

test("constraints: FK cascade, snapshot_version check, not-null hash, RLS enabled", () => {
  assert.ok(/references public\.products\(id\) on delete cascade/.test(SQL), "FK to products with cascade");
  assert.ok(/snapshot_version integer\s+not null default 1 check \(snapshot_version >= 1\)/.test(SQL));
  assert.ok(/payload_hash\s+text\s+not null/.test(SQL));
  assert.ok(/alter table public\.platform_snapshots enable row level security/.test(SQL));
});

test("RLS: authenticated select + insert only — NO update/delete (append-only)", () => {
  assert.ok(/for select to authenticated using \(true\)/.test(SQL));
  assert.ok(/for insert to authenticated with check \(true\)/.test(SQL));
  assert.ok(!/for update/.test(SQL), "no update policy (immutable)");
  assert.ok(!/for delete/.test(SQL), "no delete policy (immutable)");
  assert.ok(!/for all/.test(SQL), "never a blanket for-all policy");
});

test("no service role / no destructive product or inventory writes in the migration", () => {
  assert.ok(!/service_role/.test(SQL));
  assert.ok(!/\bdrop table\b/.test(SQL), "up migration never drops a table");
  // Only the new table is created/altered — never products/inventory/platform_status
  // (statement scan; the header comment may name them).
  assert.ok(!/alter table\s+public\.(products|inventory|platform_status)/i.test(SQL), "never alters other tables");
  assert.ok(!/insert into|delete from|update\s+public\./i.test(SQL), "no DML on any table");
});

test("rollback exists, is idempotent, and only drops snapshot objects", () => {
  assert.ok(/drop table  if exists public\.platform_snapshots/.test(DOWN));
  assert.ok(/drop policy if exists platform_snapshots_insert/.test(DOWN));
  // no statement targets any other table (comment may name them)
  assert.ok(!/(drop|alter) table\s+public\.(products|inventory|platform_status)/i.test(DOWN), "rollback drops nothing else");
});

test("capture action: session client, READ+INSERT only, no service role, no raw errors", () => {
  assert.ok(ACTION.includes('"use server"'));
  assert.ok(ACTION.includes("createClient"), "session client");
  assert.ok(!ACTION.includes("createAdminClient"), "no admin client");
  assert.ok(!ACTION.includes("service_role"));
  // never mutates products/inventory/platform_status
  assert.ok(!/\.update\(|\.delete\(|\.upsert\(/.test(ACTION), "no product/inventory writes");
  assert.ok(!/from\("inventory"\)|from\("platform_status"\)/.test(ACTION));
  // fixed Arabic errors, never a raw DB message
  assert.ok(ACTION.includes("تعذّرت قراءة الكتالوج") || ACTION.includes("تعذّر حفظ لقطات PureSoul"));
});
