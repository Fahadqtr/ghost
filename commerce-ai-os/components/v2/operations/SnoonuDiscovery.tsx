"use client";

// MEDIA.1B — Snoonu Media Discovery (PRESENTATIONAL + view filters). Renders the
// pre-composed discovery view: the product being searched, per-storefront session
// state, classification, match reason, and any candidates the provider supplied
// (preview only). It holds NO data client, issues NO queries, performs NO writes,
// and offers NO recovery/import action. When no authenticated session exists it
// shows a clear SESSION_REQUIRED state — never a fabricated result.

import { useMemo, useState } from "react";
import type { SnoonuDiscoveryView } from "@/lib/adapters/snoonu/merchant/discovery.server";
import type { DiscoveryClassification, DiscoveryResult } from "@/lib/adapters/snoonu/merchant/discovery-contract";
import { CLASSIFICATION_LABEL, REASON_LABEL } from "@/lib/adapters/snoonu/merchant/discovery-contract";

const CLASS_TONE: Record<DiscoveryClassification, string> = {
  SAFE_MATCH: "border-emerald-200 bg-emerald-50 text-emerald-700",
  NEEDS_REVIEW: "border-amber-200 bg-amber-50 text-amber-700",
  NO_MATCH: "border-slate-200 bg-slate-50 text-slate-600",
  SESSION_REQUIRED: "border-sky-200 bg-sky-50 text-sky-700",
  ERROR: "border-rose-200 bg-rose-50 text-rose-700",
};

const STOREFRONT_LABEL: Record<string, string> = {
  "snoonu:malikas": "Snoonu — Malikas",
  "snoonu:pure_seoul": "Snoonu — Pure Seoul",
};

type Filter = "all" | DiscoveryClassification | "malikas" | "pureseoul" | "barcode" | "sku";

const FILTERS: { key: Filter; label: string }[] = [
  { key: "all", label: "الكل" },
  { key: "SAFE_MATCH", label: "تطابق آمن" },
  { key: "NEEDS_REVIEW", label: "يحتاج مراجعة" },
  { key: "NO_MATCH", label: "لا تطابق" },
  { key: "malikas", label: "Malikas" },
  { key: "pureseoul", label: "Pure Seoul" },
  { key: "barcode", label: "باركود" },
  { key: "sku", label: "SKU" },
];

function matches(r: DiscoveryResult, f: Filter): boolean {
  switch (f) {
    case "all": return true;
    case "malikas": return r.storefrontKey === "snoonu:malikas";
    case "pureseoul": return r.storefrontKey === "snoonu:pure_seoul";
    case "barcode": return r.matchReason === "exact_barcode" || r.matchReason === "multiple_barcode";
    case "sku": return r.matchReason === "exact_sku" || r.matchReason === "multiple_sku";
    default: return r.classification === f;
  }
}

