// UX.1A — long-text helper tests.
// node --conditions=react-server --experimental-strip-types --test lib/ui/text.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { isExpandableText, CLAMP_LINES, EXPAND_CHAR_THRESHOLD } from "./text.ts";

test("clamp is a small, fixed number of lines", () => {
  assert.equal(CLAMP_LINES, 3);
});

test("short single-line text needs no expand toggle", () => {
  assert.equal(isExpandableText("Rose serum"), false);
  assert.equal(isExpandableText(""), false);
  assert.equal(isExpandableText("   "), false);
  assert.equal(isExpandableText(null), false);
  assert.equal(isExpandableText(undefined), false);
});

test("multi-line text always needs a toggle", () => {
  assert.equal(isExpandableText("line1\nline2"), true);
  assert.equal(isExpandableText("a\r\nb"), true);
});

test("long single-line text needs a toggle past the threshold", () => {
  assert.equal(isExpandableText("x".repeat(EXPAND_CHAR_THRESHOLD)), false, "at the threshold, not over");
  assert.equal(isExpandableText("x".repeat(EXPAND_CHAR_THRESHOLD + 1)), true);
});

test("threshold is configurable", () => {
  assert.equal(isExpandableText("abcdef", 5), true);
  assert.equal(isExpandableText("abc", 5), false);
});
