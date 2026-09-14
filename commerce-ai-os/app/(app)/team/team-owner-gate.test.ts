// D-4A1 — team-management authorization: OWNER-ONLY, guard-first.
//
// Why this file exists: app/(app)/team/actions.ts mints and revokes credentials
// for a whole separate identity system. A staff_members row carries a PIN that
// signs its holder into /staff (stock in/out) and a permissions list, and none
// of it is Supabase Auth. Every action runs on the SERVICE-ROLE client, which
// bypasses RLS — so no grant, policy or ACC-02 cleanup can constrain them. The
// gate in that file is the only boundary. Until D-4A1 it was requireUser(),
// i.e. ANY signed-in account could issue itself a staff code of its choosing.
//
// Two layers are asserted here:
//   1. BEHAVIOUR — decideOwner() is pure and importable, so the actual
//      allow/deny decision is executed, not just pattern-matched.
//   2. WIRING — the actions import `server-only` + `@/…`, which node:test
//      cannot resolve, so their use of the gate is proven by source scan
//      (the repo's established style: owner-only-actions.test.ts,
//      int1-writer-gate.test.ts). The scan proves the guard precedes every
//      side effect, which is what makes a denied call a zero-write call.
//
// No production data is touched: nothing here opens a network or DB connection.
// Run: node --conditions=react-server --experimental-strip-types --test "app/(app)/team/team-owner-gate.test.ts"

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { decideOwner, OWNER_ONLY_DENIED } from "../../../lib/malak/owner-check.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

const TEAM = read("app/(app)/team/actions.ts");
const REQUIRE_USER = read("lib/auth/requireUser.ts");
const AUTHZ = read("lib/malak/authz.ts");
const PAGE = read("app/(app)/team/page.tsx");
const CLIENT = read("app/(app)/team/TeamClient.tsx");

/** The six privileged team-management actions. */
const TEAM_ACTIONS = [
  "listStaff",
  "setStaffPermissions",
  "addStaff",
  "resetStaffPin",
  "setStaffActive",
  "deleteStaff",
] as const;

/**
 * Strip line and block comments so a gate assertion tests the CODE, never the
 * prose around it — the file's own header explains the old requireUser() gate,
 * and a doc mention must not be able to satisfy or break these checks.
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

/** Slice a single `export async function NAME(` body up to the next top-level export. */
function fnBody(src: string, name: string): string {
  const start = src.indexOf(`export async function ${name}(`);
  assert.notEqual(start, -1, `function ${name} not found`);
  const rest = src.slice(start + 1);
  const next = rest.indexOf("\nexport ");
  return next === -1 ? src.slice(start) : src.slice(start, start + 1 + next);
}

// Anything that reaches the database or the service-role client. The gate must
// precede ALL of them, so a denial returns before a single statement is issued.
const SIDE_EFFECT = [
  "adminClient(",
  "createAdminClient(",
  "admin.",
  ".from(",
  ".insert(",
  ".update(",
  ".delete(",
  ".select(",
  "revalidatePath(",
];

function firstSideEffectIdx(body: string): number {
  let best = -1;
  for (const tok of SIDE_EFFECT) {
    const at = body.indexOf(tok);
    if (at !== -1 && (best === -1 || at < best)) best = at;
  }
  return best;
}

// ---------------------------------------------------------------------------
// A + B + C — the decision itself, executed
// ---------------------------------------------------------------------------

const OWNER = "clanqtr@gmail.com";

test("A. unauthenticated caller is denied (401) — no session, no access", () => {
  const d = decideOwner(false, null, OWNER);
  assert.equal(d.ok, false);
  assert.equal(d.ok === false && d.status, 401);
  assert.equal(d.ok === false && d.error, OWNER_ONLY_DENIED);
});

test("A. a session that carries no email is denied, never defaulted to allow", () => {
  for (const email of [null, undefined, ""]) {
    const d = decideOwner(true, email, OWNER);
    assert.equal(d.ok, false, `email ${JSON.stringify(email)} must be denied`);
    assert.equal(d.ok === false && d.status, 403);
  }
});

test("B. authenticated NON-owner is denied (403) for every team action's gate", () => {
  const impostors = [
    "someone@example.com",
    "staff@malikas.qa",
    "clanqtr@gmail.com.attacker.test",
    "clanqtr@gmail.co",
    "clanqtr+admin@gmail.com",
    " clanqtr@gmail.com",
  ];
  for (const email of impostors) {
    const d = decideOwner(true, email, OWNER);
    assert.equal(d.ok, false, `${email} must NOT pass the owner gate`);
    assert.equal(d.ok === false && d.status, 403);
    // The denial must not leak who the owner is.
    assert.doesNotMatch(d.ok === false ? d.error : "", /@/,
      "denial message must not disclose an email address");
  }
});

test("C. the owner is authorized, case-insensitively", () => {
  for (const email of [OWNER, OWNER.toUpperCase(), "ClanQtr@Gmail.Com"]) {
    const d = decideOwner(true, email, OWNER);
    assert.equal(d.ok, true, `${email} must pass the owner gate`);
  }
});

// ---------------------------------------------------------------------------
// The gate the actions actually call
// ---------------------------------------------------------------------------

