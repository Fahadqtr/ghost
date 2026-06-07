import Anthropic from "@anthropic-ai/sdk";
import { createAdminClient } from "@/lib/supabase/admin";
import { signAction } from "@/lib/malak/confirm";
import { detectForcedTool } from "@/lib/malak/intent";
import { CATEGORIES } from "@/lib/constants";

// Malak AI — Phase 1 server brain. Holds all secrets (ANTHROPIC_API_KEY +
// Supabase service role). The browser only ever sees the final structured JSON.
// Read-only tool loop: Claude asks for catalog data, we run it against Supabase,
// Claude returns a final { agent, speak, panel } via the `respond` tool.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MODEL = "claude-sonnet-4-6"; // current Sonnet (plan asked for Sonnet)
// 1500 (the plan's value) was too low: a products panel of 8 items easily
// exceeds it, so the final `respond` tool call gets truncated → stop_reason
// "max_tokens" → empty answer ("تم."). 4096 gives ample headroom.
const MAX_TOKENS = 4096;
const MAX_TOOL_ROUNDS = 4;

// The 8 named specialists + Malak herself. The `agent` field returned must be
// one of these ids so the UI can light up the right rail member.
const AGENT_IDS = [
  "malak",
  "noor",
  "bayan",
  "reem",
  "siraj",
  "razan",
  "rashid",
  "latifa",
  "salem",
] as const;

const SYSTEM_PROMPT =
  'أنتِ ملاك، المديرة العامة الذكية لمتجر Malika\'s Universe Trading (جمال وكورية، قطر). ' +
  'تديرين فريقًا: نور=الكتالوج، بيان=المحتوى، ريم=الصور، سراج=التواصل والنشر، رزان=التسعير، ' +
  'راشد=التقارير، لطيفة=العملاء، سالم=العمليات. ' +
  'تكلّمي بلهجة خليجية قطرية طبيعية وواقعية، واثقة ومختصرة، كأنكِ شريكة أعمال تتكلمين مع فهد وجهًا لوجه. ' +
  'استخدمي تعابير خليجية دارجة مثل: تمام، أبشر، حيّاك، وش رايك، خلّها عليّ، الحين، زين، يا طويل العمر — ' +
  'وتجنّبي تمامًا الفصحى الرسمية والكلمات المتكلّفة. ' +
  'استخدمي الأدوات لجلب البيانات الحقيقية — لا تخترعي أرقامًا. ' +
  'صياغة حقل speak للنطق: جملة أو جملتين قصيرتين بلهجة خليجية واضحة وكاملة، بدون نقاط متتالية (...) ' +
  'ولا حروف مكرّرة للتطويل (مثل: زييين) ولا رموز ولا إيموجي ولا تشكيل، عشان النطق يطلع سلس بدون تأتأة. ' +
  'اكتبي الأرقام بشكل بسيط وواضح. ' +
  'أمثلة على نبرتكِ المطلوبة — قلّدي هذا الأسلوب: ' +
  '"هلا فهد، أبشر، جهّزت لك أهم منتجات Medicube." / ' +
  '"تمام، خلّها عليّ، أراجع الكتالوج الحين وأرجع لك." / ' +
  '"وش رايك نركّز على المعتمدة أول؟ زين كذا." / ' +
  '"يا طويل العمر، عندنا كم منتج ناقص صورة، أصلّحها لك." ' +
  '— شخصية ملاك ومبادرتها (مهم جدًا): أنتِ شريكة أعمال صريحة وذكية لفهد، لستِ مجرّد منفّذة تقول "تم". أعطي رأيكِ الحقيقي. ' +
  'بعد أي طلب، إن لاحظتِ في البيانات ما يستحق الانتباه، نبّهي فهد بإيجاز ومبادرة: ' +
  'في عرض المنتجات نوّهي عن أي سعر يبدو شاذًّا أو منتج بدون صورة أو حالة مرفوضة؛ ' +
  'في التقارير أبرزي أهم رقم واحد يحتاج تصرّفًا بدل تعداد كل الأرقام؛ ' +
  'كوني صريحة بأدب: لو طلب فهد شيئًا قد يضرّ بالأعمال (مثل سعر أقل بكثير من المعقول) قولي رأيكِ بوضوح مع بديل، ' +
  'لا تنفّذي بصمت — مثال: "هالسعر أقل من المنافس بكثير، متأكد؟ أنصح بـ كذا". ' +
  'لا تجاملي بإفراط ولا تكرري المدح؛ ركّزي على القيمة والتصرّف. ' +
  'ابقي مختصرة جدًا في speak (جملة أو جملتين)، والتفاصيل في panel. ' +
  'لا تخترعي أرقامًا أبدًا — استخدمي الأدوات للبيانات الحقيقية. ' +
  'ردّك النهائي JSON فقط: {"agent":"<id>","speak":"<رد قصير للنطق يذكر اسم الوكيل>","panel":<اختياري>}. ' +
  'أنواع panel: products{items:[{name,brand,price,status,sku}]}, ' +
  'stats{items:[{label,value,sub}]}, ' +
  'post{item:{caption_ar,caption_en,hashtags,platforms,schedule,product}}, ' +
  'tiktok{item:{hook,scenes:[{shot,text}],audio,hashtags,cta}}. ' +
  'النشر الفعلي يحتاج Meta/TikTok API — وضّحي ذلك في speak. ' +
  'مهم: في لوحة products أدرجي sku دائمًا لكل منتج، ولا تُدرجي image_url إطلاقًا — ' +
  'الخادم يضيف صورة كل منتج تلقائيًا حسب الـsku (هذا يوفّر المساحة ويضمن ظهور الصور الحقيقية). ' +
  'قدّمي ردّكِ النهائي دائمًا عبر استدعاء أداة respond (وليس كنص عادي). ' +
  'قواعد الكتابة (إلزامية وحرجة): أي طلب لتعديل سعر أو مخزون أو حالة اعتماد أو إضافة منتج أو توليد صورة إعلانية ' +
  'يجب أن تستدعي فيه الأداة المطابقة فورًا: set_price أو update_stock أو set_approval أو add_product أو set_image أو generate_product_image. '
  + 'إذا أرفق المستخدم صورة (يخبرك النظام بذلك)، فهو يريد ربطها بمنتج: استدعي set_image مع الـSKU المذكور. ' +
  'ممنوع منعًا باتًا أن تدّعي في speak أنكِ عدّلتِ أو حدّثتِ أو أضفتِ أو أن العملية "تمّت/تم/خلصت" ' +
  'بدون استدعاء أداة الكتابة المناسبة. وممنوع استخدام respond للردّ على طلب تعديل قبل استدعاء أداة الكتابة. ' +
  'هذه الأدوات لا تنفّذ التعديل أبدًا — هي فقط تجهّز كرت تأكيد يظهر للمستخدم، والتنفيذ الفعلي يحدث ' +
  'بعد ضغط المستخدم [أكّد]. فلا تقولي "تم" إطلاقًا؛ بعد استدعاء الأداة سيتولّى النظام عرض كرت التأكيد. ' +
  'وضوح مهم: أدوات تعديل السعر والمخزون والاعتماد وإضافة المنتج **متاحة وتعمل بالكامل** عبر أدوات الكتابة هذه، وهي تكتب مباشرة في قاعدة بيانات المتجر بعد التأكيد. ' +
  'ممنوع منعًا باتًا أن تقولي إن أداة التعديل "غير متاحة" أو "تحتاج صلاحية مباشرة" أو "تحتاج صلاحيات قاعدة بيانات" أو "تحتاج ربط API" أو أن التعديل ' +
  'يتم "يدويًا من لوحة التحكم". كل هذا غير صحيح لتعديل السعر/المخزون/الاعتماد/المنتجات — استدعي الأداة فورًا. ' +
  '(التحذير عن APIs خارجية يخص فقط النشر للمنصّات Meta/TikTok، وليس الكتابة في الكتالوج.) ' +
  'توليد الصور: ريم تملك أداة generate_product_image وهي **متاحة وتعمل** (مربوطة فعلًا بمولّد صور). ' +
  'عند أي طلب لتوليد/تصميم صورة إعلانية لمنتج، استدعي generate_product_image فورًا مع الـSKU. ' +
  'ممنوع منعًا باتًا أن تقولي إن التوليد "يحتاج DALL-E" أو "غير مربوط" أو أن تقترحي بوستًا نصيًا بديلًا بدل استدعاء الأداة. ' +
  'id الوكلاء: ' + AGENT_IDS.join("، ") + ".";

