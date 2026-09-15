// ACC-05 batch 1 — guards for the `anon` grant revocation on the ten
// credential-bearing / customer-PII tables.
//
// The privilege change itself lives in Postgres, so these tests do two things
// the database cannot: they keep the repository's RECORD of the change honest
// (exact table set, anon only, nothing granted, no policy touched), and they
// keep the PREMISE honest — that no anon-key client anywhere in the app reads
// or writes these tables.
//
// The premise scan resolves single-quoted, double-quoted AND constant table
// references. The single-quote case is not hypothetical: the ACC-02B batch 1-3
// scanners matched only .from("double") and so could not see
// app/(app)/catalog/health/page.tsx, which does .from('products').update(...)
// on the browser client. That page is unreachable (middleware canonically
// redirects /catalog/health to /v2/operations/health), but the blind spot was
// real and must not recur.
//
// Run: node --experimental-strip-types --test lib/security/acc05-batch1-anon-grants.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

const UP = "supabase/migrations/20260915300000_acc05_batch1_anon_revoke_sensitive.sql";
const DOWN = "supabase/migrations/20260915300001_acc05_batch1_anon_revoke_sensitive_down.sql";

/** The audited batch, in the order the migration revokes them. */
const BATCH = [
  "shopify_tokens",
  "staff_members",
  "push_subscriptions",
  "app_settings",
  "loyalty_customers",
  "loyalty_submissions",
  "dm_conversations",
  "dm_messages",
  "shopify_synced_orders",
  "talabat_orders",
] as const;

/** SQL with `--` comments stripped, so assertions never match prose. */
function sqlOnly(src: string): string {
  return src.replace(/^\s*--.*$/gm, "");
}

// ---------------------------------------------------------------- migration

test("UP revokes ALL PRIVILEGES from anon on exactly the ten audited tables", () => {
  const sql = sqlOnly(read(UP));
  const revoked = [...sql.matchAll(/REVOKE\s+ALL\s+PRIVILEGES\s+ON\s+TABLE\s+public\.(\w+)\s+FROM\s+anon\s*;/gi)]
    .map((m) => m[1]);
  assert.deepEqual(revoked, [...BATCH], "the revoke set must match the audit exactly");
  // No other statement of any kind.
  const statements = sql.split(";").map((s) => s.trim()).filter(Boolean);
  assert.equal(statements.length, BATCH.length, "the migration does nothing but revoke");
});

test("UP touches anon ONLY — authenticated and service_role are never named", () => {
  const sql = sqlOnly(read(UP));
  assert.equal(/\bauthenticated\b/.test(sql), false, "ACC-02B owns authenticated; this step must not touch it");
  assert.equal(/\bservice_role\b/.test(sql), false, "every server-side workflow runs on service_role");
  assert.equal(/\bpostgres\b|\bsupabase_admin\b|\bPUBLIC\b/.test(sql), false);
});

test("UP grants nothing and changes no policy, schema, data or auth object", () => {
  const sql = sqlOnly(read(UP));
  for (const forbidden of [
    /\bGRANT\b/i,
    /\bCREATE\s+POLICY\b/i, /\bDROP\s+POLICY\b/i, /\bALTER\s+POLICY\b/i,
    /\bALTER\s+TABLE\b/i, /\bCREATE\s+TABLE\b/i, /\bDROP\s+TABLE\b/i,
    /\bINSERT\b/i, /\bUPDATE\b/i, /\bDELETE\b/i, /\bTRUNCATE\s+TABLE\b/i,
    /\bauth\./i, /\bstorage\./i, /\bCREATE\s+FUNCTION\b/i, /\bENABLE\s+ROW\s+LEVEL\b/i,
  ]) {
    assert.equal(forbidden.test(sql), false, `UP must not contain ${forbidden}`);
  }
});

test("DOWN restores exactly the same ten tables to anon, and nothing else", () => {
  const sql = sqlOnly(read(DOWN));
  const granted = [...sql.matchAll(/GRANT\s+ALL\s+PRIVILEGES\s+ON\s+TABLE\s+public\.(\w+)\s+TO\s+anon\s*;/gi)]
    .map((m) => m[1]);
  assert.deepEqual(granted, [...BATCH], "the rollback must mirror the revoke exactly");
  assert.equal(/\bREVOKE\b/i.test(sql), false);
  assert.equal(/\bauthenticated\b|\bservice_role\b/.test(sql), false);
  const statements = sql.split(";").map((s) => s.trim()).filter(Boolean);
  assert.equal(statements.length, BATCH.length);
});

test("ACC-02B's three batches are not re-touched by this migration", () => {
  const sql = sqlOnly(read(UP)) + sqlOnly(read(DOWN));
  for (const earlier of ["staff_tasks", "product_archive", "external_channel_listings", "products",
                         "product_images", "channel_products", "platform_status", "agent_logs",
                         "malak_audit", "export_runs", "platform_snapshots"]) {
    assert.equal(new RegExp(`\\b${earlier}\\b`).test(sql), false,
      `${earlier} belongs to an earlier step and must not be re-touched here`);
  }
});