test("requireOwnerGate delegates to requireOwner and keeps the { error } | null contract", () => {
  const body = REQUIRE_USER.slice(REQUIRE_USER.indexOf("export async function requireOwnerGate"));
  assert.match(body, /await requireOwner\(\)/,
    "requireOwnerGate must resolve the decision through requireOwner()");
  assert.match(body, /owner\.ok \? null : \{ error: owner\.error \}/,
    "requireOwnerGate must return null on allow and { error } on deny");
});

test("requireOwner reads the session server-side and compares against a hardcoded owner", () => {
  // getUser() revalidates with the auth server; getSession() would trust the cookie.
  assert.match(AUTHZ, /export async function requireOwner\(\)[\s\S]*?auth\.getUser\(\)/,
    "requireOwner must use auth.getUser(), not auth.getSession()");
  assert.match(AUTHZ, /const OWNER_EMAIL = "/,
    "the owner identity must be a hardcoded constant");
  // A missing/blank env var must not be able to widen the gate.
  const ownerFn = AUTHZ.slice(AUTHZ.indexOf("export async function requireOwner("));
  assert.doesNotMatch(ownerFn, /process\.env/,
    "requireOwner must not consult env vars — MALAK_WRITER_EMAILS must not grant owner");
  assert.match(ownerFn, /decideOwner\(!!user, user\?\.email \?\? null, OWNER_EMAIL\)/,
    "requireOwner must delegate to the pure, tested decision");
});

// ---------------------------------------------------------------------------
// D — wiring: denied ⇒ zero database mutation
// ---------------------------------------------------------------------------

test("team: the owner gate is imported, and the signed-in-only gate is gone", () => {
  assert.match(TEAM, /import \{ requireOwnerGate \} from "@\/lib\/auth\/requireUser"/,
    "team actions must import requireOwnerGate");
  const code = stripComments(TEAM);
  assert.doesNotMatch(code, /requireUser\(\)/,
    "no team action may still call requireUser() — that is the escalation path");
  assert.doesNotMatch(code, /isSignedIn\(\)/,
    "no team action may fall back to isSignedIn()");
  assert.doesNotMatch(code, /requireWriterGate|requireMalakWriter/,
    "the writer allow-list must not grant team management — owner only");
});

test("team: every one of the six actions is owner-gated BEFORE any side effect", () => {
  for (const fn of TEAM_ACTIONS) {
    const body = fnBody(TEAM, fn);
    const guard = body.indexOf("await requireOwnerGate()");
    assert.notEqual(guard, -1, `${fn} must call requireOwnerGate()`);

    // The decision must be checked, and the denial must short-circuit.
    assert.match(body, /const denied = await requireOwnerGate\(\);\s*\n\s*if \(denied\) return /,
      `${fn} must await requireOwnerGate() and return immediately when denied`);

    const effect = firstSideEffectIdx(body);
    if (effect !== -1) {
      assert.ok(guard < effect,
        `${fn}: the gate must precede its first side effect (gate@${guard}, effect@${effect})`);
    }
  }
});

test("team: exactly six gate calls — one per exported action, none missed or doubled", () => {
  const gates = TEAM.match(/await requireOwnerGate\(\)/g) ?? [];
  assert.equal(gates.length, TEAM_ACTIONS.length);
  const exported = TEAM.match(/^export async function (\w+)\(/gm) ?? [];
  assert.equal(exported.length, TEAM_ACTIONS.length,
    "a new exported action appeared — gate it before shipping");
  for (const fn of TEAM_ACTIONS) {
    assert.ok(TEAM.includes(`export async function ${fn}(`), `${fn} must still be exported`);
  }
});

// ---------------------------------------------------------------------------
// Blast radius: authorization changed, nothing else did
// ---------------------------------------------------------------------------

test("team: business logic, PIN hashing and the service-role client are untouched", () => {
  // PIN handling
  assert.match(TEAM, /import \{ hashPin, isLegacyPlaintextPin \} from "@\/lib\/staff\/pin"/);
  assert.match(fnBody(TEAM, "addStaff"), /pin: hashPin\(code\)/);
  assert.match(fnBody(TEAM, "resetStaffPin"), /pin: hashPin\(code\)/);
  assert.match(fnBody(TEAM, "listStaff"), /isLegacyPlaintextPin/);
  // The PIN is still never returned to the client.
  assert.doesNotMatch(TEAM, /pin: r\.pin\b/);
  assert.match(TEAM, /hasCode: !!r\.pin/);
  // Permissions model
  assert.match(TEAM, /parsePermissions/);
  // Same table, same client
  assert.match(TEAM, /createAdminClient/);
  // 7 = one per action, plus listStaff's legacy-plaintext-PIN upgrade write.
  assert.equal((TEAM.match(/\.from\("staff_members"\)/g) ?? []).length, 7);
  // Validation rules kept verbatim
  assert.equal((TEAM.match(/\^\\d\{4,8\}\$/g) ?? []).length, 2);
});

test("team UI already surfaces the denial — no client change was required", () => {
  // listStaff keeps its { members, ready, error } shape, and the page renders it.
  assert.match(fnBody(TEAM, "listStaff"),
    /if \(denied\) return \{ members: \[\], ready: true, error: denied\.error \}/);
  assert.match(PAGE, /const \{ members, ready, error \} = await listStaff\(\)/);
  assert.match(PAGE, /error \?/, "the page must render listStaff's error");
  // Mutating actions keep the { error } shape the client already flashes.
  assert.match(CLIENT, /"error" in r && r\.error/);
});