// ---- Tool schemas exposed to Claude (read-only in Phase 1) -----------------
const TOOLS: Anthropic.Tool[] = [
  {
    name: "search_products",
    description:
      "ابحثي في كتالوج المنتجات. مرّري query (كلمة بحث في الاسم/الـSKU/العلامة) و/أو brand و/أو category و/أو status (Approved/Rejected/SentAI). ترجع صفوفًا فيها name و brand و price و status و sku (الصور يضيفها الخادم حسب sku).",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "كلمة بحث (اسم المنتج أو SKU أو العلامة التجارية)" },
        brand: { type: "string", description: "اسم العلامة التجارية، مثل Medicube أو Anua" },
        category: { type: "string", description: "اسم التصنيف الرئيسي" },
        status: { type: "string", enum: ["Approved", "Rejected", "SentAI"], description: "حالة الاعتماد" },
        limit: { type: "integer", description: "عدد النتائج (افتراضي 8)" },
      },
    },
  },
  {
    name: "catalog_stats",
    description: "إحصائيات الكتالوج الكاملة: الإجمالي، أعداد الاعتماد، المنتجات بدون صورة، المروّجة، أعلى التصنيفات، عدد العلامات التجارية.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "list_rejected",
    description: "قائمة المنتجات المرفوضة (approval = Rejected): الاسم والـSKU.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "list_missing_images",
    description: "قائمة المنتجات التي بدون صورة (image_url فارغ): الاسم والـSKU والفئة. الوكيل: ريم (الصور).",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "low_stock",
    description: "المنتجات التي مخزونها أقل من threshold (افتراضي 10).",
    input_schema: {
      type: "object",
      properties: { threshold: { type: "integer", description: "حد المخزون المنخفض (افتراضي 10)" } },
    },
  },
  // ---- WRITE tools (Phase 2B). None of these writes immediately: each returns
  // a CONFIRM panel + signed token; the actual write happens in /api/malak/commit
  // only after the user taps [أكّد]. ------------------------------------------
  {
    name: "update_stock",
    description:
      "حدّثي كمية مخزون منتج عبر الـSKU. لا تكتب فورًا — يظهر للمستخدم كرت تأكيد. الوكيل: سالم (العمليات).",
    input_schema: {
      type: "object",
      properties: {
        sku: { type: "string", description: "SKU المنتج" },
        value: { type: "integer", description: "الكمية الجديدة للمخزون" },
      },
      required: ["sku", "value"],
    },
  },
  {
    name: "set_price",
    description:
      "عدّلي سعر منتج عبر الـSKU. لا تكتب فورًا — كرت تأكيد. الوكيل: رزان (التسعير).",
    input_schema: {
      type: "object",
      properties: {
        sku: { type: "string", description: "SKU المنتج" },
        price: { type: "number", description: "السعر الجديد بالريال القطري" },
      },
      required: ["sku", "price"],
    },
  },
  {
    name: "set_approval",
    description:
      "غيّري حالة اعتماد منتج عبر الـSKU. القيم: Approved أو Rejected أو SentAI. لا تكتب فورًا — كرت تأكيد. الوكيل: نور (الكتالوج).",
    input_schema: {
      type: "object",
      properties: {
        sku: { type: "string", description: "SKU المنتج" },
        status: { type: "string", enum: ["Approved", "Rejected", "SentAI"], description: "حالة الاعتماد الجديدة" },
      },
      required: ["sku", "status"],
    },
  },
  {
    name: "add_product",
    description:
      "أضيفي منتجًا جديدًا بحالة Draft. بيان تكتب الوصف عربي/إنجليزي، ونور تولّد الـSKU بصيغة MU-[CAT]-[SUB]-[####]. الصورة تُرفع لاحقًا من صفحة التعديل. لا تكتب فورًا — كرت تأكيد. الوكيل: نور+بيان.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "اسم المنتج بالإنجليزية (name_en)" },
        name_ar: { type: "string", description: "اسم المنتج بالعربية" },
        description_en: { type: "string", description: "وصف إنجليزي مختصر (بيان)" },
        description_ar: { type: "string", description: "وصف عربي مختصر (بيان)" },
        price: { type: "number", description: "السعر بالريال القطري" },
        category: { type: "string", description: "الفئة الرئيسية — يجب أن تكون من قائمة الفئات المقفلة" },
        sub_category: { type: "string", description: "تصنيف فرعي اختياري (يُستخدم في توليد الـSKU)" },
        brand: { type: "string", description: "اسم العلامة التجارية (اختياري)" },
      },
      required: ["name", "price", "category"],
    },
  },
  {
    name: "set_image",
    description:
      "اربطي صورة منتج (تكون قد رُفعت من المستخدم) عبر الـSKU. تُستخدم فقط عندما يرفق المستخدم صورة. لا تكتب فورًا — كرت تأكيد بمعاينة الصورة. الوكيل: ريم (الصور).",
    input_schema: {
      type: "object",
      properties: {
        sku: { type: "string", description: "SKU المنتج الذي تُربط به الصورة" },
      },
      required: ["sku"],
    },
  },
  {
    name: "generate_product_image",
    description:
      "ولّدي صورة إعلانية احترافية لمنتج موجود عبر الـSKU. لا تولّدي فورًا — يظهر كرت يطلب تأكيد التوليد. الوكيل: ريم (الصور).",
    input_schema: {
      type: "object",
      properties: {
        sku: { type: "string", description: "SKU المنتج المراد توليد صورة له" },
        style: { type: "string", enum: ["hero", "lifestyle"], description: "نمط الصورة: hero (منتج على خلفية نظيفة) أو lifestyle (أجواء استخدام)" },
      },
      required: ["sku"],
    },
  },
  {
    name: "respond",
    description:
      "قدّمي ردّكِ النهائي للمستخدم. استدعي هذه الأداة دائمًا في النهاية مرة واحدة فقط بعد جمع البيانات.",
    input_schema: {
      type: "object",
      properties: {
        agent: { type: "string", enum: AGENT_IDS as unknown as string[], description: "معرّف الوكيل النشط" },
        speak: { type: "string", description: "رد قصير عربي للنطق يذكر اسم الوكيل" },
        panel: {
          type: "object",
          description: "لوحة بصرية اختيارية",
          properties: {
            type: { type: "string", enum: ["products", "stats", "post", "tiktok"] },
            items: { type: "array", items: { type: "object" } },
            item: { type: "object" },
          },
        },
      },
      required: ["agent", "speak"],
    },
  },
];

