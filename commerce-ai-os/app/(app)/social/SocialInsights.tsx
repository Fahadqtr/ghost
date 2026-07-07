"use client";

import { useState, useTransition } from "react";
import { fetchSocialInsights, type SocialInsightsReport } from "./actions";
import { ratePct } from "@/lib/social/insights-compute";

// On-demand Instagram performance report: live reach/likes/saves per published
// post (read via the Graph API using the media ids we stored at publish time),
// sorted strongest-first with the winner crowned. Read-only — nothing changes.

const TILE: [label: string, key: "reach" | "views" | "likes" | "comments" | "saved" | "shares"][] = [
  ["👀 وصول", "reach"], ["▶️ مشاهدات", "views"], ["❤️ إعجابات", "likes"],
  ["💬 تعليقات", "comments"], ["🔖 حفظ", "saved"], ["📤 مشاركة", "shares"],
];

export default function SocialInsights({ configured }: { configured: boolean }) {
  const [report, setReport] = useState<SocialInsightsReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, start] = useTransition();

  const load = () => {
    setError(null);
    start(async () => {
      const r = await fetchSocialInsights();
      if (!r.ok) { setError(r.error ?? "فشل جلب التقرير."); return; }
      setReport(r);
    });
  };

  if (!configured) return null;

  return (
    <div className="card space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-ink">📊 أداء البوستات (إنستقرام)</h3>
          <p className="text-xs text-muted">إحصائيات حية من إنستقرام لآخر المنشورات — الأقوى أولًا.</p>
        </div>
        <button type="button" className="btn-ghost whitespace-nowrap text-sm disabled:opacity-50" onClick={load} disabled={busy}>
          {busy ? "…يجلب" : report ? "🔄 حدّث" : "📊 حمّل التقرير"}
        </button>
      </div>
      {error ? <p className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{error}</p> : null}

      {report?.ok && !report.posts.length ? (
        <p className="text-xs text-muted">ما فيه بوستات منشورة عبر النظام بعد — أول ما تنشر، الأرقام تظهر هنا.</p>
      ) : null}

      {report?.ok && report.posts.length ? (
        <>
          <div className="grid grid-cols-3 gap-2 text-center text-xs sm:grid-cols-6">
            {TILE.map(([label, key]) => (
              <div key={key} className="rounded-lg bg-[#faf6f0] p-2">
                <div className="text-base font-bold text-ink">{report.totals[key].toLocaleString("ar")}</div>
                <div className="text-muted">{label}</div>
              </div>
            ))}
          </div>
          <p className="text-[11px] text-muted">
            إجمالي آخر {report.posts.length} بوست · متوسط الوصول {report.avgReach.toLocaleString("ar")} لكل بوست
            {report.failed ? ` · تعذّر قراءة ${report.failed}` : ""}
          </p>

          <div className="max-h-96 space-y-2 overflow-y-auto">
            {report.posts.map((p) => (
              <div key={p.id} className={`flex items-center gap-3 rounded-xl border p-2 ${p.id === report.bestId ? "border-amber-300 bg-amber-50/60" : "border-[#efe3d6] bg-white/60"}`}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={p.image_url} alt="" className="h-14 w-14 shrink-0 rounded-lg border border-[#efe3d6] bg-white object-cover" />
                <div className="min-w-0 flex-1 text-xs">
                  <p className="truncate font-semibold text-ink">
                    {p.id === report.bestId ? "🏆 " : ""}{p.caption || "بدون عنوان"}
                  </p>
                  <p className="mt-0.5 text-muted">
                    👀 {p.stats.reach.toLocaleString("ar")} · ❤️ {p.stats.likes.toLocaleString("ar")} · 💬 {p.stats.comments.toLocaleString("ar")} · 🔖 {p.stats.saved.toLocaleString("ar")} · 📤 {p.stats.shares.toLocaleString("ar")} · تفاعل {ratePct(p.rate)}
                  </p>
                  <p className="mt-0.5 text-[10px] text-muted">
                    {p.posted_at ? new Date(p.posted_at).toLocaleDateString("ar") : ""}
                    {p.permalink ? (
                      <>
                        {" · "}
                        <a href={p.permalink} target="_blank" rel="noreferrer" className="underline">افتح البوست</a>
                      </>
                    ) : null}
                  </p>
                </div>
              </div>
            ))}
          </div>
          <p className="text-[11px] text-muted">💡 التاج 🏆 = أعلى تفاعل موزون (الحفظ والمشاركة تحسب أكثر من الإعجاب) — كرّر أسلوبه في التصاميم الجاية.</p>
        </>
      ) : null}
    </div>
  );
}
