// Malak image generation (Ream). Triggered ONLY when the user taps [✨ ولّد
// الصورة] on an image_request card (which carries a signed generate_image
// token). It calls OpenAI Images, uploads the result to Supabase Storage, and
// returns a normal "confirm" preview card carrying a set_image token — so the
// real product link still happens through the existing /api/malak/commit after
// the user approves. No product write happens here.
import { createAdminClient } from "@/lib/supabase/admin";
import { safeFetchImage } from "@/lib/net/safeImage";
import { verifyAction, signAction, type MalakAction } from "@/lib/malak/confirm";
import { requireMalakWriter } from "@/lib/malak/authz";
import { rateLimit } from "@/lib/malak/ratelimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60; // image generation can take 10-40s

const BUCKET = "product-images";

async function firstRow(builder: any): Promise<any | null> {
  const { data } = await builder.limit(1);
  return Array.isArray(data) && data.length ? data[0] : null;
}

function buildPrompt(name: string, style: string, hasRef: boolean, portrait = false): string {
  const frame = portrait
    ? `Vertical portrait composition optimized for Instagram/social feed and stories, product placed off-center with generous clean empty space at the top or bottom. `
    : `Square 1:1 composition for an Instagram feed post, product centered or slightly off-center. `;
  const base =
    frame +
    `Professional luxury Korean K-beauty (K-beauty) skincare advertising product photo of "${name}". ` +
    `Photorealistic, ultra sharp product in crisp focus, premium soft studio lighting with elegant highlights, ` +
    `gentle reflections and soft shadows, dewy glowy aesthetic, refined color grading, high resolution, ` +
    `magazine-grade e-commerce hero look. `;
  const styleBit =
    style === "lifestyle"
      ? `Elegant aspirational lifestyle setting: soft natural light, tasteful minimal props (fresh flowers, water droplets, silk or marble, soft pastel tones), bright and clean. `
      : `Clean minimal luxury background (soft white or delicate pastel gradient), the product as the clear hero, no clutter. `;
  // Generous EMPTY space so a designer adds the (Arabic) text manually later.
  const negSpace =
    `Leave generous clean EMPTY negative space (no objects in it) so a designer can add a headline and call-to-action TEXT later by hand. `;
  // Hard rule: NO generated text/typography of any kind (AI garbles Arabic).
  const noText =
    `ABSOLUTELY CRITICAL: do NOT add or render ANY text, typography, captions, headlines, slogans, letters, words, numbers, ` +
    `paragraphs, badges, stickers, price tags, watermarks, or extra logos anywhere on the image. ` +
    `The image must be a clean product shot ONLY — zero graphic text overlays. `;
  const fidelity = hasRef
    ? `Keep the product packaging EXACTLY as in the provided reference image: identical bottle/box shape, proportions, material and colors, ` +
      `and keep its own existing printed label as-is — do NOT rewrite, restyle, distort, blur or change the product's own label. ` +
      `Only improve the background, lighting, composition and mood. `
    : `Keep the product realistic; do not invent any brand name or label text. `;
  return `${base}${styleBit}${negSpace}${noText}${fidelity}No people.`;
}

