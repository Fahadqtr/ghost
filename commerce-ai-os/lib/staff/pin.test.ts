// Tests for staff PIN hashing.
// Run: node --conditions=react-server --experimental-strip-types --test lib/staff/pin.test.ts
//
// PINs must be stored as a keyed hash (never plaintext); the hash has to be
// deterministic so login can look an employee up by it in one indexed query.
process.env.MALAK_SIGNING_SECRET ||= "test-signing-secret-pin";

import test from "node:test";
import assert from "node:assert/strict";

import { hashPin, isLegacyPlaintextPin } from "./pin.ts";

test("hash is deterministic and a 64-char hex digest", () => {
  const a = hashPin("1234");
  assert.equal(a, hashPin("1234"));
  assert.match(a, /^[0-9a-f]{64}$/);
});

test("different PINs hash differently; whitespace is trimmed", () => {
  assert.notEqual(hashPin("1234"), hashPin("5678"));
  assert.equal(hashPin(" 1234 "), hashPin("1234"));
});

test("hash depends on the server secret", () => {
  const a = hashPin("1234");
  const original = process.env.MALAK_SIGNING_SECRET;
  process.env.MALAK_SIGNING_SECRET = "different-secret";
  try {
    assert.notEqual(hashPin("1234"), a);
  } finally {
    process.env.MALAK_SIGNING_SECRET = original;
  }
});

test("isLegacyPlaintextPin flags raw 4-8 digit codes only", () => {
  for (const raw of ["1234", "12345678", "0000"]) {
    assert.equal(isLegacyPlaintextPin(raw), true, `${raw} is a legacy plaintext PIN`);
  }
  // A real hash (64 hex) and non-numeric / empty values are not legacy PINs.
  assert.equal(isLegacyPlaintextPin(hashPin("1234")), false);
  for (const notRaw of ["", null, undefined, "abc", "123", "123456789"]) {
    assert.equal(isLegacyPlaintextPin(notRaw as string | null | undefined), false, `${notRaw} is not a legacy PIN`);
  }
});