// ---- Tool implementations (Supabase, service role, READ ONLY) --------------
type Sb = ReturnType<typeof createAdminClient>;

async function brandMap(sb: Sb): Promise<Map<string, string>> {
  const m = new Map<string, string>();
  const { data } = await sb.from("brands").select("id, name");
  for (const b of data ?? []) m.set(b.id, b.name);
  return m;
}

async function searchProducts(sb: Sb, input: any) {
  const limit = Math.min(Math.max(Number(input?.limit) || 8, 1), 24);
  let q = sb
    .from("products")
    .select("id, name_en, brand_id, main_category, price, approval, sku, image_url");

  const query = (input?.query ?? "").toString().trim();
  if (query) {
    const safe = query.replace(/[%,()]/g, " ");
    q = q.or(`name_en.ilike.%${safe}%,sku.ilike.%${safe}%`);
  }
  // brand_id is sparse, so brand is matched against the product name too.
  const brand = (input?.brand ?? "").toString().trim();
  if (brand) {
    const safe = brand.replace(/[%,()]/g, " ");
    q = q.ilike("name_en", `%${safe}%`);
  }
  const category = (input?.category ?? "").toString().trim();
  if (category) {
    const safe = category.replace(/[%,()]/g, " ");
    q = q.ilike("main_category", `%${safe}%`);
  }
  const status = (input?.status ?? "").toString().trim();
  if (status) q = q.eq("approval", status);

  q = q.limit(limit);
  const { data, error } = await q;
  if (error) return { error: error.message, items: [] };

  const brands = await brandMap(sb);
  const items = (data ?? []).map((r: any) => ({
    name: r.name_en,
    brand: r.brand_id ? brands.get(r.brand_id) ?? null : null,
    price: r.price,
    status: r.approval,
    sku: r.sku,
    category: r.main_category,
    image_url: r.image_url,
  }));
  return { count: items.length, items };
}

