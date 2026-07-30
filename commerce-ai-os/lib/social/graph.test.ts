// Tests for the central Graph API client. All network is MOCKED — no real
// Meta/Instagram call is made. These prove the token rides ONLY in the
// Authorization header, never the URL/body, that failures are classified into
// a safe category, and that neither the token nor a raw response can leak.
// Run: node --conditions=react-server --experimental-strip-types --test lib/social/graph.test.ts

import test from "node:test";
import assert from "node:assert/strict";

import {
  graphFetch,
  classifyMetaStatus,
  redactToken,
  GRAPH_BASE,
  IG_GRAPH_BASE,
} from "./graph.ts";

const TOKEN = "SUPER_SECRET_TOKEN_9x";

type Call = { url: string; init: any };
function installFetch(
  responder: (url: string, init: any) => { status?: number; ok?: boolean; json?: unknown; throwErr?: string },
) {
  const calls: Call[] = [];
  const orig = globalThis.fetch;
  globalThis.fetch = (async (url: unknown, init: unknown) => {
    const u = String(url);
    calls.push({ url: u, init });
    const r = responder(u, init as any);
    if (r.throwErr) throw new Error(r.throwErr);
    const status = r.status ?? 200;
    return {
      ok: r.ok ?? (status >= 200 && status < 300),
      status,
      json: async () => r.json ?? {},
      text: async () => JSON.stringify(r.json ?? {}),
    } as unknown as Response;
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = orig; } };
}

test("1/2: token rides in Authorization header, never the URL", async () => {
  const f = installFetch(() => ({ json: { ok: true } }));
  try {
    await graphFetch("/me/accounts", { token: TOKEN, query: { fields: "name" } });
    const { url, init } = f.calls[0];
    assert.equal(url, `${GRAPH_BASE}/me/accounts?fields=name`);
    assert.ok(!url.includes(TOKEN), "URL must not contain the token");
    assert.ok(!/access_token=/.test(url), "URL must not contain access_token=");
    assert.equal(init.headers.Authorization, `Bearer ${TOKEN}`);
  } finally { f.restore(); }
});

test("9: method + JSON body are preserved and carry no token", async () => {
  const f = installFetch(() => ({ json: { id: "c1" } }));
  try {
    await graphFetch("/123/media", { token: TOKEN, method: "POST", body: { media_type: "REELS", video_url: "https://x/v.mp4" } });
    const { init } = f.calls[0];
    assert.equal(init.method, "POST");
    assert.equal(init.headers["Content-Type"], "application/json");
    const body = JSON.parse(init.body);
    assert.deepEqual(body, { media_type: "REELS", video_url: "https://x/v.mp4" });
    assert.ok(!("access_token" in body), "body must not contain access_token");
    assert.ok(!init.body.includes(TOKEN), "body must not contain the token");
  } finally { f.restore(); }
});

test("GET sends no body and no Content-Type", async () => {
  const f = installFetch(() => ({ json: {} }));
  try {
    await graphFetch("/x", { token: TOKEN });
    const { init } = f.calls[0];
    assert.equal(init.method, "GET");
    assert.equal(init.body, undefined);
    assert.equal(init.headers["Content-Type"], undefined);
  } finally { f.restore(); }
});

test("6: non-2xx maps to a safe classified category", async () => {
  const cases: [number, string][] = [
    [401, "meta_auth_error"],
    [403, "meta_auth_error"],
    [429, "meta_rate_limited"],
    [400, "meta_api_error"],
    [500, "meta_api_error"],
  ];
  for (const [status, kind] of cases) {
    const f = installFetch(() => ({ status, ok: false, json: { error: { message: "generic" } } }));
    try {
      const r = await graphFetch("/x", { token: TOKEN });
      assert.equal(r.ok, false);
      assert.equal(r.errorKind, kind, `status ${status} → ${kind}`);
    } finally { f.restore(); }
  }
});

test("6: a token echoed in an error message is redacted", async () => {
  const f = installFetch(() => ({ status: 400, ok: false, json: { error: { message: `bad token ${TOKEN} here` } } }));
  try {
    const r = await graphFetch("/x", { token: TOKEN });
    assert.equal(r.ok, false);
    assert.ok(!r.errorMessage!.includes(TOKEN), "errorMessage must not contain the token");
    assert.ok(r.errorMessage!.includes("[redacted]"));
  } finally { f.restore(); }
});

test("7: a network error is classified and never exposes the token", async () => {
  const f = installFetch(() => ({ throwErr: `connect ECONNREFUSED ${GRAPH_BASE}/x?access_token=${TOKEN}` }));
  try {
    const r = await graphFetch("/x", { token: TOKEN });
    assert.equal(r.ok, false);
    assert.equal(r.errorKind, "meta_network_error");
    assert.equal(r.errorMessage, "meta_network_error");
    assert.ok(!JSON.stringify(r).includes(TOKEN), "result must not contain the token");
  } finally { f.restore(); }
});

test("query on a path that already has a query string is merged with &", async () => {
  const f = installFetch(() => ({ json: {} }));
  try {
    await graphFetch("/me?fields=id", { token: TOKEN, query: { limit: 10 }, base: IG_GRAPH_BASE });
    assert.equal(f.calls[0].url, `${IG_GRAPH_BASE}/me?fields=id&limit=10`);
  } finally { f.restore(); }
});

test("8: the helper itself logs nothing (no token to any console channel)", async () => {
  const errs: unknown[][] = [];
  const logs: unknown[][] = [];
  const origErr = console.error, origLog = console.log;
  console.error = (...a: unknown[]) => { errs.push(a); };
  console.log = (...a: unknown[]) => { logs.push(a); };
  const f = installFetch(() => ({ status: 401, ok: false, json: { error: { message: TOKEN } } }));
  try {
    await graphFetch("/x", { token: TOKEN, method: "POST", body: { a: 1 } });
  } finally {
    f.restore(); console.error = origErr; console.log = origLog;
  }
  assert.equal(errs.length, 0);
  assert.equal(logs.length, 0);
});

test("redactToken strips the token and any access_token= fragment", () => {
  assert.equal(redactToken(`x ${TOKEN} y`, TOKEN), "x [redacted] y");
  assert.equal(redactToken("url?access_token=abc123&z=1"), "url?access_token=[redacted]&z=1");
  assert.equal(redactToken("nothing here", TOKEN), "nothing here");
});

test("classifyMetaStatus boundaries", () => {
  assert.equal(classifyMetaStatus(401), "meta_auth_error");
  assert.equal(classifyMetaStatus(403), "meta_auth_error");
  assert.equal(classifyMetaStatus(429), "meta_rate_limited");
  assert.equal(classifyMetaStatus(400), "meta_api_error");
  assert.equal(classifyMetaStatus(502), "meta_api_error");
});
