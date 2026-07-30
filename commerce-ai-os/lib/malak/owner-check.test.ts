// Tests for the pure owner-authorization decision. No network, no Supabase,
// no real session — just the allow/deny logic that gates every external
// publish/messaging action.
// Run: node --conditions=react-server --experimental-strip-types --test lib/malak/owner-check.test.ts

import test from "node:test";
import assert from "node:assert/strict";

import { decideOwner, OWNER_ONLY_DENIED } from "./owner-check.ts";

const OWNER = "clanqtr@gmail.com";

// ---- the owner is allowed -----------------------------------------------------

test("owner (exact email) is allowed and gets its normalized email back", () => {
  const d = decideOwner(true, OWNER, OWNER);
  assert.deepEqual(d, { ok: true, email: OWNER });
});

test("owner match is case-insensitive (session email in any case)", () => {
  for (const e of ["CLANQTR@GMAIL.COM", "Clanqtr@Gmail.com", "clanQTR@gmail.com"]) {
    const d = decideOwner(true, e, OWNER);
    assert.equal(d.ok, true, `should allow ${e}`);
  }
});

// ---- a signed-in non-owner is rejected (403) ----------------------------------

test("signed-in NON-owner is rejected with 403 and the safe denial", () => {
  const d = decideOwner(true, "staff@example.com", OWNER);
  assert.deepEqual(d, { ok: false, status: 403, error: OWNER_ONLY_DENIED });
});

test("signed-in user with no email on the session is rejected (403)", () => {
  for (const e of [null, undefined, ""] as const) {
    const d = decideOwner(true, e, OWNER);
    assert.equal(d.ok, false);
    if (!d.ok) assert.equal(d.status, 403);
  }
});

// ---- an unauthenticated caller is rejected (401) ------------------------------

test("no session at all is rejected with 401 (distinct from 403)", () => {
  const d = decideOwner(false, null, OWNER);
  assert.deepEqual(d, { ok: false, status: 401, error: OWNER_ONLY_DENIED });
});

test("no session wins even if an email string is somehow present", () => {
  // Defense in depth: presence of the user flag is authoritative, not the email.
  const d = decideOwner(false, OWNER, OWNER);
  assert.equal(d.ok, false);
  if (!d.ok) assert.equal(d.status, 401);
});

// ---- the denial never leaks the owner email or the allow-list -----------------

test("the denial message reveals no email, allow-list, or internal detail", () => {
  const msgs = [
    OWNER_ONLY_DENIED,
    (decideOwner(true, "someone@else.com", OWNER) as { error: string }).error,
    (decideOwner(false, null, OWNER) as { error: string }).error,
  ];
  for (const msg of msgs) {
    assert.doesNotMatch(msg, /clanqtr/i, "must not contain the owner local-part");
    assert.doesNotMatch(msg, /@|gmail/i, "must not contain an email address");
    assert.doesNotMatch(msg, /MALAK_WRITER|allow.?list|owner_email|403|401/i, "must not leak internals");
  }
});

test("signed-out and signed-in-non-owner denials are byte-identical (no oracle)", () => {
  const a = decideOwner(false, null, OWNER);
  const b = decideOwner(true, "nope@example.com", OWNER);
  assert.equal(a.ok, false);
  assert.equal(b.ok, false);
  if (!a.ok && !b.ok) assert.equal(a.error, b.error, "message must not distinguish the two cases");
});
