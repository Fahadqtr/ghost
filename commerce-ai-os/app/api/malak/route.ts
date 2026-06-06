import Anthropic from "@anthropic-ai/sdk";
import { createAdminClient } from "@/lib/supabase/admin";

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
  'ردّك النهائي JSON فقط: {"agent":"<id>","speak":"<رد قصير للنطق يذكر اسم الوكيل>","panel":<اختياري>}. ' +
  'أنواع panel: products{items:[{name,brand,price,status,sku}]}, ' +
  'stats{items:[{label,value,sub}]}, ' +
  'post{item:{caption_ar,caption_en,hashtags,platforms,schedule,product}}, ' +
  'tiktok{item:{hook,scenes:[{shot,text}],audio,hashtags,cta}}. ' +
  'النشر الفعلي يحتاج Meta/TikTok API — وضّحي ذلك في speak. ' +
  'مهم: في لوحة products أدرجي sku دائمًا لكل منتج، ولا تُدرجي image_url إطلاقًا — ' +
  'الخادم يضيف صورة كل منتج تلقائيًا حسب الـsku (هذا يوفّر المساحة ويضمن ظهور الصور الحقيقية). ' +
  'قدّمي ردّكِ النهائي دائمًا عبر استدعاء أداة respond (وليس كنص عادي). id الوكلاء: ' +
  AGENT_IDS.join("، ") + ".";

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
    name: "low_stock",
    description: "المنتجات التي مخزونها أقل من threshold (افتراضي 10).",
    input_schema: {
      type: "object",
      properties: { threshold: { type: "integer", description: "حد المخزون المنخفض (افتراضي 10)" } },
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

  try {
    let resp = await create();
    let toolRounds = 0;

    // Tool loop. We check for a `respond` block after EVERY model response —
    // regardless of stop_reason — so a truncated/`max_tokens` or final-round
    // respond call is never silently dropped (the old bug that returned "تم.").
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      console.log(`[malak] round=${round} stop_reason=${resp.stop_reason}`);

      const respondBlock = findRespond(resp.content);
      if (respondBlock) {
        console.log("[malak] respond via tool call");
        return Response.json(buildResponse(respondBlock.input, skuImages));
      }

      // No respond yet. If the model isn't asking for a data tool, stop looping.
      if (resp.stop_reason !== "tool_use") break;

      // Execute the data tools it asked for, feed results back.
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
