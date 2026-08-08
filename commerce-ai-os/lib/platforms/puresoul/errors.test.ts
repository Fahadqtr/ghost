// PureSoul errors tests (Phase UI.9.1). PURE.
// Run: node --conditions=react-server --experimental-strip-types --test lib/platforms/puresoul/errors.test.ts

import test from "node:test";
import assert from "node:assert/strict";

import { PURESOUL_ERRORS, pureSoulErrorMessage, toSafeMessage } from "./errors.ts";

test("messages are fixed Arabic; unknown code falls back", () => {
  assert.equal(pureSoulErrorMessage("read_failed"), "تعذر قراءة PureSoul حاليًا.");
  assert.equal(pureSoulErrorMessage("not_connected"), "PureSoul غير مربوط.");
  // @ts-expect-error prototype-safe lookup of a non-code
  assert.equal(pureSoulErrorMessage("toString"), PURESOUL_ERRORS.unknown);
});

test("toSafeMessage never leaks a raw error", () => {
  const raw = new Error("select * from platform_status failed: password=secret");
  const msg = toSafeMessage(raw);
  assert.equal(msg, PURESOUL_ERRORS.read_failed);
  assert.ok(!msg.includes("secret"));
  assert.ok(!msg.includes("select"));
});
