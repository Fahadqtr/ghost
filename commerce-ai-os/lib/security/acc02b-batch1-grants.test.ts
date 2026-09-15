// ACC-02B batch 1 — guards on the authenticated-grant revocation migration.
//
// The privilege change itself lives in Postgres, so what a test CAN prove here
// is that the repository's record of it stays honest and reversible:
//
//   • the up migration revokes write from `authenticated` on exactly the ten
//     audited tables, and on nothing else
//   • it never touches anon (ACC-05's subject) or service_role
//   • it replaces each permissive ALL policy with a SELECT-only one, so a future
//     re-grant cannot silently restore write access
//   • the down migration restores every table the up migration changed, by the
//     ORIGINAL policy name — an incomplete rollback is a silent trap
//   • the tables deliberately EXCLUDED stay excluded, with the code reason still
//     true in the source (a direct authenticated-client writer still exists)
//
// Run: node --conditions=react-server --experimental-strip-types --test lib/security/acc02b-batch1-grants.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

const UP_FILE = "supabase/migrations/20260915000000_acc02b_batch1_authenticated_readonly.sql";
const DOWN_FILE = "supabase/migrations/20260915000001_acc02b_batch1_authenticated_readonly_down.sql";
const UP = read(UP_FILE);
const DOWN = read(DOWN_FILE);

/** The ten audited tables, and the ALL policy each one carried before. */
const BATCH: Record<string, string | null> = {
  staff_tasks: "staff_tasks owner full access",
  product_archive: "product_archive owner full access",
  external_channel_listings: null, // already SELECT-only (ecl_select) — grant only
  shelf_slots: "shelf_slots_rw",
  task_routines: "task_routines owner full access",
  task_comments: "task_comments owner full access",
  brands: "authenticated_all_brands",
  channels: "authenticated_all_channels",
  product_categories: "authenticated_all_product_categories",
  pure_seoul_status: "ps_status_all",
};

/** Strip SQL comments so the rationale prose can neither satisfy nor break a check. */
function sql(src: string): string {
  return src.replace(/^\s*--.*$/gm, "");
}

test("migration files exist and are paired", () => {
  const files = readdirSync(path.join(ROOT, "supabase/migrations"));
  assert.ok(files.includes(path.basename(UP_FILE)), "up migration must exist");
  assert.ok(files.includes(path.basename(DOWN_FILE)), "down migration must exist");
  assert.match(DOWN, new RegExp(path.basename(UP_FILE).replace(/\./g, "\\.")),
    "the down migration must name the up migration it reverses");
});

test("up: revokes write from authenticated on exactly the ten audited tables", () => {
  const code = sql(UP);
  const revoked = [...code.matchAll(/revoke[^;]*?on public\.(\w+) from authenticated/gs)].map((m) => m[1]);
  assert.deepEqual(revoked.sort(), Object.keys(BATCH).sort(),
    "the revoke set must match the audited batch exactly — no extra table, none missing");
  // Each revoke must cover every write privilege, not just some.
  for (const m of code.matchAll(/revoke([^;]*?)on public\.(\w+) from authenticated/gs)) {
    for (const priv of ["insert", "update", "delete", "truncate", "references", "trigger"]) {
      assert.ok(m[1].includes(priv), `${m[2]}: revoke must include ${priv}`);
    }
  }
});

test("up: never touches anon or service_role, and never grants anything", () => {
  const code = sql(UP);
  assert.doesNotMatch(code, /\banon\b/, "anon grants are ACC-05's subject — not this batch");
  assert.doesNotMatch(code, /\bservice_role\b/, "service_role must keep every privilege");
  assert.doesNotMatch(code, /^\s*grant\b/im, "a hardening migration must not widen any privilege");
});

test("up: touches no schema, data, function or auth setting", () => {
  const code = sql(UP);
  for (const forbidden of [
    /\bcreate table\b/i, /\balter table\b/i, /\bdrop table\b/i, /\btruncate\b\s+public\./i,
    /\bcreate index\b/i, /\bdrop index\b/i, /\badd constraint\b/i, /\bdrop constraint\b/i,
    /\bcreate trigger\b/i, /\bcreate (or replace )?function\b/i,
    /\binsert into\b/i, /\bupdate\s+public\./i, /\bdelete from\b/i, /\bauth\./i,
  ]) {
    assert.doesNotMatch(code, forbidden, `up migration must not contain ${forbidden}`);
  }
});

