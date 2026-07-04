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
