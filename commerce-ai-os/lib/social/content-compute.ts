// Social content engine — pure, DB-free core.
//
// Which product to spotlight today, what to ask the model for, and how to read
// its reply. No Supabase/Anthropic imports — generation I/O lives in
// lib/social/generate.ts. Kept pure so the selection/caption rules are
// unit-tested and shared by every platform.

/** Candidate product for the daily spotlight (already fetched + joined). */
export interface SpotlightCandidate {
  id: string;
  name_en?: string | null;
  name_ar?: string | null;
  brand?: string | null;        // resolved brand NAME (not the id)
  image_url?: string | null;
  price?: number | string | null;
  discount_price?: number | string | null;
  stock?: number | null;        // effective stock (inventory total)
  created_at?: string | null;
}

/**
 * The instruction handed to the image-edit engine to turn a plain catalog
 * photo into an Instagram-ready one. The engine itself already pins "same
 * product, no added text/watermark" — this only styles the scene.
 */
export const IG_IMAGE_STYLE =
  "Ultra-realistic LUXURY beauty campaign photo, editorial 8K quality, like Rhode, Aesop, Dior Beauty or Jo Malone. " +
  "The uploaded product is the SOURCE OF TRUTH: do NOT redesign, recreate, replace or invent any part of it, its " +
  "packaging, its label or any lettering on it — preserve every visible detail exactly; the ONLY allowed changes are " +
  "lighting, shadows, background and camera angle. Keep it the hero, sharp focus with premium " +
  "reflections, occupying about 40–50% of the frame. Background: warm beige, ivory, cream and soft sand palette, " +
  "elegant minimalist luxury, soft flowing fabric, natural sunlight entering from one side, soft realistic shadows, " +
  "a marble or travertine natural-stone podium; a few dried flowers or leaves only if they complement the product. " +
  "Clean premium spa atmosphere, refined natural color grading. " +
  "COMPOSITION: place the product toward the RIGHT side and keep the LEFT ~45% as clean EMPTY background " +
  "(smooth beige/cream surface reserved for Arabic marketing text that is added later); generous breathing room, " +
  "elegant balance, extremely clean, no clutter. Photorealistic. " +
  "CRITICAL: do NOT add ANY new text, captions, headlines, labels, prices, buttons, icons, typography, UI or graphics " +
  "anywhere in the image. Keep only the product's own real packaging and label unchanged; invent no lettering.";

/**
 * Pick today's product: must have an image and stock, must not have been
 * featured recently (excludeIds), newest first — fresh arrivals are the most
 * postable. Returns null when nothing qualifies (caller skips the day).
 */
