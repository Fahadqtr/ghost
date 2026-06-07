// Malak image generation (Ream). Triggered ONLY when the user taps [✨ ولّد
// الصورة] on an image_request card (which carries a signed generate_image
// token). It calls OpenAI Images, uploads the result to Supabase Storage, and
// returns a normal "confirm" preview card carrying a set_image token — so the
// real product link still happens through the existing /api/malak/commit after
// the user approves. No product write happens here.
import { createAdminClient } from "@/lib/supabase/admin";
import { verifyAction, signAction, type MalakAction } from "@/lib/malak/confirm";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60; // image generation can take 10-40s

const BUCKET = "product-images";

async function firstRow(builder: any): Promise<any | null> {
  const { data } = await builder.limit(1);
  return Array.isArray(data) && data.length ? data[0] : null;
}

function buildPrompt(name: string, style: string, hasRef: boolean): string {
  const base =
    `High-end luxury K-beauty advertising product photo of "${name}". ` +
    `Photorealistic, premium studio lighting with soft reflections and gentle shadows, ` +
    `the product perfectly centered, sharp and in focus, e-commerce quality. ` +
    (style === "lifestyle"
      ? `Elegant lifestyle scene with tasteful minimal props (soft flowers, water droplets, marble or silk), bright and clean. `
      : `Clean seamless studio background in soft white or very light pastel, no clutter. `);
  const fidelity = hasRef
    ? `IMPORTANT: keep the product packaging EXACTLY as in the provided reference image — same bottle/box shape, colors, and label text. Only improve the background, lighting and composition. Do not redesign the product or invent text.`
    : `Keep the product design realistic and the label clean; do not invent fake brand text.`;
  return `${base}${fidelity}`;
}

export async function POST(req: Request) {
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
  const currentImage = p.image_url ?? null;
  const model = process.env.OPENAI_IMAGE_MODEL || "gpt-image-1-mini";
  const prompt = buildPrompt(p.name_en || p.sku, style, !!currentImage);

  // ---- Call OpenAI Images: edit the current photo (keeps the bottle accurate)
  // when one exists, otherwise generate from the name. -----------------------
  let b64: string | null = null;
  let imgUrl: string | null = null;
  try {
    let r: Response;
    if (currentImage) {
      const imgRes = await fetch(currentImage);
      if (!imgRes.ok) throw new Error("تعذّر تحميل الصورة الحالية للمرجع.");
      const buf = Buffer.from(await imgRes.arrayBuffer());
      const type = imgRes.headers.get("content-type") || "image/png";
      const form = new FormData();
      form.append("model", model);
      form.append("prompt", prompt);
      form.append("size", "1024x1024");
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
        body: JSON.stringify({ model, prompt, size: "1024x1024", n: 1 }),
      });
    }
    if (!r.ok) {
      const errBody = (await r.text()).slice(0, 300);
      console.error("[malak-genimage] OpenAI", r.status, errBody);
      return Response.json({ error: `فشل التوليد من OpenAI (${r.status}). ${errBody}` }, { status: 200 });
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
    else if (imgUrl) bytes = Buffer.from(await (await fetch(imgUrl)).arrayBuffer());
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
    v: 1, type: "set_image", agent: "reem", sku: p.sku, productId: p.id,
    field: "image_url", oldValue: currentImage, newValue: url, ts: Date.now(),
  });

  return Response.json({
    ok: true,
    agent: "reem",
    speak: `ريم: جهّزت الصورة المولّدة لـ ${p.name_en}. راجع المعاينة واعتمدها لو عجبتك.`,
    panel: {
      type: "confirm",
      item: {
        title: "معاينة الصورة المولّدة",
        agent: "reem",
        operation: "اعتماد الصورة المولّدة كصورة المنتج",
        name: p.name_en,
        sku: p.sku,
        imageUrl: url,
        changes: [{ label: "الصورة", old: currentImage ? "صورة حالية" : "بدون صورة", new: "الصورة المولّدة" }],
        confirmLabel: "✓ اعتمدها صورة المنتج",
        cancelLabel: "✗ تجاهل",
        token: setToken,
      },
    },
  });
}
