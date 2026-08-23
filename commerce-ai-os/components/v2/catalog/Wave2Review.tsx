"use client";

// CATALOG.GOLIVE.3A — Wave 2 Bulk Review (client). PRESENTATION + EXPLICIT
// operator actions only. Category selects are seeded from the audited
// suggestions (defaults, not writes); availability requires an explicit
// choice; approval is offered only for category-resolved rows; activation
// only for READY rows. Every button calls a thin server action that
// delegates to an existing certified boundary and fails closed for
// non-writers.

/* eslint-disable @next/next/no-img-element */

import { useMemo, useState, useTransition } from "react";
import { CATEGORIES } from "@/lib/constants";
import {
  filterWave2Rows,
  WAVE2_FILTERS,
  type Wave2Filter,
  type Wave2Progress,
  type Wave2RowView,
} from "@/lib/catalog/wave2/wave2-plan";
import {
  activateWave2,
  applyWave2Availability,
  applyWave2Categories,
  approveWave2,
} from "@/app/(v2)/v2/catalog/launch/wave2/actions";

const FILTER_LABELS: Record<Wave2Filter, string> = {
  all: "الكل",
  safe_suggestion: "اقتراحات آمنة",
  needs_review: "تحتاج مراجعة",
  unknown_category: "فئة مجهولة",
  availability_unresolved: "توفّر غير محسوم",
  approval_unresolved: "اعتماد غير محسوم",
  ready_for_activation: "جاهزة للتفعيل",
};