async function catalogStats(sb: Sb) {
  const head = async (apply?: (b: any) => any) => {
    let b = sb.from("products").select("*", { count: "exact", head: true });
    if (apply) b = apply(b);
    const { count } = await b;
    return count ?? 0;
  };
  const [total, approved, rejected, sentAi, noImage, promoted, featured, brandsCount] =
    await Promise.all([
      head(),
      head((b) => b.eq("approval", "Approved")),
      head((b) => b.eq("approval", "Rejected")),
      head((b) => b.eq("approval", "SentAI")),
      head((b) => b.is("image_url", null)),
      head((b) => b.eq("is_promoted", true)),
      head((b) => b.eq("is_featured", true)),
      sb.from("brands").select("*", { count: "exact", head: true }).then((r) => r.count ?? 0),
    ]);

  // Top categories — page through products (1000-row cap).
  const catMap = new Map<string, number>();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb
      .from("products")
      .select("main_category")
      .range(from, from + 999);
    if (error) break;
    for (const r of data ?? []) {
      const k = r.main_category || "Uncategorized";
      catMap.set(k, (catMap.get(k) || 0) + 1);
    }
    if ((data ?? []).length < 1000) break;
  }
  const topCategories = [...catMap.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  return {
    total,
    approved,
    rejected,
    sentAi,
    missingImage: noImage,
    promoted,
    featured,
    brands: brandsCount,
    topCategories,
  };
}

async function listRejected(sb: Sb) {
  const { data, error } = await sb
    .from("products")
    .select("name_en, sku")
    .eq("approval", "Rejected")
    .order("sku", { ascending: true });
  if (error) return { error: error.message, items: [] };
  return { count: (data ?? []).length, items: (data ?? []).map((r: any) => ({ name: r.name_en, sku: r.sku })) };
}

async function listMissingImages(sb: Sb) {
  const { data, error } = await sb
    .from("products")
    .select("name_en, sku, main_category")
    .is("image_url", null)
    .order("sku", { ascending: true })
    .limit(50);
  if (error) return { error: error.message, items: [] };
  return {
    count: (data ?? []).length,
    items: (data ?? []).map((r: any) => ({ name: r.name_en, sku: r.sku, category: r.main_category })),
  };
}

async function lowStock(sb: Sb, input: any) {
  const threshold = Number(input?.threshold) || 10;
  const { data, error } = await sb
    .from("inventory")
    .select("product_id, stock_quantity")
    .lt("stock_quantity", threshold)
    .limit(50);
  if (error) return { error: error.message, threshold, items: [] };
  const rows = data ?? [];
  if (rows.length === 0) return { threshold, count: 0, items: [], note: "لا توجد منتجات تحت الحد حاليًا (المخزون قاعدي = 50)." };
  const ids = rows.map((r: any) => r.product_id);
  const { data: prods } = await sb.from("products").select("id, name_en, sku").in("id", ids);
  const byId = new Map((prods ?? []).map((p: any) => [p.id, p]));
  const items = rows.map((r: any) => ({
    name: byId.get(r.product_id)?.name_en ?? null,
    sku: byId.get(r.product_id)?.sku ?? null,
    stock: r.stock_quantity,
  }));
  return { threshold, count: items.length, items };
}

