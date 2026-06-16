// Real end-to-end test for the Malak brain — mirrors app/api/malak/route.ts.
// Runs the actual Anthropic tool loop against the LIVE Supabase catalog and
// prints RAW output (stop_reason per round + final {agent,speak,panel}).
//
//   node scripts/test_malak.mjs                # runs the acceptance prompts
//   node scripts/test_malak.mjs "اعرض منتجات Anua"
//
// Requires ANTHROPIC_API_KEY + Supabase keys in .env.local (or the env).
import { readFileSync } from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@supabase/supabase-js";

// ---- env -----------------------------------------------------------------
let env = { ...process.env };
try {
  const file = Object.fromEntries(
    readFileSync(".env.local", "utf8")
      .split("\n")
      .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
      .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })
  );
  env = { ...file, ...env };
} catch { /* no .env.local */ }

const ANTHROPIC_API_KEY = env.ANTHROPIC_API_KEY;
const SUPABASE_URL = env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) { console.error("Missing Supabase env."); process.exit(1); }
const sb = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } });

const MODEL = "claude-sonnet-4-6";
const MAX_TOKENS = 4096;
const MAX_TOOL_ROUNDS = 4;
const AGENT_IDS = ["malak","noor","reem","siraj","razan","rashid","latifa"];

const SYSTEM_PROMPT =
  'أنتِ ملاك، المديرة العامة الذكية لمتجر Malika\'s Universe Trading (جمال وكورية، قطر). ' +
  'تديرين فريقًا: نور=الكتالوج، ريم=الصور، سراج=المزامنة والمنصّات، رزان=الأسعار والمخزون والمالية، ' +
  'راشد=التسويق والتقارير، لطيفة=العملاء. لهجة خليجية واثقة ومختصرة كشريكة أعمال لفهد. ' +
  'استخدمي الأدوات لجلب البيانات الحقيقية — لا تخترعي أرقامًا. ' +
  'ردّك النهائي JSON فقط: {"agent":"<id>","speak":"<رد قصير>","panel":<اختياري>}. ' +
  'أنواع panel: products{items:[{name,brand,price,status,sku}]}, stats{items:[{label,value,sub}]}, ' +
  'post{item:{caption_ar,caption_en,hashtags,platforms,schedule,product}}, ' +
  'tiktok{item:{hook,scenes:[{shot,text}],audio,hashtags,cta}}. ' +
  'مهم: في products أدرجي sku دائمًا ولا تُدرجي image_url (الخادم يضيفها حسب sku). ' +
  'قدّمي ردّكِ النهائي دائمًا عبر استدعاء أداة respond. id الوكلاء: ' + AGENT_IDS.join("، ") + ".";

const TOOLS = [
  { name: "search_products", description: "ابحثي في الكتالوج. query/brand/category/status/limit. ترجع name,brand,price,status,sku.",
    input_schema: { type: "object", properties: { query:{type:"string"}, brand:{type:"string"}, category:{type:"string"}, status:{type:"string",enum:["Approved","Rejected","SentAI"]}, limit:{type:"integer"} } } },
  { name: "catalog_stats", description: "إحصائيات الكتالوج.", input_schema: { type: "object", properties: {} } },
  { name: "list_rejected", description: "المنتجات المرفوضة.", input_schema: { type: "object", properties: {} } },
  { name: "low_stock", description: "منتجات تحت حد المخزون.", input_schema: { type: "object", properties: { threshold:{type:"integer"} } } },
  { name: "respond", description: "ردّك النهائي. استدعيها دائمًا في النهاية.",
    input_schema: { type: "object", properties: { agent:{type:"string",enum:AGENT_IDS}, speak:{type:"string"}, panel:{type:"object", properties:{ type:{type:"string",enum:["products","stats","post","tiktok"]}, items:{type:"array",items:{type:"object"}}, item:{type:"object"} } } }, required:["agent","speak"] } },
];

