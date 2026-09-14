// D-4A2 — privileged-path authorization proofs.
//
// Two layers, matching the repo's established style:
//
//  1. BEHAVIOURAL — decideWriter() is pure and importable, so the writer
//     boundary is executed for real here (unauthenticated / signed-in
//     non-writer / allow-listed writer / owner), exactly as owner-check.test.ts
//     does for decideOwner(). This is what proves "denied" actually denies,
//     rather than proving only that a call is present.
//
//  2. WIRING (source scan) — the hardened actions and routes import
//     `server-only` and `@/…`, which node:test cannot resolve, so their
//     guard-before-side-effect property is proven by reading the source. That
//     ordering is what makes a denied call a ZERO-MUTATION call: the gate
//     returns before the first client construction, DB statement, credential
//     write or external request.
//
// The unchanged paths are pinned too, so a later edit cannot silently escalate
// a read to owner-only or downgrade a hardened write back to "any signed-in".
//
// Run: node --conditions=react-server --experimental-strip-types --test lib/malak/d4a2-privileged-gates.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { decideWriter, writerAllowList, WRITER_NOT_SIGNED_IN, WRITER_READ_ONLY_DENIED } from "./writer-check.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

const OWNER = "clanqtr@gmail.com";

// ---------------------------------------------------------------------------
// 1. BEHAVIOURAL — the writer decision itself
// ---------------------------------------------------------------------------

test("writer: no session is denied 401 and never falls through to allowed", () => {
  const d = decideWriter(false, null, OWNER, "");
  assert.equal(d.ok, false);
  assert.equal(d.ok === false && d.status, 401);
  assert.equal(d.ok === false && d.error, WRITER_NOT_SIGNED_IN);
});

test("writer: a session with no usable email is denied 403, never defaulted to allow", () => {
  for (const email of [null, undefined, "", "   "]) {
    const d = decideWriter(true, email as string | null, OWNER, "");
    assert.equal(d.ok, false, `email ${JSON.stringify(email)} must be denied`);
    assert.equal(d.ok === false && d.status, 403);
  }
});

test("writer: a signed-in account that is not on the allow-list is denied 403", () => {
  const d = decideWriter(true, "someone.else@example.test", OWNER, "");
  assert.equal(d.ok, false);
  assert.equal(d.ok === false && d.status, 403);
  assert.equal(d.ok === false && d.error, WRITER_READ_ONLY_DENIED);
});

test("writer: near-miss impostors of the owner address are all denied", () => {
  const impostors = [
    "clanqtr@gmail.com.attacker.test", // suffix attack
    "clanqtr@gmail.co",                // truncation
    "clanqtr+admin@gmail.com",         // plus-alias
    " clanqtr@gmail.com",              // leading space
    "clanqtr@gmail.com ",              // trailing space
    "clanqtr@gmaiI.com",               // homoglyph (capital i)
    "xclanqtr@gmail.com",              // prefix attack
  ];
  for (const email of impostors) {
    const d = decideWriter(true, email, OWNER, "");
    assert.equal(d.ok, false, `${email} must NOT be treated as the owner`);
    assert.equal(d.ok === false && d.status, 403);
  }
});

test("writer: the owner is allowed, case-insensitively, with no extras configured", () => {
  for (const email of ["clanqtr@gmail.com", "Clanqtr@Gmail.com", "CLANQTR@GMAIL.COM"]) {
    const d = decideWriter(true, email, OWNER, "");
    assert.equal(d.ok, true, `${email} must be allowed`);
  }
});

test("writer: MALAK_WRITER_EMAILS widens the list but never removes the owner", () => {
  const extras = "staff.one@example.test, Staff.Two@Example.Test ,,";
  assert.equal(decideWriter(true, "staff.one@example.test", OWNER, extras).ok, true);
  assert.equal(decideWriter(true, "STAFF.TWO@EXAMPLE.TEST", OWNER, extras).ok, true);
  assert.equal(decideWriter(true, OWNER, OWNER, extras).ok, true);
  assert.equal(decideWriter(true, "nobody@example.test", OWNER, extras).ok, false);
});

