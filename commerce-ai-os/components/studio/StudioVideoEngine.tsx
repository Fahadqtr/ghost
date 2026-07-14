"use client";

import { useState } from "react";
import { uploadStudioImage, generateStudioPreview, pollStudioVideo } from "@/app/(app)/studio/actions";
import { VIDEO_TEMPLATES, DEFAULT_TEMPLATE_ID } from "@/lib/video/templates";
import type { Locale } from "@/lib/i18n";

// Video Engine flow: upload product image → pick template → generate PREVIEW →
// poll → show the video. Audio/translation come in a later step.
export default function StudioVideoEngine({ locale = "ar" }: { locale?: Locale }) {
  const en = locale === "en";
  const L = (ar: string, e: string) => (en ? e : ar);

  const [imageUrl, setImageUrl] = useState("");
  const [templateId, setTemplateId] = useState(DEFAULT_TEMPLATE_ID);
  const [uploading, setUploading] = useState(false);
  const [phase, setPhase] = useState<"idle" | "generating" | "done" | "error">("idle");
  const [note, setNote] = useState("");
  const [err, setErr] = useState("");
  const [provider, setProvider] = useState("");
  const [videoUrl, setVideoUrl] = useState("");

  const pickImage = async (file: File | undefined) => {
    if (!file) return;
    setUploading(true); setErr("");
    try {
      const fd = new FormData(); fd.set("image", file);
      const r = await uploadStudioImage(fd);
      if ("error" in r) setErr(r.error);
      else { setImageUrl(r.url); setVideoUrl(""); setPhase("idle"); }
    } finally { setUploading(false); }
  };

  const generate = async () => {
    if (!imageUrl) { setErr(L("ارفع صورة منتج أول", "Upload a product image first")); return; }
    setPhase("generating"); setErr(""); setNote(""); setVideoUrl("");
    const r = await generateStudioPreview({ imageUrl, templateId });
    if ("error" in r) { setPhase("error"); setErr(r.error); return; }
    setProvider(r.provider); if (r.note) setNote(r.note);
    let attempts = 0;
    const tick = async () => {
      attempts++;
      const p = await pollStudioVideo(r.requestId);
      if ("error" in p) { setPhase("error"); setErr(p.error); return; }
      if (p.videoUrl) { setVideoUrl(p.videoUrl); setPhase("done"); return; }
      if (attempts > 60) { setPhase("error"); setErr(L("طال وقت التوليد — جرّب مرة ثانية", "Timed out — try again")); return; }
      setTimeout(tick, 10000);
    };
    setTimeout(tick, 10000);
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <a href="/studio" className="btn-ghost px-2 py-1 text-xs">← {L("الاستوديو", "Studio")}</a>
        <span className="text-2xl">🎬</span>
        <h2 className="text-lg font-semibold text-ink">{L("محرك الفيديو", "Video Engine")}</h2>
        <span className="badge bg-emerald-100 text-emerald-700">{L("معاينة", "Preview")}</span>
      </div>
      <p className="text-sm text-muted">{L("ارفع صورة منتج، اختر تمبلت، وولّد نسخة معاينة. (بدون صوت/ترجمة الآن).", "Upload a product image, pick a template, generate a preview. (No audio/translation yet.)")}</p>

      {/* 1) Product image */}
      <div className="card space-y-2">
        <p className="text-sm font-bold text-ink">١) {L("صورة المنتج", "Product image")}</p>
        <div className="flex flex-wrap items-center gap-3">
          <label className="btn-primary cursor-pointer px-3 py-1.5 text-xs">
            {uploading ? L("…يرفع", "…uploading") : L("📤 ارفع صورة", "📤 Upload image")}
            <input type="file" accept="image/*" className="hidden" onChange={(e) => pickImage(e.target.files?.[0])} />
          </label>
          {imageUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- user-uploaded preview; Next/Image adds no value here
            <img src={imageUrl} alt="" className="h-20 w-20 rounded-lg object-cover ring-1 ring-[#efe3d6]" />
          ) : null}
        </div>
      </div>

      {/* 2) Template */}
      <div className="card space-y-2">
        <p className="text-sm font-bold text-ink">٢) {L("التمبلت", "Template")}</p>
        <div className="flex flex-wrap gap-2">
          {VIDEO_TEMPLATES.map((t) => (
            <button key={t.id} onClick={() => setTemplateId(t.id)}
              className={`rounded-lg border px-3 py-1.5 text-xs font-semibold ${templateId === t.id ? "border-violet-400 bg-violet-50 text-violet-800" : "border-[#efe3d6] text-slate-700"}`}>
              {en ? t.labelEn : t.labelAr}
            </button>
          ))}
        </div>
      </div>

      {/* 3) Generate */}
      <div className="card space-y-2">
        <p className="text-sm font-bold text-ink">٣) {L("توليد المعاينة", "Generate preview")}</p>
        <button onClick={generate} disabled={phase === "generating" || !imageUrl}
          className="btn-primary px-4 py-1.5 text-sm disabled:opacity-50">
          {phase === "generating" ? `⏳ ${L("يولّد… (دقائق)", "generating… (min)")}` : `✨ ${L("ولّد المعاينة", "Generate preview")}`}
        </button>
        {provider ? <span className="ms-2 text-[11px] text-muted">{L("المحرك:", "Engine:")} {provider}</span> : null}
        {note ? <p className="rounded-lg bg-amber-50 px-3 py-1.5 text-[11px] text-amber-800">{note}</p> : null}
        {err ? <p className="rounded-lg bg-red-50 px-3 py-1.5 text-xs text-red-700">{err}</p> : null}
      </div>

      {/* 4) Result */}
      {videoUrl ? (
        <div className="card space-y-2">
          <p className="text-sm font-bold text-ink">✅ {L("المعاينة جاهزة", "Preview ready")}</p>
          <video src={videoUrl} controls className="w-full max-w-sm rounded-xl" />
          <a href={videoUrl} target="_blank" rel="noreferrer" dir="ltr" className="block truncate text-[11px] text-violet-700 underline">{videoUrl}</a>
        </div>
      ) : null}
    </div>
  );
}
