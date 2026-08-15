// CH.3 — safe-error unit tests.
// node --conditions=react-server --experimental-strip-types --test lib/security/safe-error.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { describeError, safeError } from "./safe-error.ts";

test("describeError extracts message from Error / string / {code,message} / unknown", () => {
  assert.equal(describeError(new Error("boom")), "boom");
  assert.equal(describeError("raw string"), "raw string");
  assert.equal(describeError({ code: "42P01", message: "relation missing" }), "42P01 relation missing");
  assert.equal(describeError({ message: "only msg" }), "only msg");
  assert.equal(describeError(42), "42");
  assert.equal(describeError(null), "null");
});

test("safeError returns ONLY the public message (never the raw detail)", () => {
  const publicMsg = "تعذّر تنفيذ العملية.";
  const out = safeError("tag.x", new Error("supabase: column products.secret does not exist"), publicMsg);
  assert.equal(out, publicMsg);
  assert.ok(!/supabase|column|secret/.test(out), "raw DB detail must not appear in the returned message");
});

test("safeError logs the raw detail server-side under the tag", () => {
  const orig = console.error;
  const seen: string[] = [];
  // eslint-disable-next-line no-console
  console.error = (...a: unknown[]) => { seen.push(a.map(String).join(" ")); };
  try {
    safeError("snoonu.applyUpdates", { code: "23505", message: "duplicate key" }, "فشل.");
  } finally {
    console.error = orig;
  }
  assert.equal(seen.length, 1);
  assert.ok(seen[0].includes("[snoonu.applyUpdates]"), "log carries the tag");
  assert.ok(seen[0].includes("duplicate key"), "log carries the raw detail for observability");
});
