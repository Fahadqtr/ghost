import "server-only";
import crypto from "crypto";

// Product-preserving luxury SCENE generation via Google's Gemini 2.5 Flash
// Image ("Nano Banana") — stronger than gpt-image-1 at keeping the uploaded
// product intact and at photorealism. Env-gated on GEMINI_API_KEY; callers
// fall back to the OpenAI path when it's unset. Text is still overlaid later
// with real fonts, so we never ask the model to render Arabic.

const PRODUCT_BUCKET = "product-images";

export function geminiConfigured(): boolean {
  return !!(process.env.GEMINI_API_KEY || process.env.GOOGLE_AI_API_KEY);
}

/**
 * Generate an EMPTY luxury backdrop (no product, no text) from a text brief
 * only — the real product photo is composited on top later, untouched. This is
 * what guarantees packaging/labels can never be redrawn or garbled.
 */
export async function generateBackdropWithGemini(
  admin: any,
  prompt: string,
  pathPrefix: string,
): Promise<{ imageUrl: string } | { error: string }> {
  const key = process.env.GEMINI_API_KEY || process.env.GOOGLE_AI_API_KEY;
  if (!key) return { error: "Gemini غير مفعّل (GEMINI_API_KEY غير مضبوط)." };
  const instruction = String(prompt || "").trim().slice(0, 4000);
  if (!instruction) return { error: "وصف الخلفية فارغ." };

  const model = process.env.GEMINI_IMAGE_MODEL || "gemini-2.5-flash-image";
  let bytes: Buffer;
  try {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: "POST",
      headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ parts: [{ text: instruction }] }] }),
      signal: AbortSignal.timeout(55_000),
    });
    if (!r.ok) {
      const detail = (await r.text()).slice(0, 300);
      console.error("[gemini-backdrop]", r.status, detail);
      return { error: `تعذّر توليد الخلفية الآن (رمز ${r.status}).` };
    }
    const data: any = await r.json();
    const parts: any[] = data?.candidates?.[0]?.content?.parts ?? [];
    const img = parts.find((p) => p?.inlineData?.data || p?.inline_data?.data);
    const b64 = img?.inlineData?.data || img?.inline_data?.data;
    if (!b64) return { error: "ما رجعت خلفية من Gemini." };
    bytes = Buffer.from(b64, "base64");
  } catch (e: any) {
    return { error: e?.message || "خطأ أثناء توليد الخلفية." };
  }

  const path = `${pathPrefix}/bg-${Date.now()}-${crypto.randomBytes(4).toString("hex")}.png`;
  const up = await admin.storage.from(PRODUCT_BUCKET).upload(path, bytes, { contentType: "image/png", upsert: false, cacheControl: "3600" });
  if (up.error) return { error: `تعذّر حفظ الخلفية: ${up.error.message}` };
  return { imageUrl: admin.storage.from(PRODUCT_BUCKET).getPublicUrl(path).data.publicUrl };
}

/**
 * Read the product photo with Gemini (text out): what's actually on the
 * packaging — name, brand, type, colors, key printed words, visual mood — so
 * the copywriter never invents details. Returns null on any failure (the
 * caption prompt simply omits the analysis block).
 */
export async function analyzeProductImageWithGemini(imageUrl: string): Promise<string | null> {
  const key = process.env.GEMINI_API_KEY || process.env.GOOGLE_AI_API_KEY;
  const src = String(imageUrl || "").trim();
  if (!key || !src) return null;
  try {
    const r0 = await fetch(src);
    if (!r0.ok) return null;
    const ct = (r0.headers.get("content-type") || "image/jpeg").split(";")[0].trim();
    const buf = Buffer.from(await r0.arrayBuffer());
    const model = process.env.GEMINI_TEXT_MODEL || "gemini-2.5-flash";
    const body = {
      contents: [{ parts: [
        { text:
          "حلّلي صورة المنتج هذه بدقة وأجيبي بالعربي في 5 أسطر قصيرة كحد أقصى:\n" +
          "1) اسم المنتج الظاهر على العبوة  2) البراند  3) نوع المنتج  4) الألوان والشكل  " +
          "5) أهم الكلمات المطبوعة على العبوة والإحساس البصري المناسب.\n" +
          "لا تخترعي أي معلومة غير ظاهرة في الصورة." },
        { inline_data: { mime_type: ct, data: buf.toString("base64") } },
      ] }],
    };
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: "POST",
      headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(25_000),
    });
    if (!r.ok) return null;
    const data: any = await r.json();
    const parts: any[] = data?.candidates?.[0]?.content?.parts ?? [];
    const text = parts.map((p) => p?.text ?? "").join("").trim();
    return text ? text.slice(0, 1200) : null;
  } catch { return null; }
}

/**
 * Art-direct the ad scene FROM the product itself: Gemini looks at the photo
 * and invents scene concept #variation (palette pulled from the packaging,
 * textures/props echoing the product's purpose). Returns one English
 * "Setting: ..." clause, or null on any failure (callers keep their fallback
 * mood). Different variation numbers give clearly different concepts, so every
 * re-tap is a new product-inspired design.
 */
