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
    assert.deepEqual(r, {
      configured: false,
      allowed: true,
      remaining: 3,
      retryAfterSec: 0,
      reason: "missing_config",
    });
  } finally {
    if (savedUrl != null) process.env.UPSTASH_REDIS_REST_URL = savedUrl;
    if (savedTok != null) process.env.UPSTASH_REDIS_REST_TOKEN = savedTok;
  }
});

// ---- runIfAllowed (gate side effects behind the limiter) --------------------

test("runIfAllowed: blocks perform and returns onLimited when over the limit", async () => {
  let performed = false;
  const out = await runIfAllowed(
    async () => ({ configured: true, allowed: false, remaining: 0, retryAfterSec: 12, reason: "ok" as const }),
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
    async () => ({ configured: true, allowed: true, remaining: 5, retryAfterSec: 0, reason: "ok" as const }),
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
    async () => ({ configured: false, allowed: true, remaining: 20, retryAfterSec: 0, reason: "missing_config" as const }),
    () => "429",
    async () => {
      performed = true;
      return "ok";
    }
  );
  assert.equal(out, "ok");
  assert.equal(performed, true);
});

// ---- fail-open reason classification + safe logging (mocked fetch) ----------

/**
 * Run rateLimit() with fetch + console.warn mocked and dummy Upstash env, then
 * restore everything. Returns the result and any captured warning lines.
 * Uses TEST-NET IP 203.0.113.9 and dummy creds — never real data.
 */
async function runWithMockedUpstash(opts: {
  fetchImpl?: () => Promise<Response>;
  configured?: boolean;
}): Promise<{ result: Awaited<ReturnType<typeof rateLimit>>; warnings: string[] }> {
  const savedUrl = process.env.UPSTASH_REDIS_REST_URL;
  const savedTok = process.env.UPSTASH_REDIS_REST_TOKEN;
  const savedFetch = globalThis.fetch;
  const savedWarn = console.warn;
  const warnings: string[] = [];
  console.warn = (...a: unknown[]) => { warnings.push(a.map(String).join(" ")); };
  if (opts.configured === false) {
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
  } else {
    process.env.UPSTASH_REDIS_REST_URL = "https://dummy.upstash.invalid";
    process.env.UPSTASH_REDIS_REST_TOKEN = "dummy-token-value";
  }
  if (opts.fetchImpl) globalThis.fetch = opts.fetchImpl as typeof globalThis.fetch;
  try {
    const result = await rateLimit("rewards:state", "203.0.113.9", { limit: 20, windowSec: 300 });
    return { result, warnings };
  } finally {
    globalThis.fetch = savedFetch;
    console.warn = savedWarn;
    if (savedUrl != null) process.env.UPSTASH_REDIS_REST_URL = savedUrl; else delete process.env.UPSTASH_REDIS_REST_URL;
    if (savedTok != null) process.env.UPSTASH_REDIS_REST_TOKEN = savedTok; else delete process.env.UPSTASH_REDIS_REST_TOKEN;
  }
}

test("reason=missing_config when URL/token absent (fail open, warns)", async () => {
  const { result, warnings } = await runWithMockedUpstash({ configured: false });
  assert.equal(result.reason, "missing_config");
  assert.equal(result.allowed, true);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0], "[ratelimit] fail_open scope=rewards:state reason=missing_config");
});

test("reason=upstream_status on HTTP 401/500 (fail open)", async () => {
  for (const status of [401, 500]) {
    const { result, warnings } = await runWithMockedUpstash({
      fetchImpl: async () => new Response(null, { status }),
    });
    assert.equal(result.reason, "upstream_status");
    assert.equal(result.allowed, true, "must fail open");
    assert.equal(warnings[0], "[ratelimit] fail_open scope=rewards:state reason=upstream_status");
  }
});

test("reason=timeout when the fetch aborts (fail open)", async () => {
  const { result, warnings } = await runWithMockedUpstash({
    fetchImpl: async () => {
      const e = new Error("The operation was aborted due to timeout");
      e.name = "TimeoutError";
      throw e;
    },
  });
  assert.equal(result.reason, "timeout");
  assert.equal(result.allowed, true);
  assert.equal(warnings[0], "[ratelimit] fail_open scope=rewards:state reason=timeout");
});

test("reason=invalid_response when the pipeline result isn't a number", async () => {
  const { result, warnings } = await runWithMockedUpstash({
    fetchImpl: async () => new Response(JSON.stringify([{ result: "not-a-number" }]), { status: 200 }),
  });
  assert.equal(result.reason, "invalid_response");
  assert.equal(result.allowed, true);
  assert.equal(warnings[0], "[ratelimit] fail_open scope=rewards:state reason=invalid_response");
});

test("reason=network_error on a generic fetch throw", async () => {
  const { result, warnings } = await runWithMockedUpstash({
    fetchImpl: async () => { throw new Error("ECONNREFUSED"); },
  });
  assert.equal(result.reason, "network_error");
  assert.equal(result.allowed, true);
  assert.equal(warnings[0], "[ratelimit] fail_open scope=rewards:state reason=network_error");
});

test("reason=ok on a valid response, and NO warning is emitted", async () => {
  const { result, warnings } = await runWithMockedUpstash({
    fetchImpl: async () => new Response(JSON.stringify([{ result: 1 }]), { status: 200 }),
  });
  assert.equal(result.reason, "ok");
  assert.equal(result.allowed, true);
  assert.equal(result.configured, true);
  assert.equal(warnings.length, 0, "ok must never warn");
});

test("a real block (over limit) is reason=ok, blocks, and does NOT warn", async () => {
  const { result, warnings } = await runWithMockedUpstash({
    fetchImpl: async () => new Response(JSON.stringify([{ result: 21 }]), { status: 200 }),
  });
  assert.equal(result.reason, "ok");
  assert.equal(result.allowed, false, "count 21 > limit 20 must block");
  assert.equal(warnings.length, 0, "a real block is not a fail-open");
  // And the block actually prevents perform via runIfAllowed.
  let performed = false;
  const out = await runIfAllowed(async () => result, () => "429", async () => { performed = true; return "ok"; });
  assert.equal(out, "429");
  assert.equal(performed, false);
});

test("fail-open result still lets runIfAllowed run perform", async () => {
  const { result } = await runWithMockedUpstash({
    fetchImpl: async () => { throw new Error("boom"); },
  });
  let performed = false;
  const out = await runIfAllowed(async () => result, () => "429", async () => { performed = true; return "ok"; });
  assert.equal(out, "ok");
  assert.equal(performed, true);
});

test("the warning line leaks no URL, token, IP, Redis key, or PII", async () => {
  const { warnings } = await runWithMockedUpstash({
    fetchImpl: async () => new Response(null, { status: 500 }),
  });
  const line = warnings[0] ?? "";
  // present: scope + reason only
  assert.match(line, /^\[ratelimit\] fail_open scope=rewards:state reason=upstream_status$/);
  // absent: any sensitive token
  for (const secret of ["dummy.upstash.invalid", "dummy-token-value", "203.0.113.9", "rl:", "Bearer", "http"]) {
    assert.equal(line.includes(secret), false, `warning must not contain ${secret}`);
  }
});