test("up: each permissive ALL policy is replaced by a SELECT-only policy", () => {
  const code = sql(UP);
  for (const [table, oldPolicy] of Object.entries(BATCH)) {
    if (oldPolicy === null) {
      // external_channel_listings was already SELECT-only: grant change only.
      assert.doesNotMatch(code, new RegExp(`policy[^;]*on public\\.${table}`),
        `${table}'s policy was already SELECT-only and must not be rewritten`);
      continue;
    }
    assert.ok(code.includes(`drop policy if exists "${oldPolicy}" on public.${table}`),
      `${table}: the permissive ALL policy must be dropped by its exact name`);
    const created = new RegExp(
      `create policy "${table}_select_authenticated"\\s+on public\\.${table} for select to authenticated using \\(true\\)`);
    assert.match(code, created, `${table}: a SELECT-only replacement policy must be created`);
  }
  // No replacement policy may permit writes.
  assert.doesNotMatch(code, /create policy[^;]*for all/i, "no ALL policy may be created");
  assert.doesNotMatch(code, /with check/i, "a SELECT-only policy has no WITH CHECK");
});

test("down: restores every table the up migration changed, by its ORIGINAL policy name", () => {
  const code = sql(DOWN);
  const granted = [...code.matchAll(/grant[^;]*?on public\.(\w+) to authenticated/gs)].map((m) => m[1]);
  assert.deepEqual(granted.sort(), Object.keys(BATCH).sort(),
    "the rollback must restore exactly the tables the up migration revoked");
  for (const [table, oldPolicy] of Object.entries(BATCH)) {
    if (oldPolicy === null) {
      assert.doesNotMatch(code, new RegExp(`create policy[^;]*on public\\.${table}`),
        `${table}'s policy was never changed, so the rollback must not recreate one`);
      continue;
    }
    assert.ok(code.includes(`create policy "${oldPolicy}"`),
      `${table}: rollback must restore the ORIGINAL policy name "${oldPolicy}"`);
    assert.ok(code.includes(`drop policy if exists "${table}_select_authenticated"`),
      `${table}: rollback must remove the SELECT-only policy it replaces`);
  }
  assert.doesNotMatch(code, /\banon\b/, "the up migration did not change anon, so the rollback must not either");
});

test("down: restores the same privilege set the up migration removed", () => {
  for (const m of sql(DOWN).matchAll(/grant([^;]*?)on public\.(\w+) to authenticated/gs)) {
    for (const priv of ["insert", "update", "delete", "truncate", "references", "trigger"]) {
      assert.ok(m[1].includes(priv), `${m[2]}: rollback must restore ${priv}`);
    }
  }
});

// ---------------------------------------------------------------------------
// The excluded tables stay excluded — and the reason stays true
// ---------------------------------------------------------------------------

/**
 * Tables held back because a DIRECT authenticated-client writer still exists.
 * Each entry names a file that still performs that write, so if the code is
 * migrated to the service role this test fails and prompts the next batch.
 */
const HELD_BACK: Record<string, string> = {
  products: "app/(app)/products/actions.ts",
  product_images: "app/(v2)/v2/catalog/new/actions.ts",
  channel_products: "app/(app)/channels/actions.ts",
  platform_status: "app/(app)/platforms/actions.ts",
  agent_logs: "app/(app)/agents/actions.ts",
};

test("held-back tables are absent from this batch", () => {
  const code = sql(UP);
  for (const table of Object.keys(HELD_BACK)) {
    assert.doesNotMatch(code, new RegExp(`on public\\.${table}\\b`),
      `${table} still has a direct authenticated writer — it must not be in batch 1`);
  }
});

test("held-back tables still have the direct authenticated writer that justifies holding them", () => {
  for (const [table, file] of Object.entries(HELD_BACK)) {
    const src = read(file);
    assert.match(src, /from "@\/lib\/supabase\/server"/,
      `${file} should still import the authenticated client`);
    assert.match(src, new RegExp(`from\\("${table}"\\)`),
      `${file} should still reference ${table} — if this moved to the service role, add ${table} to the next batch`);
  }
});

test("malak_audit, export_runs and platform_snapshots are left to their open decisions", () => {
  const code = sql(UP);
  for (const table of ["malak_audit", "export_runs", "platform_snapshots"]) {
    assert.doesNotMatch(code, new RegExp(`public\\.${table}\\b`),
      `${table} is blocked on an owner decision (D-3 / D-5) and must not be touched here`);
  }
});

test("ACC-02A's three tables are not re-touched", () => {
  const code = sql(UP);
  for (const table of ["customers", "orders", "expenses"]) {
    assert.doesNotMatch(code, new RegExp(`public\\.${table}\\b`),
      `${table} was already fixed in ACC-02A — this batch is verification-only for it`);
  }
});
