// Deterministic intent router for Malak. Runs BEFORE Claude so creative/write
// requests can't "escape" into a text-only reply ("the tool isn't connected").
// Returns the tool name to force via tool_choice, or null for a normal turn.
//
// Intents: generate_product_image | add_product | set_approval | update_stock | set_price
export function detectForcedTool(text: string): string | null {
  const t = (text || "").toLowerCase();
  const changeVerb = /(غيّر|غير|عدّل|عدل|حدّث|حدث|نزّل|نزل|ارفع|خفّض|خفض|اجعل|خلّي|خل|حط|عيّن|عين|إلى|الى|\bto\b)/;

  // ---- Internet: search the net vs. open a specific page -------------------
  // A bare URL → open it directly (browse_web). A search request that names the
  // net/a search engine → web_search (search APIs avoid the CAPTCHA wall that
  // scraping Google results hits). Both require explicit web words so we don't
  // steal catalog reads like "دوّر على منتجات كورية" (search OUR catalog).
  // Interactive control (click/type/select/login) — needs browser_action, not a
  // read-only open. Look for control verbs alongside a web/page context.
  const controlVerb = /(اضغط|اضغطي|دوس|دوسي|اختر|اختاري|سجّل|سجل|سجّلي|سجلي|عبّي|عبي|املئي?|اكتبي?\s*في|شغّل|شغل|شغّلي|شغلي|نزّل|مرّري?|click|press|select|login|log\s*in|fill|submit|type\s*in)/;
  const pageCtx = /(الصفحة|صفحة|الموقع|موقع|المتصفح|الزر|زرّ|زر |الرابط|رابط|يوتيوب|youtube|google|قوقل|button|\bpage\b|النتيجة|نتيجة\s|الحقل|form|نموذج)/;
  const hasUrl = /https?:\/\/\S+|www\.\S+\.\w/.test(t);
  if (controlVerb.test(t) && (pageCtx.test(t) || hasUrl)) return "browser_action";
  if (hasUrl) return "browse_web";
  const netNoun = /(النت|الإنترنت|الانترنت|قوقل|جوجل|google|الويب|الشبكة|محرّك|محرك\s*البحث|online|web)/;
  const searchVerb = /(ابحث|ابحثي|دوّر|دور|بحث|قارن|قارني|قارني?\s*أسعار|search|google\s+for|look\s*up)/;
  if (searchVerb.test(t) && netNoun.test(t)) return "web_search";
  const webNoun = /(موقع|المتصفح|متصفح|website|browser|رابط|لينك|\blink\b|\burl\b|قوقل|جوجل|google)/;
  const browseVerb = /(افتح|افتحي|تصفّح|تصفح|ادخل|ادخلي|روح|روحي|زور|زوري|open|browse|visit|go\s*to)/;
  if (webNoun.test(t) && browseVerb.test(t)) return "browse_web";

  // ---- Guards (prevent false image-generation matches) ---------------------
  // Reads ABOUT products that lack an image (e.g. "المنتجات بدون صورة").
  const missingImageRead =
    /(بدون|بلا|من\s*دون|ناقص|ناقصة|ناقصين|مفقود|ما\s*فيه|محد|كم\s*منتج).{0,8}صور|صور.{0,8}(ناقص|ناقصة|مفقود|فاضي)/.test(t);
  // Explicit TEXT post / caption / description writing → the post panel (Bayan),
  // not image generation.
  const writeTextPost = /(اكتب|أكتب|اكتبي|كاتب|صيغ|صياغة|وصف|caption).{0,15}(بوست|منشور|وصف|نص|كابشن|caption)/.test(t);

  // ---- IMAGE / ad / poster / creative generation (Ream) --------------------
  // Strong creative nouns almost always imply "make me one".
  const strongCreative =
    /(بوستر|poster|creative|كريتف|تصميم|\bdesign\b|ad\s*image|product\s*image|generate\s*image|إعلاني|اعلاني|إعلان|اعلان)/;
  // A bare "صورة/image" only forces generation when paired with a create verb.
  const createVerb =
    /(سوّي|سوي|سوّ\s|اعمل|اعملي|سو\s?لي|ولّد|ولد|توليد|اصنع|صمّم|صمم|صممي|أنشئ|انشئ|جديد|generate|create|make|design)/;
  if (
    !missingImageRead &&
    !writeTextPost &&
    (strongCreative.test(t) || (/(صورة|صوره|\bimage\b)/.test(t) && createVerb.test(t)))
  ) {
    return "generate_product_image";
  }

  // ---- READ: new / uncategorized products (incl. Snoonu imports) -----------
  // "اعرض المنتجات الجديدة" / "غير المصنّفة" → list_uncategorized. Guarded so it
  // doesn't steal "أضف منتج جديد" (that's a write → add_product, handled below).
  const addVerb = /(أضف|اضف|أضيفي?|اضافة|إضافة|\badd\b)/;
  if (
    !addVerb.test(t) &&
    (/(uncategorized|بدون\s*تصنيف|غير\s*مصنّ?فة|غير\s*المصنّ?فة|بلا\s*تصنيف)/.test(t) ||
      /(المنتجات\s*الجديدة|منتجات\s*جديدة|المنتجات\s*الجدد|new\s*products)/.test(t))
  ) {
    return "list_uncategorized";
  }

  // ---- Cross-platform availability sync (Siraj) ---------------------------
  // "زامني/طابقي/وحّدي التوفّر" · "ادفعي النافد لشوبيفاي" · "طابقي المنصّات مع ماليكاس".
  const syncVerb = /(زامن|زامني|مزامنة|طابق|طابقي|مطابقة|وحّد|وحد|وحّدي|sync|reconcile)/;
  const syncObject = /(التوفّر|التوفر|المنصّات|المنصات|القنوات|النافد|النافدة|المخلّص|شوبيفاي|shopify|channels?|availability)/;
  if ((syncVerb.test(t) && syncObject.test(t)) || /(ادفعي?|ادفع|دفع).{0,12}(النافد|النافدة|شوبيفاي|shopify)/.test(t))
    return "sync_availability";

  // ---- Catalog write intents ----------------------------------------------
  if (/(منتج جديد|أضف\s*منتج|اضف\s*منتج|أضيفي?\s*منتج|اضافة\s*منتج|إضافة\s*منتج|add\s*product|new\s*product)/.test(t))
    return "add_product";
  if (/(اعتمد|ارفض|اعتماد|وافقي?|approve|reject|approval|sentai)/.test(t)) return "set_approval";
  if (/(مخزون|المخزون|كمية|الكمية|ستوك|stock|inventory)/.test(t) && changeVerb.test(t)) return "update_stock";

  // READ: detect/check price problems (no change verb → not a set_price).
  const priceCheck = /(مشكلة|مشاكل|خطأ|أخطاء|غلط|غلطان|شاذ|شاذّ?ة|خلل|راجع|راجعي|شيك|تأكد|افحص|فحص|اكشف|كشف|check|issue|wrong)/;
  if (/(سعر|السعر|أسعار|الأسعار|التسعير|price|pricing)/.test(t) && priceCheck.test(t) && !changeVerb.test(t))
    return "price_issues";

  if (/(سعر|السعر|بسعر|price)/.test(t) && changeVerb.test(t)) return "set_price";
  return null;
}
