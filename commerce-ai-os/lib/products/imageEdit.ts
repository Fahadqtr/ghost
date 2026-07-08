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
  opts?: { raw?: boolean; quality?: string }, // raw = use the prompt verbatim (allows text/full ad)
): Promise<{ imageUrl: string } | { error: string }> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return { error: "تعديل الصور غير مفعّل (OPENAI_API_KEY غير مضبوط)." };
  const src = String(imageUrl || "").trim();
  const instruction = String(prompt || "").trim().slice(0, opts?.raw ? 4000 : 500);
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

  const model = process.env.OPENAI_IMAGE_MODEL || "gpt-image-1";
  // raw mode (full ad): the caller's prompt is complete — it WANTS text. Default
  // mode wraps the instruction: the PRODUCT must survive untouched (models love
  // to repaint labels into gibberish), only the scene around it changes — styled
  // like a premium global-brand product ad.
  const fullPrompt = opts?.raw
    ? instruction
    : `Edit this product photo as instructed: ${instruction}. ` +
      `CRITICAL: keep the product itself EXACTLY as in the input photo — identical shape, size, position, colors, materials and above all the packaging text: ` +
      `every word, line and letter of the label (including SMALL fine print) must be copied from the source pixels character-for-character — never retype, approximate, blur or invent lettering. ` +
      `If any small text cannot be reproduced perfectly, keep the original pixels of that area untouched. ` +
      `Change ONLY the background, surface and lighting around the product. ` +
      `Style it like a premium international beauty-brand advertisement: clean studio backdrop, soft natural shadow and gentle reflection, elegant complementary tones. ` +
      `Do NOT add any new text, watermark or price anywhere. Photorealistic, high-end commercial photography.`;

  let bytes: Buffer;
  try {
    const form = new FormData();
    form.append("model", model);
    form.append("prompt", fullPrompt);
    form.append("size", "1024x1024");
    form.append("n", "1");
    // Default to the top quality tier: fine label print survives at "high"
    // where "auto"/medium rewrites it into gibberish. Env-overridable.
    if (model.startsWith("gpt-image")) form.append("quality", opts?.quality || process.env.OPENAI_IMAGE_QUALITY || "high");
    // gpt-image-* default to strict ("auto") moderation, which false-positives
    // on ordinary product/beauty photos. "low" relaxes it (still filtered).
    if (model.startsWith("gpt-image")) form.append("moderation", "low");
    // High input fidelity preserves the source product faithfully (label
    // typography, logos, fine detail) instead of repainting it from scratch —
    // the fix for garbled label text on edited product photos.
    if (model.startsWith("gpt-image")) form.append("input_fidelity", "high");
    form.append("image", new Blob([new Uint8Array(buf)], { type: ct }), `src.${ct.includes("png") ? "png" : "jpg"}`);
    const r = await fetch("https://api.openai.com/v1/images/edits", {
      method: "POST", headers: { Authorization: `Bearer ${apiKey}` }, body: form,
      signal: AbortSignal.timeout(opts?.raw ? 58_000 : 55_000), // full ad renders slower
    });
    if (!r.ok) {
      const detail = (await r.text()).slice(0, 300);
      console.error("[editProductImage] OpenAI", r.status, detail);
      const blocked = /moderation|safety|content_policy/i.test(detail);
      return { error: blocked
        ? "رفض مولّد الصور هذه الصورة (فلتر الأمان). جرّب صورة/منتج ثاني."
        : `تعذّر تعديل الصورة الآن (رمز ${r.status}). جرّب صياغة أبسط.` };
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
