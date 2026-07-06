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
  planWeekSlot,
  approveSocialPost,
  rescheduleSocialPost,
  type SocialPost,
} from "./actions";
import { planSlots, qatarDayLabel, qatarTimeLabel, qatarDayKey } from "@/lib/social/schedule-compute";
import { fetchAsDataUrl, nodeToJpeg } from "@/lib/social/dom-to-image";
import { adFontCss } from "@/lib/social/ad-fonts";
import { pickVariant, pickLayout, buildProductSceneBrief, BRAND_PALETTE } from "@/lib/social/ad-variants";
import AdTemplate, { AD_W, AD_H, type AdTemplateProps } from "./AdTemplate";

const BRAND_TOP = "MALIKA'S";
const BRAND_SUB = "UNIVERSE BEAUTY";
const HANDLE = "@malikas_universe";
const WEBSITE = "www.malikasuniverse.com";

// MU monogram, fetched once and inlined (the SVG raster can't load URLs).
let logoCache: string | null = null;
async function brandLogoDataUrl(): Promise<string> {
  if (logoCache) return logoCache;
  try { logoCache = await fetchAsDataUrl("/brand/logo.png"); } catch { logoCache = ""; }
  return logoCache;
}

// Is this a clean white/near-white catalog shot? Sample the border pixels: if
// almost all are near-white the photo can multiply-melt into the scene;
// otherwise (lifestyle/busy photo) the template frames it as a rounded card.
async function hasLightBackground(dataUrl: string): Promise<boolean> {
  try {
    const img = new Image();
    await new Promise<void>((res, rej) => { img.onload = () => res(); img.onerror = () => rej(new Error("img")); img.src = dataUrl; });
    const S = 48;
    const cv = document.createElement("canvas");
    cv.width = S; cv.height = S;
    const cx = cv.getContext("2d");
    if (!cx) return false;
    cx.drawImage(img, 0, 0, S, S);
    const d = cx.getImageData(0, 0, S, S).data;
    let light = 0, total = 0;
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      if (x > 3 && x < S - 4 && y > 3 && y < S - 4) continue; // border ring only
      const i = (y * S + x) * 4;
      total++;
      if (Math.min(d[i], d[i + 1], d[i + 2]) > 225) light++;
    }
    return light / Math.max(1, total) > 0.82;
  } catch { return false; }
}