test("writer: a missing or malformed env can only fail to widen — never lock the owner out", () => {
  for (const env of [undefined, null, "", "   ", ",,,", "not-an-email"]) {
    assert.equal(decideWriter(true, OWNER, OWNER, env as string | null).ok, true,
      `owner must stay allowed for env ${JSON.stringify(env)}`);
  }
  assert.ok(writerAllowList(OWNER, undefined).has(OWNER));
});

test("writer: denial text never discloses the owner address or the allow-list", () => {
  for (const text of [WRITER_NOT_SIGNED_IN, WRITER_READ_ONLY_DENIED]) {
    assert.doesNotMatch(text, /@/, "denial must not contain an email address");
  }
  const d = decideWriter(true, "nobody@example.test", OWNER, "staff@example.test");
  assert.equal(d.ok === false && d.error.includes("clanqtr"), false);
  assert.equal(d.ok === false && d.error.includes("staff@example.test"), false);
});

test("writer: the writer gate is strictly weaker than the owner gate, never stronger", () => {
  // An allow-listed non-owner passes WRITE but must never be treated as owner.
  const extras = "staff.one@example.test";
  assert.equal(decideWriter(true, "staff.one@example.test", OWNER, extras).ok, true);
  const AUTHZ = read("lib/malak/authz.ts");
  const ownerFn = AUTHZ.slice(AUTHZ.indexOf("export async function requireOwner("));
  assert.doesNotMatch(ownerFn.slice(0, 400), /MALAK_WRITER|writerAllowList|decideWriter/,
    "requireOwner must not consult the writer allow-list");
});

// ---------------------------------------------------------------------------
// 2. WIRING — guard before the first side effect
// ---------------------------------------------------------------------------

/** Strip comments so these guards test CODE, never prose. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

/** Slice one `export async function NAME(` body up to the next top-level export. */
function fnBody(src: string, name: string): string {
  const code = stripComments(src);
  const start = code.indexOf(`export async function ${name}(`);
  assert.notEqual(start, -1, `function ${name} not found`);
  const rest = code.slice(start + 1);
  const next = rest.indexOf("\nexport ");
  return next === -1 ? code.slice(start) : code.slice(start, start + 1 + next);
}

/** Tokens that begin a DB statement, a credential write or an external request. */
const SIDE_EFFECT = [
  "createClient(", "createAdminClient(", "adminClient(", "admin(",
  ".from(", ".rpc(", "cookies(", "await fetch(", "new Anthropic(",
  "messages.create(", "redirect(", "revalidatePath(",
];

function assertGatedFirst(src: string, name: string, gate: "requireOwner" | "requireMalakWriter") {
  const body = fnBody(src, name);
  const at = body.indexOf(gate);
  assert.notEqual(at, -1, `${name} must call ${gate}()`);
  for (const tok of SIDE_EFFECT) {
    const hit = body.indexOf(tok);
    if (hit !== -1) assert.ok(at < hit, `${name}: ${gate}() must come before the first "${tok}"`);
  }
  // A writer gate belongs on a path that actually mutates — escalating a pure
  // read is a regression in the other direction, and reading write statements at
  // FILE level (rather than per function) is exactly how that mistake is made.
  if (gate === "requireMalakWriter") {
    assert.match(body, /\.(update|insert|upsert|delete)\(/,
      `${name} must write in its OWN body to justify the writer gate`);
  }
  // A hardened path must not still accept the broad signed-in-only session.
  assert.doesNotMatch(body, /isSignedIn\(\)/, `${name} must not fall back to isSignedIn()`);
  assert.doesNotMatch(body, /requireUser\(\)/, `${name} must not fall back to requireUser()`);
  assert.doesNotMatch(body, /"Not signed in\."/, `${name} must not use the signed-in-only denial`);
}

// ---- A. owner-gated ---------------------------------------------------------

const INSTALL = read("app/api/shopify/install/route.ts");
const CALLBACK = read("app/api/shopify/callback/route.ts");
const SOCIAL = read("app/(app)/social/actions.ts");

test("shopify install: owner-gated before the state cookie and the redirect", () => {
  assert.match(INSTALL, /import \{ requireOwner \} from "@\/lib\/malak\/authz"/);
  const code = stripComments(INSTALL);
  assert.doesNotMatch(code, /isSignedIn/, "no signed-in-only fallback may survive");
  const guard = code.indexOf("requireOwner");
  for (const tok of ["cookies(", "jar.set(", "buildAuthorizeUrl(", "redirect("]) {
    const hit = code.indexOf(tok);
    if (hit !== -1) assert.ok(guard < hit, `requireOwner must precede "${tok}"`);
  }
  // The denial keeps the gate's own 401/403 rather than collapsing to one code.
  assert.match(code, /if \(!owner\.ok\) return Response\.json\([^)]*\{ status: owner\.status \}\)/);
});

