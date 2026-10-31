// ACC-05 batch 3 (FINAL) — guards for the last `anon` grant revocation.
//
// After this batch no table in `public` holds any privilege for `anon`, so the
// strongest guard available is a CLOSED-SET one: batch 1 + batch 2 + batch 3
// must together name every table the audit found, and no future batch should be
// needed. That is asserted below against the three migrations themselves.
//
// Run: node --experimental-strip-types --test lib/security/acc05-batch3-anon-grants.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

const M = "supabase/migrations/";
const UP = `${M}20261031000000_acc05_batch3_anon_revoke_final.sql`;
const DOWN = `${M}20261031000001_acc05_batch3_anon_revoke_final_down.sql`;
const UP_B1 = `${M}20260915300000_acc05_batch1_anon_revoke_sensitive.sql`;
const UP_B2 = `${M}20260916000000_acc05_batch2_anon_revoke_catalog_channel.sql`;

/** The audited batch, in the order the migration revokes them. */
const BATCH = [
  "agent_logs", "brands", "compliance_log", "compliance_rules", "import_batches",
  "kpi_snapshots", "loop_log", "loop_state", "loyalty_prizes", "marketing_posts",
  "product_categories", "pure_seoul_status", "rafeeq_email_deliveries",
  "rafeeq_package_items", "rafeeq_packages", "shelf_slots", "snoonu_sync_audits",
  "social_posts", "talabat_email_deliveries", "talabat_queue", "task_comments",
  "task_routines", "tasks",
] as const;

/** SQL with `--` comments stripped, so assertions never match prose. */
const sqlOnly = (src: string) => src.replace(/^\s*--.*$/gm, "");
const revokedIn = (rel: string) =>
  [...sqlOnly(read(rel)).matchAll(/REVOKE\s+ALL\s+PRIVILEGES\s+ON\s+TABLE\s+public\.(\w+)\s+FROM\s+anon\s*;/gi)]
    .map((m) => m[1]);

// ---------------------------------------------------------------- migration

test("UP revokes ALL PRIVILEGES from anon on exactly the 23 audited tables", () => {
  assert.deepEqual(revokedIn(UP), [...BATCH], "the revoke set must match the audit exactly");
  const statements = sqlOnly(read(UP)).split(";").map((s) => s.trim()).filter(Boolean);
  assert.equal(statements.length, BATCH.length, "the migration does nothing but revoke");
});

test("ALL PRIVILEGES is used, so PG17's MAINTAIN is covered", () => {
  const sql = sqlOnly(read(UP));
  assert.equal(/REVOKE\s+(SELECT|INSERT|UPDATE|DELETE|TRUNCATE|REFERENCES|TRIGGER|MAINTAIN)\b/i.test(sql), false,
    "revoke the whole ACL, never an enumerated subset");
  assert.equal((sql.match(/REVOKE\s+ALL\s+PRIVILEGES/gi) ?? []).length, BATCH.length);
});

test("UP touches anon ONLY — no other role is ever named", () => {
  const sql = sqlOnly(read(UP));
  assert.equal(/\bauthenticated\b/.test(sql), false, "ACC-02B owns authenticated; this step must not touch it");
  assert.equal(/\bservice_role\b/.test(sql), false, "every server-side workflow runs on service_role");
  assert.equal(/\bpostgres\b|\bsupabase_admin\b|\bPUBLIC\b/.test(sql), false);
});

test("UP grants nothing and changes no policy, schema, data or auth object", () => {
  const sql = sqlOnly(read(UP));
  for (const forbidden of [
    /\bGRANT\b/i, /\bCREATE\s+POLICY\b/i, /\bDROP\s+POLICY\b/i, /\bALTER\s+POLICY\b/i,
    /\bALTER\s+TABLE\b/i, /\bCREATE\s+TABLE\b/i, /\bDROP\s+TABLE\b/i,
    /\bINSERT\b/i, /\bUPDATE\b/i, /\bDELETE\b/i, /\bTRUNCATE\s+TABLE\b/i,
    /\bauth\./i, /\bstorage\./i, /\bCREATE\s+FUNCTION\b/i, /\bENABLE\s+ROW\s+LEVEL\b/i,
  ]) assert.equal(forbidden.test(sql), false, `UP must not contain ${forbidden}`);
});

test("DOWN restores exactly the same 23 tables to anon, and nothing else", () => {
  const sql = sqlOnly(read(DOWN));
  const granted = [...sql.matchAll(/GRANT\s+ALL\s+PRIVILEGES\s+ON\s+TABLE\s+public\.(\w+)\s+TO\s+anon\s*;/gi)]
    .map((m) => m[1]);
  assert.deepEqual(granted, [...BATCH], "the rollback must mirror the revoke exactly");
  assert.equal(/\bREVOKE\b/i.test(sql), false);
  assert.equal(/\bauthenticated\b|\bservice_role\b/.test(sql), false);
  assert.equal(sql.split(";").map((s) => s.trim()).filter(Boolean).length, BATCH.length);
});

// --------------------------------------------- the closed set: ACC-05 is done

