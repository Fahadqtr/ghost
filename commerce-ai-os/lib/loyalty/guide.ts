// Beauty Rewards — the customer-facing guide: the ordered steps to take part
// (الطريقة). Pure, DB-free content so it is the one source of truth for the
// public /rewards card (and anywhere else the rules are shown). `required` is
// the stamps-per-card goal (STAMPS_REQUIRED) so the copy always matches config.

/**
 * Minimum order value that qualifies for a stamp, in Qatari riyal.
 *
 * Copy-only: nothing in the codebase enforces this today, so it is stated here
 * as a rule for customers and kept in one place so the wording can never drift
 * from the number.
 */
export const MIN_ORDER_QAR = 80;

/** Arabic-Indic digits, matching the way numbers are written on the card. */
function arDigits(n: number): string {
  const map = "٠١٢٣٤٥٦٧٨٩";
  return String(Math.trunc(Math.abs(n))).replace(/\d/g, (d) => map[Number(d)] ?? d);
}

/**
 * How to take part — the ordered steps shown on the card. These five lines are
 * the whole guide: the qualifying-order rule (minimum value) is folded into the
 * order step, and there is no separate terms list.
 */
export function rewardsSteps(required = 6, minOrderQar = MIN_ORDER_QAR): string[] {
  return [
    "سجّلي بياناتك في بطاقة المكافآت.",
    `اطلبي من Malika's Universe عبر سنونو (الحد الأدنى للطلب ${arDigits(minOrderQar)} ريال).`,
    "اتركي تقييمًا إيجابيًا للمنتج على سنونو بعد استلامه.",
    "ارفعي صورة التقييم في بطاقتك.",
    `اجمعي ${arDigits(required)} أختام واختاري هديتك مجاناً.`,
  ];
}
