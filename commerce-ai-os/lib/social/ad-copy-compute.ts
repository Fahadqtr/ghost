// Ad-copy core — pure, DOM- and network-free.
//
// Builds the prompt that turns a product into ad text (a short headline, 3
// selling-point benefits, 3 tiny trust features) and parses the model reply
// tolerantly. Kept pure so the shaping/trimming rules are unit-tested; the
// Anthropic call lives in the /social action.

export interface AdCopyInput {
  nameAr?: string | null;
  nameEn?: string | null;
  description?: string | null;
}

export interface AdCopy {
  headline: string;      // short product headline (falls back to the name)
  benefits: string[];    // up to 3 medium selling points
  features: string[];    // up to 3 very short trust chips
}

const clip = (s: unknown, max: number): string =>
  String(s ?? "").replace(/\s+/g, " ").trim().slice(0, max);

/** Prompt: Malika tone, Arabic, strict JSON, no medical claims. */
export function buildAdCopyPrompt(input: AdCopyInput): string {
  const name = (input.nameAr || input.nameEn || "").trim();
  const en = input.nameEn && input.nameAr ? ` (${input.nameEn})` : "";
  const desc = clip(input.description, 600);
  return (
    "أنت مصمّمة إعلانات لمتجر Malika's Universe (منتجات جمال، قطر). " +
    "من بيانات المنتج، اكتبي نص إعلان عربي أنثوي راقٍ وأرجعي JSON فقط بهذا الشكل:\n" +
    '{"headline":"...","benefits":["...","...","..."],"features":["...","...","..."]}\n\n' +
    `المنتج: ${name}${en}\n` +
    (desc ? `الوصف: ${desc}\n` : "") +
    "\nالقواعد (أسلوب فخم راقٍ مثل علامات التجميل العالمية):\n" +
    "• headline: جملة تسويقية فخمة قصيرة وموحية (٣–٦ كلمات)، ليست اسم المنتج.\n" +
    "• benefits: ٤ فوائد بيعية أنيقة، كل وحدة ٢–٥ كلمات (مثال: «تحفّز الدورة الدموية»).\n" +
    "• features: ٣ مميزات ثقة قصيرة جدًا، كلمة–كلمتان لكل وحدة (مثال: «جودة عالية»، «خشب طبيعي»).\n" +
    "• عربي فصيح راقٍ، بدون ادعاءات طبية، بدون أسعار، بدون إيموجي.\n" +
    "أجيبي بـ JSON صحيح فقط."
  );
}

/**
 * Read the reply: prefer JSON, tolerate prose around it. Missing pieces come
 * back empty (the template hides empty rows). Arrays are trimmed to 3 and each
 * string is length-capped so the layout never overflows.
 */
export function parseAdCopy(text: string, fallbackName = ""): AdCopy {
  const raw = String(text ?? "");
  let obj: any = null;
  const m = raw.match(/\{[\s\S]*\}/);
  if (m) { try { obj = JSON.parse(m[0]); } catch { /* keep null */ } }

  const arr = (v: unknown, max: number, cap: number): string[] =>
    (Array.isArray(v) ? v : [])
      .map((x) => clip(x, cap))
      .filter(Boolean)
      .slice(0, max);

  const headline = clip(obj?.headline, 60) || clip(fallbackName, 60);
  return {
    headline,
    benefits: arr(obj?.benefits, 5, 42),  // 3–5 elegant lines
    features: arr(obj?.features, 3, 22),
  };
}