test("the three ACC-05 batches are disjoint and together cover all 47 audited objects", () => {
  const b1 = revokedIn(UP_B1), b2 = revokedIn(UP_B2), b3 = revokedIn(UP);
  assert.equal(b1.length, 10, "batch 1 revoked ten");
  assert.equal(b2.length, 14, "batch 2 revoked fourteen");
  assert.equal(b3.length, 23, "batch 3 revokes twenty-three");
  const all = [...b1, ...b2, ...b3];
  assert.equal(all.length, 47, "the audit found 47 anon-granted objects");
  assert.equal(new Set(all).size, 47, "no table may appear in more than one batch");
});

// ----------------------------------------------------- the premise: no anon
//                                                        client touches these

const SKIP_DIRS = new Set(["node_modules", ".next", ".git", "dist", "build", ".turbo"]);
function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry) && !entry.includes(".test.")) out.push(full);
  }
  return out;
}
const SOURCES = ["app", "lib", "components", "scripts"].flatMap((d) => {
  try { return walk(path.join(ROOT, d)); } catch { return []; }
});

/** Every table reached by .from(...) — double, single, backtick and constant. */
function tablesTouched(src: string): Set<string> {
  const consts = new Map<string, string>();
  for (const m of src.matchAll(/\b(?:const|let|var)\s+(\w+)\s*(?::\s*[^=]+)?=\s*["'`]([a-z_]+)["'`]\s*;?/g))
    consts.set(m[1], m[2]);
  const out = new Set<string>();
  for (const m of src.matchAll(/\.from\(\s*(?:["'`]([a-z_]+)["'`]|(\w+))\s*\)/g)) {
    if (m[1]) out.add(m[1]);
    else if (m[2] && consts.has(m[2])) out.add(consts.get(m[2])!);
  }
  return out;
}
const browserClientFiles = () =>
  SOURCES.filter((f) => /from\s+["']@\/lib\/supabase\/client["']/.test(readFileSync(f, "utf8")));

test("no browser (anon-key) client touches any batch-3 table", () => {
  const offenders: string[] = [];
  for (const abs of browserClientFiles()) {
    const touched = tablesTouched(readFileSync(abs, "utf8"));
    for (const t of BATCH) if (touched.has(t)) offenders.push(`${path.relative(ROOT, abs)} -> ${t}`);
  }
  assert.deepEqual(offenders, [], "a browser client on a batch table would break on revoke");
});

test("the scanner is not vacuous — it sees all four reference forms", () => {
  assert.ok(tablesTouched(`x.from("loyalty_prizes").select()`).has("loyalty_prizes"));
  assert.ok(tablesTouched(`x.from('loyalty_prizes').select()`).has("loyalty_prizes"), "single quotes");
  assert.ok(tablesTouched('x.from(`loyalty_prizes`).select()').has("loyalty_prizes"), "backticks");
  assert.ok(tablesTouched(`const T = "social_posts";\nx.from(T).insert({})`).has("social_posts"), "constants");
  assert.ok(browserClientFiles().length > 0, "the scan must have real files to scan");
});

test("the public loyalty surface — the one truly public page — stays service-role", () => {
  const rewards = read("lib/loyalty/rewards.ts");
  assert.ok(rewards.includes("loyalty_prizes"), "this is the file that reads prizes");
  assert.ok(rewards.includes("createAdminClient"), "prizes are read on the service role");
  assert.equal(/from\s+["']@\/lib\/supabase\/(server|client)["']/.test(rewards), false,
    "no session or browser client in the public loyalty path");
});

test("every unauthenticated route still runs on the service role", () => {
  const mw = read("lib/supabase/middleware.ts");
  const list = /const PUBLIC_PATHS = \[([\s\S]*?)\];/.exec(mw)?.[1] ?? "";
  assert.deepEqual([...list.matchAll(/"([^"]+)"/g)].map((m) => m[1]),
    ["/login", "/auth", "/staff", "/rewards", "/api/cron", "/api/webhooks", "/api/rewards"],
    "a new public path needs its own anon-exposure trace before this batch stays valid");

  const publicFiles = SOURCES.filter((f) => {
    const rel = path.relative(ROOT, f).replace(/\\/g, "/");
    return /^app\/api\/(cron|webhooks|rewards)\//.test(rel) || /^app\/(rewards|staff)\//.test(rel);
  });
  assert.ok(publicFiles.length >= 15, "the public surface must be found");
  for (const abs of publicFiles) {
    assert.equal(/from\s+["']@\/lib\/supabase\/(server|client)["']/.test(readFileSync(abs, "utf8")), false,
      `${path.relative(ROOT, abs)} must not use a session or browser client`);
  }
});

test("the owner's Pure Seoul decision still holds (requireOwner, not a session check)", () => {
  const src = read("app/(app)/import-export/pure-seoul-snapshot-actions.ts");
  assert.ok(src.includes("requireOwner"));
  assert.equal(src.includes("getUser()"), false, "the bare session check must not come back");
  const body = src.replace(/^import .*$/gm, "");
  assert.ok(body.indexOf("requireOwner(") < body.indexOf("createAdminClient("));
});