// ---- tools (same queries as the route) -----------------------------------
async function brandMap() { const m = new Map(); const { data } = await sb.from("brands").select("id,name"); for (const b of data ?? []) m.set(b.id, b.name); return m; }
async function searchProducts(input) {
  const limit = Math.min(Math.max(Number(input?.limit) || 8, 1), 24);
  let q = sb.from("products").select("id,name_en,brand_id,main_category,price,approval,sku,image_url");
  const query = (input?.query ?? "").toString().trim();
  if (query) { const s = query.replace(/[%,()]/g, " "); q = q.or(`name_en.ilike.%${s}%,sku.ilike.%${s}%`); }
  const brand = (input?.brand ?? "").toString().trim();
  if (brand) q = q.ilike("name_en", `%${brand.replace(/[%,()]/g, " ")}%`);
  const category = (input?.category ?? "").toString().trim();
  if (category) q = q.ilike("main_category", `%${category.replace(/[%,()]/g, " ")}%`);
  const status = (input?.status ?? "").toString().trim();
  if (status) q = q.eq("approval", status);
  q = q.limit(limit);
  const { data, error } = await q;
  if (error) return { error: error.message, items: [] };
  const brands = await brandMap();
  const items = (data ?? []).map((r) => ({ name: r.name_en, brand: r.brand_id ? brands.get(r.brand_id) ?? null : null, price: r.price, status: r.approval, sku: r.sku, category: r.main_category, image_url: r.image_url }));
  return { count: items.length, items };
}
async function catalogStats() {
  const head = async (f) => { let b = sb.from("products").select("*",{count:"exact",head:true}); if (f) b = f(b); const { count } = await b; return count ?? 0; };
  const [total,approved,rejected,sentAi,noImage,promoted,featured,brands] = await Promise.all([
    head(), head(b=>b.eq("approval","Approved")), head(b=>b.eq("approval","Rejected")), head(b=>b.eq("approval","SentAI")),
    head(b=>b.is("image_url",null)), head(b=>b.eq("is_promoted",true)), head(b=>b.eq("is_featured",true)),
    sb.from("brands").select("*",{count:"exact",head:true}).then(r=>r.count??0) ]);
  const catMap = new Map();
  for (let from=0;;from+=1000){ const {data,error}=await sb.from("products").select("main_category").range(from,from+999); if(error)break; for(const r of data??[]){const k=r.main_category||"Uncategorized";catMap.set(k,(catMap.get(k)||0)+1);} if((data??[]).length<1000)break; }
  const topCategories=[...catMap.entries()].map(([name,count])=>({name,count})).sort((a,b)=>b.count-a.count).slice(0,5);
  return { total,approved,rejected,sentAi,missingImage:noImage,promoted,featured,brands,topCategories };
}
async function listRejected() { const {data,error}=await sb.from("products").select("name_en,sku").eq("approval","Rejected").order("sku"); if(error)return{error:error.message,items:[]}; return {count:(data??[]).length,items:(data??[]).map(r=>({name:r.name_en,sku:r.sku}))}; }
async function lowStock(input){ const t=Number(input?.threshold)||10; const {data,error}=await sb.from("inventory").select("product_id,stock_quantity").lt("stock_quantity",t).limit(50); if(error)return{error:error.message,threshold:t,items:[]}; if((data??[]).length===0)return{threshold:t,count:0,items:[],note:"لا توجد منتجات تحت الحد (المخزون=50)."}; const ids=data.map(r=>r.product_id); const {data:p}=await sb.from("products").select("id,name_en,sku").in("id",ids); const by=new Map((p??[]).map(x=>[x.id,x])); return {threshold:t,count:data.length,items:data.map(r=>({name:by.get(r.product_id)?.name_en??null,sku:by.get(r.product_id)?.sku??null,stock:r.stock_quantity}))}; }

