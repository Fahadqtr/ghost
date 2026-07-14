"use server";

import { createAdminClient } from "@/lib/supabase/admin";
import { requireUser } from "@/lib/auth/requireUser";
import { submitProductVideo, pollProductVideo } from "@/lib/video/provider-router";
import { videoTemplate, DEFAULT_TEMPLATE_ID } from "@/lib/video/templates";
import { floraConfigured } from "@/lib/video/flora";
import { higgsfieldConfigured } from "@/lib/social/higgsfield";
import { resolveProvider } from "@/lib/video/routing";

// Malika AI Studio → Video Engine actions. Step-2 flow: upload a product image,
// pick a template, generate a PREVIEW clip via the provider router (FLORA first),
// poll, and return the video URL. No audio/translation here yet.

const BUCKET = "product-images";

/** Upload a product image for the studio flow; returns a public URL. */
export async function uploadStudioImage(form: FormData): Promise<{ error: string } | { url: string }> {
  const unauth = await requireUser();
  if (unauth) return unauth;
  const file = form.get("image");
  if (!(file instanceof File) || !file.size) return { error: "لا توجد صورة." };
  if (file.size > 12 * 1024 * 1024) return { error: "حجم الصورة كبير — الحد ١٢ ميجابايت." };
  const ext = (file.name.split(".").pop() || "jpg").toLowerCase().replace(/[^a-z0-9]/g, "") || "jpg";
  const type = file.type && /^image\//.test(file.type) ? file.type : "image/jpeg";
  let db: any;
  try { db = createAdminClient(); } catch (e: any) { return { error: e?.message || "الخادم غير مهيأ." }; }
  const buf = Buffer.from(await file.arrayBuffer());
  const path = `studio-uploads/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  const { error } = await db.storage.from(BUCKET).upload(path, buf, { contentType: type, upsert: true });
  if (error) return { error: `رفع الصورة فشل: ${error.message}` };
  const url = db.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;
  return { url };
}

/** Generate a preview clip from a product image + a template. */
export async function generateStudioPreview(input: { imageUrl: string; templateId?: string }):
  Promise<{ error: string } | { requestId: string; provider: string; note?: string }> {
  const unauth = await requireUser();
  if (unauth) return unauth;
  const imageUrl = String(input.imageUrl || "").trim();
  if (!/^https?:\/\//i.test(imageUrl)) return { error: "رابط صورة غير صالح." };
  const tpl = videoTemplate(input.templateId) ?? videoTemplate(DEFAULT_TEMPLATE_ID)!;
  const r = await submitProductVideo({ imageUrl, prompt: tpl.prompt, kind: tpl.kind });
  if (!r.ok || !r.requestId) return { error: r.error || "فشل بدء التوليد." };
  return { requestId: r.requestId, provider: r.provider ?? "—", note: r.note };
}

/** Poll a studio preview job; returns the video URL once ready. */
export async function pollStudioVideo(requestId: string): Promise<{ error: string } | { status: string; videoUrl?: string }> {
  const unauth = await requireUser();
  if (unauth) return unauth;
  const s = await pollProductVideo(requestId);
  if (s.status === "failed") return { error: s.error || "فشل التوليد." };
  return { status: s.status, videoUrl: s.videoUrl };
}

/** Which video engines are configured (for the settings page). */
export async function videoEngineStatus(): Promise<{ flora: boolean; higgsfield: boolean; defaultProvider: string }> {
  await requireUser();
  return {
    flora: floraConfigured(),
    higgsfield: higgsfieldConfigured(),
    defaultProvider: resolveProvider("product_cinematic", process.env.VIDEO_PROVIDER),
  };
}
