// Source-level guarantees for the Meta token-transport change. The webhook
// route, the owner-only social routes, and the signature module import
// server-only side-effects, so node:test can't import them — instead we scan
// their sources. These lock in: no access_token= credential in any modified
// Meta URL, owner-only + webhook verification untouched, and a single central
// Graph helper adopted by both call sites.
// Run: node --conditions=react-server --experimental-strip-types --test lib/social/meta-token-transport.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

const INSTAGRAM = read("lib/social/instagram.ts");
const INBOX = read("lib/dm/inbox.ts");
const GRAPH = read("lib/social/graph.ts");

test("12: no access_token= credential in any outgoing Meta URL (modified scope)", () => {
  for (const [name, src] of [["instagram.ts", INSTAGRAM], ["inbox.ts", INBOX]] as const) {
    // `?access_token=` / `&access_token=` is the credential-in-URL pattern we
    // removed. (A `fields=...,access_token` field request is a response field,
    // not a URL credential, and is intentionally allowed.)
    assert.ok(!/[?&]access_token=/.test(src), `${name} still has access_token= in a URL`);
    assert.ok(!src.includes("access_token=${"), `${name} still interpolates a token into a URL`);
  }
});

test("3/4: publish + DM route every Graph call through the single central helper", () => {
  assert.match(GRAPH, /export async function graphFetch/, "central helper exists in lib/social/graph.ts");
  assert.match(INSTAGRAM, /from "\.\/graph"/, "instagram.ts imports the central helper");
  assert.match(INSTAGRAM, /graphFetch[<(]/);
  assert.match(INBOX, /from "\.\.\/social\/graph"/, "inbox.ts imports the central helper");
  assert.match(INBOX, /graphFetch[<(]/);
  // The chokepoint guarantee: no raw `fetch(` remains in either module, so
  // EVERY outgoing Meta/Instagram request goes through graphFetch — which
  // graph.test.ts proves never puts the token in the URL or body. ("graphFetch("
  // has a capital F, so a lowercase /fetch\(/ matches only a raw call.)
  assert.ok(!/fetch\(/.test(INSTAGRAM), "instagram.ts (Social publish) must have no raw fetch — safe path only");
  assert.ok(!/fetch\(/.test(INBOX), "inbox.ts (Inbox/DM) must have no raw fetch — safe path only");
});

test("8: neither module logs a raw response body (no r.text()) or the token", () => {
  for (const [name, src] of [["instagram.ts", INSTAGRAM], ["inbox.ts", INBOX]] as const) {
    assert.ok(!/\.text\(\)/.test(src), `${name} must not read/log a raw response body`);
  }
  // The DM send path logs only the classified category, never the raw body.
  assert.match(INBOX, /console\.error\("\[dm-send\]", base, lastErr\)/);
  assert.match(INBOX, /lastErr = r\.errorKind/);
});

test("9: DM request body + method are unchanged (only the token transport moved)", () => {
  assert.match(INBOX, /"\/me\/messages"/, "same endpoint");
  assert.match(INBOX, /method: "POST"/, "same method");
  assert.match(INBOX, /recipient: \{ id: recipientId \}, message: \{ text: text\.slice\(0, 900\) \}/, "same body shape");
});

test("11: owner-only enforcement preserved on the social routes", () => {
  for (const rel of ["app/api/social/ig-verify/route.ts", "app/api/social/ig-test-publish/route.ts"]) {
    const src = read(rel);
    assert.match(src, /requireOwner/, `${rel} must still enforce requireOwner`);
  }
});

test("10: Meta webhook signature verification is unchanged (fail closed)", () => {
  const src = read("app/api/webhooks/meta/route.ts");
  assert.match(src, /verifyMetaSignature/, "webhook still verifies the HMAC signature");
  assert.match(src, /status:\s*503/, "still fails closed (503) when the secret is absent");
  assert.match(src, /status:\s*401/, "still rejects (401) an invalid signature");
});

test("classified error categories are the only allowed shapes", () => {
  for (const kind of ["meta_auth_error", "meta_rate_limited", "meta_api_error", "meta_network_error"]) {
    assert.ok(GRAPH.includes(kind), `graph.ts defines ${kind}`);
  }
});
