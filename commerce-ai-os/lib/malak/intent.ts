// Detects whether the latest user message is a WRITE request, so the brain can
// force the matching tool (the model otherwise tends to refuse with "the tool
// isn't available"). Shared so it can be unit-checked from the version probe.
export function detectForcedTool(text: string): string | null {
  const t = (text || "").toLowerCase();
  const changeVerb = /(غيّر|غير|عدّل|عدل|حدّث|حدث|نزّل|نزل|ارفع|خفّض|خفض|اجعل|خلّي|خل|حط|عيّن|عين|إلى|الى)/;
  // Image GENERATION intent (Ream): a generate verb + "صورة", or "صورة إعلانية".
  if (
    /(ولّد|ولد|توليد|اصنع|صمّم|صمم|أنشئ|انشئ|اعمل|سوّ\s|سو\s|generate|create).{0,12}صور/.test(t) ||
    /صور.{0,12}(إعلان|اعلان|احتراف|استوديو|هيرو|hero|lifestyle)/.test(t)
  ) return "generate_product_image";
  if (/(منتج جديد|أضف\s*منتج|اضف\s*منتج|أضيفي?\s*منتج|اضافة\s*منتج|إضافة\s*منتج|add\s*product)/.test(t)) return "add_product";
  if (/(اعتمد|ارفض|اعتماد|وافقي?|approve|reject|sentai)/.test(t)) return "set_approval";
  if (/(مخزون|المخزون|كمية|الكمية|ستوك|stock|inventory)/.test(t) && changeVerb.test(t)) return "update_stock";
  if (/(سعر|السعر|بسعر|price)/.test(t) && changeVerb.test(t)) return "set_price";
  return null;
}
