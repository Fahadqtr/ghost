// Platform Snapshot Engine — hash tests (Phase UI.9.2). PURE.
// Run: node --conditions=react-server --experimental-strip-types --test lib/platforms/core/hash.test.ts

import test from "node:test";
import assert from "node:assert/strict";

import { hashPayload, stableStringify, canonicalize } from "./hash.ts";

test("hash is stable for identical content", () => {
  const a = hashPayload({ price: 10, title: "x", metadata: { a: 1 } });
  const b = hashPayload({ price: 10, title: "x", metadata: { a: 1 } });
  assert.equal(a, b);
});

test("hash is INDEPENDENT of key order (top-level and nested)", () => {
  const a = hashPayload({ price: 10, title: "x", metadata: { a: 1, b: 2 } });
  const b = hashPayload({ title: "x", metadata: { b: 2, a: 1 }, price: 10 });
  assert.equal(a, b);
});

test("hash changes when any value changes", () => {
  const base = hashPayload({ price: 10, title: "x" });
  assert.notEqual(base, hashPayload({ price: 11, title: "x" }));
  assert.notEqual(base, hashPayload({ price: 10, title: "y" }));
});

test("array order is significant (not sorted)", () => {
  assert.notEqual(hashPayload({ m: [1, 2] }), hashPayload({ m: [2, 1] }));
});

test("undefined normalizes to null in canonical form", () => {
  assert.equal(stableStringify({ a: undefined }), stableStringify({ a: null }));
});

test("canonicalize sorts nested keys but preserves arrays", () => {
  assert.deepEqual(canonicalize({ b: 1, a: { d: 4, c: 3 } }), { a: { c: 3, d: 4 }, b: 1 });
  assert.deepEqual(canonicalize([{ b: 2, a: 1 }]), [{ a: 1, b: 2 }]);
});

test("digest is 64-char sha256 hex", () => {
  assert.match(hashPayload({ a: 1 }), /^[0-9a-f]{64}$/);
});
