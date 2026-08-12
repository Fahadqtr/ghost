import test from "node:test";
import assert from "node:assert/strict";

import { MIN_ORDER_QAR, rewardsSteps } from "./guide.ts";

test("the guide is exactly the five participation steps and mentions Snoonu", () => {
  const steps = rewardsSteps(6);
  assert.equal(steps.length, 5);
  assert.ok(steps.some((s) => s.includes("سنونو")));
  assert.ok(steps.some((s) => s.includes("بطاقة المكافآت")));
  assert.ok(steps.some((s) => s.includes("هديتك مجاناً")));
});

test("the goal count adapts to `required`, in Arabic-Indic digits", () => {
  assert.ok(rewardsSteps(6).some((s) => s.includes("٦ أختام")));
  assert.ok(rewardsSteps(3).some((s) => s.includes("٣ أختام")));
  assert.ok(rewardsSteps(12).some((s) => s.includes("١٢ أختام")));
});

test("the minimum order value comes from one constant and renders in Arabic digits", () => {
  assert.equal(MIN_ORDER_QAR, 80);
  assert.ok(rewardsSteps(6).some((s) => s.includes("٨٠ ريال")));
  // Changing the constant changes the copy — the wording cannot drift.
  assert.ok(rewardsSteps(6, 75).some((s) => s.includes("٧٥ ريال")));
  assert.ok(rewardsSteps(6, 100).some((s) => s.includes("١٠٠ ريال")));
  // Western digits never leak into the Arabic order line.
  const line = rewardsSteps(6).find((s) => s.includes("الحد الأدنى للطلب"))!;
  assert.ok(!/\d/.test(line), "no ASCII digits in the Arabic copy");
});