// ----------------------------------------------------- the premise: no anon
//                                                        client reads these

const SKIP_DIRS = new Set(["node_modules", ".next", ".git", "dist", "build", ".turbo"]);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry) && !entry.includes(".test.")) out.push(full);
  }
  return out;
}

const SOURCES = ["app", "lib", "components", "scripts"]
  .flatMap((d) => {
    try { return walk(path.join(ROOT, d)); } catch { return []; }
  });

/** Resolve `const X = "table"` so .from(X) is visible, then find every table
 *  name reached by .from(...) in a file — single quotes, double quotes, backticks
 *  and constants alike. */
function tablesTouched(src: string): Set<string> {
  const consts = new Map<string, string>();
  for (const m of src.matchAll(/\b(?:const|let|var)\s+(\w+)\s*(?::\s*[^=]+)?=\s*["'`]([a-z_]+)["'`]\s*;/g)) {
    consts.set(m[1], m[2]);
  }
  const out = new Set<string>();
  for (const m of src.matchAll(/\.from\(\s*(?:["'`]([a-z_]+)["'`]|(\w+))\s*\)/g)) {
    if (m[1]) out.add(m[1]);
    else if (m[2] && consts.has(m[2])) out.add(consts.get(m[2])!);
  }
  return out;
}

/** Files that build the browser (anon-key) Supabase client. */
function browserClientFiles(): string[] {
  return SOURCES.filter((f) => /from\s+["']@\/lib\/supabase\/client["']/.test(readFileSync(f, "utf8")));
}

test("no browser (anon-key) client touches any table in this batch", () => {
  const offenders: string[] = [];
  for (const abs of browserClientFiles()) {
    const touched = tablesTouched(readFileSync(abs, "utf8"));
    for (const t of BATCH) {
      if (touched.has(t)) offenders.push(`${path.relative(ROOT, abs)} -> ${t}`);
    }
  }
  assert.deepEqual(offenders, [], "a browser client reaching a batch table would break on revoke");
});

test("the browser-client scanner is not vacuous — it sees BOTH quote styles and constants", () => {
  // Proves the ACC-02B blind spot is closed: each form must be detected.
  assert.ok(tablesTouched(`x.from("staff_members").select()`).has("staff_members"));
  assert.ok(tablesTouched(`x.from('staff_members').select()`).has("staff_members"), "single quotes must be seen");
  assert.ok(tablesTouched('x.from(`staff_members`).select()').has("staff_members"));
  assert.ok(tablesTouched(`const T = "staff_members";\nx.from(T).insert({})`).has("staff_members"),
    "constant-referenced tables must be resolved");
  // And that it actually found the real browser-client files rather than none.
  assert.ok(browserClientFiles().length > 0, "the scan must have real files to scan");
});

// --------------------------------------------- the premise: public routes
//                                                run on the service role

test("every unauthenticated path is still service-role or auth-only (no anon Data API)", () => {
  const mw = read("lib/supabase/middleware.ts");
  // The public allow-list is what makes a route reachable without a session.
  const list = /const PUBLIC_PATHS = \[([\s\S]*?)\];/.exec(mw)?.[1] ?? "";
  const paths = [...list.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(paths, ["/login", "/auth", "/staff", "/rewards", "/api/cron", "/api/webhooks", "/api/rewards"],
    "a new public path needs its own anon-exposure trace before this batch stays valid");

  // Route handlers under the public API prefixes must never build a session
  // client — a session client with no cookie IS the anon role.
  const publicApi = SOURCES.filter((f) => {
    const rel = path.relative(ROOT, f).replace(/\\/g, "/");
    return /^app\/api\/(cron|webhooks|rewards)\//.test(rel);
  });
  assert.ok(publicApi.length >= 6, "the public API routes must be found");
  for (const abs of publicApi) {
    const src = readFileSync(abs, "utf8");
    assert.equal(/from\s+["']@\/lib\/supabase\/server["']/.test(src), false,
      `${path.relative(ROOT, abs)} must not use the cookie/session client`);
    assert.equal(/from\s+["']@\/lib\/supabase\/client["']/.test(src), false,
      `${path.relative(ROOT, abs)} must not use the browser client`);
  }
});

test("the public loyalty surface writes only through the service role", () => {
  const rewards = read("lib/loyalty/rewards.ts");
  assert.ok(rewards.includes("createAdminClient"), "loyalty writes run on the service role");
  assert.equal(/from\s+["']@\/lib\/supabase\/(server|client)["']/.test(rewards), false,
    "no session or browser client in the public loyalty path");
});
