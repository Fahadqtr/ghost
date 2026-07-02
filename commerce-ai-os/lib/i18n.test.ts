// Tests for the cookie-based i18n helpers.
// Run: node --conditions=react-server --experimental-strip-types --test lib/i18n.test.ts

import test from "node:test";
import assert from "node:assert/strict";

import { parseLocale, dirOf, makeT } from "./i18n.ts";

test("parseLocale accepts 'en', defaults everything else to 'ar'", () => {
  assert.equal(parseLocale("en"), "en");
  assert.equal(parseLocale("ar"), "ar");
  assert.equal(parseLocale(undefined), "ar");
  assert.equal(parseLocale(null), "ar");
  assert.equal(parseLocale("fr"), "ar"); // unknown → default
});

test("dirOf maps locale to text direction", () => {
  assert.equal(dirOf("ar"), "rtl");
  assert.equal(dirOf("en"), "ltr");
});

test("makeT returns the localized string", () => {
  assert.equal(makeT("en")("app.signOut"), "Sign out");
  assert.equal(makeT("ar")("app.signOut"), "تسجيل الخروج");
});

test("makeT falls back to the provided fallback, then the key itself", () => {
  assert.equal(makeT("en")("missing.key", "Fallback"), "Fallback");
  assert.equal(makeT("en")("missing.key"), "missing.key");
});