const SEED_BADGE: Record<string, { label: string; cls: string }> = {
  safe: { label: "اقتراح آمن", cls: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  review: { label: "تحتاج مراجعة", cls: "bg-amber-50 text-amber-700 border-amber-200" },
  unknown: { label: "مجهولة", cls: "bg-rose-50 text-rose-700 border-rose-200" },
  none: { label: "—", cls: "bg-slate-50 text-slate-500 border-slate-200" },
};

type AvailabilityPick = "in_stock" | "out_of_stock" | "keep_unknown";

export default function Wave2Review({
  rows,
  progress,
}: {
  rows: Wave2RowView[];
  progress: Wave2Progress;
}) {
  const [filter, setFilter] = useState<Wave2Filter>("all");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // Operator-editable category choices, seeded from the audit defaults.
  const [categoryPick, setCategoryPick] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const r of rows) {
      if (!r.categoryResolved && r.seed.kind === "safe") init[r.id] = r.seed.category;
    }
    return init;
  });
  const [availabilityPick, setAvailabilityPick] = useState<AvailabilityPick>("keep_unknown");
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const visible = useMemo(() => filterWave2Rows(rows, filter), [rows, filter]);
  const visibleIds = useMemo(() => visible.map((r) => r.id), [visible]);
  const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((id) => selected.has(id));

  const toggleAllVisible = () => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allVisibleSelected) visibleIds.forEach((id) => next.delete(id));
      else visibleIds.forEach((id) => next.add(id));
      return next;
    });
  };
  const toggleOne = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const report = (label: string, ok: number, failed: number, extra?: string) =>
    setMessage(`${label}: نجح ${ok}${failed ? ` — فشل ${failed}` : ""}${extra ? ` — ${extra}` : ""}`);

  const runApplyCategories = () =>
    startTransition(async () => {
      setMessage(null);
      const items = visible
        .filter((r) => selected.has(r.id) && !r.categoryResolved && categoryPick[r.id])
        .map((r) => ({ productId: r.id, category: categoryPick[r.id] }));
      if (!items.length) return setMessage("لا توجد صفوف محددة بفئة مختارة.");
      const res = await applyWave2Categories(items);
      if (res.error) return setMessage(res.error);
      const ok = res.results.filter((r) => r.ok).length;
      report("تطبيق الفئات", ok, res.results.length - ok);
    });

  const runApplyAvailability = () =>
    startTransition(async () => {
      setMessage(null);
      if (availabilityPick === "keep_unknown") {
        return setMessage("«إبقاء غير محدد» لا ينفّذ أي كتابة — اختر متوفر أو غير متوفر أولًا.");
      }
      const ids = visible.filter((r) => selected.has(r.id)).map((r) => r.id);
      if (!ids.length) return setMessage("لا توجد صفوف محددة.");
      const res = await applyWave2Availability(ids, availabilityPick);
      if (!res.ok) return setMessage(res.error ?? "تعذّر تحديث التوفّر.");
      report("تحديث التوفّر", res.count, 0);
    });

  const runApprove = () =>
    startTransition(async () => {
      setMessage(null);
      const ids = visible.filter((r) => selected.has(r.id) && r.approveEligible).map((r) => r.id);
      if (!ids.length) return setMessage("لا توجد صفوف مؤهلة للاعتماد (الفئة أولًا).");
      const res = await approveWave2(ids);
      if (res.error) return setMessage(res.error);
      const ok = res.results.filter((r) => r.ok).length;
      report(
        "الاعتماد",
        ok,
        res.results.length - ok,
        res.skippedUnresolved.length ? `تم تخطي ${res.skippedUnresolved.length} بدون فئة` : undefined,
      );
    });

  const runActivate = () =>
    startTransition(async () => {
      setMessage(null);
      const ids = visible.filter((r) => selected.has(r.id) && r.activationEligible).map((r) => r.id);
      if (!ids.length) return setMessage("لا توجد صفوف جاهزة للتفعيل (READY فقط).");
      const res = await activateWave2(ids);
      if (res.error) return setMessage(res.error);
      const ok = res.results.filter((r) => r.ok).length;
      report("التفعيل", ok, res.results.length - ok);
    });

  return (
    <div className="space-y-3">
      {/* progress header */}
      <div className="flex flex-wrap gap-2 text-xs">
        <span className="rounded-full border border-slate-200 bg-white px-3 py-1 font-semibold text-slate-700">
          الفئات {progress.categories.done}/{progress.categories.total}
        </span>
        <span className="rounded-full border border-slate-200 bg-white px-3 py-1 font-semibold text-slate-700">
          التوفّر {progress.availability.done}/{progress.availability.total}
        </span>
        <span className="rounded-full border border-slate-200 bg-white px-3 py-1 font-semibold text-slate-700">
          الاعتماد {progress.approvals.done}/{progress.approvals.total}
        </span>
        <span className="rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 font-semibold text-emerald-700">
          جاهزة للتفعيل {progress.activationReady}/{progress.total}
        </span>
        <span className="rounded-full border border-violet-200 bg-violet-50 px-3 py-1 font-semibold text-violet-700">
          مفعّلة {progress.activated}/{progress.total}
        </span>
      </div>

      {/* filters + bulk actions */}
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={filter}
          onChange={(e) => setFilter(e.target.value as Wave2Filter)}
          className="rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-xs"
          aria-label="تصفية"
        >
          {WAVE2_FILTERS.map((f) => (
            <option key={f} value={f}>{FILTER_LABELS[f]}</option>
          ))}
        </select>
        <button type="button" onClick={toggleAllVisible} className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50">
          {allVisibleSelected ? "إلغاء تحديد المعروض" : "تحديد كل المعروض"}
        </button>
        <span className="text-xs text-muted">محدد: {selected.size}</span>
        <div className="ms-auto flex flex-wrap items-center gap-2">
          <button type="button" disabled={pending} onClick={runApplyCategories} className="rounded-lg bg-brand px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50">
            تطبيق الفئات المحددة
          </button>
          <select
            value={availabilityPick}
            onChange={(e) => setAvailabilityPick(e.target.value as AvailabilityPick)}
            className="rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-xs"
            aria-label="اختيار التوفّر"
          >
            <option value="keep_unknown">إبقاء غير محدد</option>
            <option value="in_stock">متوفر</option>
            <option value="out_of_stock">غير متوفر</option>
          </select>
          <button type="button" disabled={pending || availabilityPick === "keep_unknown"} onClick={runApplyAvailability} className="rounded-lg bg-slate-800 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50">
            تطبيق التوفّر
          </button>
          <button type="button" disabled={pending} onClick={runApprove} className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50">
            اعتماد المؤهل
          </button>
          <button type="button" disabled={pending} onClick={runActivate} className="rounded-lg bg-violet-600 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50">
            تفعيل الجاهز
          </button>
        </div>
      </div>

      {message && (
        <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-700" role="status">
          {message}
        </div>
      )}

      {/* rows */}
      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-slate-100 text-start text-[11px] text-muted">
              <th className="p-2"><input type="checkbox" checked={allVisibleSelected} onChange={toggleAllVisible} aria-label="تحديد الكل" /></th>
              <th className="p-2 text-start">SKU</th>
              <th className="p-2 text-start">المنتج</th>
              <th className="p-2 text-start">الفئة</th>
              <th className="p-2 text-start">التوفّر</th>
              <th className="p-2 text-start">الاعتماد</th>
              <th className="p-2 text-start">الحالة</th>
              <th className="p-2 text-start">الجاهزية</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((r) => {
              const badge = SEED_BADGE[r.seed.kind] ?? SEED_BADGE.none;
              return (
                <tr key={r.id} className="border-b border-slate-50 align-top">
                  <td className="p-2">
                    <input type="checkbox" checked={selected.has(r.id)} onChange={() => toggleOne(r.id)} aria-label={`تحديد ${r.sku}`} />
                  </td>
                  <td className="p-2 font-mono" dir="ltr">{r.sku}</td>
                  <td className="p-2">
                    <div className="flex items-center gap-2">
                      {r.imageUrl ? (
                        <img src={r.imageUrl} alt="" className="h-9 w-9 rounded-lg border border-slate-100 object-cover" loading="lazy" />
                      ) : (
                        <span className="flex h-9 w-9 items-center justify-center rounded-lg border border-slate-100 text-slate-300">—</span>
                      )}
                      <div className="min-w-0">
                        <div className="truncate font-semibold text-slate-800" style={{ maxWidth: "18rem" }}>{r.nameAr ?? r.nameEn ?? "—"}</div>
                        <div className="truncate text-[11px] text-muted" style={{ maxWidth: "18rem" }} dir="ltr">{r.nameEn ?? ""}</div>
                      </div>
                    </div>
                  </td>
                  <td className="p-2">
                    {r.categoryResolved ? (
                      <span className="rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[11px] text-slate-700">{r.category}</span>
                    ) : (
                      <div className="space-y-1">
                        <span className={`inline-block rounded-full border px-2 py-0.5 text-[10px] font-semibold ${badge.cls}`}>{badge.label}</span>
                        <select
                          value={categoryPick[r.id] ?? ""}
                          onChange={(e) => setCategoryPick((prev) => ({ ...prev, [r.id]: e.target.value }))}
                          className="block w-40 rounded-lg border border-slate-200 bg-white px-1.5 py-1 text-[11px]"
                          aria-label={`فئة ${r.sku}`}
                        >
                          <option value="">— اختر فئة —</option>
                          {CATEGORIES.map((c) => (
                            <option key={c} value={c}>{c}</option>
                          ))}
                        </select>
                      </div>
                    )}
                  </td>
                  <td className="p-2">
                    {r.availabilityResolved ? (
                      <span className="text-slate-700">{r.availability}</span>
                    ) : (
                      <span className="rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[10px] font-semibold text-amber-700">غير محدد</span>
                    )}
                  </td>
                  <td className="p-2">
                    {r.approvalResolved ? (
                      <span className="text-emerald-700">معتمد</span>
                    ) : (
                      <span className="text-muted">{r.approveEligible ? "مؤهل" : "بانتظار الفئة"}</span>
                    )}
                  </td>
                  <td className="p-2" dir="ltr">{r.lifecycle ?? "—"}</td>
                  <td className="p-2">
                    {r.activated ? (
                      <span className="text-violet-700">مفعّل</span>
                    ) : r.activationEligible ? (
                      <span className="text-emerald-700">جاهز للتفعيل</span>
                    ) : (
                      <span className="text-muted">{r.readinessStatus}</span>
                    )}
                  </td>
                </tr>
              );
            })}
            {!visible.length && (
              <tr>
                <td colSpan={8} className="p-6 text-center text-muted">لا توجد صفوف مطابقة للتصفية.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