export async function POST(req: Request) {
  // Paid OpenAI call + storage write — require an allow-listed writer (F2) on
  // top of the signed token, and a per-user daily cap (F3) so the paid image
  // endpoint can't be looped into a big bill.
  const auth = await requireMalakWriter();
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  const cap = rateLimit(`img:${auth.email}`, 40, 24 * 60 * 60_000);
  if (!cap.ok) return Response.json({ error: "وصلت الحدّ اليومي لتوليد الصور. جرّب بكرة." }, { status: 200 });

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return Response.json({ error: "ميزة توليد الصور غير مهيأة (OPENAI_API_KEY مفقود على الخادم)." }, { status: 200 });
  }

  let token: unknown;
  try {
    token = (await req.json())?.token;
  } catch {
    return Response.json({ error: "صيغة الطلب غير صحيحة." }, { status: 400 });
  }

  const action = verifyAction(token);
  if (!action || action.type !== "generate_image") {
    return Response.json({ error: "طلب التوليد غير صالح أو منتهي الصلاحية. أعد العملية." }, { status: 400 });
  }

  const sb = createAdminClient();
  // Re-read the product (by signed id first, then SKU).
  const p =
    (action.productId && (await firstRow(sb.from("products").select("id, name_en, sku, image_url").eq("id", action.productId)))) ||
    (action.sku && (await firstRow(sb.from("products").select("id, name_en, sku, image_url").ilike("sku", action.sku))));
  if (!p) return Response.json({ error: `المنتج غير موجود (${action.sku}).` }, { status: 200 });

  const style = action.style === "lifestyle" ? "lifestyle" : "hero";
  const size = action.size === "1024x1536" ? "1024x1536" : "1024x1024";
  const portrait = size === "1024x1536";
  const currentImage = p.image_url ?? null;
  const model = process.env.OPENAI_IMAGE_MODEL || "gpt-image-1-mini";
  const prompt = buildPrompt(p.name_en || p.sku, style, !!currentImage, portrait);

  // ---- Call OpenAI Images: edit the current photo (keeps the bottle accurate)
  // when one exists, otherwise generate from the name. -----------------------
  let b64: string | null = null;
  let imgUrl: string | null = null;
  try {
    let r: Response;
    if (currentImage) {
      const imgRes = await safeFetchImage(currentImage);
      if (!imgRes.ok) throw new Error("تعذّر تحميل الصورة الحالية للمرجع.");
      const buf = Buffer.from(await imgRes.arrayBuffer());
      const type = imgRes.headers.get("content-type") || "image/png";
      const form = new FormData();
      form.append("model", model);
      form.append("prompt", prompt);
      form.append("size", size);
      form.append("n", "1");
      form.append("image", new Blob([buf], { type }), `ref.${type.includes("png") ? "png" : "jpg"}`);
      r = await fetch("https://api.openai.com/v1/images/edits", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}` },
        body: form,
      });
    } else {
      r = await fetch("https://api.openai.com/v1/images/generations", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model, prompt, size, n: 1 }),
      });
    }
    if (!r.ok) {
      const errBody = (await r.text()).slice(0, 300);
      console.error("[malak-genimage] OpenAI", r.status, errBody); // details to log only (F6)
      return Response.json({ error: `تعذّر توليد الصورة الحين (رمز ${r.status}). جرّب مرة ثانية.` }, { status: 200 });
    }
    const data: any = await r.json();
    b64 = data?.data?.[0]?.b64_json ?? null;
    imgUrl = data?.data?.[0]?.url ?? null;
  } catch (e: any) {
    console.error("[malak-genimage] error", e?.message);
    return Response.json({ error: e?.message ?? "خطأ غير متوقع أثناء التوليد." }, { status: 200 });
  }

  // Normalize to bytes.
  let bytes: Buffer;
  try {
    if (b64) bytes = Buffer.from(b64, "base64");
    else if (imgUrl) bytes = Buffer.from(await (await safeFetchImage(imgUrl)).arrayBuffer()); // F4: SSRF guard
    else return Response.json({ error: "ما رجع أي صورة من المولّد." }, { status: 200 });
  } catch {
    return Response.json({ error: "تعذّرت قراءة الصورة المولّدة." }, { status: 200 });
  }

  // ---- Upload to Storage (NOT linked to the product yet) -------------------
  const safeSku = String(p.sku || "img").replace(/[^a-zA-Z0-9_-]/g, "") || "img";
  const path = `${safeSku}-ad-${Date.now()}.jpg`;
  const { error: upErr } = await sb.storage
    .from(BUCKET)
    .upload(path, bytes, { contentType: "image/jpeg", upsert: true, cacheControl: "3600" });
  if (upErr) return Response.json({ error: `فشل رفع الصورة: ${upErr.message}` }, { status: 200 });
  const url = sb.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;

  // Token B: a normal set_image action → approved via the existing /commit.
  const setToken = signAction({
    v: 1, type: "set_image", agent: "malak", sku: p.sku, productId: p.id,
    field: "image_url", oldValue: currentImage, newValue: url, ts: Date.now(),
  });

  return Response.json({
    ok: true,
    agent: "malak",
    speak: `جهّزت الصورة المولّدة لـ ${p.name_en}. راجع المعاينة واعتمدها لو عجبتك.`,
    panel: {
      type: "confirm",
      item: {
        title: "معاينة الصورة المولّدة",
        agent: "malak",
        operation: "اعتماد الصورة المولّدة كصورة المنتج",
        name: p.name_en,
        sku: p.sku,
        imageUrl: url,
        changes: [{ label: "الصورة", old: currentImage ? "صورة حالية" : "بدون صورة", new: "الصورة المولّدة" }],
        note: "الصورة بدون نص — أضف النص العربي بمحرر خارجي قبل النشر.",
        confirmLabel: "✓ اعتمدها صورة المنتج",
        cancelLabel: "✗ تجاهل",
        token: setToken,
      },
    },
  });
}