export function pickSpotlightProduct(
  candidates: SpotlightCandidate[],
  excludeIds: Iterable<string>,
): SpotlightCandidate | null {
  const excluded = new Set(excludeIds);
  const ok = candidates.filter((c) =>
    !!String(c.image_url ?? "").trim() &&
    (c.stock ?? 0) > 0 &&
    !excluded.has(String(c.id)),
  );
  ok.sort((a, b) => String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")));
  return ok[0] ?? null;
}

/** Extra publish-ready assets generated alongside the caption. */
export interface PostExtras {
  story: string; // short story-version text
  reel: string;  // 8–12s reel voiceover script
  alt: string;   // image alt text
}

/**
 * The full post prompt: Malika's Instagram content brief — Gulf luxury tone,
 * hook-first caption, 3 safe benefits, CTA, Qatar/K-Beauty hashtags, plus a
 * story version, a reel script and alt text. `imageAnalysis` (optional) is a
 * Gemini read of the product photo so the copy sticks to what's really there.
 */
export function buildPostPrompt(p: SpotlightCandidate, imageAnalysis?: string): string {
  const price = p.discount_price ?? p.price;
  const priceLine = price != null && String(price).trim() !== "" ? `السعر: ${price} ر.ق` : "";
  const analysis = String(imageAnalysis ?? "").trim().slice(0, 900);
  return (
    "أنتِ مسؤولة تسويق محتوى إنستقرام لبراند Malika's Universe Beauty في قطر، متخصصة في منتجات K-Beauty والعناية والجمال. " +
    "أنشئي محتوى فاخرًا واقعيًا جاهزًا للنشر لمنتج اليوم، وأرجعي JSON فقط بهذا الشكل بالضبط:\n" +
    '{"caption":"...","story":"...","reel":"...","alt":"..."}\n\n' +
    "بيانات المنتج:\n" +
    `المنتج: ${p.name_ar || p.name_en || ""}${p.name_en && p.name_ar ? ` (${p.name_en})` : ""}\n` +
    (p.brand ? `البراند: ${p.brand}\n` : "") +
    (priceLine ? priceLine + "\n" : "") +
    (analysis ? `\nتحليل صورة المنتج (اعتمدي عليه ولا تخترعي غيره):\n${analysis}\n` : "") +
    "\nقواعد caption:\n" +
    "• أول سطر Hook قوي يوقف المتابعة (بدون اسم المنتج إن لزم).\n" +
    "• بعده سطر يذكر البراند واسم المنتج بوضوح وبكتابة صحيحة (البراند بالإنجليزية كما هو). لا تحذفي البراند أبدًا.\n" +
    "• ثم 3 فوائد تسويقية قصيرة، ثم السعر إن وُجد.\n" +
    "• اختمي بـ: «اطلبيه الآن من Malika's Universe — الرابط في البايو 🛍️».\n" +
    "• ثم سطر هاشتاقات: 8-12 هاشتاق تناسب قطر والجمال وK-Beauty (#MalikasUniverse #QatarBeauty #KBeautyQatar #DohaBeauty وما يناسب المنتج).\n" +
    "\nقواعد story: نسخة قصيرة جدًا (سطران) بنفس الروح، تنتهي بدعوة بسيطة.\n" +
    "قواعد reel: سكربت تعليق صوتي 8-12 ثانية، جملة أو جملتان بصيغة مخاطبة أنثوية.\n" +
    "قواعد alt: وصف موجز ودقيق لصورة المنتج بالعربي (سطر واحد).\n" +
    "\nالأسلوب العام:\n" +
    "• عربي خليجي فاخر نظيف أنثوي، بسيط مع لمسة إنجليزية خفيفة عند الحاجة، وغير مبالغ.\n" +
    "• 1-3 إيموجي فقط في الكابشن كله.\n" +
    "• ممنوع الادعاءات الطبية (يعالج، يشفي، يزيل نهائيًا، يوقف التساقط) — استخدمي: يساعد، يمنح إحساس، يدعم، يترك البشرة بمظهر.\n" +
    "• لا تخترعي مكونات أو فوائد أو معلومات غير مذكورة، ولا تقولي «أصلي» إلا لو ذُكرت.\n" +
    "أجيبي بـ JSON صحيح فقط."
  );
}

/**
 * Read the model's reply: prefer JSON {caption}, fall back to the raw text.
 * Instagram caps captions at 2200 chars — trim hard so publishing never 400s.
 */
export function parseCaptionReply(text: string): string {
  const raw = String(text ?? "").trim();
  const m = raw.match(/\{[\s\S]*\}/);
  if (m) {
    try {
      const j = JSON.parse(m[0]);
      const c = String(j?.caption ?? "").trim();
      if (c) return c.slice(0, 2200);
    } catch { /* fall through to raw */ }
  }
  return raw.slice(0, 2200);
}

/**
 * Read the full-post reply: caption (falls back like parseCaptionReply) plus
 * the story / reel / alt extras, each length-capped. Missing extras come back
 * as empty strings (the UI hides empty sections).
 */
export function parsePostReply(text: string): { caption: string; extras: PostExtras } {
  const raw = String(text ?? "").trim();
  let j: any = null;
  const m = raw.match(/\{[\s\S]*\}/);
  if (m) { try { j = JSON.parse(m[0]); } catch { /* fall through */ } }
  const s = (v: unknown, max: number) => String(v ?? "").trim().slice(0, max);
  return {
    caption: s(j?.caption, 2200) || raw.slice(0, 2200),
    extras: { story: s(j?.story, 500), reel: s(j?.reel, 700), alt: s(j?.alt, 300) },
  };
}
