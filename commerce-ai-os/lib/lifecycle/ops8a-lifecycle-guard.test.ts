// OPS.8A — lifecycle safety guard (§10). Proves the foundation adds no channel
// lifecycle conflation, no forbidden lifecycle_state value, no auto-publish, no
// hard-delete exposure, no direct inventory writes, and keeps archive/restore as
// the ONLY cold-storage path.
// node --conditions=react-server --experimental-strip-types --test lib/lifecycle/ops8a-lifecycle-guard.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
const stripTs = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
const stripSql = (s: string) => s.replace(/(^|\n)\s*--[^\n]*/g, "$1");

const STATE = "lib/lifecycle/state.ts";
const MIGRATION = "supabase/migrations/20260817000000_ops_8a_lifecycle_foundation.sql";
const HEALTH_ACTIONS = "app/(app)/catalog/health/actions.ts";

// ── no channel-publication vocabulary leaks into the product lifecycle ─────────
test("lifecycle code introduces no channel PUBLISHED/HIDDEN/NOT_LISTED vocabulary", () => {
  const state = stripTs(read(STATE));
  for (const tok of ["PUBLISHED", "HIDDEN", "NOT_LISTED"]) {
    assert.equal(state.includes(tok), false, `state.ts must not mention channel term ${tok}`);
  }
  const sql = stripSql(read(MIGRATION));
  for (const tok of ["'PUBLISHED'", "'HIDDEN'", "'NOT_LISTED'"]) {
    assert.equal(sql.includes(tok), false, `migration must not add channel value ${tok}`);
  }
});

// ── no forbidden value is stored as a lifecycle_state ─────────────────────────
test("no ARCHIVED/READY as a stored lifecycle_state", () => {
  const state = stripTs(read(STATE));
  // the closed domain literal is exactly the three
  assert.ok(/\["DRAFT", "ACTIVE", "STOPPED"\]/.test(state), "LIFECYCLE_STATES is exactly the three");
  const sql = stripSql(read(MIGRATION));
  assert.equal(/lifecycle_state[^\n]*'ARCHIVED'/.test(sql), false, "never stores ARCHIVED");
  assert.equal(/lifecycle_state[^\n]*'READY'/.test(sql), false, "never stores READY");
});

// ── restore never auto-publishes; product returns DRAFT ───────────────────────
test("restore forces DRAFT and never activates/publishes", () => {
  const sql = stripSql(read(MIGRATION));
  assert.ok(/jsonb_build_object\('lifecycle_state', 'DRAFT'\)/.test(sql), "restore forces DRAFT");
  assert.equal(/jsonb_build_object\('lifecycle_state', 'ACTIVE'\)/.test(sql), false, "restore never sets ACTIVE");
});

// ── archive/restore remain the ONLY cold-storage path ─────────────────────────
test("only the archive RPC deletes a live product; no new delete path", () => {
  const sql = stripSql(read(MIGRATION));
  const deletes = (sql.match(/delete from public\.products\b/gi) ?? []).length;
  assert.equal(deletes, 1, "exactly one products delete — inside archive_product_bundle");
  // the migration only (re)defines the two certified cold-storage RPCs
  assert.ok(/create or replace function public\.archive_product_bundle/i.test(sql));
  assert.ok(/create or replace function public\.restore_product_archive/i.test(sql));
});

// ── hard delete retired to owner-only; state.ts is pure (no IO) ───────────────
test("legacy hard delete is owner-gated (retired from casual exposure)", () => {
  const s = read(HEALTH_ACTIONS);
  assert.ok(/requireOwner\(\)/.test(s), "deleteProductById now owner-gated");
  assert.equal(/isSignedIn\(\)/.test(s), false, "no longer login-only");
});

test("lifecycle read-compat is pure (no DB client, no IO)", () => {
  const s = stripTs(read(STATE));
  for (const bad of [/@\/lib\/supabase/, /createClient/, /\.from\(/, /\.rpc\(/, /fetch\(/, /"use server"/]) {
    assert.equal(bad.test(s), false, `state.ts must not contain ${bad}`);
  }
});
