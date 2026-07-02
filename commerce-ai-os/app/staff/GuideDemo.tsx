"use client";

import type { Locale } from "@/lib/i18n";

// Self-running CSS "walkthrough animation" for the staff guide — a phone frame
// that cross-fades through 4 mock scenes (sign-in → stock → add product →
// tasks) with a pulsing tap dot. No external video needed.
export default function GuideDemo({ locale = "ar" }: { locale?: Locale }) {
  const en = locale === "en";
  const L = (ar: string, e: string) => (en ? e : ar);

  const captions = [
    L("١) سجّل الدخول برمزك", "1) Sign in with your code"),
    L("٢) امسح وأدخِل/أخرِج المخزون", "2) Scan & move stock in/out"),
    L("٣) أضِف منتج جديد بالصورة", "3) Add a product from a photo"),
    L("٤) أنجِز مهامك", "4) Complete your tasks"),
  ];

  return (
    <div className="flex flex-col items-center gap-3">
      <style>{`
        @keyframes gdScene { 0%{opacity:0} 2%{opacity:1} 23%{opacity:1} 26%{opacity:0} 100%{opacity:0} }
        @keyframes gdTap { 0%,100%{transform:scale(.7);opacity:.25} 50%{transform:scale(1.15);opacity:.9} }
        @keyframes gdBar { 0%{width:2%} 25%{width:100%} 25.01%{width:2%} 100%{width:2%} }
        .gd-scene{position:absolute;inset:0;opacity:0;animation:gdScene 16s infinite}
        .gd-tap{position:absolute;width:34px;height:34px;border-radius:50%;background:rgba(168,104,58,.5);animation:gdTap 1.1s infinite}
        .gd-cap{opacity:0;animation:gdScene 16s infinite}
        @media (prefers-reduced-motion: reduce){.gd-scene,.gd-tap,.gd-cap{animation:none}.gd-scene:first-of-type,.gd-cap:first-of-type{opacity:1}}
      `}</style>

      {/* phone */}
      <div className="relative h-[380px] w-[230px] overflow-hidden rounded-[26px] border-4 border-[#3f2a1d] bg-white shadow-xl">
        {/* Scene 1 — sign in */}
        <div className="gd-scene" style={{ animationDelay: "0s" }}>
          <div className="flex h-full flex-col items-center justify-center gap-3 p-5">
            <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-brand text-2xl text-white">📦</div>
            <p className="font-serif text-sm font-bold text-ink">{L("صفحة الموظفين", "Employee page")}</p>
            <div className="w-full rounded-xl border border-[#e4d6c5] px-3 py-2.5 text-center tracking-[0.4em] text-ink">••••</div>
            <div className="relative w-full">
              <div className="rounded-xl bg-brand py-2.5 text-center text-sm font-bold text-white">{L("دخول", "Sign in")}</div>
              <span className="gd-tap" style={{ insetInlineStart: "50%", top: "6px", marginInlineStart: "-17px" }} />
            </div>
          </div>
        </div>

        {/* Scene 2 — stock */}
        <div className="gd-scene" style={{ animationDelay: "4s" }}>
          <div className="flex h-full flex-col gap-2 p-3">
            <div className="rounded-lg bg-brand-light px-2 py-1 text-center text-[11px] font-bold text-brand-dark">📦 {L("المخزون", "Stock")}</div>
            <div className="rounded-lg border border-[#e4d6c5] px-2 py-2 text-[10px] text-muted">{L("امسح الباركود…", "Scan barcode…")} 📷</div>
            <div className="flex items-center gap-2 rounded-lg border border-[#efe3d6] p-2">
              <span className="flex h-8 w-8 items-center justify-center rounded-md bg-brand-light">🧴</span>
              <span className="text-[11px] font-medium text-ink">{L("سيروم جلو", "Glow serum")}</span>
            </div>
            <div className="relative grid grid-cols-2 gap-2">
              <div className="rounded-lg bg-emerald-600 py-2 text-center text-[11px] font-bold text-white">➕ {L("إدخال", "In")}</div>
              <div className="rounded-lg bg-amber-500/20 py-2 text-center text-[11px] font-bold text-amber-700">➖ {L("إخراج", "Out")}</div>
              <span className="gd-tap" style={{ insetInlineStart: "25%", top: "3px", marginInlineStart: "-17px" }} />
            </div>
            <div className="text-center text-sm font-bold text-ink">− &nbsp;3&nbsp; +</div>
            <div className="mt-auto rounded-lg bg-emerald-50 px-2 py-1.5 text-center text-[11px] font-bold text-emerald-700">✓ {L("أُدخل 3 · مخزون 15", "In 3 · stock 15")}</div>
          </div>
        </div>

        {/* Scene 3 — add product */}
        <div className="gd-scene" style={{ animationDelay: "8s" }}>
          <div className="flex h-full flex-col gap-2 p-3">
            <div className="rounded-lg bg-brand-light px-2 py-1 text-center text-[11px] font-bold text-brand-dark">➕ {L("منتج جديد", "Add product")}</div>
            <div className="rounded-xl border-2 border-dashed border-brand/40 bg-brand-light/40 py-4 text-center text-[10px] text-brand-dark">📸 {L("صوّر المنتج", "Photograph it")}</div>
            <div className="rounded-lg border border-[#efe3d6] px-2 py-1.5 text-[10px] text-muted">{L("الاسم — تولّد ✨", "Name — drafted ✨")}</div>
            <div className="rounded-lg border border-[#efe3d6] px-2 py-1.5 text-[10px] text-muted">{L("الوصف — تولّد ✨", "Description — drafted ✨")}</div>
            <div className="relative mt-auto">
              <div className="rounded-lg bg-brand py-2 text-center text-[11px] font-bold text-white">{L("أضِف", "Add")}</div>
              <span className="gd-tap" style={{ insetInlineStart: "50%", top: "3px", marginInlineStart: "-17px" }} />
            </div>
          </div>
        </div>

        {/* Scene 4 — tasks */}
        <div className="gd-scene" style={{ animationDelay: "12s" }}>
          <div className="flex h-full flex-col gap-2 p-3">
            <div className="rounded-lg bg-brand-light px-2 py-1 text-center text-[11px] font-bold text-brand-dark">📋 {L("المهام", "Tasks")}</div>
            <div className="relative overflow-hidden rounded-lg border border-red-200 bg-red-50 p-2 ps-3">
              <span className="absolute inset-y-0 start-0 w-1.5 bg-red-500" />
              <p className="text-[11px] font-bold text-ink">🔴 {L("رتّبي رف رود", "Tidy the Rhode shelf")}</p>
              <p className="text-[9px] text-red-600">⏰ {L("متأخّرة", "overdue")}</p>
            </div>
            <div className="relative grid grid-cols-2 gap-2">
              <div className="rounded-lg border border-amber-300 py-2 text-center text-[11px] font-bold text-amber-700">▶ {L("جاري", "Doing")}</div>
              <div className="rounded-lg bg-emerald-600 py-2 text-center text-[11px] font-bold text-white">✓ {L("تم", "Done")}</div>
              <span className="gd-tap" style={{ insetInlineStart: "75%", top: "3px", marginInlineStart: "-17px" }} />
            </div>
          </div>
        </div>

        {/* progress bar */}
        <div className="absolute inset-x-3 bottom-1.5 h-1 overflow-hidden rounded-full bg-[#efe3d6]">
          <div className="h-full rounded-full bg-brand" style={{ animation: "gdBar 16s infinite" }} />
        </div>
      </div>

      {/* caption */}
      <div className="relative h-5 w-full max-w-[260px] text-center">
        {captions.map((c, i) => (
          <span key={i} className="gd-cap absolute inset-0 text-xs font-semibold text-brand-dark" style={{ animationDelay: `${i * 4}s` }}>{c}</span>
        ))}
      </div>
    </div>
  );
}
