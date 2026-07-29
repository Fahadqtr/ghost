// Tests for the prefetch-safe recovery helpers.
// Run: node --conditions=react-server --experimental-strip-types --test lib/auth/recovery.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  parseRecoveryHash,
  parseRecoveryParams,
  resolveRecoveryToken,
  isValidRecoveryParams,
  validateNewPassword,
  requestPasswordReset,
  RECOVERY_ERRORS,
  LOGIN_ERRORS,
  RESET_REQUEST_SENT,
} from "./recovery.ts";

/** Source of the recovery page, read once for static safety assertions. */
const recoveryPageSource = readFileSync(
  new URL("../../app/(auth)/auth/recovery/page.tsx", import.meta.url),
  "utf8"
);

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

test("requestPasswordReset: success returns the generic (non-enumerating) sent message", async () => {
  const outcome = await requestPasswordReset("user@example.com", async () => ({ error: null }));
  assert.deepEqual(outcome, { status: "sent", message: RESET_REQUEST_SENT });
});

test("requestPasswordReset: checks the returned error and does NOT report success on failure", async () => {
  let called = false;
  const outcome = await requestPasswordReset("user@example.com", async () => {
    called = true;
    return { error: { message: "rate limit exceeded", status: 429 } };
  });
  assert.equal(called, true, "sendReset must be invoked");
  assert.equal(outcome.status, "failed");
  assert.equal(outcome.message, LOGIN_ERRORS.resetRequestFailed);
  assert.notEqual(outcome.message, RESET_REQUEST_SENT);
  // The raw provider error text must never leak into the user-facing message.
  assert.doesNotMatch(outcome.message, /rate limit|429/i);
});

test("requestPasswordReset: a thrown exception (network) maps to the generic failure message", async () => {
  const outcome = await requestPasswordReset("user@example.com", async () => {
    throw new Error("network down: getaddrinfo ENOTFOUND");
  });
  assert.equal(outcome.status, "failed");
  assert.equal(outcome.message, LOGIN_ERRORS.resetRequestFailed);
  assert.doesNotMatch(outcome.message, /network down|ENOTFOUND/i);
});

test("requestPasswordReset: trims the email before sending", async () => {
  let received: string | null = null;
  await requestPasswordReset("  user@example.com  ", async (email) => {
    received = email;
    return { error: null };
  });
  assert.equal(received, "user@example.com");
});

test("LOGIN_ERRORS.resetRequestFailed is a safe generic string (no raw markers)", () => {
  assert.doesNotMatch(LOGIN_ERRORS.resetRequestFailed, /token|stack|supabase|jwt|rate limit|429/i);
});

test("parseRecoveryParams: reads token_hash + type from a query string (leading '?' optional)", () => {
  assert.deepEqual(parseRecoveryParams("?token_hash=q1&type=recovery"), {
    tokenHash: "q1",
    type: "recovery",
  });
  assert.deepEqual(parseRecoveryParams("token_hash=q2&type=recovery"), {
    tokenHash: "q2",
    type: "recovery",
  });
  assert.deepEqual(parseRecoveryParams("#token_hash=h1&type=recovery"), {
    tokenHash: "h1",
    type: "recovery",
  });
  assert.deepEqual(parseRecoveryParams(""), { tokenHash: null, type: null });
  assert.deepEqual(parseRecoveryParams(null), { tokenHash: null, type: null });
});

test("resolveRecoveryToken: reads token_hash from the query when there is no fragment", () => {
  assert.deepEqual(resolveRecoveryToken("", "?token_hash=abc&type=recovery"), {
    tokenHash: "abc",
    type: "recovery",
    source: "query",
  });
});

test("resolveRecoveryToken: only accepts type=recovery", () => {
  assert.equal(resolveRecoveryToken("", "?token_hash=abc&type=signup").source, "none");
  assert.equal(resolveRecoveryToken("#token_hash=abc&type=magiclink", "").source, "none");
  assert.equal(resolveRecoveryToken("", "?token_hash=&type=recovery").source, "none");
});

test("resolveRecoveryToken: fragment takes priority when both are present", () => {
  const r = resolveRecoveryToken(
    "#token_hash=frag&type=recovery",
    "?token_hash=query&type=recovery"
  );
  assert.equal(r.source, "fragment");
  assert.equal(r.tokenHash, "frag");
});

test("resolveRecoveryToken: falls back to the query when the fragment is invalid", () => {
  const r = resolveRecoveryToken(
    "#type=recovery",
    "?token_hash=query&type=recovery"
  );
  assert.equal(r.source, "query");
  assert.equal(r.tokenHash, "query");
});

test("resolveRecoveryToken: legacy fragment links still work", () => {
  const r = resolveRecoveryToken("#token_hash=legacy&type=recovery", "");
  assert.equal(r.source, "fragment");
  assert.equal(r.tokenHash, "legacy");
});

test("resolveRecoveryToken: returns 'none' when neither carries a valid token", () => {
  assert.equal(resolveRecoveryToken("", "").source, "none");
  assert.equal(resolveRecoveryToken(null, null).source, "none");
  assert.equal(resolveRecoveryToken("#foo=bar", "?baz=qux").source, "none");
});

// --- Static safety assertions on the recovery page component ---------------

test("recovery page: does NOT call verifyOtp inside the mount effect", () => {
  const effect = recoveryPageSource.slice(
    recoveryPageSource.indexOf("useEffect("),
    recoveryPageSource.indexOf("}, []);") + "}, []);".length
  );
  assert.ok(effect.length > 0, "mount effect block should be found");
  assert.doesNotMatch(effect, /verifyOtp/);
});

test("recovery page: verification runs only in the explicit continue handler", () => {
  // The verifyOtp CALL (`verifyOtp(`) appears exactly once — a comment mention
  // like "(verifyOtp)" has no trailing '(' and is not counted.
  const calls = recoveryPageSource.match(/verifyOtp\(/g) ?? [];
  assert.equal(calls.length, 1);
  const continueStart = recoveryPageSource.indexOf("handleContinue");
  const verifyAt = recoveryPageSource.indexOf("verifyOtp(");
  assert.ok(continueStart >= 0 && verifyAt > continueStart);
});

test("recovery page: never uses cookies or web storage for the token", () => {
  assert.doesNotMatch(recoveryPageSource, /localStorage|sessionStorage|document\.cookie/);
});

test("recovery page: clears query + fragment (replaceState to pathname only)", () => {
  assert.match(
    recoveryPageSource,
    /replaceState\(\s*null\s*,\s*""\s*,\s*window\.location\.pathname\s*\)/
  );
});
