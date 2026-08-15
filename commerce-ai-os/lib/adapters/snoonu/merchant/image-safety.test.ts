// CH.6B — fetched-image safety tests.
// node --conditions=react-server --experimental-strip-types --test lib/adapters/snoonu/merchant/image-safety.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { validateFetchedImage, looksLikeImage, looksLikeHtml } from "./image-safety.ts";

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const HTML = new Uint8Array([...Buffer.from("<!doctype html><html>login")]);

test("valid JPEG/PNG pass", () => {
  assert.ok(looksLikeImage(JPEG));
  assert.ok(looksLikeImage(PNG));
  assert.equal(validateFetchedImage({ contentType: "image/jpeg", byteLength: 50_000, headBytes: JPEG, width: 800, height: 800 }).ok, true);
});

test("HTML login page masquerading as image is rejected", () => {
  assert.ok(looksLikeHtml(HTML));
  const r = validateFetchedImage({ contentType: "text/html", byteLength: 2000, headBytes: HTML });
  assert.equal(r.ok, false);
  // even if the content-type lies:
  const r2 = validateFetchedImage({ contentType: "image/jpeg", byteLength: 2000, headBytes: HTML });
  assert.equal(r2.ok, false);
});

test("unsupported content-type rejected", () => {
  assert.equal(validateFetchedImage({ contentType: "application/pdf", byteLength: 50_000, headBytes: JPEG }).ok, false);
});

test("size + dimension bounds", () => {
  assert.equal(validateFetchedImage({ contentType: "image/png", byteLength: 10, headBytes: PNG }).ok, false); // too small
  assert.equal(validateFetchedImage({ contentType: "image/png", byteLength: 999_999_999, headBytes: PNG }).ok, false); // too large
  assert.equal(validateFetchedImage({ contentType: "image/png", byteLength: 50_000, headBytes: PNG, width: 20, height: 20 }).ok, false); // too small dims
});

test("bytes not a recognized image are rejected even with image/* content-type", () => {
  const junk = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(validateFetchedImage({ contentType: "image/jpeg", byteLength: 50_000, headBytes: junk }).ok, false);
});
