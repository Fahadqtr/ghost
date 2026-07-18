import test from "node:test";
import assert from "node:assert/strict";

import { rewardsSteps, rewardsTerms } from "./guide.ts";

test("steps and terms are non-empty and mention Snoonu + the goal", () => {
  const steps = rewardsSteps(6);
  const terms = rewardsTerms(6);
  assert.ok(steps.length >= 5);
  assert.ok(terms.length >= 5);
  assert.ok(steps.some((s) => s.includes("سنونو")));
  assert.ok(steps.some((s) => s.includes("ست ختمات"))); // 6 → "ست ختمات"
  assert.ok(terms.some((t) => t.includes("ست ختمات")));
});

test("the goal count adapts to `required`", () => {
  assert.ok(rewardsSteps(3).some((s) => s.includes("ثلاث ختمات")));
  assert.ok(rewardsTerms(10).some((t) => t.includes("عشر ختمات")));
  // out-of-table counts fall back to the digit form, never throw
  assert.ok(rewardsSteps(12).some((s) => s.includes("12 ختمات")));
});
