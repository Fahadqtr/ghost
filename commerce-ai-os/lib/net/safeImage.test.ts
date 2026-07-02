// Tests for the SSRF URL guard.
// Run: node --experimental-strip-types --test lib/net/safeImage.test.ts

import test from "node:test";
import assert from "node:assert/strict";

import { assertSafeImageUrl, assertSafeBrowseUrl, safeImageUrlOrNull } from "./safeImage.ts";

// Anything that resolves to an internal/metadata target must be rejected,
// including the numeric-IP encodings that inet_aton accepts.
const BLOCKED = [
  "https://localhost/x",
  "https://127.0.0.1/x",
  "https://169.254.169.254/latest/meta-data/", // cloud metadata
  "https://10.0.0.5/x",
  "https://192.168.1.1/x",
  "https://172.16.0.1/x",
  "https://[::1]/x", // IPv6 loopback
  "https://[fd00::1]/x", // IPv6 unique-local
  "https://[::ffff:127.0.0.1]/x", // IPv4-mapped IPv6
  "https://2130706433/x", // decimal 127.0.0.1
  "https://0x7f000001/x", // hex 127.0.0.1
  "https://0177.0.0.1/x", // octal 127.0.0.1
  "https://127.1/x", // short form 127.0.0.1
  "https://100.64.0.1/x", // CGNAT
  "https://foo.internal/x",
  "https://box.local/x",
];

// Legitimate public destinations must still pass.
const ALLOWED = [
  "https://cdn.snoonu.com/img/1.jpg",
  "https://abc.supabase.co/storage/v1/object/x.png",
  "https://8.8.8.8/x", // public IP literal
  "https://fcbarcelona.com/logo.png", // hostname starting with "fc" — not IPv6
];

test("assertSafeImageUrl blocks internal / numeric-encoded targets", () => {
  for (const u of BLOCKED) {
    assert.throws(() => assertSafeImageUrl(u), new RegExp("."), `should block ${u}`);
  }
});

test("assertSafeImageUrl allows public https hosts", () => {
  for (const u of ALLOWED) {
    assert.doesNotThrow(() => assertSafeImageUrl(u), `should allow ${u}`);
  }
});

test("assertSafeImageUrl requires https", () => {
  assert.throws(() => assertSafeImageUrl("http://cdn.snoonu.com/x.jpg"));
});

test("assertSafeBrowseUrl allows http but still blocks internal", () => {
  assert.doesNotThrow(() => assertSafeBrowseUrl("http://example.com/x"));
  assert.throws(() => assertSafeBrowseUrl("http://127.0.0.1/x"));
  assert.throws(() => assertSafeBrowseUrl("http://2130706433/x"));
});

test("safeImageUrlOrNull returns null instead of throwing", () => {
  assert.equal(safeImageUrlOrNull("https://169.254.169.254/x"), null);
  assert.equal(safeImageUrlOrNull(""), null);
  assert.equal(safeImageUrlOrNull(123 as unknown), null);
  assert.equal(
    safeImageUrlOrNull("https://cdn.snoonu.com/1.jpg"),
    "https://cdn.snoonu.com/1.jpg",
  );
});
