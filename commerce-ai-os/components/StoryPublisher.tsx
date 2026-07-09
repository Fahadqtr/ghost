"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { createClient } from "@/lib/supabase/client";
import { publishStoryByUrl, scheduleStory, generateStoryForProduct, listProductsForStory, type StoryProduct } from "@/app/(app)/social/actions";
import type { Locale } from "@/lib/i18n";

const BUCKET = "product-images";

// Publish an Instagram Story: upload/paste media, OR generate one with AI from a
// product photo, then post now or schedule it for auto-publish.
export default function StoryPublisher({ configured, locale = "ar" }: { configured: boolean; locale?: Locale }) {
  const en = locale === "en";
  const L = (ar: string, e: string) => (en ? e : ar);
  const [open, setOpen] = useState(false);
  const [mediaUrl, setMediaUrl] = useState("");
  const [kind, setKind] = useState<"image" | "video">("image");
  const [uploading, setUploading] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [publishing, startPublish] = useTransition();
  const [when, setWhen] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  // AI generation from a product photo.
  const [products, setProducts] = useState<StoryProduct[]>([]);
  const [productId, setProductId] = useState("");
  const [generating, startGenerate] = useTransition();

  useEffect(() => {
    if (!open || products.length) return;
    listProductsForStory().then((r) => { if (r.products) setProducts(r.products); }).catch(() => {});
  }, [open, products.length]);

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const isVideo = file.type.startsWith("video/");
    const isImage = file.type.startsWith("image/");
    if (!isVideo && !isImage) { setMsg({ ok: false, text: L("اختر صورة أو فيديو.", "Pick an image or video.") }); return; }
    setUploading(true); setMsg(null); setMediaUrl("");
    try {
      const sb = createClient();
      const path = `stories/${Date.now()}-${file.name.replace(/[^\w.-]+/g, "_")}`;
      const { error } = await sb.storage.from(BUCKET).upload(path, file, { upsert: false, contentType: file.type });
      if (error) { setMsg({ ok: false, text: error.message }); setUploading(false); return; }
      const url = sb.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;
      setMediaUrl(url); setKind(isVideo ? "video" : "image");
      setMsg({ ok: true, text: L("✅ اترفع — جاهز للنشر كستوري.", "✅ Uploaded — ready to post as a story.") });
    } catch (err) {
      setMsg({ ok: false, text: err instanceof Error ? err.message : L("فشل الرفع", "Upload failed") });
    } finally {
      setUploading(false);
    }
  };

  const generate = () => {
    if (!productId) { setMsg({ ok: false, text: L("اختر منتج أولًا.", "Pick a product first.") }); return; }
    setMsg({ ok: true, text: L("🎨 يولّد ستوري بالذكاء… (٢٠–٤٠ ثانية)", "🎨 Generating a story with AI… (20–40s)") });
    startGenerate(async () => {
      const r = await generateStoryForProduct(productId);
      if (r.error || !r.imageUrl) { setMsg({ ok: false, text: `❌ ${r.error ?? L("تعذّر التوليد", "Generation failed")}` }); return; }
      setMediaUrl(r.imageUrl); setKind("image");
      setMsg({ ok: true, text: L("✅ اتولّد الستوري — انشره الآن أو جدوله.", "✅ Story generated — post now or schedule it.") });
    });
  };

  const reset = () => { setMediaUrl(""); setWhen(""); if (fileRef.current) fileRef.current.value = ""; };

  const publish = () => {
    if (!mediaUrl.trim()) { setMsg({ ok: false, text: L("ارفع/ولّد وسائط أو الصق رابط أولًا.", "Upload/generate media or paste a link first.") }); return; }
    setMsg({ ok: true, text: L("⏳ يُنشر الستوري…", "⏳ Posting the story…") });
    startPublish(async () => {
      const r = await publishStoryByUrl(mediaUrl.trim(), kind);
      if (r.error) { setMsg({ ok: false, text: `❌ ${r.error}` }); return; }
      setMsg({ ok: true, text: L("🎉 اننشر الستوري على إنستقرام!", "🎉 Story posted to Instagram!") });
      reset();
    });
  };

  const schedule = () => {
    if (!mediaUrl.trim()) { setMsg({ ok: false, text: L("ارفع/ولّد وسائط أو الصق رابط أولًا.", "Upload/generate media or paste a link first.") }); return; }
    if (!when) { setMsg({ ok: false, text: L("اختر وقت النشر.", "Pick a publish time.") }); return; }
    const iso = new Date(when).toISOString();
    setMsg({ ok: true, text: L("⏳ يُجدول الستوري…", "⏳ Scheduling the story…") });
    startPublish(async () => {
      const r = await scheduleStory(mediaUrl.trim(), kind, iso);
      if (r.error) { setMsg({ ok: false, text: `❌ ${r.error}` }); return; }
      setMsg({ ok: true, text: L("📅 اتجدول الستوري — ينشر تلقائيًا في وقته.", "📅 Story scheduled — it auto-posts at its time.") });
      reset();
    });
  };

  const busy = uploading || publishing || generating;

  return (
    <div className="card p-0">
      <button onClick={() => setOpen((o) => !o)} className="flex w-full items-center justify-between p-3 text-start">
        <span className="text-sm font-bold text-ink">📸 {L("انشر ستوري على إنستقرام", "Post an Instagram Story")}</span>
        <span className="text-muted">{open ? "▴" : "▾"}</span>
      </button>
      {open ? (
        <div className="space-y-3 border-t border-[#efe3d6] p-3">
          {!configured ? (
            <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
              {L("إنستقرام غير مهيأ (INSTAGRAM_USER_ID / INSTAGRAM_ACCESS_TOKEN).", "Instagram not configured (INSTAGRAM_USER_ID / INSTAGRAM_ACCESS_TOKEN).")}
            </p>
          ) : null}

          {/* Generate a story with AI from a product photo */}
          <div className="rounded-lg bg-violet-50 p-2">
            <label className="mb-1 block text-xs font-semibold text-violet-800">{L("✨ ولّد ستوري بالذكاء من منتج", "✨ Generate a story with AI from a product")}</label>
            <div className="flex gap-2">
              <select value={productId} onChange={(e) => setProductId(e.target.value)} disabled={busy}
                className="input min-w-0 flex-1 text-xs">
                <option value="">{L("اختر منتج…", "Pick a product…")}</option>
                {products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
              <button onClick={generate} disabled={busy || !productId}
                className="btn-primary shrink-0 whitespace-nowrap px-3 text-xs disabled:opacity-50">
                {generating ? L("يولّد…", "…") : `✨ ${L("ولّد", "Generate")}`}
              </button>
            </div>
          </div>

          <div>
            <label className="mb-1 block text-xs font-semibold text-muted">{L("أو ارفع صورة/فيديو للستوري", "Or upload a story image/video")}</label>
            <input ref={fileRef} type="file" accept="image/*,video/*" onChange={onFile} disabled={busy}
              className="block w-full text-xs text-slate-600 file:mr-3 file:rounded-lg file:border-0 file:bg-violet-600 file:px-3 file:py-2 file:text-xs file:font-bold file:text-white" />
            <p className="mt-1 text-[11px] text-muted">{L("أو الصق رابط عام:", "Or paste a public link:")}</p>
            <input value={mediaUrl} onChange={(e) => { setMediaUrl(e.target.value); setKind(/\.(mp4|mov|webm)(\?|$)/i.test(e.target.value) ? "video" : "image"); }}
              disabled={busy} className="input mt-1 w-full text-xs" placeholder="https://…" dir="ltr" />
            {uploading ? <p className="mt-1 text-xs text-violet-700">{L("جاري الرفع…", "Uploading…")}</p> : null}
          </div>

          {mediaUrl && kind === "image" ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={mediaUrl} alt="story preview" className="mx-auto max-h-64 rounded-lg" />
          ) : null}

          {msg ? <p className={`rounded-lg px-3 py-2 text-xs ${msg.ok ? "bg-emerald-50 text-emerald-800" : "bg-red-50 text-red-700"}`}>{msg.text}</p> : null}

          <button onClick={publish} disabled={busy || !mediaUrl.trim()} className="btn-primary w-full disabled:opacity-50">
            {publishing ? L("جاري النشر…", "Posting…") : `📸 ${L("انشر الستوري الآن", "Post story now")}`}
          </button>

          {/* Schedule for later */}
          <div className="rounded-lg border border-[#efe3d6] p-2">
            <label className="mb-1 block text-xs font-semibold text-muted">{L("📅 أو جدوله للنشر تلقائيًا لاحقًا", "📅 Or schedule it to auto-publish later")}</label>
            <div className="flex gap-2">
              <input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} disabled={busy}
                className="input min-w-0 flex-1 text-xs" />
              <button onClick={schedule} disabled={busy || !mediaUrl.trim() || !when}
                className="btn-ghost shrink-0 whitespace-nowrap px-3 text-xs disabled:opacity-50">
                📅 {L("جدول", "Schedule")}
              </button>
            </div>
          </div>

          <p className="text-[11px] text-muted">
            {L("الأفضل: عمودي 9:16. الستوري ما فيه كابشن — النص يكون داخل الصورة/الفيديو.", "Best vertical 9:16. Stories have no caption — text lives in the media.")}
          </p>
        </div>
      ) : null}
    </div>
  );
}
