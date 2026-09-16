// ACC-05 batch 2 — guards for the `anon` grant revocation on the catalog,
// channel, audit and job tables.
//
// The privilege change lives in Postgres, so these tests do the two things the
// database cannot: keep the repository's RECORD of it honest (exact table set,
// anon only, nothing granted, no policy touched), and keep the PREMISE honest —
// that no anon-key client reads or writes these tables, and that no view or RPC
// exposes them indirectly.
//
// Run: node --experimental-strip-types --test lib/security/acc05-batch2-anon-grants.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

const UP = "supabase/migrations/20260916000000_acc05_batch2_anon_revoke_catalog_channel.sql";
const DOWN = "supabase/migrations/20260916000001_acc05_batch2_anon_revoke_catalog_channel_down.sql";

/** The audited batch, in the order the migration revokes them. */
const BATCH = [
  "products",
  "product_images",
  "product_archive",
  "channel_products",
  "channel_variant_mappings",
  "channels",
  "external_channel_listings",
  "platform_status",
  "platform_snapshots",
  "malak_audit",
  "export_runs",
  "rafeeq_package_jobs",
  "talabat_package_jobs",
  "staff_tasks",
] as const;

/** Batch 1's ten — already revoked, must not be re-touched here. */
const BATCH_1 = [
  "shopify_tokens", "staff_members", "push_subscriptions", "app_settings",
  "loyalty_customers", "loyalty_submissions", "dm_conversations", "dm_messages",
  "shopify_synced_orders", "talabat_orders",
] as const;

/** SQL with `--` comments stripped, so assertions never match prose. */
function sqlOnly(src: string): string {
  return src.replace(/^\s*--.*$/gm, "");
}

// ---------------------------------------------------------------- migration

test("UP revokes ALL PRIVILEGES from anon on exactly the fourteen audited tables", () => {
  const sql = sqlOnly(read(UP));
  const revoked = [...sql.matchAll(/REVOKE\s+ALL\s+PRIVILEGES\s+ON\s+TABLE\s+public\.(\w+)\s+FROM\s+anon\s*;/gi)]
    .map((m) => m[1]);
  assert.deepEqual(revoked, [...BATCH], "the revoke set must match the audit exactly");
  const statements = sqlOnly(read(UP)).split(";").map((s) => s.trim()).filter(Boolean);
  assert.equal(statements.length, BATCH.length, "the migration does nothing but revoke");
});

