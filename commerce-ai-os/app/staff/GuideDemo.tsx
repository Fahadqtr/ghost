"use client";

import type { Locale } from "@/lib/i18n";

// Self-running CSS phone demo for the staff guide — a realistic handset that
// walks through 4 scenes (sign-in → stock → add product → tasks) with a status
// bar, the real tab strip, a pulsing finger-tap, a progress bar and captions.
export default function GuideDemo({ locale = "ar" }: { locale?: Locale }) {
  const en = locale === "en";
  const L = (ar: string, e: string) => (en ? e : ar);

  const captions = [
    L("سجّل الدخول برمزك", "Sign in with your code"),
    L("امسح وأدخِل/أخرِج المخزون", "Scan & move stock in/out"),
    L("أضِف منتج جديد بالصورة", "Add a product from a photo"),
    L("أنجِز مهامك", "Complete your tasks"),
  ];

  // The app's real tab strip (with the active one highlighted per scene).
  const Tabs = ({ active }: { active: number }) => {
    const items = ["📦", "🔎", "➕", "📋", "✨"];
    return (
      <div className="mb-2 flex gap-0.5 rounded-lg bg-[#f3ece1] p-0.5">
        {items.map((ic, i) => (
          <span key={i} className={`flex-1 rounded-md py-1 text-center text-[11px] ${i === active ? "bg-white shadow-xs" : "opacity-45"}`}>{ic}</span>
        ))}
      </div>
    );
  };

  return (
    <div className="flex flex-col items-center gap-3">
      <style>{`
        @keyframes gdScene { 0%{opacity:0;transform:translateY(6px)} 2%{opacity:1;transform:translateY(0)} 23%{opacity:1;transform:translateY(0)} 25.5%{opacity:0;transform:translateY(-4px)} 100%{opacity:0} }
        @keyframes gdTap { 0%,100%{transform:scale(.55);opacity:0} 40%{transform:scale(.55);opacity:.85} 70%{transform:scale(1.25);opacity:0} }
        @keyframes gdPress { 0%,38%{transform:scale(1)} 46%{transform:scale(.95)} 60%{transform:scale(1)} 100%{transform:scale(1)} }
        @keyframes gdBar { 0%{width:3%} 25%{width:100%} 25.01%{width:3%} 100%{width:3%} }
        .gd-scene{position:absolute;inset:0;opacity:0;animation:gdScene 20s infinite}
        .gd-cap{position:absolute;inset:0;opacity:0;animation:gdScene 20s infinite}
        .gd-tap{position:absolute;width:30px;height:30px;border-radius:50%;background:rgba(63,42,29,.35);border:2px solid rgba(63,42,29,.5);animation:gdTap 20s infinite}
        .gd-press{animation:gdPress 20s infinite}
        @media (prefers-reduced-motion: reduce){.gd-scene,.gd-tap,.gd-cap,.gd-press{animation:none}.gd-scene:first-of-type,.gd-cap:first-of-type{opacity:1}}
      `}</style>

      {/* handset */}
      <div className="relative h-[420px] w-[236px] rounded-[34px] border-[5px] border-[#2a1c12] bg-[#2a1c12] shadow-2xl">
        <div className="relative h-full w-full overflow-hidden rounded-[26px] bg-[#faf5f0]">
          {/* status bar */}
          <div className="flex items-center justify-between px-4 pt-2 text-[10px] font-semibold text-[#3f2a1d]">
            <span>9:41</span>
            <span className="absolute left-1/2 top-1.5 h-3.5 w-16 -translate-x-1/2 rounded-full bg-[#2a1c12]" />
            <span>📶 🔋</span>
          </div>

          <div className="relative h-[calc(100%-26px)] w-full">
            {/* Scene 1 — sign in */}
            <div className="gd-scene" style={{ animationDelay: "0s" }}>
              <div className="flex h-full flex-col items-center justify-center gap-3 p-6">
                <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-brand text-3xl text-white shadow-lg">📦</div>
                <p className="font-serif text-base font-bold text-ink">{L("صفحة الموظفين", "Employee page")}</p>
                <p className="-mt-2 text-[10px] text-muted">Malika&apos;s Universe</p>
                <div className="mt-1 w-full rounded-xl border border-[#e4d6c5] bg-white px-3 py-3 text-center text-lg tracking-[0.5em] text-ink">••••</div>
                <div className="relative w-full">
                  <div className="gd-press rounded-xl bg-brand py-3 text-center text-sm font-bold text-white shadow-md" style={{ animationDelay: "0s" }}>{L("دخول", "Sign in")}</div>
                  <span className="gd-tap" style={{ insetInlineStart: "50%", top: "8px", marginInlineStart: "-15px", animationDelay: "0s" }} />
                </div>
              </div>
            </div>

            {/* Scene 2 — stock */}
            <div className="gd-scene" style={{ animationDelay: "5s" }}>
              <div className="flex h-full flex-col gap-2 p-3">
                <Tabs active={0} />
                <div className="flex items-center gap-2 rounded-xl border border-[#e4d6c5] bg-white px-2.5 py-2 text-[11px] text-muted">{L("امسح الباركود…", "Scan barcode…")} <span className="ms-auto">📷</span></div>
                <div className="flex items-center gap-2 rounded-xl border border-[#efe3d6] bg-white p-2 shadow-xs">
                  <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand-light">🧴</span>
                  <span><span className="block text-[11px] font-semibold text-ink">{L("سيروم جلو 30مل", "Glow serum 30ml")}</span><span className="block text-[9px] text-muted">mk1204 · {L("مخزون", "stock")} 12</span></span>
                </div>
                <div className="relative grid grid-cols-2 gap-2">
                  <div className="gd-press rounded-xl bg-emerald-600 py-2.5 text-center text-[11px] font-bold text-white" style={{ animationDelay: "5s" }}>➕ {L("إدخال", "In")}</div>
                  <div className="rounded-xl bg-amber-500/15 py-2.5 text-center text-[11px] font-bold text-amber-700">➖ {L("إخراج", "Out")}</div>
                  <span className="gd-tap" style={{ insetInlineStart: "25%", top: "6px", marginInlineStart: "-15px", animationDelay: "5s" }} />
                </div>
                <div className="text-center text-base font-bold text-ink">−&nbsp;&nbsp;3&nbsp;&nbsp;+</div>
                <div className="mt-auto rounded-xl bg-emerald-50 px-2 py-2 text-center text-[11px] font-bold text-emerald-700">✓ {L("أُدخل 3 · مخزون 15", "In 3 · stock 15")}</div>
              </div>
            </div>

            {/* Scene 3 — add product */}
            <div className="gd-scene" style={{ animationDelay: "10s" }}>
              <div className="flex h-full flex-col gap-2 p-3">
                <Tabs active={2} />
                <div className="rounded-2xl border-2 border-dashed border-brand/40 bg-brand-light/50 py-5 text-center text-[11px] font-medium text-brand-dark">📸 {L("صوّر المنتج", "Photograph it")}<span className="mt-1 block text-[9px] font-normal">{L("العنوان والوصف تلقائيًا", "title & description auto")}</span></div>
                <div className="rounded-xl border border-[#efe3d6] bg-white px-2.5 py-2 text-[10px] text-ink">{L("سيروم فيتامين سي ✨", "Vitamin C serum ✨")}</div>
                <div className="rounded-xl border border-[#efe3d6] bg-white px-2.5 py-2 text-[10px] text-muted">{L("وصف تسويقي مولّد… ✨", "generated marketing copy… ✨")}</div>
                <div className="relative mt-auto">
                  <div className="gd-press rounded-xl bg-brand py-2.5 text-center text-[11px] font-bold text-white" style={{ animationDelay: "10s" }}>{L("أضِف", "Add")}</div>
                  <span className="gd-tap" style={{ insetInlineStart: "50%", top: "5px", marginInlineStart: "-15px", animationDelay: "10s" }} />
                </div>
              </div>
            </div>

            {/* Scene 4 — tasks */}
            <div className="gd-scene" style={{ animationDelay: "15s" }}>
              <div className="flex h-full flex-col gap-2 p-3">
                <Tabs active={3} />
                <div className="grid grid-cols-3 gap-1.5 text-center">
                  <div className="rounded-lg border border-[#efe3d6] bg-white py-1.5 text-[9px] text-muted">{L("مفتوحة", "Open")}<b className="block text-sm text-brand">2</b></div>
                  <div className="rounded-lg border border-red-100 bg-red-50 py-1.5 text-[9px] text-muted">{L("متأخّرة", "Overdue")}<b className="block text-sm text-red-600">1</b></div>
                  <div className="rounded-lg border border-[#efe3d6] bg-white py-1.5 text-[9px] text-muted">{L("منجزة", "Done")}<b className="block text-sm text-emerald-600">4</b></div>
                </div>
                <div className="relative overflow-hidden rounded-xl border border-red-200 bg-red-50 p-2.5 ps-3.5 shadow-xs">
                  <span className="absolute inset-y-0 inset-s-0 w-1.5 bg-red-500" />
                  <p className="text-[11px] font-bold text-ink">🔴 {L("رتّبي رف رود", "Tidy the Rhode shelf")}</p>
                  <p className="text-[9px] text-red-600">⏰ {L("متأخّرة", "overdue")}</p>
                </div>
                <div className="relative mt-1 grid grid-cols-2 gap-2">
                  <div className="rounded-xl border border-amber-300 py-2.5 text-center text-[11px] font-bold text-amber-700">▶ {L("جاري", "Doing")}</div>
                  <div className="gd-press rounded-xl bg-emerald-600 py-2.5 text-center text-[11px] font-bold text-white" style={{ animationDelay: "15s" }}>✓ {L("تم", "Done")}</div>
                  <span className="gd-tap" style={{ insetInlineStart: "75%", top: "5px", marginInlineStart: "-15px", animationDelay: "15s" }} />
                </div>
              </div>
            </div>

            {/* progress bar + home indicator */}
            <div className="absolute inset-x-6 bottom-3 h-1 overflow-hidden rounded-full bg-[#e7d9c9]">
              <div className="h-full rounded-full bg-brand" style={{ animation: "gdBar 20s infinite" }} />
            </div>
            <div className="absolute bottom-1 left-1/2 h-1 w-20 -translate-x-1/2 rounded-full bg-[#2a1c12]/30" />
          </div>
        </div>
      </div>

      {/* caption */}
      <div className="relative h-5 w-full max-w-[260px] text-center">
        {captions.map((c, i) => (
          <span key={i} className="gd-cap text-xs font-semibold text-brand-dark" style={{ animationDelay: `${i * 5}s` }}>{c}</span>
        ))}
      </div>
    </div>
  );
}
