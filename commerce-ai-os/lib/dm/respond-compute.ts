// DM responder — pure prompt/parse/matching core (DB- and API-free, tested).

export interface DmProduct {
  sku: string | null;
  name_en: string | null;
  name_ar: string | null;
  price: number | null;
  discount_price: number | null;
  stock: number | null;
  category?: string | null;
}

export interface DmTurn { direction: "in" | "out"; body: string }

const STOP = new Set([
  "the", "and", "for", "you", "how", "much", "price", "have", "do", "does", "is", "are", "hi", "hello",
  "السلام", "عليكم", "مرحبا", "هلا", "كم", "سعر", "بكم", "عندكم", "عندك", "فيه", "في", "ابي", "أبي", "ابغى",
  "متوفر", "متوفره", "متوفرة", "شحن", "توصيل", "من", "الى", "إلى", "على", "هذا", "هذي", "وش", "شنو",
]);

/** Tokenize a customer message for catalog matching (letters/digits, len ≥ 3). */
export function dmSearchTokens(text: string): string[] {
  return [...new Set(
    String(text ?? "")
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .map((w) => w.trim())
      .filter((w) => w.length >= 3 && !STOP.has(w)),
  )].slice(0, 12);
}

// Category browse: map what customers type (Arabic or English) to the catalog's
// English category names, so "شنو عندكم منتجات للبشرة" surfaces Face/Body Care
// products instead of stalling. Keyword (substring, lowercase) → categories.
const CATEGORY_SYNONYMS: { keys: string[]; cats: string[] }[] = [
  { keys: ["بشره", "بشرة", "سكin", "skincare", "skin care", "skin"], cats: ["Face Care", "Body Care", "Masks", "Sun Protection"] },
  { keys: ["وجه", "face"], cats: ["Face Care", "Masks"] },
  { keys: ["جسم", "بودي", "body"], cats: ["Body Care"] },
  { keys: ["شعر", "hair"], cats: ["Hair Care"] },
  { keys: ["مكياج", "ميك", "makeup", "cosmetic"], cats: ["Makeup"] },
  { keys: ["رموش", "اظافر", "أظافر", "lash", "lashes", "nail", "nails"], cats: ["Lashes & Nails"] },
  { keys: ["ماسك", "ماسكات", "قناع", "mask", "masks"], cats: ["Masks"] },
  { keys: ["شمس", "واقي", "sun", "sunscreen", "spf"], cats: ["Sun Protection"] },
  { keys: ["اسنان", "أسنان", "سنان", "dental", "teeth", "toothpaste"], cats: ["Dental Care"] },
  { keys: ["رود", "rhode"], cats: ["Rhode Products Section"] },
  { keys: ["تايلند", "تايلاند", "thailand", "thai"], cats: ["Thailand Products"] },
  { keys: ["الكترون", "إلكترون", "electronic", "electronics"], cats: ["Electronics"] },
  { keys: ["العاب", "ألعاب", "toy", "toys"], cats: ["Toys"] },
  { keys: ["تخييم", "كامب", "camp", "camping", "outdoor"], cats: ["Summer And Camping Supplies"] },
];

/** Detect which catalog categories a customer message is asking about (if any). */
export function detectCategories(text: string): string[] {
  const t = String(text ?? "").toLowerCase();
  const out = new Set<string>();
  for (const { keys, cats } of CATEGORY_SYNONYMS) {
    if (keys.some((k) => t.includes(k))) cats.forEach((c) => out.add(c));
  }
  return [...out];
}

/** Products in the given categories, in-stock first; top `max`. */
export function matchDmProductsByCategory(products: DmProduct[], categories: string[], max = 6): DmProduct[] {
  if (!categories.length) return [];
  const set = new Set(categories.map((c) => c.toLowerCase()));
  return products
    .filter((p) => p.category && set.has(String(p.category).toLowerCase()))
    .sort((a, b) => (Number(b.stock) > 0 ? 1 : 0) - (Number(a.stock) > 0 ? 1 : 0))
    .slice(0, max);
}

/** Score catalog rows against the tokens; top `max` matches (score > 0). */
export function matchDmProducts(products: DmProduct[], tokens: string[], max = 5): DmProduct[] {
  if (!tokens.length) return [];
  const scored = products
    .map((p) => {
      const hay = `${p.sku ?? ""} ${p.name_en ?? ""} ${p.name_ar ?? ""}`.toLowerCase();
      let score = 0;
      for (const t of tokens) if (hay.includes(t)) score++;
      return { p, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, max).map((x) => x.p);
}

/** One prompt: history + matched products + store facts → strict JSON out. */
export function buildDmPrompt(opts: {
  history: DmTurn[];
  products: DmProduct[];
  storeInfo: string;
}): string {
  const lines = opts.products.map((p) => {
    const eff = Number(p.discount_price) > 0 ? p.discount_price : p.price;
    const stock = p.stock != null ? (p.stock > 0 ? "متوفر" : "نافد حاليًا") : "";
    return `• ${p.name_en ?? ""}${p.name_ar ? ` | ${p.name_ar}` : ""} — ${eff != null ? `${eff} ر.ق` : "بدون سعر"}${stock ? ` — ${stock}` : ""}`;
  });
  const history = opts.history
    .slice(-10)
    .map((t) => `${t.direction === "in" ? "العميل" : "ملاك"}: ${String(t.body ?? "").slice(0, 400)}`)
    .join("\n");

  return (
    "أنتِ «ملاك» — مساعدة متجر Malika's Universe للرد على رسائل العملاء في الدايركت.\n" +
    "قواعدك:\n" +
    "• ردّي بنفس لغة العميل (عربي أو إنجليزي)، بأسلوب ودّي مختصر (سطر إلى ثلاثة) مع إيموجي خفيف.\n" +
    "• استخدمي فقط معلومات المتجر والمنتجات المرفقة — لا تخترعي أسعارًا أو منتجات أو وعودًا.\n" +
    "• سؤال عن فئة أو «شنو عندكم» (بشرة، شعر، مكياج…) وفيه منتجات مرفقة: اعرضي ٢–٤ منها بأسعارها واسأليه أي نوع يناسبه — لا تماطلي ولا تحوّلي طالما فيه منتجات مرفقة.\n" +
    "• سؤال عن منتج/فئة وما في أي منتجات مرفقة نهائيًا: قولي إنك بتتأكدين من التوفر وبيرد عليه الفريق، وخلي handoff=true.\n" +
    "• شكوى، مشكلة طلب سابق، طلب استرجاع، أو أي شي مو متأكدة منه 100%: ردّي رد لطيف إن الفريق بيتواصل معه، و handoff=true.\n" +
    "• لا تطلبي بيانات حساسة (بطاقات، كلمات مرور).\n\n" +
    `معلومات المتجر:\n${opts.storeInfo}\n\n` +
    (lines.length ? `منتجات مطابقة من الكتالوج:\n${lines.join("\n")}\n\n` : "ما في منتجات مطابقة في الكتالوج لهذه الرسالة.\n\n") +
    (history ? `المحادثة:\n${history}\n\n` : "") +
    'أجيبي بـ JSON فقط بدون أي نص آخر: {"reply":"نص الرد للعميل","handoff":false}'
  );
}

/** Tolerant parse of the model's JSON verdict. */
export function parseDmReply(text: string): { reply: string; handoff: boolean } | null {
  const m = String(text ?? "").match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const j = JSON.parse(m[0]);
    const reply = String(j.reply ?? "").trim();
    if (!reply) return null;
    return { reply: reply.slice(0, 900), handoff: Boolean(j.handoff) };
  } catch {
    return null;
  }
}
