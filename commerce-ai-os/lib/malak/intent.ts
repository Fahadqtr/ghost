// Deterministic intent router for Malak. Runs BEFORE Claude so creative/write
// requests can't "escape" into a text-only reply ("the tool isn't connected").
// Returns the tool name to force via tool_choice, or null for a normal turn.
//
// Intents: generate_product_image | add_product | set_approval | update_stock | set_price
export function detectForcedTool(text: string): string | null {
  const t = (text || "").toLowerCase();
  const changeVerb = /(غيّر|غير|عدّل|عدل|حدّث|حدث|نزّل|نزل|ارفع|خفّض|خفض|اجعل|خلّي|خل|حط|عيّن|عين|إلى|الى|\bto\b)/;

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

  // ---- Catalog write intents ----------------------------------------------
  if (/(منتج جديد|أضف\s*منتج|اضف\s*منتج|أضيفي?\s*منتج|اضافة\s*منتج|إضافة\s*منتج|add\s*product|new\s*product)/.test(t))
    return "add_product";
  if (/(اعتمد|ارفض|اعتماد|وافقي?|approve|reject|approval|sentai)/.test(t)) return "set_approval";
  if (/(مخزون|المخزون|كمية|الكمية|ستوك|stock|inventory)/.test(t) && changeVerb.test(t)) return "update_stock";
  if (/(سعر|السعر|بسعر|price)/.test(t) && changeVerb.test(t)) return "set_price";
  return null;
}
