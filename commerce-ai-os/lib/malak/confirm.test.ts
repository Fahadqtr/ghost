// Tests for Malak's signed write-confirm tokens.
// Run: node --conditions=react-server --experimental-strip-types --test lib/malak/confirm.test.ts
//
// These tokens are the ONLY thing standing between "Malak proposed a write" and
// "/api/malak/commit performs it", so forgery/tamper/expiry must all be caught.
process.env.MALAK_SIGNING_SECRET ||= "test-signing-secret-confirm";

import test from "node:test";
import assert from "node:assert/strict";

import { signAction, verifyAction, type MalakAction } from "./confirm.ts";

function action(overrides: Partial<MalakAction> = {}): MalakAction {
  return { v: 1, type: "set_price", agent: "malak", sku: "mk0001", newValue: 99, ts: Date.now(), ...overrides };
}

test("round-trips a valid action", () => {
  const a = action();
  const got = verifyAction(signAction(a));
  assert.equal(got?.type, "set_price");
  assert.equal(got?.sku, "mk0001");
  assert.equal(got?.newValue, 99);
});

test("rejects a tampered payload", () => {
  const [, sig] = signAction(action()).split(".");
  // Swap in a different action body but keep the original signature.
  const forgedPayload = Buffer.from(JSON.stringify(action({ newValue: 1 })))
    .toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  assert.equal(verifyAction(`${forgedPayload}.${sig}`), null);
});

test("rejects a tampered signature", () => {
  const [payload] = signAction(action()).split(".");
  assert.equal(verifyAction(`${payload}.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`), null);
});

test("rejects a token signed with a different secret (key isolation)", () => {
  const token = signAction(action());
  const original = process.env.MALAK_SIGNING_SECRET;
  process.env.MALAK_SIGNING_SECRET = "a-totally-different-secret";
  try {
    assert.equal(verifyAction(token), null);
  } finally {
    process.env.MALAK_SIGNING_SECRET = original;
  }
});

test("rejects an expired token", () => {
  const stale = signAction(action({ ts: Date.now() - 20 * 60 * 1000 })); // 20 min old
  assert.equal(verifyAction(stale), null); // default maxAge is 15 min
  // ...but accepted within a wider window.
  assert.ok(verifyAction(stale, 30 * 60 * 1000));
});

test("rejects malformed tokens and wrong version", () => {
  for (const bad of [undefined, null, 123, "", "nodot", "a.", ".b", "a.b.c"]) {
    assert.equal(verifyAction(bad as unknown), null, `should reject ${JSON.stringify(bad)}`);
  }
  assert.equal(verifyAction(signAction(action({ v: 2 as unknown as 1 }))), null);
});
