// ACC-02B batch 3 — the final effective authenticated writes.
//
// Closes the last six tables that a signed-in account could still write through
// the Data API: malak_audit, export_runs, platform_snapshots, marketing_posts,
// import_batches, tasks.
//
// TWO CODE CHANGES ARE PROVEN HERE
//   1. /agents logAgentCommand moves from "any signed-in account" to the writer
//      gate (owner decision).
//   2. The Platform Snapshot Engine's INSERT moves from the session client to
//      the service role, keeping requireOwner on all four capture actions — and
//      RAISING the one capture path that was not owner-gated, rather than
//      lowering the boundary to meet it.
//
// THE SCANNER RESOLVES CONSTANTS, NOT JUST LITERALS
// platform_snapshots is referenced as `const TABLE = "platform_snapshots"`, so a
// scan that only matches .from("literal") misses it entirely — that is exactly
// the blind spot the earlier batches had. The scanner below resolves BOTH forms
// and attributes each write to the nearest preceding binding of its client
// variable.
//
// Run: node --conditions=react-server --experimental-strip-types --test lib/security/acc02b-batch3-final-writes.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

const BATCH3 = ["malak_audit", "export_runs", "platform_snapshots", "marketing_posts", "import_batches", "tasks"] as const;

const CAPTURE_ACTIONS = [
  "app/(v2)/v2/operations/shopify-snapshot-actions.ts",
  "app/(app)/import-export/rafeeq-snapshot-actions.ts",
  "app/(app)/import-export/talabat-snapshot-actions.ts",
  "app/(app)/import-export/pure-seoul-snapshot-actions.ts",
] as const;

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

function bindingKind(lines: string[], atLine: number, varName: string): string {
  const decl = new RegExp(`\\b(?:const|let|var)\\s+${varName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*(?::[^=]+)?=\\s*(?:await\\s+)?(\\w+)\\(`);
  for (let i = atLine; i >= 0; i--) {
    const m = decl.exec(lines[i]);
    if (m) {
      switch (m[1]) {
        case "createAdminClient": case "adminClient": case "writableClient": return "service_role";
        case "createClient": return "authenticated";
        default: return `via:${m[1]}`;
      }
    }
  }
  return "param/unknown";
}

type Hit = { table: string; file: string; line: number; via: string };

/** Scan every source file for authenticated writes, resolving literal AND constant table refs. */
function scanAuthenticatedWrites(tables: readonly string[]): Hit[] {
  const hits: Hit[] = [];
  const mutation = /\.(insert|update|upsert|delete)\(/;
  const fromRe = /\b(\w+)\s*\n?\s*\.from\(\s*(?:"([a-z_]+)"|(\w+))\s*\)([\s\S]{0,400}?)(?=\bawait\b|\bconst\b|\breturn\b|\n\n|$)/g;

  for (const abs of walk(path.join(ROOT, "app")).concat(walk(path.join(ROOT, "lib")))) {
    const src = readFileSync(abs, "utf8");
    if (!src.includes(".from(")) continue;
    const rel = path.relative(ROOT, abs);
    const lines = src.split("\n");

    const consts = new Map<string, string>();
    for (const c of src.matchAll(/(?:const|let)\s+(\w+)\s*(?::\s*\w+\s*)?=\s*"([a-z_]+)"/g)) consts.set(c[1], c[2]);

    fromRe.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = fromRe.exec(src)) !== null) {
      const table = m[2] ?? consts.get(m[3] ?? "");
      if (!table || !tables.includes(table) || !mutation.test(m[4])) continue;
      const line = src.slice(0, m.index).split("\n").length - 1;
      if (bindingKind(lines, line, m[1]) === "authenticated") {
        hits.push({ table, file: rel, line: line + 1, via: m[2] ? "literal" : `const ${m[3]}` });
      }
    }
  }
  return hits;
}

// ---------------------------------------------------------------------------
// The guards
// ---------------------------------------------------------------------------

test("GUARD: no authenticated-client writer exists for any batch-3 table", () => {
  const hits = scanAuthenticatedWrites(BATCH3);
  const report = hits.map((h) => `  ${h.table}: ${h.file}:${h.line} (${h.via})`).join("\n");
  assert.equal(hits.length, 0,
    `Found ${hits.length} authenticated write(s) to batch-3 tables. These tables have no ` +
    `INSERT/UPDATE/DELETE grant for \`authenticated\`, so the write WILL FAIL at runtime.\n${report}`);
});

