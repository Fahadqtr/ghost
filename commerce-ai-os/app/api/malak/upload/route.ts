// Malak image upload (Phase 2C). Receives an image file from the /malak
// composer and stores it in Supabase Storage (same bucket the product editor
// uses). It does NOT link the image to any product yet — that's a write, so it
// happens only after the user confirms (see set_image in /api/malak/commit).
// This endpoint just returns the public URL so the confirm card can preview it.
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BYTES = 10 * 1024 * 1024; // 10 MB
const EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
};
const BUCKET = "product-images";

export async function POST(req: Request) {
  // Must be signed in (same gate as the editor's upload action).
  const {
    data: { user },
  } = await createClient().auth.getUser();
  if (!user) return Response.json({ error: "غير مسجّل الدخول." }, { status: 401 });

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return Response.json({ error: "صيغة الطلب غير صحيحة." }, { status: 400 });
  }

  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) return Response.json({ error: "لا يوجد ملف." }, { status: 400 });
  if (file.size > MAX_BYTES) return Response.json({ error: `الملف كبير (${(file.size / 1048576).toFixed(1)}MB). الحد 10MB.` }, { status: 400 });
  const ext = EXT[file.type];
  if (!ext) return Response.json({ error: `نوع غير مدعوم "${file.type || "?"}". استخدم JPG/PNG/WebP/GIF.` }, { status: 400 });

  let admin;
  try {
    admin = createAdminClient();
  } catch (e: any) {
    return Response.json({ error: e?.message ?? "Service role unavailable." }, { status: 500 });
  }

  const path = `malak_${Date.now()}_${Math.floor(Math.random() * 1e4)}.${ext}`;
  try {
    const buf = Buffer.from(await file.arrayBuffer());
    const { error: upErr } = await admin.storage
      .from(BUCKET)
      .upload(path, buf, { contentType: file.type, upsert: true, cacheControl: "3600" });
    if (upErr) return Response.json({ error: `فشل الرفع: ${upErr.message}` }, { status: 200 });
    const url = admin.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;
    return Response.json({ ok: true, url, path });
  } catch (e: any) {
    return Response.json({ error: e?.message ?? "خطأ غير متوقع أثناء الرفع." }, { status: 200 });
  }
}