async function runTool(sb: Sb, name: string, input: any, skuImages: Map<string, string>) {
  let result: any;
  switch (name) {
    case "search_products":
      result = await searchProducts(sb, input);
      break;
    case "catalog_stats":
      result = await catalogStats(sb);
      break;
    case "list_rejected":
      result = await listRejected(sb);
      break;
    case "list_missing_images":
      result = await listMissingImages(sb);
      break;
    case "low_stock":
      result = await lowStock(sb, input);
      break;
    default:
      result = { error: `Unknown tool: ${name}` };
  }
  // Remember real image_url per SKU so we can re-inject them into the products
  // panel even if Claude drops/alters a URL.
  if (result?.items) {
    for (const it of result.items) {
      if (it?.sku && it?.image_url) skuImages.set(String(it.sku), it.image_url);
    }
  }
  return result;
}

// Belt-and-suspenders: guarantee product cards carry the REAL image_url/price.
function enrichPanel(panel: any, skuImages: Map<string, string>) {
  if (panel?.type === "products" && Array.isArray(panel.items)) {
    for (const it of panel.items) {
      if (it?.sku && skuImages.has(String(it.sku))) it.image_url = skuImages.get(String(it.sku));
    }
  }
  return panel;
}

// ---- WRITE tools: prepare-only (Phase 2B) ----------------------------------
// These NEVER mutate data. Each validates inputs, reads the current value, and
// returns a signed CONFIRM panel. The write happens in /api/malak/commit only
// after the user confirms.
const WRITE_TOOLS = ["update_stock", "set_price", "set_approval", "add_product", "set_image", "generate_product_image"];
const APPROVAL_VALUES = ["Approved", "Rejected", "SentAI"];

// Which agent "owns" each write tool (for direct error responses).
function agentForTool(name: string): string {
  switch (name) {
    case "update_stock": return "salem";
    case "set_price": return "razan";
    case "set_approval": return "noor";
    case "add_product": return "noor";
    case "set_image": return "reem";
    case "generate_product_image": return "reem";
    default: return "malak";
  }
}

type PrepResult =
  | { ok: true; agent: string; speak: string; panel: any }
  | { ok: false; error: string };

async function firstRow(builder: any): Promise<any | null> {
  const { data } = await builder.limit(1);
  return Array.isArray(data) && data.length ? data[0] : null;
}

function confirmPanel(
  title: string,
  agent: string,
  operation: string,
  name: string | null,
  sku: string | null,
  changes: { label: string; old?: any; new: any }[],
  token: string,
  warning?: string
) {
  return { type: "confirm", item: { title, agent, operation, name, sku, changes, token, warning: warning || null } };
}