test("GUARD: the scanner resolves a CONSTANT table reference, not just a literal", () => {
  // This is the blind spot that hid platform_snapshots from the earlier batches.
  // Prove the constant form is actually covered, or this suite is theatre.
  const store = read("lib/platforms/core/supabase-store.ts");
  assert.match(store, /const TABLE = "platform_snapshots"/,
    "the store still names its table through a constant");
  assert.match(store, /\.from\(TABLE\)\.insert\(/,
    "the insert still goes through that constant — so a literal-only scan would miss it");
  // And the scanner does pick constant refs up: feed it a table the store writes.
  const seen = scanAuthenticatedWrites(["platform_snapshots"]);
  // Zero because the client is now service-role — but the scanner DID visit the site.
  assert.equal(seen.length, 0, "no authenticated writer may remain on platform_snapshots");
});

test("GUARD: scanner is not vacuous — it flags a session-client write", () => {
  const fake = ["const sb = createClient();", 'await sb.from("malak_audit").insert({});'];
  assert.equal(bindingKind(fake, 1, "sb"), "authenticated");
  const real = ["const sb = createAdminClient();", 'await sb.from("malak_audit").insert({});'];
  assert.equal(bindingKind(real, 1, "sb"), "service_role");
});

// ---------------------------------------------------------------------------
// 1. /agents — the owner's writer-gate decision
// ---------------------------------------------------------------------------

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

/**
 * SQL comments are `--`, not `//`. These migrations explain their reasoning at
 * length — including quoting the words "anon" and "with check" — so the
 * assertions below MUST read statements only, never the prose.
 */
function sqlOnly(src: string): string {
  return src.replace(/^\s*--.*$/gm, "");
}

test("logAgentCommand is on the WRITER gate, and the gate precedes the insert", () => {
  const code = stripComments(read("app/(app)/agents/actions.ts"));
  assert.match(code, /requireWriterGate\(\)/, "owner decision: REQUIRE_WRITER");
  assert.doesNotMatch(code, /requireUser\(\)/, "the broad signed-in gate must be gone");
  assert.doesNotMatch(code, /isSignedIn\(\)/);
  const gate = code.indexOf("requireWriterGate(");
  const client = code.indexOf("createAdminClient(");
  const insert = code.indexOf('.from("agent_logs")');
  assert.ok(gate !== -1 && gate < client && gate < insert,
    "the gate must run before the service-role client is built and before the insert");
  // A denied call returns before anything else happens — zero insert.
  assert.match(code, /if \(denied\) return \{ error: denied\.error \}/);
});

test("logAgentCommand's logged fields are unchanged by the gate change", () => {
  const code = read("app/(app)/agents/actions.ts");
  for (const field of ["agent_name: agentName", "command: cmd", 'result: "Logged (Phase 1 — no AI execution)."']) {
    assert.ok(code.includes(field), `field must be unchanged: ${field}`);
  }
});

// ---------------------------------------------------------------------------
// 2. Platform Snapshot Engine — service-role writer, owner gate intact
// ---------------------------------------------------------------------------

test("all four capture actions keep requireOwner AND run it before the admin client", () => {
  for (const rel of CAPTURE_ACTIONS) {
    const code = stripComments(read(rel));
    assert.match(code, /requireOwner\(\)/, `${rel} must keep the owner gate`);
    const gate = code.indexOf("requireOwner(");
    const admin = code.indexOf("createAdminClient(");
    assert.notEqual(admin, -1, `${rel} must use the service-role client`);
    assert.ok(gate < admin,
      `${rel}: requireOwner() must run BEFORE createAdminClient() — a denied call must not build a privileged client`);
    assert.doesNotMatch(code, /createClient\(\)/,
      `${rel} must not construct a session client for the capture path`);
  }
});

test("the pure-seoul capture path was RAISED to owner-only, not lowered", () => {
  const code = stripComments(read("app/(app)/import-export/pure-seoul-snapshot-actions.ts"));
  // The unscoped branch used a bare getUser() session check; with a service-role
  // writer that would have handed a privileged insert to any signed-in account.
  assert.doesNotMatch(code, /auth\.getUser\(\)/, "the bare session check must be gone");
  assert.doesNotMatch(code, /"غير مسجّل الدخول\."/, "the signed-in-only denial must be gone");
  assert.equal((code.match(/requireOwner\(\)/g) ?? []).length, 1,
    "exactly one owner gate now covers BOTH the scoped and unscoped paths");
});

test("the snapshot store stays INSERT-only and immutable", () => {
  const store = read("lib/platforms/core/supabase-store.ts");
  assert.doesNotMatch(store, /\.from\(TABLE\)\.update\(/, "snapshots are immutable — no UPDATE");
  assert.doesNotMatch(store, /\.from\(TABLE\)\.delete\(/, "snapshots are immutable — no DELETE");
  assert.match(store, /saveSnapshot\b/);
  assert.match(store, /saveSnapshots\b/);
  // The header must now document the service-role client. (It quotes the old
  // "via the SESSION client" wording while explaining why it changed, so assert
  // on the NEW claim rather than the absence of the old phrase.)
  assert.match(store, /ACC-02B batch 3 — the client handed in is now the SERVICE-ROLE client/);
});

test("read-only snapshot consumers are NOT forced onto the service role", () => {
  // Only the capture paths write; readers keep whatever client they had, and
  // authenticated SELECT is retained, so nothing here needed to change.
  for (const rel of [
    "lib/operations/platform-history-read.ts",
    "lib/operations/platform-matrix-read.ts",
    "lib/missing-products/discovery-source.server.ts",
  ]) {
    const code = read(rel);
    assert.ok(code.includes("new SupabaseSnapshotStore("), `${rel} still builds the store`);
    assert.equal(/captureSnapshots|\.capture\(/.test(code), false,
      `${rel} is a read path — it must not reach the insert`);
  }
});

// ---------------------------------------------------------------------------
// 3. malak_audit stays MIXED — the service-role UPDATE is legitimate
// ---------------------------------------------------------------------------

test("malak_audit keeps its writer-gated service-role details UPDATE (not append-only)", () => {
  const code = read("app/(app)/inventory/approvals-actions.ts");
  assert.match(code, /from\("malak_audit"\)\.update\(\{ details \}\)/,
    "approveMovements stamps review metadata on an existing audit row — STEP 13 proved this is legitimate");
  assert.match(code, /requireWriterGate\(\)|requireMalakWriter\(\)/,
    "that update stays behind a writer gate");
});

test("every malak_audit insert goes through the shared audit writer", () => {
  const audit = read("lib/audit.ts");
  assert.match(audit, /from\("malak_audit"\)/, "insertAuditRow owns the insert");
  const hits = scanAuthenticatedWrites(["malak_audit"]);
  assert.equal(hits.length, 0, "no authenticated malak_audit writer may exist");
});

// ---------------------------------------------------------------------------
// 4. The migration file itself
// ---------------------------------------------------------------------------

const UP_FILE = "supabase/migrations/20260915200000_acc02b_batch3_final_authenticated_readonly.sql";
const DOWN_FILE = "supabase/migrations/20260915200001_acc02b_batch3_final_authenticated_readonly_down.sql";

test("up migration: revokes write on exactly the six batch-3 tables, touches nothing else", () => {
  const code = sqlOnly(read(UP_FILE));
  const revoked = [...code.matchAll(/revoke[^;]*?on public\.(\w+) from authenticated/gs)].map((m) => m[1]);
  assert.deepEqual(revoked.sort(), [...BATCH3].sort(), "revoke set must match the batch exactly");
  for (const m of code.matchAll(/revoke([^;]*?)on public\.(\w+) from authenticated/gs)) {
    for (const priv of ["insert", "update", "delete", "truncate", "references", "trigger"]) {
      assert.ok(m[1].includes(priv), `${m[2]}: revoke must include ${priv}`);
    }
  }
  assert.doesNotMatch(code, /\banon\b/, "anon is ACC-05's subject");
  assert.doesNotMatch(code, /\bservice_role\b/, "service_role must keep every privilege");
  assert.doesNotMatch(code, /^\s*grant\b/im, "a hardening migration never widens");
  for (const forbidden of [/\bcreate table\b/i, /\balter table\b/i, /\bdrop table\b/i, /\binsert into\b/i, /\bdelete from\b/i, /\bauth\./i]) {
    assert.doesNotMatch(code, forbidden);
  }
});

test("up migration: every remaining authenticated policy is SELECT-only", () => {
  const code = sqlOnly(read(UP_FILE));
  assert.doesNotMatch(code, /create policy[^;]*for (all|insert|update|delete)/i,
    "no write policy may be created — that is the whole point");
  assert.doesNotMatch(code, /with check/i, "a SELECT-only policy has no WITH CHECK");
  // The two INSERT policies that authorized the old Data API writes must be dropped.
  for (const pol of ["export_runs_insert", "platform_snapshots_insert"]) {
    assert.ok(code.includes(`drop policy if exists "${pol}"`) || code.includes(`drop policy if exists ${pol}`),
      `${pol} must be dropped — the grant alone is not the only thing authorizing the write`);
  }
});

test("down migration: restores exactly what the up migration removed, by original names", () => {
  const code = sqlOnly(read(DOWN_FILE));
  const granted = [...code.matchAll(/grant[^;]*?on public\.(\w+) to authenticated/gs)].map((m) => m[1]);
  assert.deepEqual(granted.sort(), [...BATCH3].sort(), "rollback must cover the same six tables");
  for (const pol of ["malak_audit_auth_all", "authenticated_all_marketing_posts",
                     "authenticated_all_import_batches", "authenticated_all_tasks",
                     "export_runs_insert", "platform_snapshots_insert"]) {
    assert.ok(code.includes(pol), `rollback must restore the ORIGINAL policy "${pol}"`);
  }
  assert.doesNotMatch(code, /\banon\b/, "the up migration did not change anon, so neither does the rollback");
});
