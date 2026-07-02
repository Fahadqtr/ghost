// Tests for the signed staff-session cookie.
// Run: node --conditions=react-server --experimental-strip-types --test lib/staff/session.test.ts
//
// This HMAC token is what attributes every stock movement to an employee without
// giving them a real account, so a forged/tampered token must never verify.
process.env.MALAK_SIGNING_SECRET ||= "test-signing-secret-session";

import test from "node:test";
import assert from "node:assert/strict";

import { signStaff, verifyStaff } from "./session.ts";

test("round-trips a name string", () => {
  const got = verifyStaff(signStaff("Fahad"));
  assert.equal(got?.name, "Fahad");
});

test("round-trips a full session (id + perms)", () => {
  const got = verifyStaff(signStaff({ name: "Sara", id: "emp-7", perms: ["count", "move"] }));
  assert.equal(got?.name, "Sara");
  assert.equal(got?.id, "emp-7");
  assert.deepEqual(got?.perms, ["count", "move"]);
});

test("rejects a tampered signature", () => {
  const [payload] = signStaff("Fahad").split(".");
  assert.equal(verifyStaff(`${payload}.deadbeefdeadbeefdeadbeefdeadbeef`), null);
});

test("rejects a swapped payload kept with an old signature", () => {
  const [, mac] = signStaff("Fahad").split(".");
  const forged = Buffer.from(JSON.stringify({ name: "Attacker", ts: Date.now() }))
    .toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  assert.equal(verifyStaff(`${forged}.${mac}`), null);
});

test("rejects a token signed with a different secret", () => {
  const token = signStaff("Fahad");
  const original = process.env.MALAK_SIGNING_SECRET;
  process.env.MALAK_SIGNING_SECRET = "another-secret";
  try {
    assert.equal(verifyStaff(token), null);
  } finally {
    process.env.MALAK_SIGNING_SECRET = original;
  }
});

test("rejects an expired token", () => {
  const token = signStaff("Fahad");
  assert.equal(verifyStaff(token, -1), null); // any positive age is already exceeded
  assert.ok(verifyStaff(token)); // valid within the default 12h window
});

test("rejects malformed tokens", () => {
  for (const bad of [undefined, "", "nodot", "a.", ".b"]) {
    assert.equal(verifyStaff(bad as string | undefined), null, `should reject ${JSON.stringify(bad)}`);
  }
});
