// Tests for the rate limiter's pure core (window math, decision, IP parsing).
// Run: node --experimental-strip-types --test lib/ratelimit.test.ts

import test from "node:test";
import assert from "node:assert/strict";

import { windowKey, secsUntilWindowEnd, decide, clientIpFrom, rateLimit, runIfAllowed } from "./ratelimit.ts";

// ---- windowKey ---------------------------------------------------------------

test("same window → same key; next window → new key", () => {
  const winSec = 300;
  const t0 = 1_000_000 * 300_000; // exact window start (bucket 1,000,000)
  const k1 = windowKey("staff-login", "1.2.3.4", t0, winSec);
  const k2 = windowKey("staff-login", "1.2.3.4", t0 + 299_000, winSec);
  const k3 = windowKey("staff-login", "1.2.3.4", t0 + 300_000 * 2, winSec);
  assert.equal(k1, k2);
  assert.notEqual(k1, k3);
});

test("keys separate by scope and by id", () => {
  const t = 1_000_000_000_000;
  assert.notEqual(windowKey("a", "ip", t, 60), windowKey("b", "ip", t, 60));
  assert.notEqual(windowKey("a", "ip1", t, 60), windowKey("a", "ip2", t, 60));
});

// ---- secsUntilWindowEnd --------------------------------------------------------

test("counts down within the window and never returns 0", () => {
  const winSec = 300;
  const winMs = winSec * 1000;
  const start = 42 * winMs;               // exact window start
  assert.equal(secsUntilWindowEnd(start, winSec), 300);
  assert.equal(secsUntilWindowEnd(start + 299_000, winSec), 1);
  assert.ok(secsUntilWindowEnd(start + 299_999, winSec) >= 1); // never 0
});

// ---- decide --------------------------------------------------------------------

test("allows up to the limit, blocks past it, remaining floors at 0", () => {
  assert.deepEqual(decide(1, 10), { allowed: true, remaining: 9 });
  assert.deepEqual(decide(10, 10), { allowed: true, remaining: 0 }); // the last allowed try
  assert.deepEqual(decide(11, 10), { allowed: false, remaining: 0 });
  assert.deepEqual(decide(50, 10), { allowed: false, remaining: 0 });
});

// ---- clientIpFrom ----------------------------------------------------------------

test("takes the first x-forwarded-for hop, trims whitespace", () => {
  assert.equal(clientIpFrom("1.2.3.4, 10.0.0.1, 10.0.0.2", null), "1.2.3.4");
  assert.equal(clientIpFrom("  5.6.7.8  ", null), "5.6.7.8");
});

test("falls back to x-real-ip, then a shared bucket", () => {
  assert.equal(clientIpFrom(null, "9.9.9.9"), "9.9.9.9");
  assert.equal(clientIpFrom("", ""), "unknown");
  assert.equal(clientIpFrom(null, null), "unknown");
});

// ---- rateLimit (unconfigured path only — no network) ----------------------------

test("without Upstash env, rateLimit is a configured:false no-op that allows", async () => {
  const savedUrl = process.env.UPSTASH_REDIS_REST_URL;
  const savedTok = process.env.UPSTASH_REDIS_REST_TOKEN;
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  try {
    const r = await rateLimit("scope", "id", { limit: 3, windowSec: 60 });
    assert.deepEqual(r, { configured: false, allowed: true, remaining: 3, retryAfterSec: 0 });
  } finally {
    if (savedUrl != null) process.env.UPSTASH_REDIS_REST_URL = savedUrl;
    if (savedTok != null) process.env.UPSTASH_REDIS_REST_TOKEN = savedTok;
  }
});

// ---- runIfAllowed (gate side effects behind the limiter) --------------------

test("runIfAllowed: blocks perform and returns onLimited when over the limit", async () => {
  let performed = false;
  const out = await runIfAllowed(
    async () => ({ configured: true, allowed: false, remaining: 0, retryAfterSec: 12 }),
    () => "429",
    async () => {
      performed = true; // stands in for any DB/Storage/WhatsApp side effect
      return "ok";
    }
  );
  assert.equal(out, "429");
  assert.equal(performed, false, "no side effect may start when rate-limited");
});

test("runIfAllowed: runs perform when allowed", async () => {
  let performed = false;
  const out = await runIfAllowed(
    async () => ({ configured: true, allowed: true, remaining: 5, retryAfterSec: 0 }),
    () => "429",
    async () => {
      performed = true;
      return "ok";
    }
  );
  assert.equal(out, "ok");
  assert.equal(performed, true);
});

test("runIfAllowed: fail-open (configured:false) still runs perform", async () => {
  let performed = false;
  const out = await runIfAllowed(
    async () => ({ configured: false, allowed: true, remaining: 20, retryAfterSec: 0 }),
    () => "429",
    async () => {
      performed = true;
      return "ok";
    }
  );
  assert.equal(out, "ok");
  assert.equal(performed, true);
});
