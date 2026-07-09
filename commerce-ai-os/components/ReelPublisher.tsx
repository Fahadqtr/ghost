"use client";

import { useRef, useState, useTransition } from "react";
import { createClient } from "@/lib/supabase/client";
import { publishReelByUrl } from "@/app/(app)/social/actions";
import type { Locale } from "@/lib/i18n";

const BUCKET = "product-images";

// Publish an Instagram Reel from a video the owner uploads (or a public link).
export default function ReelPublisher({ configured, locale = "ar" }: { configured: boolean; locale?: Locale }) {
  const en = locale === "en";
  const L = (ar: string, e: string) => (en ? e : ar);
  const [open, setOpen] = useState(false);
  const [videoUrl, setVideoUrl] = useState("");
  const [caption, setCaption] = useState("");
  const [uploading, setUploading] = useState(false);
  const [upPct, setUpPct] = useState<number | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [publishing, startPublish] = useTransition();
  const fileRef = useRef<HTMLInputElement>(null);

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith("video/")) { setMsg({ ok: false, text: L("اختر ملف فيديو.", "Pick a video file.") }); return; }
    setUploading(true); setUpPct(0); setMsg(null); setVideoUrl("");
    try {
      const sb = createClient();
      const path = `reels/${Date.now()}-${file.name.replace(/[^\w.-]+/g, "_")}`;
      const { error } = await sb.storage.from(BUCKET).upload(path, file, { upsert: false, contentType: file.type });
      if (error) { setMsg({ ok: false, text: `${error.message}` }); setUploading(false); setUpPct(null); return; }
      const url = sb.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;
      setVideoUrl(url);
      setMsg({ ok: true, text: L("✅ اترفع الفيديو — جاهز للنشر.", "✅ Video uploaded — ready to publish.") });
    } catch (err) {
      setMsg({ ok: false, text: err instanceof Error ? err.message : L("فشل الرفع", "Upload failed") });
    } finally {
      setUploading(false); setUpPct(null);
    }
  };

  const publish = () => {
    if (!videoUrl.trim()) { setMsg({ ok: false, text: L("ارفع فيديو أو الصق رابط أولًا.", "Upload a video or paste a link first.") }); return; }
    setMsg({ ok: true, text: L("⏳ يُنشر… قد ياخذ حتى دقيقة لمعالجة الفيديو.", "⏳ Publishing… video processing can take up to a minute.") });
    startPublish(async () => {
      const r = await publishReelByUrl(videoUrl.trim(), caption);
      if (r.error) { setMsg({ ok: false, text: `❌ ${r.error}` }); return; }
      setMsg({ ok: true, text: L("🎉 اننشر الريل على إنستقرام!", "🎉 Reel published to Instagram!") });
      setVideoUrl(""); setCaption(""); if (fileRef.current) fileRef.current.value = "";
    });
  };

  return (
    <div className="card p-0">
      <button onClick={() => setOpen((o) => !o)} className="flex w-full items-center justify-between p-3 text-start">
        <span className="text-sm font-bold text-ink">🎬 {L("انشر ريل على إنستقرام", "Publish an Instagram Reel")}</span>
        <span className="text-muted">{open ? "▴" : "▾"}</span>
      </button>
      {open ? (
        <div className="space-y-3 border-t border-[#efe3d6] p-3">
          {!configured ? (
            <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
              {L("إنستقرام غير مهيأ (INSTAGRAM_USER_ID / INSTAGRAM_ACCESS_TOKEN).", "Instagram not configured (INSTAGRAM_USER_ID / INSTAGRAM_ACCESS_TOKEN).")}
            </p>
          ) : null}

          <div>
            <label className="mb-1 block text-xs font-semibold text-muted">{L("١) الفيديو", "1) Video")}</label>
            <input ref={fileRef} type="file" accept="video/*" onChange={onFile} disabled={uploading || publishing}
              className="block w-full text-xs text-slate-600 file:mr-3 file:rounded-lg file:border-0 file:bg-violet-600 file:px-3 file:py-2 file:text-xs file:font-bold file:text-white" />
            <p className="mt-1 text-[11px] text-muted">
              {L("أو الصق رابط فيديو عام (mp4):", "Or paste a public video (mp4) link:")}
            </p>
            <input value={videoUrl} onChange={(e) => setVideoUrl(e.target.value)} disabled={uploading || publishing}
              className="input mt-1 w-full text-xs" placeholder="https://…/video.mp4" dir="ltr" />
            {uploading ? <p className="mt-1 text-xs text-violet-700">{L("جاري رفع الفيديو…", "Uploading video…")}{upPct != null ? ` ${upPct}%` : ""}</p> : null}
          </div>

          <div>
            <label className="mb-1 block text-xs font-semibold text-muted">{L("٢) الكابشن", "2) Caption")}</label>
            <textarea value={caption} onChange={(e) => setCaption(e.target.value)} disabled={publishing} rows={3}
              className="input w-full text-sm" placeholder={L("اكتب وصف الريل والهاشتاقات…", "Write the reel caption & hashtags…")} />
          </div>

          {msg ? <p className={`rounded-lg px-3 py-2 text-xs ${msg.ok ? "bg-emerald-50 text-emerald-800" : "bg-red-50 text-red-700"}`}>{msg.text}</p> : null}

          <button onClick={publish} disabled={uploading || publishing || !videoUrl.trim()}
            className="btn-primary w-full disabled:opacity-50">
            {publishing ? L("جاري النشر…", "Publishing…") : `🎬 ${L("انشر الريل الآن", "Publish reel now")}`}
          </button>
          <p className="text-[11px] text-muted">
            {L("ملاحظة: الفيديو لازم يكون بمواصفات ريلز إنستقرام (رأسي 9:16، أقل من ٩٠ ثانية، MP4).", "Note: the video must meet Instagram Reels specs (vertical 9:16, under 90s, MP4).")}
          </p>
        </div>
      ) : null}
    </div>
  );
}
