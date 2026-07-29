// Tests for the prefetch-safe recovery helpers.
// Run: node --conditions=react-server --experimental-strip-types --test lib/auth/recovery.test.ts

import test from "node:test";
import assert from "node:assert/strict";

import {
  parseRecoveryHash,
  isValidRecoveryParams,
  validateNewPassword,
  RECOVERY_ERRORS,
} from "./recovery.ts";

test("parseRecoveryHash: parses token_hash + type (with or without '#')", () => {
  assert.deepEqual(parseRecoveryHash("#token_hash=abc123&type=recovery"), {
    tokenHash: "abc123",
    type: "recovery",
  });
  assert.deepEqual(parseRecoveryHash("token_hash=xyz&type=recovery"), {
    tokenHash: "xyz",
    type: "recovery",
  });
});

test("parseRecoveryHash: nulls for empty/missing input", () => {
  assert.deepEqual(parseRecoveryHash(""), { tokenHash: null, type: null });
  assert.deepEqual(parseRecoveryHash(null), { tokenHash: null, type: null });
  assert.deepEqual(parseRecoveryHash("#type=recovery"), { tokenHash: null, type: "recovery" });
});

test("isValidRecoveryParams: only type=recovery with a non-empty token hash", () => {
  assert.equal(isValidRecoveryParams("recovery", "abc"), true);
  assert.equal(isValidRecoveryParams("recovery", ""), false);
  assert.equal(isValidRecoveryParams("recovery", null), false);
  assert.equal(isValidRecoveryParams("signup", "abc"), false);
  assert.equal(isValidRecoveryParams(null, "abc"), false);
});

test("validateNewPassword: accepts matching >= 12 chars", () => {
  assert.deepEqual(validateNewPassword("abcdefghijkl", "abcdefghijkl"), { ok: true });
});

test("validateNewPassword: rejects short passwords", () => {
  const r = validateNewPassword("short", "short");
  assert.equal(r.ok, false);
  assert.match(r.error ?? "", /at least 12/i);
});

test("validateNewPassword: rejects mismatched passwords", () => {
  const r = validateNewPassword("abcdefghijkl", "abcdefghijkX");
  assert.equal(r.ok, false);
  assert.match(r.error ?? "", /do not match/i);
});

test("validateNewPassword: checks length before match", () => {
  const r = validateNewPassword("short", "different");
  assert.equal(r.ok, false);
  assert.match(r.error ?? "", /at least 12/i);
});

test("RECOVERY_ERRORS are safe generic strings (no raw markers)", () => {
  const all = Object.values(RECOVERY_ERRORS).join(" ");
  assert.doesNotMatch(all, /token|stack|supabase|jwt/i);
});
