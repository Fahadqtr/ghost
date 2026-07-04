"use client";

import { useState, useTransition } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import {
  publishSocialPost,
  dismissSocialPost,
  generateNowAction,
  generateAdCreative,
  saveSocialImage,
  type SocialPost,
} from "./actions";
import { fetchAsDataUrl, nodeToJpeg } from "@/lib/social/dom-to-image";
import { adFontCss } from "@/lib/social/ad-fonts";
import { pickVariant } from "@/lib/social/ad-variants";
import AdTemplate, { AD_W, AD_H, type AdTemplateProps } from "./AdTemplate";

const BRAND_TOP = "MALIKA'S";
const BRAND_SUB = "UNIVERSE BEAUTY";
const PRICE_LABEL = "سعر خاص";
const HANDLE = "@malikas.universe";

// Render the ad template off-screen (real fonts → crisp Arabic), rasterize it,
// then clean up. flushSync mounts synchronously; two rAFs let it lay out first.
async function captureAd(props: AdTemplateProps): Promise<string> {
  const fontCss = await adFontCss(); // luxury fonts, inlined for the SVG raster
  const host = document.createElement("div");
  host.style.cssText = `position:fixed;left:-99999px;top:0;width:${AD_W}px;height:${AD_H}px;pointer-events:none;`;
  document.body.appendChild(host);
  const root = createRoot(host);
  try {
    flushSync(() => root.render(<AdTemplate {...props} />));
    await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
    const node = host.firstElementChild as HTMLElement | null;
    if (!node) throw new Error("تعذّر تجهيز التصميم.");
    return await nodeToJpeg(node, AD_W, AD_H, 0.92, fontCss);
  } finally {
    root.unmount();
    host.remove();
  }
}

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

  const setNote = (id: string, m: string) => setMsg((s) => ({ ...s, [id]: m }));

  // Design taps per post: the variant is stable per product on the first tap
  // and rotates to a fresh art direction on every re-tap.
  const [taps, setTaps] = useState<Record<string, number>>({});

  // Luxury ad: AI writes the Arabic copy, Gemini paints an EMPTY backdrop in
  // the variant's mood, and the browser composites the ORIGINAL product photo
  // (never AI-redrawn) + real-font Arabic on top. Variant rotates per re-tap.
  const designAd = (p: SocialPost) => {
    const tap = taps[p.id] ?? 0;
    const variant = pickVariant(p.id, tap);
    setTaps((s) => ({ ...s, [p.id]: tap + 1 }));
    setBusyId(p.id);
    setNote(p.id, "…يصمّم الإعلان الفخم (خلفية فخمة + منتجك الأصلي + نص — قد يأخذ دقيقة)");
    start(async () => {
      try {
        const info = await generateAdCreative(p.id, variant.scene);
        if (info.error || !info.copy) { setBusyId(null); setNote(p.id, `❌ ${info.error ?? "تعذّر توليد النصوص"}`); return; }
        const productDataUrl = await fetchAsDataUrl(info.productUrl || p.image_url);
        const backdropDataUrl = info.backdropUrl ? await fetchAsDataUrl(info.backdropUrl) : "";
        const dataUrl = await captureAd({
          productDataUrl, backdropDataUrl,
          brandTop: BRAND_TOP, brandSub: BRAND_SUB, handle: HANDLE, priceLabel: PRICE_LABEL,
          headline: info.copy.headline, subtitle: info.copy.subtitle,
          benefits: info.copy.benefits, features: info.copy.features,
          price: info.price ?? "",
          palette: variant.palette,
        });
        const saved = await saveSocialImage(p.id, dataUrl);
        setBusyId(null);
        if (saved.error) { setNote(p.id, `❌ ${saved.error}`); return; }
        if (saved.imageUrl) setImages((s) => ({ ...s, [p.id]: saved.imageUrl! }));
        setNote(p.id, "✅ الإعلان الفخم جاهز — اضغط مرة ثانية لتصميم بستايل مختلف");
      } catch (e) {
        setBusyId(null);
        setNote(p.id, `❌ ${e instanceof Error ? e.message : "تعذّر التصميم"}`);
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
              className="btn w-full text-sm disabled:opacity-50"
              onClick={() => designAd(p)}
              disabled={busy || busyId === p.id}
            >
              {busyId === p.id ? "…يصمّم الإعلان الفخم" : "🎨 صمّم إعلان فخم (بضغطة)"}
            </button>

            <textarea
              dir="rtl"
              className="input min-h-36 w-full text-sm leading-6"
              value={captions[p.id] ?? p.caption}
              onChange={(e) => setCaptions((s) => ({ ...s, [p.id]: e.target.value }))}
            />

            {p.extras && (p.extras.story || p.extras.reel || p.extras.alt) ? (
              <details className="rounded-xl border border-[#efe3d6] bg-white/60 px-3 py-2">
                <summary className="cursor-pointer text-xs font-semibold text-ink">📦 محتوى إضافي جاهز (ستوري + ريلز + Alt)</summary>
                <div className="mt-2 space-y-2 text-xs">
                  {([["📱 ستوري", p.extras.story], ["🎬 سكربت ريلز", p.extras.reel], ["🖼️ Alt Text", p.extras.alt]] as const)
                    .filter(([, v]) => v)
                    .map(([label, v]) => (
                      <div key={label} className="rounded-lg bg-[#faf6f0] p-2" dir="rtl">
                        <div className="mb-1 flex items-center justify-between">
                          <span className="font-semibold text-ink">{label}</span>
                          <button
                            type="button"
                            className="rounded-md border border-[#e5d5c0] px-2 py-0.5 text-[10px] text-muted"
                            onClick={() => { navigator.clipboard?.writeText(String(v)); setNote(p.id, `✅ انتسخ: ${label}`); }}
                          >
                            نسخ
                          </button>
                        </div>
                        <p className="whitespace-pre-wrap leading-5 text-ink/80">{v}</p>
                      </div>
                    ))}
                </div>
              </details>
            ) : null}

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