// Guarantee the scene's product never sits under the headline: find the
// product's top edge (the first row of the central band with real contrast —
// smooth backdrops stay near zero) and, if it intrudes into the reserved text
// band, shift the whole scene down, refilling the top with a stretched blurred
// slice of its own smooth backdrop so nothing looks cropped.
async function ensureTopClearance(dataUrl: string, clearFrac: number): Promise<string> {
  try {
    const img = new Image();
    await new Promise<void>((res, rej) => { img.onload = () => res(); img.onerror = () => rej(new Error("img")); img.src = dataUrl; });
    const W = 108, H = 135;
    const cv = document.createElement("canvas");
    cv.width = W; cv.height = H;
    const cx = cv.getContext("2d");
    if (!cx) return dataUrl;
    cx.drawImage(img, 0, 0, W, H);
    const d = cx.getImageData(0, 0, W, H).data;
    let top = H;
    for (let y = 4; y < H; y++) {
      let busy = 0;
      for (let x = Math.floor(W * 0.22); x < Math.floor(W * 0.78); x++) {
        const a = (y * W + x) * 4, b = ((y - 2) * W + x) * 4;
        if (Math.abs(d[a] - d[b]) + Math.abs(d[a + 1] - d[b + 1]) + Math.abs(d[a + 2] - d[b + 2]) > 36) busy++;
      }
      if (busy >= 6) { top = y; break; }
    }
    if (top / H >= clearFrac) return dataUrl; // product already below the text band
    const delta = Math.round(Math.min(clearFrac - top / H, 0.16) * AD_H);
    const out = document.createElement("canvas");
    out.width = AD_W; out.height = AD_H;
    const ox = out.getContext("2d");
    if (!ox) return dataUrl;
    const scale = Math.max(AD_W / img.width, AD_H / img.height);
    const dw = img.width * scale, dh = img.height * scale;
    ox.filter = "blur(10px)";
    ox.drawImage(img, 0, 0, img.width, Math.max(8, img.height * 0.03), -20, -20, AD_W + 40, delta + 60);
    ox.filter = "none";
    ox.drawImage(img, (AD_W - dw) / 2, (AD_H - dh) / 2 + delta, dw, dh);
    return out.toDataURL("image/jpeg", 0.92);
  } catch { return dataUrl; }
}

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
    const variant = pickVariant(p.id, tap);   // palette + backdrop mood (5)
    const layout = pickLayout(p.id, tap);     // arrangement (3) → 15 combos
    setTaps((s) => ({ ...s, [p.id]: tap + 1 }));
    setBusyId(p.id);
    setNote(p.id, "…يصمّم الإعلان الفخم (خلفية فخمة + منتجك الأصلي + نص — قد يأخذ دقيقة)");
    start(async () => {
      try {
        const info = await generateAdCreative(p.id, buildProductSceneBrief(variant, layout), tap);
        if (info.error || !info.copy) { setBusyId(null); setNote(p.id, `❌ ${info.error ?? "تعذّر توليد النصوص"}`); return; }
        // The Gemini scene already CONTAINS the product (grounded on the
        // pedestal) — so it becomes the full-bleed backdrop and nothing is
        // composited on top. Fallback: frame the original photo on the CSS bg.
        let backdropDataUrl = info.backdropUrl ? await fetchAsDataUrl(info.backdropUrl) : "";
        // Hero puts the headline block on the top band — enforce the clearance
        // in pixels (the prompt alone is not a guarantee).
        if (backdropDataUrl && layout.key === "hero") backdropDataUrl = await ensureTopClearance(backdropDataUrl, 0.38);
        const productDataUrl = backdropDataUrl ? "" : await fetchAsDataUrl(info.productUrl || p.image_url);
        const frameProduct = productDataUrl ? !(await hasLightBackground(productDataUrl)) : false;
        const logoDataUrl = await brandLogoDataUrl();
        const dataUrl = await captureAd({
          productDataUrl, backdropDataUrl, frameProduct, logoDataUrl,
          brandTop: BRAND_TOP, brandSub: BRAND_SUB, handle: HANDLE, website: WEBSITE,
          headline: info.copy.headline, headlineEn: info.copy.headlineEn, subtitle: info.copy.subtitle,
          benefits: info.copy.benefits, features: info.copy.features,
          options: info.options ?? [],
          palette: BRAND_PALETTE,
          layout: layout.key,
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

  // ---- Weekly plan ----------------------------------------------------------
  const [planMsg, setPlanMsg] = useState("");

  const planWeek = () => {
    const slots = planSlots();
    setPlanMsg(`…يجهّز خطة الأسبوع (0/${slots.length}) — خلّ الصفحة مفتوحة`);
    start(async () => {
      let made = 0, kept = 0, failed = 0;
      for (let i = 0; i < slots.length; i++) {
        try {
          const r = await planWeekSlot(slots[i].dayOffset, slots[i].slot);
          if (r.error) { failed++; setPlanMsg(`⚠️ (${i + 1}/${slots.length}) ${r.error}`); }
          else {
            if (r.created) made++; else kept++;
            setPlanMsg(`…يجهّز خطة الأسبوع (${i + 1}/${slots.length})${r.name ? ` — ${r.name}` : ""}`);
          }
        } catch { failed++; }
      }
      setPlanMsg(`✅ الخطة جاهزة: ${made} منشور جديد${kept ? ` + ${kept} موجود` : ""}${failed ? ` — ${failed} فشل` : ""} — يحدّث الصفحة…`);
      setTimeout(() => window.location.reload(), 1200);
    });
  };

  const toggleApprove = (p: SocialPost) => {
    const next = !p.approved;
    setBusyId(p.id);
    start(async () => {
      const r = await approveSocialPost(p.id, next);
      setBusyId(null);
      if (r.error) { setNote(p.id, `❌ ${r.error}`); return; }
      setPending((list) => list.map((x) => (x.id === p.id ? { ...x, approved: next } : x)));
      setNote(p.id, next ? "✅ معتمد — سينشر تلقائيًا في وقته" : "أُلغي الاعتماد — لن يُنشر تلقائيًا");
    });
  };

  const reschedule = (p: SocialPost, localValue: string) => {
    const when = new Date(localValue);
    if (isNaN(when.getTime())) return;
    start(async () => {
      const r = await rescheduleSocialPost(p.id, when.toISOString());
      if (r.error) { setNote(p.id, `❌ ${r.error}`); return; }
      setPending((list) => list.map((x) => (x.id === p.id ? { ...x, scheduled_at: when.toISOString() } : x)));
      setNote(p.id, "✅ انتقل الموعد");
    });
  };

  // datetime-local wants "YYYY-MM-DDTHH:mm" in the BROWSER's clock.
  const toLocalInput = (iso: string) => {
    const d = new Date(iso);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };

  const planned = pending
    .filter((p) => p.scheduled_at)
    .sort((a, b) => String(a.scheduled_at).localeCompare(String(b.scheduled_at)));
  const daily = pending.filter((p) => !p.scheduled_at);
  const planDays: [string, SocialPost[]][] = [];
  for (const p of planned) {
    const key = qatarDayKey(String(p.scheduled_at));
    const last = planDays[planDays.length - 1];
    if (last && last[0] === key) last[1].push(p);
    else planDays.push([key, [p]]);
  }

  const notConfigured = (platform: string) =>
    (platform === "instagram" && !configured.instagram) ||
    (platform === "tiktok" && !configured.tiktok);

  const postCard = (p: SocialPost) => (
        <div key={p.id} className="card space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-sm font-semibold text-ink">
              {PLATFORM[p.platform]?.icon ?? "📣"} {PLATFORM[p.platform]?.label ?? p.platform}
              {p.status === "failed" ? <span className="mr-2 text-xs text-red-600"> — فشل سابقًا، عدّل وجرّب</span> : null}
            </span>
            <span className="text-[11px] text-muted">{new Date(p.created_at).toLocaleDateString("ar")}</span>
          </div>

          {p.scheduled_at ? (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-[#faf6f0] px-3 py-2">
              <span className={`text-xs font-semibold ${p.approved ? "text-green-700" : "text-amber-700"}`}>
                {p.approved ? "✅ معتمد — ينشر تلقائيًا" : "⏳ بانتظار اعتمادك"} · {qatarTimeLabel(String(p.scheduled_at))}
              </span>
              <input
                type="datetime-local"
                className="input h-8 w-auto px-2 py-0 text-xs"
                defaultValue={toLocalInput(String(p.scheduled_at))}
                onBlur={(e) => { if (e.target.value && e.target.value !== toLocalInput(String(p.scheduled_at))) reschedule(p, e.target.value); }}
              />
            </div>
          ) : null}

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
            {p.scheduled_at ? (
              <button
                type="button"
                className={`flex-1 disabled:opacity-50 ${p.approved ? "btn-ghost" : "btn"}`}
                onClick={() => toggleApprove(p)}
                disabled={busy || busyId === p.id || notConfigured(p.platform)}
              >
                {p.approved ? "إلغاء الاعتماد" : "✅ اعتماد للنشر التلقائي"}
              </button>
            ) : null}
            <button
              type="button"
              className={`disabled:opacity-50 ${p.scheduled_at ? "btn-ghost" : "btn flex-1"}`}
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
  );

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-ink">📣 محتوى السوشيال</h2>
          <p className="text-sm text-muted">منشور اليوم يتولّد تلقائيًا كل صباح — راجِع، عدّل، وانشر بضغطة.</p>
        </div>
        <div className="flex flex-col gap-2">
          <button type="button" className="btn-ghost whitespace-nowrap disabled:opacity-50" onClick={generateNow} disabled={busy}>
            ✨ ولّد الآن
          </button>
          <button type="button" className="btn whitespace-nowrap text-sm disabled:opacity-50" onClick={planWeek} disabled={busy}>
            🗓️ جهّز خطة أسبوع
          </button>
        </div>
      </div>
      {genMsg ? <p className="text-xs text-muted">{genMsg}</p> : null}
      {planMsg ? <p className="text-xs text-muted">{planMsg}</p> : null}

      {planDays.length ? (
        <div className="space-y-3">
          <h3 className="text-base font-semibold text-ink">🗓️ خطة الأسبوع — {planned.length} منشور (يُنشر المعتمد فقط)</h3>
          {planDays.map(([key, posts]) => (
            <div key={key} className="space-y-3">
              <p className="mt-2 text-sm font-bold text-ink/70">📅 {qatarDayLabel(String(posts[0].scheduled_at))}</p>
              {posts.map(postCard)}
            </div>
          ))}
        </div>
      ) : null}

      {daily.length === 0 && planDays.length === 0 ? (
        <div className="card text-center text-sm text-muted">
          ما فيه منشورات بانتظار المراجعة — اضغط «جهّز خطة أسبوع» ليجهّز ٢١ منشورًا، أو «ولّد الآن» لمنشور اليوم 🌅
        </div>
      ) : null}

      {daily.length ? (
        <div className="space-y-3">
          {planDays.length ? <h3 className="text-base font-semibold text-ink">منشورات بدون جدولة</h3> : null}
          {daily.map(postCard)}
        </div>
      ) : null}

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
