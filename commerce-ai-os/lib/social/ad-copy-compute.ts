// Ad-copy core — pure, DOM- and network-free.
//
// Derives the ad text (headline, subtitle, 5 benefit bullets, 3 footer
// features) from a product. Each bullet is a bold title + a thin sub-line to
// match the luxury reference layout. Kept pure so the shaping/trimming rules
// are unit-tested; the Anthropic call lives in the /social action.

export interface AdCopyInput {
  nameAr?: string | null;
  nameEn?: string | null;
  description?: string | null;
}

export interface AdBullet {
  title: string;      // bold line (2–4 words)
  sub?: string;       // thin explanatory line ("" when none)
}

export interface AdCopy {
  headline: string;   // large product headline (Arabic)
  headlineEn: string; // elegant English line under it (bilingual design)
  subtitle: string;   // short intro line under the headline
  benefits: AdBullet[]; // up to 5
  features: AdBullet[]; // up to 3 (footer bar)
}

const clip = (s: unknown, max: number): string =>
  String(s ?? "").replace(/\s+/g, " ").trim().slice(0, max);

/** Prompt: Malika tone, Arabic, strict JSON, title+sub bullets, no claims. */
export function buildAdCopyPrompt(input: AdCopyInput): string {
  const name = (input.nameAr || input.nameEn || "").trim();
  const en = input.nameEn && input.nameAr ? ` (${input.nameEn})` : "";
  const desc = clip(input.description, 600);
  return (
    "أنت مصمّمة إعلانات فخمة لمتجر Malika's Universe (منتجات جمال، قطر). " +
    "من بيانات المنتج، اكتبي نص إعلان راقٍ (عربي + سطر إنجليزي) وأرجعي JSON فقط بهذا الشكل بالضبط:\n" +
    '{"headline":"...","headlineEn":"...","subtitle":"...","benefits":[{"title":"...","sub":"..."}],"features":[{"title":"...","sub":"..."}]}\n\n' +
    `المنتج: ${name}${en}\n` +
    (desc ? `الوصف: ${desc}\n` : "") +
    "\nالقواعد:\n" +
    "• headline: عنوان المنتج الرئيسي بالعربية، بارز وجذّاب (٢–٤ كلمات).\n" +
    "• headlineEn: سطر إنجليزي أنيق يوازي العنوان (2–5 كلمات إنجليزية بأسلوب إعلانات فاخرة، مثل GLOW REPAIR SERUM).\n" +
    "• subtitle: سطر تعريفي قصير تحت العنوان (٤–٧ كلمات).\n" +
    "• benefits: ٥ مزايا، كل وحدة {title: ٢–٤ كلمات بارزة، sub: ٣–٦ كلمات توضيحية}.\n" +
    "• features: ٣ مميزات ثقة، كل وحدة {title: كلمة–كلمتان، sub: ٢–٤ كلمات}.\n" +
    "• عربي فصيح راقٍ، بدون أسعار، بدون إيموجي، بدون ادعاءات طبية.\n" +
    "أجيبي بـ JSON صحيح فقط."
  );
}

function bullets(v: unknown, max: number): AdBullet[] {
  return (Array.isArray(v) ? v : [])
    .map((x): AdBullet =>
      typeof x === "string"
        ? { title: clip(x, 32), sub: "" }
        : { title: clip((x as any)?.title, 32), sub: clip((x as any)?.sub, 52) })
    .filter((b) => b.title)
    .slice(0, max);
}

/**
 * Read the reply: prefer JSON, tolerate prose around it. Missing pieces come
 * back empty (the template hides empty rows); the headline falls back to the
 * product name.
 */
export function parseAdCopy(text: string, fallbackName = "", fallbackNameEn = ""): AdCopy {
  const raw = String(text ?? "");
  let obj: any = null;
  const m = raw.match(/\{[\s\S]*\}/);
  if (m) { try { obj = JSON.parse(m[0]); } catch { /* keep null */ } }

  return {
    headline: clip(obj?.headline, 50) || clip(fallbackName, 50),
    headlineEn: clip(obj?.headlineEn, 44) || clip(fallbackNameEn, 44),
    subtitle: clip(obj?.subtitle, 70),
    benefits: bullets(obj?.benefits, 5),
    features: bullets(obj?.features, 3),
  };
}
