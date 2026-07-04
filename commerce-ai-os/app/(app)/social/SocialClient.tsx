"use client";

import { useState, useTransition } from "react";
import {
  publishSocialPost,
  dismissSocialPost,
  generateNowAction,
  improveSocialImage,
  getAdOverlayData,
  saveSocialImage,
  type SocialPost,
} from "./actions";
import { buildAdText } from "@/lib/social/ad-overlay-compute";
import { composeAdImage } from "@/lib/social/ad-overlay-render";

// Review queue: today's AI-drafted post per platform — edit the caption if you
// like, then one tap publishes for real. Nothing posts without this tap.

const PLATFORM = {
  instagram: { label: "إنستقرام", icon: "📸" },
  tiktok: { label: "تيك توك", icon: "🎵" },
} as Record<string, { label: string; icon: string }>;

export default function SocialClient({
  pending: initialPending,
  recent,
  configured,
}: {
  pending: SocialPost[];
  recent: SocialPost[];
  configured: { instagram: boolean; tiktok: boolean };
}) {
  const [pending, setPending] = useState(initialPending);
  const [captions, setCaptions] = useState<Record<string, string>>(
    Object.fromEntries(initialPending.map((p) => [p.id, p.caption])),
  );
  const [msg, setMsg] = useState<Record<string, string>>({});
  const [images, setImages] = useState<Record<string, string>>({});
  const [busy, start] = useTransition();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [genMsg, setGenMsg] = useState("");

  const improve = (p: SocialPost) => {
    setBusyId(p.id);
    setNote(p.id, "…يحوّلها لصورة إنستقرام احترافية (نصف دقيقة تقريبًا)");
    start(async () => {
      const r = await improveSocialImage(p.id);
      setBusyId(null);
      if (r.error) { setNote(p.id, `❌ ${r.error}`); return; }
      if (r.imageUrl) setImages((s) => ({ ...s, [p.id]: r.imageUrl! }));
      setNote(p.id, "✅ الصورة اتحسّنت — اضغط مرة ثانية لو تبي محاولة أخرى");
    });
  };

  const setNote = (id: string, m: string) => setMsg((s) => ({ ...s, [id]: m }));

  // Paint the brand/name/price/CTA onto the current photo in the browser
  // (crisp Arabic via system fonts), then persist it as the post image.
  const addText = (p: SocialPost) => {
    setBusyId(p.id);
    setNote(p.id, "…يضيف نص الإعلان على الصورة");
    start(async () => {
      try {
        const info = await getAdOverlayData(p.id);
        if (info.error || !info.data) { setBusyId(null); setNote(p.id, `❌ ${info.error ?? "تعذّر جلب بيانات المنتج"}`); return; }
        const dataUrl = await composeAdImage(images[p.id] ?? p.image_url, buildAdText(info.data));
        const saved = await saveSocialImage(p.id, dataUrl);
        setBusyId(null);
        if (saved.error) { setNote(p.id, `❌ ${saved.error}`); return; }
        if (saved.imageUrl) setImages((s) => ({ ...s, [p.id]: saved.imageUrl! }));
        setNote(p.id, "✅ انضاف نص الإعلان على الصورة");
      } catch (e) {
        setBusyId(null);
        setNote(p.id, `❌ ${e instanceof Error ? e.message : "تعذّر إضافة النص"}`);
      }
    });
  };

  const publish = (p: SocialPost) => {
    setBusyId(p.id);
    setNote(p.id, "");
    start(async () => {
      const r = await publishSocialPost(p.id, captions[p.id] ?? p.caption);
      setBusyId(null);
      if (r.error) { setNote(p.id, `❌ ${r.error}`); return; }
      setNote(p.id, "✅ نُشر!");
      setPending((list) => list.filter((x) => x.id !== p.id));
    });
  };

  const dismiss = (p: SocialPost) => {
    setBusyId(p.id);
    start(async () => {
      await dismissSocialPost(p.id);
      setBusyId(null);
      setPending((list) => list.filter((x) => x.id !== p.id));
    });
  };

  const generateNow = () => {
    setGenMsg("…يولّد منشور اليوم");
    start(async () => {
      const r = await generateNowAction();
      if (r.error) { setGenMsg(`❌ ${r.error}`); return; }
      if (r.note) { setGenMsg(`ℹ️ ${r.note}`); return; }
      setGenMsg("✅ انولّد — حدّث الصفحة لعرضه");
    });
  };

  const notConfigured = (platform: string) =>
    (platform === "instagram" && !configured.instagram) ||
    (platform === "tiktok" && !configured.tiktok);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-ink">📣 محتوى السوشيال</h2>
          <p className="text-sm text-muted">منشور اليوم يتولّد تلقائيًا كل صباح — راجِع، عدّل، وانشر بضغطة.</p>
        </div>
        <button type="button" className="btn-ghost whitespace-nowrap disabled:opacity-50" onClick={generateNow} disabled={busy}>
          ✨ ولّد الآن
        </button>
      </div>
      {genMsg ? <p className="text-xs text-muted">{genMsg}</p> : null}

      {pending.length === 0 ? (
        <div className="card text-center text-sm text-muted">
          ما فيه منشورات بانتظار المراجعة — منشور بكرة يتولّد الصبح تلقائيًا 🌅
        </div>
      ) : (
        pending.map((p) => (
          <div key={p.id} className="card space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-sm font-semibold text-ink">
                {PLATFORM[p.platform]?.icon ?? "📣"} {PLATFORM[p.platform]?.label ?? p.platform}
                {p.status === "failed" ? <span className="mr-2 text-xs text-red-600"> — فشل سابقًا، عدّل وجرّب</span> : null}
              </span>
              <span className="text-[11px] text-muted">{new Date(p.created_at).toLocaleDateString("ar")}</span>
            </div>

            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={images[p.id] ?? p.image_url} alt="" className="max-h-64 w-full rounded-xl border border-[#efe3d6] object-contain bg-white" />
            <button
              type="button"
              className="btn-ghost w-full text-sm disabled:opacity-50"
              onClick={() => improve(p)}
              disabled={busy || busyId === p.id}
            >
              {busyId === p.id ? "…يحسّن الصورة" : "✨ حوّلها لصورة إنستقرام احترافية"}
            </button>
            <button
              type="button"
              className="btn-ghost w-full text-sm disabled:opacity-50"
              onClick={() => addText(p)}
              disabled={busy || busyId === p.id}
            >
              🏷️ أضف نص الإعلان (البراند + الاسم + السعر)
            </button>

            <textarea
              dir="rtl"
              className="input min-h-36 w-full text-sm leading-6"
              value={captions[p.id] ?? p.caption}
              onChange={(e) => setCaptions((s) => ({ ...s, [p.id]: e.target.value }))}
            />

            {notConfigured(p.platform) ? (
              <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
                {p.platform === "instagram"
                  ? "إنستقرام غير مربوط بعد — أضف INSTAGRAM_USER_ID و INSTAGRAM_ACCESS_TOKEN في Vercel."
                  : "تيك توك غير مربوط بعد — يحتاج TIKTOK_ACCESS_TOKEN (والنشر العام يتطلب موافقة تيك توك على التطبيق)."}
              </p>
            ) : null}
            {p.error && p.status === "failed" ? <p className="text-xs text-red-600">{p.error}</p> : null}
            {msg[p.id] ? <p className="text-xs text-muted">{msg[p.id]}</p> : null}

            <div className="flex gap-2">
              <button
                type="button"
                className="btn flex-1 disabled:opacity-50"
                onClick={() => publish(p)}
                disabled={busy || busyId === p.id || notConfigured(p.platform)}
              >
                {busyId === p.id ? "…ينشر" : "🚀 انشر الآن"}
              </button>
              <button type="button" className="btn-ghost disabled:opacity-50" onClick={() => dismiss(p)} disabled={busy}>
                تجاهل
              </button>
            </div>
          </div>
        ))
      )}

      {recent.length ? (
        <div className="card">
          <p className="mb-2 text-sm font-semibold text-ink">آخر المنشورات</p>
          <div className="space-y-1.5">
            {recent.map((r) => (
              <div key={r.id} className="flex items-center justify-between text-xs text-muted">
                <span>{PLATFORM[r.platform]?.icon} {r.status === "posted" ? "نُشر" : "تم تجاهله"} · {new Date(r.posted_at ?? r.created_at).toLocaleDateString("ar")}</span>
                <span className="max-w-[60%] truncate">{r.caption.split("\n")[0]}</span>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