const skuImages = new Map();
async function runTool(name, input) {
  let result;
  if (name==="search_products") result=await searchProducts(input);
  else if (name==="catalog_stats") result=await catalogStats();
  else if (name==="list_rejected") result=await listRejected();
  else if (name==="low_stock") result=await lowStock(input);
  else result={error:`Unknown tool ${name}`};
  if (result?.items) for (const it of result.items) if (it?.sku && it?.image_url) skuImages.set(String(it.sku), it.image_url);
  return result;
}
function enrichPanel(panel){ if(panel?.type==="products"&&Array.isArray(panel.items)) for(const it of panel.items) if(it?.sku&&skuImages.has(String(it.sku))) it.image_url=skuImages.get(String(it.sku)); return panel; }
const findRespond = (content) => content.find((b)=>b.type==="tool_use"&&b.name==="respond");
function buildResponse(out){ const agent=AGENT_IDS.includes(out?.agent)?out.agent:"malak"; const speak=(typeof out?.speak==="string"&&out.speak.trim())?out.speak:"تم."; const panel=out?.panel?enrichPanel(out.panel):undefined; return {agent,speak,panel}; }
const text = (content)=>content.filter(b=>b.type==="text").map(b=>b.text).join("\n").trim();

async function ask(client, prompt) {
  const messages = [{ role:"user", content: prompt }];
  const create = (extra={}) => client.messages.create({ model:MODEL, max_tokens:MAX_TOKENS, system:SYSTEM_PROMPT, tools:TOOLS, messages, ...extra });
  let resp = await create();
  for (let round=0; round<MAX_TOOL_ROUNDS; round++) {
    console.log(`   round=${round} stop_reason=${resp.stop_reason} blocks=[${resp.content.map(b=>b.type==="tool_use"?`tool:${b.name}`:b.type).join(", ")}]`);
    const rb = findRespond(resp.content);
    if (rb) return buildResponse(rb.input);
    if (resp.stop_reason !== "tool_use") break;
    const uses = resp.content.filter(b=>b.type==="tool_use");
    messages.push({ role:"assistant", content: resp.content });
    const results = [];
    for (const tu of uses) { const d = await runTool(tu.name, tu.input); console.log(`     ↳ ${tu.name}(${JSON.stringify(tu.input)}) → ${d.items?`${d.items.length} items`:JSON.stringify(d).slice(0,80)}`); results.push({ type:"tool_result", tool_use_id: tu.id, content: JSON.stringify(d).slice(0,12000) }); }
    messages.push({ role:"user", content: results });
    resp = await create();
  }
  const t = text(resp.content);
  const m = t.match(/\{[\s\S]*\}/);
  if (m) { try { return buildResponse(JSON.parse(m[0])); } catch {} }
  if (resp.stop_reason !== "tool_use") messages.push({ role:"assistant", content: t || "(no text)" });
  messages.push({ role:"user", content:"صيغي ردّكِ النهائي الآن عبر استدعاء أداة respond فقط." });
  const forced = await create({ tool_choice:{ type:"tool", name:"respond" } });
  const fb = findRespond(forced.content);
  if (fb) return buildResponse(fb.input);
  return { agent:"malak", speak: t || "(empty)" };
}

const PROMPTS = process.argv[2] ? [process.argv[2]] : [
  "اعرض منتجات Medicube",
  "تقرير حالة الكتالوج",
  "كم منتج مرفوض؟",
  "اكتب وصف عربي وإنجليزي لـ Anua Toner",
];

if (!ANTHROPIC_API_KEY) {
  console.error("\n⚠️  ANTHROPIC_API_KEY غير موجود في .env.local — لا يمكن تشغيل اختبار الموديل.\n   ضِف المفتاح إلى commerce-ai-os/.env.local ثم: node scripts/test_malak.mjs\n");
  process.exit(2);
}
const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
for (const p of PROMPTS) {
  console.log(`\n═══════════════════════════════════════\n🗣️  «${p}»`);
  const r = await ask(client, p);
  console.log(`🤖 agent=${r.agent}`);
  console.log(`   speak: ${r.speak}`);
  if (r.panel) {
    console.log(`   panel.type=${r.panel.type}` + (r.panel.items?` items=${r.panel.items.length}`:""));
    if (r.panel.type==="products") for (const it of (r.panel.items||[]).slice(0,3)) console.log(`     • ${it.name} | ${it.price} | ${it.sku} | img=${it.image_url?"✓":"✗"}`);
    else console.log("     " + JSON.stringify(r.panel).slice(0,300));
  } else console.log("   panel: (none)");
}
process.exit(0);
