import "server-only";
import crypto from "crypto";

// Shared AI product-photo edit (OpenAI images/edits), used by BOTH the staff
// add-product tab and the admin product form so the two flows can't drift.
// Auth is the CALLER's job — this just edits bytes and stores the result.
// Env-gated on OPENAI_API_KEY (callers surface the Arabic hint when unset).

const PRODUCT_BUCKET = "product-images";

export async function editProductImageCore(
  admin: any,
  imageUrl: string,
  prompt: string,
  pathPrefix: string, // e.g. "staff" | "products-ai" — keeps origins separable
): Promise<{ imageUrl: string } | { error: string }> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return { error: "تعديل الصور غير مفعّل (OPENAI_API_KEY غير مضبوط)." };
  const src = String(imageUrl || "").trim();
  const instruction = String(prompt || "").trim().slice(0, 500);
  if (!src) return { error: "ما فيه صورة لتعديلها." };
  if (!instruction) return { error: "اكتب وصف التعديل المطلوب." };

  // Load the current image bytes.
  let buf: Buffer; let ct = "image/png";
  try {
    const r = await fetch(src);
    if (!r.ok) return { error: `تعذّر تحميل الصورة (${r.status}).` };
    ct = (r.headers.get("content-type") || "image/png").split(";")[0].trim();
    buf = Buffer.from(await r.arrayBuffer());
  } catch { return { error: "تعذّر تحميل الصورة." }; }

  const model = process.env.OPENAI_IMAGE_MODEL || "gpt-image-1-mini";
  const fullPrompt =
    `Edit this product photo as instructed: ${instruction}. ` +
    `Keep it a realistic product photo of the SAME product (same shape, label and colors). ` +
    `Do NOT add any text, letters, watermark, logo or price. Clean, well-lit e-commerce look.`;

  let bytes: Buffer;
  try {
    const form = new FormData();
    form.append("model", model);
    form.append("prompt", fullPrompt);
    form.append("size", "1024x1024");
    form.append("n", "1");
    form.append("image", new Blob([new Uint8Array(buf)], { type: ct }), `src.${ct.includes("png") ? "png" : "jpg"}`);
    const r = await fetch("https://api.openai.com/v1/images/edits", {
      method: "POST", headers: { Authorization: `Bearer ${apiKey}` }, body: form,
    });
    if (!r.ok) {
      console.error("[editProductImage] OpenAI", r.status, (await r.text()).slice(0, 200));
      return { error: `تعذّر تعديل الصورة الآن (رمز ${r.status}). جرّب صياغة أبسط.` };
    }
    const data: any = await r.json();
    const b64 = data?.data?.[0]?.b64_json ?? null;
    const outUrl = data?.data?.[0]?.url ?? null;
    if (b64) bytes = Buffer.from(b64, "base64");
    else if (outUrl) bytes = Buffer.from(await (await fetch(outUrl)).arrayBuffer());
    else return { error: "ما رجعت صورة معدّلة." };
  } catch (e: any) {
    return { error: e?.message || "خطأ أثناء تعديل الصورة." };
  }

  const path = `${pathPrefix}/${Date.now()}-${crypto.randomBytes(4).toString("hex")}.jpg`;
  const up = await admin.storage.from(PRODUCT_BUCKET).upload(path, bytes, { contentType: "image/jpeg", upsert: false, cacheControl: "3600" });
  if (up.error) return { error: `تعذّر حفظ الصورة: ${up.error.message}` };
  return { imageUrl: admin.storage.from(PRODUCT_BUCKET).getPublicUrl(path).data.publicUrl };
}
