// SNOONU AUDIT MIGRATION — import_mode constraint proofs.
//
// 20260828000000_snoonu_sync_audits.sql is ALREADY APPLIED in production, so
// it is immutable history: widening import_mode to accept the scoped repair
// had to arrive as a NEW additive migration. These tests pin both halves —
// that the applied file is untouched, and that the migration chain's EFFECTIVE
// allowed set is exactly {FULL, PARTIAL, REPAIR}.
//
// The allowed set is DERIVED by replaying the migrations in filename order
// (the order the runner applies them) and keeping the last definition of the
// named constraint — not asserted against a hardcoded string — so a future
// migration that narrows or renames it fails here.
//
// node --conditions=react-server --experimental-strip-types --test lib/snoonu/audit-migration.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const MIGRATIONS = "supabase/migrations";
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

const HISTORICAL = `${MIGRATIONS}/20260828000000_snoonu_sync_audits.sql`;
const ALLOW_REPAIR = `${MIGRATIONS}/20260828010000_snoonu_sync_audits_allow_repair.sql`;

/** SHA-256 of the migration EXACTLY as production applied it (pre-PR #690). */
const APPLIED_SHA256 = "b41456fb9e687664ffc6f369b18f2d5825f62299f98bab985146110a1cd439c9";

/** the live constraint name, read from production before this change. */
const CONSTRAINT = "snoonu_sync_audits_import_mode_check";

const strip = (sql: string) => sql.replace(/--[^\n]*/g, "");

/** the value set of the LAST `import_mode in (...)` a migration establishes. */
function allowedIn(sql: string): string[] | null {
  const all = [...strip(sql).matchAll(/import_mode\s+in\s*\(([^)]*)\)/gi)];
  const last = all.at(-1);
  if (!last) return null;
  return last[1].split(",").map((v) => v.trim().replace(/^'|'$/g, ""));
}

/** replay the ordered chain; the last migration to define the set wins. */
function effectiveAllowedSet(): string[] {
  const chain = [HISTORICAL, ALLOW_REPAIR].sort(); // filename order = apply order
  let set: string[] | null = null;
  for (const f of chain) set = allowedIn(read(f)) ?? set;
  assert.ok(set, "the chain must establish an import_mode value set");
  return set;
}

const accepts = (v: string) => effectiveAllowedSet().includes(v);

// ── the four value proofs ───────────────────────────────────────────────────

test("FULL is accepted", () => {
  assert.ok(accepts("FULL"), "a full Snoonu sync must still be recordable");
});

test("PARTIAL is accepted", () => {
  assert.ok(accepts("PARTIAL"), "a partial (removal-free) sync must still be recordable");
});

test("REPAIR is accepted", () => {
  assert.ok(accepts("REPAIR"), "the scoped repair records import_mode REPAIR");
});

test("an invalid import_mode is rejected", () => {
  for (const bad of ["", "repair", "Repair", "REPAIRED", "DELETE", "ALL", "FULL,PARTIAL", "TRUNCATE"]) {
    assert.ok(!accepts(bad), `${JSON.stringify(bad)} must NOT be an accepted import_mode`);
  }
  assert.deepEqual(effectiveAllowedSet().sort(), ["FULL", "PARTIAL", "REPAIR"], "exactly three modes — no more");
});

// ── the applied migration is immutable history ──────────────────────────────

test("the historical (already-applied) migration is restored byte-for-byte", () => {
  const bytes = readFileSync(join(ROOT, HISTORICAL));
  assert.equal(
    createHash("sha256").update(bytes).digest("hex"),
    APPLIED_SHA256,
    "20260828000000 is applied in production — it must never be edited; widen the constraint in a NEW migration instead",
  );
  const m = strip(read(HISTORICAL));
  assert.ok(/import_mode\s+text\s+not\s+null\s+check\s*\(import_mode\s+in\s*\('FULL','PARTIAL'\)\)/.test(m),
    "it still carries the ORIGINAL two-value constraint");
  assert.ok(!m.includes("REPAIR"), "the applied file knows nothing about REPAIR");
});

// ── the new migration is a constraint change and nothing else ───────────────

test("the allow-repair migration only swaps the CHECK constraint", () => {
  const m = strip(read(ALLOW_REPAIR)).toLowerCase();
  assert.ok(m.includes(`drop constraint if exists ${CONSTRAINT}`), "drops the EXISTING constraint by its live name");
  assert.ok(m.includes(`add constraint ${CONSTRAINT}`), "re-adds it under the SAME name");
  // no table recreation, no data movement, nothing outside this one table.
  for (const banned of ["create table", "drop table", "truncate", "insert into", "update ", "delete from", "add column", "drop column", "alter column", "create index", "drop index"]) {
    assert.ok(!m.includes(banned), `the migration must not ${banned.trim()}`);
  }
  const touched = [...m.matchAll(/alter table\s+([a-z0-9_.]+)/g)].map((x) => x[1]);
  assert.deepEqual([...new Set(touched)], ["public.snoonu_sync_audits"], "exactly one table is touched");
  assert.equal(touched.length, 2, "exactly two statements: the drop and the add");
});

test("the repair server writes an import_mode the chain accepts", () => {
  const server = read("lib/snoonu/repair.server.ts");
  const mode = /import_mode:\s*"([A-Z]+)"/.exec(server)?.[1];
  assert.ok(mode, "the repair audit must set an explicit import_mode");
  assert.ok(accepts(mode), `repair.server.ts writes ${mode} — the constraint must accept it`);
});
