// Tests for the in-memory rate limiter + single-use token guard.
// Run: node --conditions=react-server --experimental-strip-types --test lib/malak/ratelimit.test.ts
//
// rateLimit blunts abuse of paid endpoints (F3); consumeOnce prevents a captured
// confirm token from being replayed (F7). Both are best-effort but security-
// relevant, so pin their core contract. (Module-level Maps are shared, so each
// test uses a unique key/signature.)

import test from "node:test";
import assert from "node:assert/strict";

import { rateLimit, consumeOnce } from "./ratelimit.ts";

test("rateLimit allows up to max hits, then blocks with a retry hint", () => {
  const key = "test:allow-then-block";
  for (let i = 0; i < 3; i++) {
    assert.equal(rateLimit(key, 3, 60_000).ok, true, `hit ${i + 1} allowed`);
  }
  const blocked = rateLimit(key, 3, 60_000);
  assert.equal(blocked.ok, false);
  assert.ok(blocked.retryMs > 0, "reports a positive retry delay while blocked");
});

test("rateLimit tracks keys independently", () => {
  assert.equal(rateLimit("test:key-A", 1, 60_000).ok, true);
  assert.equal(rateLimit("test:key-A", 1, 60_000).ok, false); // A exhausted
  assert.equal(rateLimit("test:key-B", 1, 60_000).ok, true);  // B unaffected
});

test("consumeOnce accepts a signature once, then rejects the replay", () => {
  const sig = "sig:confirm-token-123";
  assert.equal(consumeOnce(sig, 60_000), true);  // first use
  assert.equal(consumeOnce(sig, 60_000), false); // replay blocked
});

test("consumeOnce treats distinct signatures independently", () => {
  assert.equal(consumeOnce("sig:unique-A", 60_000), true);
  assert.equal(consumeOnce("sig:unique-B", 60_000), true);
});