function ResultCard({ r }: { r: DiscoveryResult }) {
  return (
    <div className="card space-y-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-bold text-ink" dir="ltr">{STOREFRONT_LABEL[r.storefrontKey] ?? r.storefrontKey}</span>
        <span className={`rounded-lg border px-2 py-0.5 text-[11px] font-bold ${CLASS_TONE[r.classification]}`}>
          {CLASSIFICATION_LABEL[r.classification]}
        </span>
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-slate-500">
        <span>الجلسة: <b className="text-slate-700">{r.sessionState}</b></span>
        <span>السبب: <b className="text-slate-700">{REASON_LABEL[r.matchReason]}</b></span>
        <span>الثقة: <b className="text-slate-700">{r.confidence}</b></span>
        <span>عدد النتائج: <b className="text-slate-700">{r.candidateCount}</b></span>
      </div>

      {r.classification === "SESSION_REQUIRED" ? (
        <p className="rounded-lg bg-sky-50 px-3 py-2 text-xs text-sky-700">
          الاكتشاف المباشر من Snoonu غير متاح بعد — يتطلب جلسة تاجر مُهيّأة (MEDIA.1A-P). لا تُعرض نتائج ملفّقة.
        </p>
      ) : null}
      {r.error ? <p className="rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700">{r.error}</p> : null}

      {r.candidates.length > 0 ? (
        <div className="space-y-2">
          {r.candidates.map((c, i) => (
            <div key={c.spi ?? i} className="flex items-center gap-3 rounded-lg border border-[#efe3d6] bg-white/60 p-2">
              {c.imageUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={c.imageUrl} alt="" className="h-12 w-12 rounded object-cover" />
              ) : (
                <div className="flex h-12 w-12 items-center justify-center rounded bg-slate-100 text-[9px] text-slate-400">لا صورة</div>
              )}
              <div className="min-w-0 flex-1 text-xs">
                <div className="truncate font-semibold text-ink">{c.name ?? "—"}</div>
                <div className="flex flex-wrap gap-x-3 text-[11px] text-slate-500">
                  <span dir="ltr">SKU: {c.sku ?? "—"}</span>
                  <span dir="ltr">باركود: {c.barcode ?? "—"}</span>
                  <span dir="ltr">SPI: {c.spi ?? "—"}</span>
                  {c.imageWidth && c.imageHeight ? <span dir="ltr">{c.imageWidth}×{c.imageHeight}</span> : null}
                </div>
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export default function SnoonuDiscovery({ view }: { view: SnoonuDiscoveryView }) {
  const [filter, setFilter] = useState<Filter>("all");
  const filtered = useMemo(() => view.results.filter((r) => matches(r, filter)), [view.results, filter]);
  const allSessionRequired = view.results.length > 0 && view.results.every((r) => r.classification === "SESSION_REQUIRED");

  if (!view.found || !view.query) {
    return (
      <div className="card text-sm text-muted">
        اختر منتجًا للبحث عن وسائطه — افتح هذه الصفحة من «حملة الإطلاق» عبر منتج، أو مرّر <code dir="ltr">?productId=</code> أو <code dir="ltr">?sku=</code>.
      </div>
    );
  }

  const q = view.query;
  return (
    <div className="space-y-4">
      {/* Product being searched */}
      <section className="card flex items-center gap-3">
        {q.currentImageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={q.currentImageUrl} alt="" className="h-14 w-14 rounded object-cover" />
        ) : (
          <div className="flex h-14 w-14 items-center justify-center rounded bg-slate-100 text-[10px] text-slate-400">لا صورة</div>
        )}
        <div className="min-w-0 flex-1 text-sm">
          <div className="truncate font-bold text-ink">{q.name ?? "—"}</div>
          <div className="flex flex-wrap gap-x-4 text-xs text-slate-500">
            <span dir="ltr">SKU: {q.sku ?? "—"}</span>
            <span dir="ltr">باركود: {q.barcode ?? "—"}</span>
          </div>
        </div>
      </section>

      {allSessionRequired ? (
        <div className="card border-sky-200 bg-sky-50 text-sm text-sky-800" role="status">
          <b>الاكتشاف المباشر من Snoonu غير متاح.</b> لا توجد جلسة تاجر مُهيّأة — يتطلب MEDIA.1A-P. البحث بالباركود/‏SKU/الاسم سيعمل تلقائيًا فور توفير جلسة معتمدة.
        </div>
      ) : null}

      {/* Filters */}
      <div className="flex flex-wrap gap-2">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            type="button"
            onClick={() => setFilter(f.key)}
            className={`rounded-lg border px-3 py-1.5 text-xs font-semibold transition ${filter === f.key ? "border-brand bg-brand text-white" : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"}`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {/* Per-storefront results */}
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        {filtered.map((r) => <ResultCard key={r.storefrontKey} r={r} />)}
        {filtered.length === 0 ? <p className="text-xs text-muted">لا توجد نتائج مطابقة للمرشّح.</p> : null}
      </div>

      <p className="text-[11px] text-slate-400">اكتشاف فقط — لا يوجد استرجاع صور أو أي كتابة في هذه المرحلة.</p>
    </div>
  );
}
