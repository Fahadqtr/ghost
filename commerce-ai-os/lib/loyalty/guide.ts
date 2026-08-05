// Beauty Rewards — the customer-facing guide: how to take part (الطريقة) and
// the rules (الشروط). Pure, DB-free content so it's one source of truth for the
// public /rewards card (and anywhere else we show the rules). `required` is the
// hearts-per-card goal (STAMPS_REQUIRED) so the copy always matches the config.

/**
 * Minimum order value that qualifies for a stamp, in Qatari riyal.
 *
 * Copy-only: nothing in the codebase enforces this today, so it is stated here
 * as a rule for customers and kept in one place so the wording can never drift
 * from the number.
 */
export const MIN_ORDER_QAR = 60;

/** Arabic-Indic digits, matching the way the number was written for the card. */
function arDigits(n: number): string {
  const map = "٠١٢٣٤٥٦٧٨٩";
  return String(Math.trunc(Math.abs(n))).replace(/\d/g, (d) => map[Number(d)] ?? d);
}

/** Arabic number word for the small counts we use (falls back to the digit). */
function arCount(n: number): string {
  const words: Record<number, string> = {
    1: "ختمة واحدة", 2: "ختمتين", 3: "ثلاث ختمات", 4: "أربع ختمات",
    5: "خمس ختمات", 6: "ست ختمات", 7: "سبع ختمات", 8: "ثماني ختمات",
    9: "تسع ختمات", 10: "عشر ختمات",
  };
  return words[n] ?? `${n} ختمات`;
}

/** How to take part — ordered steps. */
export function rewardsSteps(required = 6): string[] {
  return [
    "سجّلي اسمك ورقم جوالك في البطاقة.",
    "اطلبي من Malika's Universe عبر تطبيق سنونو.",
    "بعد وصول طلبك، قيّمي المنتج في سنونو بتقييم صادق ⭐.",
    "صوّري التقييم وارفعي الصورة في بطاقتك.",
    "بعد اعتماد الإدارة تنختم لك ❤️ ختمة واحدة.",
    `اجمعي ${arCount(required)} واختاري جائزتك مجاناً 🎁.`,
    "توصلك القسيمة على واتساب — أبرزيها عند الاستلام 💝.",
  ];
}

/** The rules / terms & conditions. */
export function rewardsTerms(required = 6, minOrderQar = MIN_ORDER_QAR): string[] {
  return [
    "كل تقييم صادق ومنشور فعلاً في سنونو = ختمة واحدة.",
    "التقييم لازم يكون لمنتج اشتريتيه من Malika's Universe.",
    // Sits with the other qualifying-order rules, not down with the voucher terms.
    `أقل قيمة للطلب ${arDigits(minOrderQar)} ريال.`,
    "الصور المكررة أو غير الحقيقية لا تُعتمد.",
    "الختمة تُعتمد بعد مراجعة الإدارة (ليست فورية).",
    `تكتمل البطاقة عند جمع ${arCount(required)}.`,
    "تُختار الجائزة من الجوائز المتاحة وقت اكتمال البطاقة.",
    "القسيمة تخص صاحبة الرقم المسجّل، وغير قابلة للتحويل أو الاستبدال نقداً.",
    "بعد استلام الجائزة تبدأ بطاقة جديدة من الصفر.",
    "تحتفظ Malika's Universe بحق تعديل الشروط أو إيقاف الحملة في أي وقت.",
  ];
}
