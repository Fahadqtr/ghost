// TickTick error-handling tests (Phase UI.7.5). PURE. Run:
// node --conditions=react-server --experimental-strip-types --test lib/integrations/ticktick/errors.test.ts

import test from "node:test";
import assert from "node:assert/strict";

import {
  TICKTICK_ERRORS, ticktickErrorMessage, classifyHttpStatus, TickTickError, toSafeMessage,
} from "./errors.ts";

test("classifyHttpStatus maps statuses to safe codes", () => {
  assert.equal(classifyHttpStatus(401), "auth");
  assert.equal(classifyHttpStatus(403), "auth");
  assert.equal(classifyHttpStatus(429), "rate_limited");
  assert.equal(classifyHttpStatus(408), "timeout");
  assert.equal(classifyHttpStatus(500), "unavailable");
  assert.equal(classifyHttpStatus(503), "unavailable");
  assert.equal(classifyHttpStatus(400), "bad_response");
  assert.equal(classifyHttpStatus(200), "unknown");
});

test("every error code has a fixed Arabic message", () => {
  for (const code of Object.keys(TICKTICK_ERRORS) as (keyof typeof TICKTICK_ERRORS)[]) {
    assert.equal(typeof ticktickErrorMessage(code), "string");
    assert.ok(ticktickErrorMessage(code).length > 0);
  }
});

test("TickTickError carries a safe code + fixed message", () => {
  const e = new TickTickError("rate_limited");
  assert.equal(e.code, "rate_limited");
  assert.equal(e.message, TICKTICK_ERRORS.rate_limited);
  assert.equal(e.name, "TickTickError");
});

test("toSafeMessage never leaks a raw error or token", () => {
  assert.equal(toSafeMessage(new TickTickError("auth")), TICKTICK_ERRORS.auth);
  assert.equal(toSafeMessage({ name: "AbortError" }), TICKTICK_ERRORS.timeout);
  assert.equal(toSafeMessage({ name: "TimeoutError" }), TICKTICK_ERRORS.timeout);
  assert.equal(toSafeMessage({ name: "TypeError" }), TICKTICK_ERRORS.unavailable);
  const raw = new Error("Bearer secret-token-xyz failed at https://api.ticktick.com");
  const msg = toSafeMessage(raw);
  assert.equal(msg, TICKTICK_ERRORS.unknown);
  assert.ok(!msg.includes("secret-token-xyz"));
  assert.ok(!msg.includes("ticktick.com"));
});