export async function designSceneSettingWithGemini(imageUrl: string, variation: number, productName?: string): Promise<string | null> {
  const key = process.env.GEMINI_API_KEY || process.env.GOOGLE_AI_API_KEY;
  const src = String(imageUrl || "").trim();
  if (!key || !src) return null;
  try {
    const r0 = await fetch(src, { signal: AbortSignal.timeout(10_000) });
    if (!r0.ok) return null;
    const ct = (r0.headers.get("content-type") || "image/jpeg").split(";")[0].trim();
    const buf = Buffer.from(await r0.arrayBuffer());
    const model = process.env.GEMINI_TEXT_MODEL || "gemini-2.5-flash";
    const n = Math.max(1, Math.round(variation));
    const name = String(productName || "").trim().slice(0, 120);
    const body = {
      contents: [{ parts: [
        { text:
          "You are a WORLD-CLASS art director for luxury beauty campaigns (think Dior, Jacquemus, Rhode, Glossier " +
          "set design). Look at this product photo" + (name ? ` — the product is "${name}"` : "") + " — first " +
          "identify exactly WHAT it is (its category and real form), then invent set-design concept #" + n +
          " for a high-end Instagram ad backdrop. Be BOLD and imaginative — avoid the cliché round-podium-with-" +
          "fabric shot. Draw from: sculptural plaster arches and niches, monolithic stone blocks, rippling water " +
          "surfaces, sun-drenched hard shadow play, floating glass shelves, mirrors, wet sand dunes, curved " +
          "seamless color walls, oversized ingredient props (petals, citrus, pearls, silk waves) — whatever fits " +
          "THIS product: pull the palette from its packaging colors and choose textures echoing its purpose. " +
          "Reply with EXACTLY one English sentence starting with \"Setting:\" describing palette, surfaces, props, " +
          "composition idea and lighting. Rules: no people, no hands, no text, no other products, light and airy " +
          "(never a dark background). Concept #" + n + " must be clearly different from concepts with other numbers." },
        { inline_data: { mime_type: ct, data: buf.toString("base64") } },
      ] }],
    };
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: "POST",
      headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    if (!r.ok) return null;
    const data: any = await r.json();
    const parts: any[] = data?.candidates?.[0]?.content?.parts ?? [];
    const text = parts.map((p) => p?.text ?? "").join("").trim();
    const m = text.match(/Setting:[^\n]*/);
    return m ? m[0].slice(0, 500) : null;
  } catch { return null; }
}

export async function generateSceneWithGemini(
  admin: any,
  imageUrl: string,
  prompt: string,
  pathPrefix: string,
): Promise<{ imageUrl: string } | { error: string }> {
  const key = process.env.GEMINI_API_KEY || process.env.GOOGLE_AI_API_KEY;
  if (!key) return { error: "Gemini غير مفعّل (GEMINI_API_KEY غير مضبوط)." };
  const src = String(imageUrl || "").trim();
  const instruction = String(prompt || "").trim().slice(0, 4000);
  if (!src) return { error: "ما فيه صورة لتعديلها." };

  // Load the product bytes to hand Gemini as the reference to preserve.
  let buf: Buffer; let ct = "image/jpeg";
  try {
    const r = await fetch(src);
    if (!r.ok) return { error: `تعذّر تحميل الصورة (${r.status}).` };
    ct = (r.headers.get("content-type") || "image/jpeg").split(";")[0].trim();
    buf = Buffer.from(await r.arrayBuffer());
  } catch { return { error: "تعذّر تحميل الصورة." }; }

  const model = process.env.GEMINI_IMAGE_MODEL || "gemini-2.5-flash-image";
  let bytes: Buffer;
  try {
    const body = {
      contents: [{ parts: [
        { text: instruction },
        { inline_data: { mime_type: ct, data: buf.toString("base64") } },
      ] }],
    };
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: "POST",
      headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(55_000),
    });
    if (!r.ok) {
      const detail = (await r.text()).slice(0, 300);
      console.error("[gemini-scene]", r.status, detail);
      const blocked = /safety|blocked|policy/i.test(detail);
      return { error: blocked
        ? "رفض Gemini هذه الصورة (فلتر الأمان). جرّب صورة/منتج ثاني."
        : `تعذّر توليد المشهد الآن (رمز ${r.status}).` };
    }
    const data: any = await r.json();
    const parts: any[] = data?.candidates?.[0]?.content?.parts ?? [];
    const img = parts.find((p) => p?.inlineData?.data || p?.inline_data?.data);
    const b64 = img?.inlineData?.data || img?.inline_data?.data;
    if (!b64) return { error: "ما رجعت صورة من Gemini." };
    bytes = Buffer.from(b64, "base64");
  } catch (e: any) {
    return { error: e?.message || "خطأ أثناء توليد المشهد." };
  }

  const path = `${pathPrefix}/gm-${Date.now()}-${crypto.randomBytes(4).toString("hex")}.png`;
  const up = await admin.storage.from(PRODUCT_BUCKET).upload(path, bytes, { contentType: "image/png", upsert: false, cacheControl: "3600" });
  if (up.error) return { error: `تعذّر حفظ الصورة: ${up.error.message}` };
  return { imageUrl: admin.storage.from(PRODUCT_BUCKET).getPublicUrl(path).data.publicUrl };
}
