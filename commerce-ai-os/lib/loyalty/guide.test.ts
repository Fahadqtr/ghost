import test from "node:test";
import assert from "node:assert/strict";

import { MIN_ORDER_QAR, rewardsSteps, rewardsTerms } from "./guide.ts";

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

test("the minimum order value is stated in the terms", () => {
  const terms = rewardsTerms(6);
  assert.ok(
    terms.some((t) => t.includes("أقل قيمة للطلب") && t.includes("٦٠") && t.includes("ريال")),
    "terms state the ٦٠ ريال minimum",
  );
  // It belongs with the other qualifying-order rules, right after the
  // "must be a product you bought" rule.
  const buyRule = terms.findIndex((t) => t.includes("اشتريتيه"));
  const minRule = terms.findIndex((t) => t.includes("أقل قيمة للطلب"));
  assert.ok(buyRule >= 0 && minRule === buyRule + 1, "grouped with the purchase rule");
});

test("the minimum order value comes from one constant and renders in Arabic digits", () => {
  assert.equal(MIN_ORDER_QAR, 60);
  // Changing the constant changes the copy — the wording cannot drift.
  assert.ok(rewardsTerms(6, 75).some((t) => t.includes("٧٥ ريال")));
  assert.ok(rewardsTerms(6, 100).some((t) => t.includes("١٠٠ ريال")));
  // Western digits never leak into this line.
  const line = rewardsTerms(6).find((t) => t.includes("أقل قيمة للطلب"))!;
  assert.ok(!/\d/.test(line), "no ASCII digits in the Arabic copy");
});

test("adding the rule did not disturb the existing terms", () => {
  const terms = rewardsTerms(6);
  for (const expected of [
    "كل تقييم صادق ومنشور فعلاً في سنونو = ختمة واحدة.",
    "التقييم لازم يكون لمنتج اشتريتيه من Malika's Universe.",
    "الصور المكررة أو غير الحقيقية لا تُعتمد.",
    "بعد استلام الجائزة تبدأ بطاقة جديدة من الصفر.",
  ]) {
    assert.ok(terms.includes(expected), `kept: ${expected}`);
  }
  assert.equal(terms.length, 10, "exactly one rule was added");
});
