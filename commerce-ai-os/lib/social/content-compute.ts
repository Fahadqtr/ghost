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
  "Keep the SAME product exactly (unchanged design, colors, labels, branding) as the hero, sharp focus with premium " +
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

/** The caption prompt: Malika's tone, Arabic-first, price + CTA + hashtags. */
export function buildCaptionPrompt(p: SpotlightCandidate): string {
  const price = p.discount_price ?? p.price;
  const priceLine = price != null && String(price).trim() !== "" ? `السعر: ${price} ر.ق` : "";
  return (
    "أنت مسؤولة سوشيال ميديا لمتجر Malika's Universe (منتجات جمال وكورية، قطر). " +
    "اكتبي كابشن إنستقرام/تيك توك لمنتج اليوم وأرجعي JSON فقط: {\"caption\":\"...\"}\n\n" +
    `المنتج: ${p.name_ar || p.name_en || ""}${p.name_en && p.name_ar ? ` (${p.name_en})` : ""}\n` +
    (p.brand ? `البراند: ${p.brand}\n` : "") +
    (priceLine ? priceLine + "\n" : "") +
    "\nقواعد الكابشن:\n" +
    "• عربي أنثوي خفيف بأسلوب متاجر الجمال الخليجية، 3-5 أسطر قصيرة مع إيموجي مناسبة.\n" +
    "• السطر الافتتاحي يذكر اسم البراند واسم المنتج بوضوح وبكتابة صحيحة (البراند بالإنجليزية كما هو + تعريبه المتعارف، مثل: «رود Rhode»). لا تحذفي البراند أبدًا.\n" +
    "• بعدها ميزة أو اثنتان، ثم السعر إن وُجد.\n" +
    "• اختمي بـ: «اطلبيه الآن — الرابط في البايو 🛍️».\n" +
    "• ثم سطر هاشتاقات: 8-12 هاشتاق يمزج العربي والإنجليزي (#قطر #الدوحة #مكياج #skincare #qatar وما يناسب المنتج).\n" +
    "• بدون أسعار مبالغ فيها أو ادعاءات طبية.\n" +
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