// Short alpha-numeric code from a category/sub-category name for the SKU.
function code(s: string | null | undefined, fallback = "GEN"): string {
  const c = (s ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  return c.slice(0, 3) || fallback;
}

async function generateSku(sb: Sb, category: string | null, sub: string | null): Promise<string> {
  const cat = code(category);
  const sc = code(sub, "GEN");
  for (let i = 0; i < 6; i++) {
    const n = String(Math.floor(1000 + Math.random() * 9000));
    const sku = `MU-${cat}-${sc}-${n}`;
    const hit = await firstRow(sb.from("products").select("id").eq("sku", sku));
    if (!hit) return sku;
  }
  return `MU-${cat}-${sc}-${Date.now().toString().slice(-4)}`;
}

async function prepareWrite(sb: Sb, name: string, input: any, ctx: { imageUrl?: string | null } = {}): Promise<PrepResult> {
  if (name === "generate_product_image") {
    const sku = String(input?.sku ?? "").trim();
    if (!sku) return { ok: false, error: "SKU مطلوب لتوليد الصورة." };
    const p = await firstRow(sb.from("products").select("id, name_en, sku, image_url").ilike("sku", sku));
    if (!p) return { ok: false, error: `ما لقيت منتج بالـSKU: ${sku}` };
    const style = input?.style === "lifestyle" ? "lifestyle" : "hero";
    // Token A: authorizes the actual generation (consumed by /generate-image).
    const token = signAction({
      v: 1, type: "generate_image", agent: "reem", sku: p.sku, productId: p.id,
      oldValue: p.image_url ?? null, style, ts: Date.now(),
    });
    return {
      ok: true, agent: "reem",
      speak: `ريم: جاهزة أولّد صورة إعلانية لـ ${p.name_en} بنمط ${style === "hero" ? "هيرو" : "لايف ستايل"}. اضغط ولّد الصورة.`,
      panel: {
        type: "image_request",
        item: {
          title: "توليد صورة إعلانية",
          agent: "reem",
          name: p.name_en,
          sku: p.sku,
          currentImage: p.image_url ?? null,
          style,
          token,
        },
      },
    };
  }

  if (name === "set_image") {
    const sku = String(input?.sku ?? "").trim();
    const imageUrl = ctx.imageUrl ?? null;
    if (!imageUrl) return { ok: false, error: "ما فيه صورة مرفقة. أرفقي صورة أول." };
    if (!sku) return { ok: false, error: "SKU مطلوب لربط الصورة." };
    const p = await firstRow(sb.from("products").select("id, name_en, sku, image_url").ilike("sku", sku));
    if (!p) return { ok: false, error: `ما لقيت منتج بالـSKU: ${sku}` };
    const token = signAction({
      v: 1, type: "set_image", agent: "reem", sku: p.sku, productId: p.id,
      field: "image_url", oldValue: p.image_url ?? null, newValue: imageUrl, ts: Date.now(),
    });
    const panel = {
      type: "confirm",
      item: {
        title: "ربط صورة المنتج",
        agent: "reem",
        operation: p.image_url ? "استبدال صورة المنتج" : "إضافة صورة للمنتج",
        name: p.name_en,
        sku: p.sku,
        imageUrl,
        changes: [{ label: "الصورة", old: p.image_url ? "صورة حالية" : "بدون صورة", new: "الصورة الجديدة" }],
        token,
      },
    };
    return {
      ok: true, agent: "reem",
      speak: `ريم: جهّزت صورة ${p.name_en}. راجع المعاينة وأكّد لو تبي أربطها بالمنتج.`,
      panel,
    };
  }

  if (name === "update_stock") {
    const sku = String(input?.sku ?? "").trim();
    const value = Number(input?.value);
    if (!sku) return { ok: false, error: "SKU مطلوب." };
    if (!Number.isFinite(value) || value < 0) return { ok: false, error: "قيمة المخزون غير صالحة." };
    const p = await firstRow(sb.from("products").select("id, name_en, sku, stock_quantity").ilike("sku", sku));
    if (!p) return { ok: false, error: `ما لقيت منتج بالـSKU: ${sku}` };
    const inv = await firstRow(sb.from("inventory").select("stock_quantity").eq("product_id", p.id));
    const oldVal = inv?.stock_quantity ?? p.stock_quantity ?? 0;
    const token = signAction({
      v: 1, type: "update_stock", agent: "salem", sku: p.sku, productId: p.id,
      field: "stock_quantity", oldValue: oldVal, newValue: value, ts: Date.now(),
    });
    // Frank sanity check on the number.
    let warning = "";
    if (value === 0) warning = "هذا يصفّر المخزون تمامًا.";
    else if (value > 9999) warning = "كمية كبيرة جدًا، متأكد من الرقم؟";
    return {
      ok: true, agent: "salem",
      speak: warning
        ? `سالم: ${warning} حطّيته ${value} لـ ${p.name_en}. راجع وأكّد لو متأكد.`
        : `سالم: جهّزت تحديث مخزون ${p.name_en} من ${oldVal} إلى ${value}. أكّد لو تبي أنفّذ.`,
      panel: confirmPanel("تحديث المخزون", "salem", "تعديل كمية المخزون", p.name_en, p.sku, [{ label: "المخزون", old: oldVal, new: value }], token, warning),
    };
  }

  if (name === "set_price") {
    const sku = String(input?.sku ?? "").trim();
    const price = Number(input?.price);
    if (!sku) return { ok: false, error: "SKU مطلوب." };
    if (!Number.isFinite(price) || price < 0) return { ok: false, error: "السعر غير صالح." };
    const p = await firstRow(sb.from("products").select("id, name_en, sku, price").ilike("sku", sku));
    if (!p) return { ok: false, error: `ما لقيت منتج بالـSKU: ${sku}` };
    const token = signAction({
      v: 1, type: "set_price", agent: "razan", sku: p.sku, productId: p.id,
      field: "price", oldValue: p.price, newValue: price, ts: Date.now(),
    });
    // Frank sanity check: flag a drastic move vs the current price, or a very
    // low price — Razan should question it, not execute silently.
    let warning = "";
    const old = Number(p.price);
    if (Number.isFinite(old) && old > 0) {
      if (price <= old * 0.3) warning = `هالسعر أقل بكثير من الحالي (${old} ر.ق). متأكد؟`;
      else if (price >= old * 3) warning = `هالسعر أعلى بكثير من الحالي (${old} ر.ق). متأكد؟`;
    }
    if (!warning && price > 0 && price < 5) warning = "السعر منخفض جدًا، متأكد؟";
    return {
      ok: true, agent: "razan",
      speak: warning
        ? `رزان: ${warning} راجع الكرت وأكّد لو متأكد.`
        : `رزان: جهّزت تعديل سعر ${p.name_en} من ${p.price ?? "—"} إلى ${price} ريال. أكّد للتنفيذ.`,
      panel: confirmPanel("تعديل السعر", "razan", "تغيير سعر المنتج", p.name_en, p.sku, [{ label: "السعر (ر.ق)", old: p.price ?? "—", new: price }], token, warning),
    };
  }

  if (name === "set_approval") {
    const sku = String(input?.sku ?? "").trim();
    const status = String(input?.status ?? "").trim();
    if (!sku) return { ok: false, error: "SKU مطلوب." };
    if (!APPROVAL_VALUES.includes(status)) return { ok: false, error: `حالة اعتماد غير صالحة: ${status}` };
    const p = await firstRow(sb.from("products").select("id, name_en, sku, approval").ilike("sku", sku));
    if (!p) return { ok: false, error: `ما لقيت منتج بالـSKU: ${sku}` };
    const token = signAction({
      v: 1, type: "set_approval", agent: "noor", sku: p.sku, productId: p.id,
      field: "approval", oldValue: p.approval, newValue: status, ts: Date.now(),
    });
    return {
      ok: true, agent: "noor",
      speak: `نور: جهّزت تغيير اعتماد ${p.name_en} من ${p.approval ?? "—"} إلى ${status}. أكّد للتنفيذ.`,
      panel: confirmPanel("تغيير الاعتماد", "noor", "تغيير حالة الاعتماد", p.name_en, p.sku, [{ label: "الاعتماد", old: p.approval ?? "—", new: status }], token),
    };
  }

  if (name === "add_product") {
    const name_en = String(input?.name ?? "").trim();
    const price = Number(input?.price);
    const rawCat = String(input?.category ?? "").trim();
    if (!name_en) return { ok: false, error: "اسم المنتج مطلوب." };
    if (!Number.isFinite(price) || price < 0) return { ok: false, error: "السعر غير صالح." };
    // Map to a canonical locked category (case-insensitive).
    const category = CATEGORIES.find((c) => c.toLowerCase() === rawCat.toLowerCase()) ?? null;
    if (!category) {
      return { ok: false, error: `الفئة "${rawCat}" غير معتمدة. اختاري من: ${CATEGORIES.join("، ")}` };
    }
    const sub = String(input?.sub_category ?? "").trim() || null;

    // Resolve brand (optional) by name.
    let brand_id: string | null = null;
    let brand_name: string | null = null;
    const brand = String(input?.brand ?? "").trim();
    if (brand) {
      const b = await firstRow(sb.from("brands").select("id, name").ilike("name", `%${brand}%`));
      if (b) { brand_id = b.id; brand_name = b.name; }
      else brand_name = brand; // keep for display even if not matched
    }

    const sku = await generateSku(sb, category, sub);
    const draft = {
      name_en,
      name_ar: String(input?.name_ar ?? "").trim() || null,
      description_en: String(input?.description_en ?? "").trim() || null,
      description_ar: String(input?.description_ar ?? "").trim() || null,
      price,
      main_category: category,
      sub_category: sub,
      brand_id,
      brand_name,
      sku,
      platform_status: "Draft",
    };
    const token = signAction({ v: 1, type: "add_product", agent: "noor", sku, product: draft, ts: Date.now() });
    return {
      ok: true, agent: "noor",
      speak: `نور وبيان: جهّزنا منتج جديد "${name_en}" بسعر ${price} ريال، فئة ${category}، الكود ${sku}، حالة Draft. أكّد لإضافته.`,
      panel: confirmPanel("إضافة منتج", "noor", "إضافة منتج جديد (Draft)", name_en, sku, [
        { label: "الاسم", new: name_en },
        ...(draft.name_ar ? [{ label: "الاسم (عربي)", new: draft.name_ar }] : []),
        { label: "السعر (ر.ق)", new: price },
        { label: "الفئة", new: category },
        ...(sub ? [{ label: "تصنيف فرعي", new: sub }] : []),
        ...(brand_name ? [{ label: "العلامة", new: brand_name }] : []),
        { label: "SKU", new: sku },
        { label: "الحالة", new: "Draft" },
      ], token),
    };
  }

  return { ok: false, error: `أداة كتابة غير معروفة: ${name}` };
}

function extractText(content: Anthropic.ContentBlock[]): string {
  return content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

function findRespond(content: Anthropic.ContentBlock[]): Anthropic.ToolUseBlock | undefined {
  return content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === "tool_use" && b.name === "respond"
  );
}

// Shape a respond/JSON payload into the client contract { agent, speak, panel }.
function buildResponse(out: any, skuImages: Map<string, string>) {
  const agent = AGENT_IDS.includes(out?.agent) ? out.agent : "malak";
  const speak = typeof out?.speak === "string" && out.speak.trim() ? out.speak : "تم.";
  const panel = out?.panel ? enrichPanel(out.panel, skuImages) : undefined;
  return { agent, speak, panel };
}

export async function POST(req: Request) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return Response.json(
      { agent: "malak", speak: "ما قدرت أوصل لعقلي الذكي — مفتاح ANTHROPIC_API_KEY غير مهيأ على الخادم." },
      { status: 200 }
    );
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return Response.json({ agent: "malak", speak: "صيغة الطلب غير صحيحة." }, { status: 400 });
  }

  const incoming = Array.isArray(body?.messages) ? body.messages : [];
  // Normalise to {role, content:string}; keep the last 12 turns.
  const messages: Anthropic.MessageParam[] = incoming
    .filter((m: any) => (m?.role === "user" || m?.role === "assistant") && typeof m?.content === "string")
    .slice(-12)
    .map((m: any) => ({ role: m.role, content: m.content.slice(0, 4000) }));

  if (messages.length === 0) {
    return Response.json({ agent: "malak", speak: "أهلًا فهد، وش تبي نسوي اليوم؟" }, { status: 200 });
  }

  const client = new Anthropic({ apiKey });
  const sb = createAdminClient();
  const skuImages = new Map<string, string>();

  const create = (extra: Partial<Anthropic.MessageCreateParamsNonStreaming> = {}) =>
    client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      temperature: 0,
      system: SYSTEM_PROMPT,
      tools: TOOLS,
      messages,
      ...extra,
    });

  // An attached image (uploaded by the composer) arrives as body.imageUrl. Its
  // presence means the user wants to set a product image → force set_image.
  const imageUrl = typeof body?.imageUrl === "string" && body.imageUrl.trim() ? body.imageUrl.trim() : null;

  // If the latest user turn is clearly a write request, force the matching
  // write tool on the first call so the model can't dodge it with prose.
  const lastUserText = [...messages].reverse().find((m) => m.role === "user")?.content;
  const forcedTool = imageUrl ? "set_image" : detectForcedTool(typeof lastUserText === "string" ? lastUserText : "");
  if (forcedTool) console.log("[malak] forcing write tool:", forcedTool);

  try {
    let resp = await create(forcedTool ? { tool_choice: { type: "tool", name: forcedTool } } : {});
    let toolRounds = 0;

    // Tool loop. We check for a `respond` block after EVERY model response —
    // regardless of stop_reason — so a truncated/`max_tokens` or final-round
    // respond call is never silently dropped (the old bug that returned "تم.").
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      console.log(`[malak] round=${round} stop_reason=${resp.stop_reason}`);

      // WRITE tools take ABSOLUTE priority over `respond`. If the model asked to
      // modify data, return the confirmation card — even if it ALSO emitted a
      // `respond` (claiming success) in the same turn. This guarantees no write
      // request is ever silently turned into a textual "done" with no card.
      // (No write happens here regardless — prepareWrite only reads + signs.)
      const writeUse = resp.content.find(
        (b): b is Anthropic.ToolUseBlock => b.type === "tool_use" && WRITE_TOOLS.includes(b.name)
      );
      if (writeUse) {
        const prep = await prepareWrite(sb, writeUse.name, writeUse.input, { imageUrl });
        if (prep.ok) {
          console.log("[malak] write confirm prepared:", writeUse.name);
          return Response.json({ agent: prep.agent, speak: prep.speak, panel: prep.panel });
        }
        // Validation failed → return the error DIRECTLY as the answer. Do NOT
        // loop back to the model: when left free after a failed write it tends
        // to hallucinate that "the tool isn't available, do it manually". A
        // clear actionable message (e.g. "السعر غير صالح") is far better.
        console.log("[malak] write validation failed:", writeUse.name, prep.error);
        return Response.json({ agent: agentForTool(writeUse.name), speak: prep.error });
      }

      const respondBlock = findRespond(resp.content);
      if (respondBlock) {
        console.log("[malak] respond via tool call");
        return Response.json(buildResponse(respondBlock.input, skuImages));
      }

      // No respond yet. If the model isn't asking for a data tool, stop looping.
      if (resp.stop_reason !== "tool_use") break;

      // Execute the (read-only) data tools it asked for, feed results back.
      const dataUses = resp.content.filter(
        (b): b is Anthropic.ToolUseBlock => b.type === "tool_use"
      );
      messages.push({ role: "assistant", content: resp.content });
      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const tu of dataUses) {
        const data = await runTool(sb, tu.name, tu.input, skuImages);
        results.push({
          type: "tool_result",
          tool_use_id: tu.id,
          content: JSON.stringify(data).slice(0, 12000),
        });
      }
      messages.push({ role: "user", content: results });
      toolRounds++;
      resp = await create();
    }

    // Loop ended without a respond tool call. Try to parse final prose as JSON.
    const text = extractText(resp.content);
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]);
        console.log("[malak] respond via parsed JSON text");
        return Response.json(buildResponse(parsed, skuImages));
      } catch {
        console.log("[malak] JSON parse of final text failed");
      }
    }

    // Forced-respond fallback: the conversation in `messages` is well-formed
    // (every tool_use already has its tool_result), and any data the model
    // gathered is in those tool_results. Force a structured respond so we ALWAYS
    // return { agent, speak, panel } instead of falling through to "تم.".
    // We do NOT push the broken final `resp` (it may be a partial tool_use).
    console.log(`[malak] forcing respond (toolRounds=${toolRounds}, finalStop=${resp.stop_reason}, textLen=${text.length})`);
    if (resp.stop_reason !== "tool_use") {
      // Safe to include the model's prose turn for context.
      messages.push({ role: "assistant", content: text || "(no text)" });
    }
    messages.push({
      role: "user",
      content: "صيغي ردّكِ النهائي الآن عبر استدعاء أداة respond فقط، مع panel مناسب إذا توفّرت بيانات منتجات/إحصائيات.",
    });
    const forced = await create({ tool_choice: { type: "tool", name: "respond" } });
    const forcedBlock = findRespond(forced.content);
    if (forcedBlock) {
      console.log("[malak] respond via forced tool_choice");
      return Response.json(buildResponse(forcedBlock.input, skuImages));
    }

    console.log("[malak] no structured answer produced");
    return Response.json({
      agent: "malak",
      speak: text || "ما قدرت أجهّز الرد، جرّب تعيد صياغة طلبك.",
    });
  } catch (e: any) {
    const msg = e?.message || "خطأ غير متوقع";
    console.error("[malak] error:", msg);
    return Response.json(
      { agent: "malak", speak: `صار خطأ تقني عندي: ${msg.slice(0, 200)}` },
      { status: 200 }
    );
  }
}
