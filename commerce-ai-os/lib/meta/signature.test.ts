// Tests for the Meta webhook signature helpers — no network, no real Meta.
// Run: node --conditions=react-server --experimental-strip-types --test lib/meta/signature.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

import {
  verifyMetaSignature,
  resolveSubscriptionChallenge,
  WEBHOOK_NOT_CONFIGURED_MESSAGE,
  WEBHOOK_INVALID_SIGNATURE_MESSAGE,
} from "./signature.ts";

const SECRET = "test_app_secret_value";
const RAW = JSON.stringify({ object: "instagram", entry: [{ messaging: [{ sender: { id: "42" } }] }] });

/** Produce a valid `sha256=<hex>` header for a body+secret (test-side only). */
function sign(body: string, secret: string): string {
  return "sha256=" + crypto.createHmac("sha256", secret).update(body, "utf8").digest("hex");
}

test("verifyMetaSignature: missing META_APP_SECRET → not_configured (fail closed, 503)", () => {
  assert.equal(verifyMetaSignature(RAW, sign(RAW, SECRET), undefined), "not_configured");
  assert.equal(verifyMetaSignature(RAW, sign(RAW, SECRET), null), "not_configured");
});

test("verifyMetaSignature: empty META_APP_SECRET → not_configured (fail closed, 503)", () => {
  assert.equal(verifyMetaSignature(RAW, sign(RAW, SECRET), ""), "not_configured");
});

test("verifyMetaSignature: missing signature header → invalid (401)", () => {
  assert.equal(verifyMetaSignature(RAW, null, SECRET), "invalid");
  assert.equal(verifyMetaSignature(RAW, undefined, SECRET), "invalid");
  assert.equal(verifyMetaSignature(RAW, "", SECRET), "invalid");
});

test("verifyMetaSignature: malformed signature → invalid (401)", () => {
  // no scheme prefix
  assert.equal(verifyMetaSignature(RAW, crypto.createHmac("sha256", SECRET).update(RAW).digest("hex"), SECRET), "invalid");
  // wrong scheme
  assert.equal(verifyMetaSignature(RAW, "sha1=abcdef", SECRET), "invalid");
  // non-hex digest
  assert.equal(verifyMetaSignature(RAW, "sha256=zzzz", SECRET), "invalid");
  // empty digest
  assert.equal(verifyMetaSignature(RAW, "sha256=", SECRET), "invalid");
  // odd-length hex
  assert.equal(verifyMetaSignature(RAW, "sha256=abc", SECRET), "invalid");
});

test("verifyMetaSignature: wrong signature (right format, wrong secret/body) → invalid (401)", () => {
  assert.equal(verifyMetaSignature(RAW, sign(RAW, "the_wrong_secret"), SECRET), "invalid");
  assert.equal(verifyMetaSignature(RAW, sign("tampered body", SECRET), SECRET), "invalid");
  // Correct length hex but all zeros — must not pass.
  assert.equal(verifyMetaSignature(RAW, "sha256=" + "0".repeat(64), SECRET), "invalid");
});

test("verifyMetaSignature: correct signature → ok (processing may continue)", () => {
  assert.equal(verifyMetaSignature(RAW, sign(RAW, SECRET), SECRET), "ok");
});

test("verifyMetaSignature: any verification failure never yields ok (no side effects gate)", () => {
  // Every non-ok state maps to a no-side-effect response in the route.
  for (const r of [
    verifyMetaSignature(RAW, sign(RAW, SECRET), undefined), // not_configured
    verifyMetaSignature(RAW, null, SECRET), // invalid
    verifyMetaSignature(RAW, "sha256=deadbeef", SECRET), // invalid
    verifyMetaSignature(RAW, sign("other", SECRET), SECRET), // invalid
  ]) {
    assert.notEqual(r, "ok");
  }
});

test("response messages never leak the secret, digest, or raw body", () => {
  const sig = sign(RAW, SECRET);
  const digest = sig.slice("sha256=".length);
  for (const msg of [WEBHOOK_NOT_CONFIGURED_MESSAGE, WEBHOOK_INVALID_SIGNATURE_MESSAGE]) {
    assert.doesNotMatch(msg, new RegExp(SECRET));
    assert.doesNotMatch(msg, new RegExp(digest));
    assert.doesNotMatch(msg, /token|body|entry|sender/i);
  }
});

test("resolveSubscriptionChallenge: GET verification still works with META_VERIFY_TOKEN", () => {
  const VERIFY = "verify_token_value";
  // happy path echoes the challenge
  assert.equal(resolveSubscriptionChallenge("subscribe", VERIFY, "CHALLENGE_123", VERIFY), "CHALLENGE_123");
  // matched but no challenge → empty 200 body (unchanged behaviour)
  assert.equal(resolveSubscriptionChallenge("subscribe", VERIFY, null, VERIFY), "");
});

test("resolveSubscriptionChallenge: rejects wrong/absent token and wrong mode (→ 403)", () => {
  const VERIFY = "verify_token_value";
  assert.equal(resolveSubscriptionChallenge("subscribe", "wrong", "C", VERIFY), null);
  assert.equal(resolveSubscriptionChallenge("subscribe", VERIFY, "C", ""), null); // no expected token configured
  assert.equal(resolveSubscriptionChallenge("subscribe", VERIFY, "C", undefined), null);
  assert.equal(resolveSubscriptionChallenge("delete", VERIFY, "C", VERIFY), null); // wrong mode
});

test("app-secret and verify-token are independent (not conflated)", () => {
  // A valid GET verify token must NOT authenticate a POST body, and vice versa.
  const VERIFY = "verify_token_value";
  // Using the verify token as the HMAC secret against a body signed with the
  // real app secret must fail.
  assert.equal(verifyMetaSignature(RAW, sign(RAW, SECRET), VERIFY), "invalid");
});
