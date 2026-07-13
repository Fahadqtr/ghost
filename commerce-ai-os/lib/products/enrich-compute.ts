// AI catalog-completion core — pure prompt/parse, DB- and API-free (tested).
//
// Given a product's current fields (+ optionally its photo, added by the
// caller), the model fills the MISSING Arabic name / Arabic description /
// category in the house style, makes the Arabic MATCH the English meaning, and
// judges whether the photo matches the product. The caller owns the model call
// and decides which generated fields to write.

export interface EnrichInput {
  name_en: string | null;
  name_ar: string | null;
  description_en: string | null;
  description_ar: string | null;
  main_category: string | null;
}

export interface EnrichResult {
  name_ar: string;          // suggested Arabic name (house style), "" if none
  description_ar: string;   // suggested Arabic description matching the English
  main_category: string;    // from the allowed list, else ""
  arMatchesEn: boolean | null;   // did the EXISTING Arabic match the English?
  imageMatches: boolean | null;  // does the photo match name/description? null = no photo
  notes: string;            // short human note on any mismatch
}

const has = (s: string | null | undefined) => !!String(s ?? "").trim();

/** What's still missing on this product (drives the "needs work" list). */
export function missingFields(p: EnrichInput): Array<"name_ar" | "description_ar" | "main_category"> {
  const out: Array<"name_ar" | "description_ar" | "main_category"> = [];
  if (!has(p.name_ar)) out.push("name_ar");
  if (!has(p.description_ar)) out.push("description_ar");
  if (!has(p.main_category)) out.push("main_category");
  return out;
}

/** Prompt: fill the gaps + verify Arabic⇄English + (if a photo is attached) verify the photo. */
export function buildEnrichPrompt(p: EnrichInput, categories: readonly string[], hasImage: boolean): string {
  const cur = JSON.stringify({
    name_en: p.name_en ?? "", name_ar: p.name_ar ?? "",
    description_en: p.description_en ?? "", description_ar: p.description_ar ?? "",
    main_category: p.main_category ?? "",
  }, null, 0);
  return (
    "أنت مساعد كتالوج لمتجر Malika's Universe (جمال وكورية، قطر). عندك بيانات منتج ناقصة، أكمِلها وتحقّق منها.\n\n" +
    `البيانات الحالية:\n${cur}\n\n` +
    (hasImage
      ? "مرفقة صورة المنتج — استخدمها للفهم وللتحقّق.\n\n"
      : "لا توجد صورة مرفقة — اعتمد على النص.\n\n") +
    "أرجِع JSON فقط بهذه الحقول بالضبط:\n" +
    '{"name_ar":"","description_ar":"","main_category":"","ar_matches_en":true,"image_matches":null,"notes":""}\n\n' +
    "القواعد:\n" +
    "• name_ar = الاسم بالعربية ثم مسافة وشرطة ثم الاسم بالإنجليزية (مثل «... - Rhode Guava Spritz Set»). لازم يعبّر عن نفس المنتج في name_en.\n" +
    "• description_ar = وصف عربي **يطابق معنى** description_en: جملة افتتاحية، ثم 4–6 نقاط تبدأ كل واحدة بـ 🔸 وسطر جديد (\\n)، ثم «اللون: ...» و«المحتويات: ...» إن وُجدت. لو description_en فاضي، اكتب وصفًا مناسبًا من الاسم/الصورة.\n" +
    `• main_category = الأنسب من هذه القائمة فقط: ${categories.join(", ")}.\n` +
    "• املأ كل الحقول الثلاثة دائمًا (حتى لو الحالي غير فاضي، أعطِ أفضل نسخة مطابقة).\n" +
    "• ar_matches_en = هل الاسم/الوصف العربي **الحالي** يطابق الإنجليزي؟ (true/false؛ إذا الحالي فاضي اجعلها false).\n" +
    (hasImage
      ? "• image_matches = هل الصورة تطابق اسم/وصف المنتج؟ (true/false).\n"
      : "• image_matches = null (لا صورة).\n") +
    "• notes = ملاحظة قصيرة جدًا عن أي تعارض (صورة لا تطابق، أو عربي كان مخالفًا للإنجليزي)، وإلا اتركها فارغة.\n\n" +
    "أجب بـ JSON صحيح فقط بدون أي نص إضافي."
  );
}

/** Tolerant parse: first {...} block; category blanked if not in the list. */
export function parseEnrichResult(text: string, categories: readonly string[]): EnrichResult | null {
  const m = String(text ?? "").match(/\{[\s\S]*\}/);
  if (!m) return null;
  let j: Record<string, unknown>;
  try { j = JSON.parse(m[0]); } catch { return null; }
  const s = (x: unknown) => (x == null ? "" : String(x).trim());
  const bool = (x: unknown): boolean | null =>
    x === true || x === "true" ? true : x === false || x === "false" ? false : null;
  const cat = s(j.main_category);
  return {
    name_ar: s(j.name_ar),
    description_ar: s(j.description_ar),
    main_category: categories.includes(cat) ? cat : "",
    arMatchesEn: bool(j.ar_matches_en),
    imageMatches: bool(j.image_matches),
    notes: s(j.notes),
  };
}