test("ALL PRIVILEGES is used, so PG17's MAINTAIN is covered too", () => {
  const sql = sqlOnly(read(UP));
  // An enumerated list would silently leave MAINTAIN (and any future privilege)
  // behind; ALL PRIVILEGES is what makes the target "anon holds nothing".
  assert.equal(/REVOKE\s+SELECT|REVOKE\s+INSERT|REVOKE\s+UPDATE|REVOKE\s+DELETE/i.test(sql), false,
    "revoke the whole ACL, never an enumerated subset");
  assert.equal((sql.match(/REVOKE\s+ALL\s+PRIVILEGES/gi) ?? []).length, BATCH.length);
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

test("DOWN restores exactly the same fourteen tables to anon, and nothing else", () => {
  const sql = sqlOnly(read(DOWN));
  const granted = [...sql.matchAll(/GRANT\s+ALL\s+PRIVILEGES\s+ON\s+TABLE\s+public\.(\w+)\s+TO\s+anon\s*;/gi)]
    .map((m) => m[1]);
  assert.deepEqual(granted, [...BATCH], "the rollback must mirror the revoke exactly");
  assert.equal(/\bREVOKE\b/i.test(sql), false);
  assert.equal(/\bauthenticated\b|\bservice_role\b/.test(sql), false);
  assert.equal(sql.split(";").map((s) => s.trim()).filter(Boolean).length, BATCH.length);
});

test("batch 1's ten are not re-touched, and the two batches do not overlap", () => {
  const sql = sqlOnly(read(UP)) + sqlOnly(read(DOWN));
  for (const earlier of BATCH_1) {
    assert.equal(new RegExp(`\\b${earlier}\\b`).test(sql), false,
      `${earlier} was revoked by batch 1 and must not be re-touched here`);
  }
  const overlap = BATCH.filter((t) => (BATCH_1 as readonly string[]).includes(t));
  assert.deepEqual(overlap, [], "no table may appear in both batches");
});

// ----------------------------------------------------- the premise: no anon
//                                                        client touches these

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

/** Every table reached by .from(...) in a file — double, single, backtick and
 *  constant-resolved alike. Prior steps were burned twice by a scanner that saw
 *  only one form, so all four are resolved and proven below. */
function tablesTouched(src: string): Set<string> {
  const consts = new Map<string, string>();
  for (const m of src.matchAll(/\b(?:const|let|var)\s+(\w+)\s*(?::\s*[^=]+)?=\s*["'`]([a-z_]+)["'`]\s*;?/g)) {
    consts.set(m[1], m[2]);
  }
  const out = new Set<string>();
  for (const m of src.matchAll(/\.from\(\s*(?:["'`]([a-z_]+)["'`]|(\w+))\s*\)/g)) {
    if (m[1]) out.add(m[1]);
    else if (m[2] && consts.has(m[2])) out.add(consts.get(m[2])!);
  }
  return out;
}

const browserClientFiles = () =>
  SOURCES.filter((f) => /from\s+["']@\/lib\/supabase\/client["']/.test(readFileSync(f, "utf8")));

/** The one browser-client file that touches batch tables. It is NOT an anon
 *  consumer: the page sits behind the app's auth gate (so its role is
 *  `authenticated`), and middleware canonically redirects it away, so it is
 *  unreachable. Both of those facts are pinned below — if either stops being
 *  true, this exemption must be re-argued rather than silently inherited. */
const KNOWN_UNREACHABLE = "app/(app)/catalog/health/page.tsx";

test("no browser (anon-key) client touches a batch table, except the pinned unreachable page", () => {
  const offenders: string[] = [];
  for (const abs of browserClientFiles()) {
    const rel = path.relative(ROOT, abs).replace(/\\/g, "/");
    if (rel === KNOWN_UNREACHABLE) continue;
    const touched = tablesTouched(readFileSync(abs, "utf8"));
    for (const t of BATCH) if (touched.has(t)) offenders.push(`${rel} -> ${t}`);
  }
  assert.deepEqual(offenders, [], "a live browser client on a batch table would break on revoke");
});

test("the exemption is still justified — the page is redirected away by middleware", () => {
  const redirect = read("lib/v2/legacy-redirect.ts");
  assert.ok(redirect.includes('"/catalog/health"'), "the legacy path must still be recognised");
  assert.ok(/pathname === "\/catalog\/health"\s*\)\s*return\s*\{\s*pathname:\s*"\/v2\/operations\/health"/.test(redirect),
    "/catalog/health must still resolve to the V2 page, making the legacy page unreachable");
  // And it must stay a signed-in-only path: it is not on the public allow-list.
  const mw = read("lib/supabase/middleware.ts");
  const list = /const PUBLIC_PATHS = \[([\s\S]*?)\];/.exec(mw)?.[1] ?? "";
  assert.equal(/catalog/.test(list), false, "/catalog must never become a public path");
});

test("the scanner is not vacuous — it sees all four reference forms", () => {
  assert.ok(tablesTouched(`x.from("platform_status").select()`).has("platform_status"));
  assert.ok(tablesTouched(`x.from('platform_status').select()`).has("platform_status"), "single quotes");
  assert.ok(tablesTouched('x.from(`platform_status`).select()').has("platform_status"), "backticks");
  assert.ok(tablesTouched(`const T = "platform_snapshots";\nx.from(T).insert({})`).has("platform_snapshots"),
    "constant-referenced tables must be resolved");
  assert.ok(browserClientFiles().length > 0, "the scan must have real files to scan");
});

// ------------------------------------------- the premise: public routes and
//                                              the owner gate are unchanged

test("every unauthenticated path is still service-role or auth-only (no anon Data API)", () => {
  const mw = read("lib/supabase/middleware.ts");
  const list = /const PUBLIC_PATHS = \[([\s\S]*?)\];/.exec(mw)?.[1] ?? "";
  const paths = [...list.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(paths, ["/login", "/auth", "/staff", "/rewards", "/api/cron", "/api/webhooks", "/api/rewards"],
    "a new public path needs its own anon-exposure trace before this batch stays valid");

  const publicApi = SOURCES.filter((f) =>
    /^app\/api\/(cron|webhooks|rewards)\//.test(path.relative(ROOT, f).replace(/\\/g, "/")));
  assert.ok(publicApi.length >= 6, "the public API routes must be found");
  for (const abs of publicApi) {
    const src = readFileSync(abs, "utf8");
    assert.equal(/from\s+["']@\/lib\/supabase\/(server|client)["']/.test(src), false,
      `${path.relative(ROOT, abs)} must not use a session or browser client`);
  }
});

test("STEP 16 owner decision: the Pure Seoul capture gate stays requireOwner", () => {
  const src = read("app/(app)/import-export/pure-seoul-snapshot-actions.ts");
  assert.ok(src.includes("requireOwner"), "the gate the owner confirmed must remain");
  assert.equal(src.includes("getUser()"), false, "the bare session check must not come back");
  const body = src.replace(/^import .*$/gm, "");
  assert.ok(body.indexOf("requireOwner(") < body.indexOf("createAdminClient("),
    "a denied call must never construct the service-role client");
});