test("shopify callback: owner-gated before the token exchange and the credential write", () => {
  assert.match(CALLBACK, /import \{ requireOwner \} from "@\/lib\/malak\/authz"/);
  const code = stripComments(CALLBACK);
  assert.doesNotMatch(code, /isSignedIn/, "no signed-in-only fallback may survive");
  const guard = code.indexOf("requireOwner");
  assert.notEqual(guard, -1);
  for (const tok of ["cookies(", "await fetch(", "createAdminClient(", 'from("shopify_tokens")', "invalidateShopifyTokenCache("]) {
    const hit = code.indexOf(tok);
    assert.notEqual(hit, -1, `expected ${tok} to still exist in the callback`);
    assert.ok(guard < hit, `requireOwner must precede "${tok}"`);
  }
  assert.match(code, /if \(!owner\.ok\) return Response\.json\([^)]*\{ status: owner\.status \}\)/);
  // The Shopify-side checks authenticate SHOPIFY, not the caller — they must
  // remain, but they are not the authorization boundary.
  for (const tok of ["verifyShopifyHmac(", "isExpectedShop("]) {
    assert.ok(code.includes(tok), `${tok} must still run`);
  }
});

test("social: dismissSocialPost joins its already-owner-gated siblings", () => {
  assertGatedFirst(SOCIAL, "dismissSocialPost", "requireOwner");
  // The rest of the planned-post decision triad must not have regressed.
  for (const fn of ["approveSocialPost", "rescheduleSocialPost"]) {
    assertGatedFirst(SOCIAL, fn, "requireOwner");
  }
});

// ---- B. writer-gated --------------------------------------------------------

const PRODUCTS = read("app/(app)/products/actions.ts");
const ENRICH = read("app/(app)/catalog/enrich/actions.ts");
const SNOONU = read("app/(app)/import-export/snoonu-actions.ts");
const PURE_SEOUL = read("app/(app)/import-export/pure-seoul-actions.ts");

test("products: both approval writers are on the writer boundary, guard-first", () => {
  for (const fn of ["setProductApproval", "setProductsApproval"]) {
    assertGatedFirst(PRODUCTS, fn, "requireMalakWriter");
  }
  // setProductStatus already held this boundary — pin it so it cannot regress.
  assertGatedFirst(PRODUCTS, "setProductStatus", "requireMalakWriter");
  // Hard delete stays STRICTER than the writer boundary (OPS.7 §7).
  assert.match(fnBody(PRODUCTS, "deleteProduct"), /requireOwner\(\)/);
});

test("catalog enrich: the writing action is writer-gated, the read stays open", () => {
  assertGatedFirst(ENRICH, "enrichProduct", "requireMalakWriter");
  const listBody = fnBody(ENRICH, "listEnrichTargets");
  assert.match(listBody, /isSignedIn\(\)/, "the pure read must stay on the session guard");
  assert.doesNotMatch(listBody, /requireMalakWriter|requireOwner/, "a read must not be escalated");
});

