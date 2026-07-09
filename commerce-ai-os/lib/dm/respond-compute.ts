// DM responder — pure prompt/parse/matching core (DB- and API-free, tested).

export interface DmProduct {
  sku: string | null;
  name_en: string | null;
  name_ar: string | null;
  price: number | null;
  discount_price: number | null;
  stock: number | null;
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
    "• سؤال عن منتج غير موجود في القائمة المرفقة: قولي إنك بتتأكدين من التوفر وبيرد عليه الفريق، وخلي handoff=true.\n" +
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
