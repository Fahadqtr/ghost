// Product-draft prompt + response parsing — pure, DB-free core.
//
// ONE house style for AI product drafts, shared by BOTH entry points (the
// staff photo-first flow and the admin New-product form) so their output can
// never drift apart. No Anthropic/Supabase imports — the callers own the model
// call; this module owns what to ask and how to read the answer.

export interface DraftVariant {
  variant_name: string; // Arabic/primary option name, e.g. "أحمر" / "آيفون 16"
  variant_name_en: string; // English option name, e.g. "Red" / "iPhone 16"
  color: string;
  size: string;
}

export interface ProductDraft {
  name_en: string;
  name_ar: string;
  description_en: string;
  description_ar: string;
  keywords_en: string;
  keywords_ar: string;
  main_category: string; // "" when the model's pick isn't in the allowed list
  variants?: DraftVariant[]; // options the seller asked for (empty/absent when none)
}

export const EMPTY_DRAFT: ProductDraft = {
  name_en: "", name_ar: "", description_en: "", description_ar: "",
  keywords_en: "", keywords_ar: "", main_category: "", variants: [],
};

// A real catalog entry, shown to the model as the target style.
export const HOUSE_STYLE_EXAMPLE = JSON.stringify({
  name_ar: "طقم رود ليب تينت جوافا سبرتز مع كفر الهاتف - Rhode Guava Spritz Set",
  name_en: "Rhode Guava Spritz Lip Tint & Phone Case Set",
  description_ar:
    "احصلي على إطلالة عصرية مع طقم رود جوافا سبرتز الذي يجمع بين ليب تينت رود الشهير وكفر الهاتف المخصص لحمل المنتج بسهولة وأناقة طوال اليوم.\n" +
    "🔸 ليب تينت رود لون جوافا سبرتز\n🔸 كفر رود بتصميم حامل للمنتج\n🔸 لون منعش مستوحى من الجوافة الوردية\n🔸 يمنح الشفاه مظهراً لامعاً وطبيعياً\n🔸 تصميم أنيق ومثالي للاستخدام اليومي\n🔸 هدية رائعة لعشاق منتجات Rhode\n" +
    "اللون: Guava Spritz\nالمحتويات: ليب تينت + كفر هاتف رود",
  description_en:
    "Enjoy the perfect combination of style and convenience with the Rhode Guava Spritz Set, featuring the iconic Rhode Lip Tint and the signature phone case designed to hold your lip product on the go.\n" +
    "✔️ Rhode Lip Tint in Guava Spritz shade\n✔️ Signature Rhode phone case holder\n✔️ Fresh pink guava-inspired color\n✔️ Gives lips a glossy natural look\n✔️ Stylish and practical everyday accessory\n✔️ Perfect gift for Rhode lovers\n" +
    "Color: Guava Spritz\nIncludes: Rhode Lip Tint + Rhode Phone Case",
  keywords_ar: "رود, ليب تينت, جوافا سبرتز, كفر هاتف, مكياج شفاه, هدية",
  keywords_en: "Rhode, lip tint, guava spritz, phone case, lip makeup, gift set",
  main_category: "Rhode Products Section",
}, null, 0);

/**
 * The vision prompt: analyze the product photo, answer JSON in house style.
 * `instructions` is the seller's free-text note — corrections or context the
 * photo alone can't convey (the real color, that it's a phone case, that it
 * comes in several color options…). When present it OVERRIDES what the photo
 * seems to show, and may ask for options (variants).
 */
export function buildDraftPrompt(categories: readonly string[], instructions?: string): string {
  const note = String(instructions ?? "").trim();
  return (
    "أنت مساعد كتالوج لمتجر Malika's Universe (جمال وكورية، قطر). حلّل صورة المنتج وأرجِع JSON فقط بهذه الحقول بالضبط:\n" +
    '{"name_en":"","name_ar":"","description_en":"","description_ar":"","keywords_en":"","keywords_ar":"","main_category":"","variants":[]}\n\n' +
    "اتبع أسلوب متجرنا بدقة:\n" +
    "• name_ar = الاسم بالعربية ثم مسافة وشرطة ثم الاسم بالإنجليزية (مثل: «... - Rhode Guava Spritz Set»).\n" +
    "• name_en = اسم إنجليزي واضح ومختصر.\n" +
    "• description_ar = جملة تسويقية افتتاحية، ثم من 4 إلى 6 نقاط تبدأ كل واحدة بـ 🔸 وسطر جديد، ثم سطر «اللون: ...»، ثم سطر «المحتويات: ...».\n" +
    "• description_en = جملة افتتاحية، ثم نقاط تبدأ كل واحدة بـ ✔️ وسطر جديد، ثم «Color: ...»، ثم «Includes: ...».\n" +
    "• استخدم أسطر جديدة فعلية (\\n) داخل الوصف.\n" +
    "• keywords = 5 إلى 8 كلمات مفصولة بفواصل.\n" +
    `• main_category = الأنسب من هذه القائمة فقط: ${categories.join(", ")}.\n` +
    '• variants = مصفوفة الخيارات إذا ذكر البائع أن للمنتج خيارات (ألوان/مقاسات)، كل عنصر بهذا الشكل {"variant_name":"","variant_name_en":"","color":"","size":""} حيث variant_name = اسم الخيار بالعربية و variant_name_en = نفس الخيار بالإنجليزية. إذا ما في خيارات اترك المصفوفة فارغة [].\n\n' +
    (note
      ? "⚠️ ملاحظة البائع (اعتمدها فوق ما تظهره الصورة، وصحّح اللون/النوع/الاسم بناءً عليها، وإذا ذكر خيارات ولّد variants):\n«" + note + "»\n\n"
      : "") +
    "مثال كامل بالأسلوب المطلوب بالضبط:\n" + HOUSE_STYLE_EXAMPLE + "\n\n" +
    "أجب بـ JSON صحيح فقط بدون أي نص إضافي."
  );
}

/**
 * Parse the model's reply into a draft. Tolerant: takes the first {...} block,
 * trims every field, and blanks a main_category that isn't in the allowed
 * list. Returns null only when there is no parseable JSON at all — callers
 * then fall back to an empty draft rather than failing the upload.
 */
export function parseProductDraft(text: string, categories: readonly string[]): ProductDraft | null {
  const m = String(text ?? "").match(/\{[\s\S]*\}/);
  if (!m) return null;
  let j: Record<string, unknown>;
  try { j = JSON.parse(m[0]); } catch { return null; }
  const s = (x: unknown) => (x == null ? "" : String(x).trim());
  const cat = s(j.main_category);
  const variants = (Array.isArray(j.variants) ? j.variants : [])
    .map((v) => {
      const o = (v ?? {}) as Record<string, unknown>;
      return {
        variant_name: s(o.variant_name) || s(o.color) || s(o.size),
        variant_name_en: s(o.variant_name_en),
        color: s(o.color),
        size: s(o.size),
      };
    })
    .filter((v) => v.variant_name || v.variant_name_en || v.color || v.size);
  return {
    name_en: s(j.name_en),
    name_ar: s(j.name_ar),
    description_en: s(j.description_en),
    description_ar: s(j.description_ar),
    keywords_en: s(j.keywords_en),
    keywords_ar: s(j.keywords_ar),
    main_category: categories.includes(cat) ? cat : "",
    variants,
  };
}