// The import/export "compute" actions (snoonuFillCodes, computeSnoonuDiff,
// comparePureSeoul) look like writers because their FILES contain product
// updates — but those statements belong to applySnoonuUpdates / setPureSeoulIds,
// which are already writer-gated. The compute actions themselves write nothing,
// so they correctly stay on the session guard. Pinned here because a file-level
// read of those files is genuinely misleading.
test("import/export: the compute actions are writes-free, so they stay on the session guard", () => {
  for (const [label, src, fn] of [
    ["snoonuFillCodes", SNOONU, "snoonuFillCodes"],
    ["computeSnoonuDiff", SNOONU, "computeSnoonuDiff"],
    ["comparePureSeoul", PURE_SEOUL, "comparePureSeoul"],
  ] as const) {
    const body = fnBody(src, fn);
    assert.doesNotMatch(body, /\.(update|insert|upsert|delete)\(/,
      `${label} is classified read-only — a write in its own body invalidates that`);
    assert.match(body, /isSignedIn\(\)/, `${label} must still require a signed-in session`);
    assert.doesNotMatch(body, /requireMalakWriter|requireOwner/,
      `${label} must not be escalated while it writes nothing`);
  }
  // …while the actions that DO write in these same files keep the writer gate.
  for (const [src, fn] of [[SNOONU, "applySnoonuUpdates"], [PURE_SEOUL, "setPureSeoulIds"]] as const) {
    const body = fnBody(src, fn);
    assert.match(body, /\.(update|insert|upsert)\(/, `${fn} is expected to write`);
    assert.match(body, /requireMalakWriter|requireOwner/, `${fn} must keep a write gate`);
  }
});

// ---------------------------------------------------------------------------
// 3. NOT CHANGED — pinned so the boundary cannot drift either way
// ---------------------------------------------------------------------------

test("team D-4A1 has not regressed: all six actions still owner-gated", () => {
  const TEAM = stripComments(read("app/(app)/team/actions.ts"));
  for (const fn of ["listStaff", "setStaffPermissions", "addStaff", "resetStaffPin", "setStaffActive", "deleteStaff"]) {
    assert.ok(new RegExp(`export async function ${fn}\\(`).test(TEAM), `${fn} must still exist`);
  }
  assert.equal((TEAM.match(/await requireOwnerGate\(\)/g) ?? []).length, 6,
    "exactly six owner-gate calls for exactly six actions");
  assert.doesNotMatch(TEAM, /requireUser\(\)/, "no signed-in-only gate may return to team actions");
  assert.doesNotMatch(TEAM, /isSignedIn\(\)/, "no signed-in-only gate may return to team actions");
});

test("read-only diagnostics stay open to any signed-in session (not escalated)", () => {
  const READ_ONLY = [
    "lib/catalog/health/health.server.ts",
    "lib/operations/media/media-center.server.ts",
    "lib/operations/channels/channel-center.server.ts",
    "lib/missing-products/discovery.server.ts",
  ];
  for (const rel of READ_ONLY) {
    const code = stripComments(read(rel));
    assert.match(code, /isSignedIn\(\)/, `${rel} must keep a session check`);
    assert.doesNotMatch(code, /\.insert\(|\.upsert\(|\.delete\(\)/,
      `${rel} is classified read-only — a write here invalidates that classification`);
  }
});

test("CRM stays untouched pending the D-2 decision", () => {
  const CRM = stripComments(read("app/(app)/crm/actions.ts"));
  assert.match(CRM, /requireUser\(\)/,
    "CRM must remain exactly as it was — D-4A2 makes no CRM authorization change");
  assert.doesNotMatch(CRM, /requireMalakWriter|requireOwnerGate/,
    "no CRM gate may be changed before D-2 is decided");
});
