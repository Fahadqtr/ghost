"use client";

// MEDIA.2 — Bulk Snoonu Image Recovery (client orchestration only).
//
// Operates ONLY on the missing-image scan the live pipeline produced; every
// selected product independently runs the certified MEDIA.1C flow through ONE
// server action per product (recoverOneSnoonuImageAction), so:
//   • one failure never aborts the batch;
//   • cancel takes effect after the current product — never mid-recovery;
//   • the SPI seen in the preview is pinned per item (stale protection);
//   • NEEDS_REVIEW rows are structurally excluded from bulk — they live in the
//     review queue and recover only on an explicit per-product approval.
// This component holds no DB client, performs no fetch of its own, and
// duplicates no matching/eligibility/write logic (all pure helpers come from
// lib/adapters/snoonu/merchant/bulk-recovery).

import { useMemo, useRef, useState, useTransition } from "react";
import Link from "next/link";
import {
  scanSnoonuImageRecoveryAction,
  recoverOneSnoonuImageAction,
} from "@/app/(v2)/v2/operations/media-actions";
import {
  BULK_REPORT_LABEL,
  buildBulkCsv,
  buildProgressLine,
  buildScanSummaryLine,
  estimateRemainingMs,
  filterRecoveryRows,
  formatDurationAr,
  reviewQueueRows,
  safeRecoveryRows,
  summarizeBulk,
  type BulkItemResult,
  type RecoveryViewFilter,
} from "@/lib/adapters/snoonu/merchant/bulk-recovery";
import { RECOVERY_STATUS_LABEL } from "@/lib/adapters/snoonu/merchant/recovery-model";
import type { ImagePreviewRow } from "@/lib/adapters/snoonu/merchant/merchant-contract";
import type { MissingImageScanResult } from "@/lib/adapters/snoonu/merchant/missing-image-scan";

const SNOONU_STOREFRONTS = [
  { key: "snoonu:malikas", label: "Snoonu — Malikas" },
  { key: "snoonu:pure_seoul", label: "Snoonu — Pure Seoul" },
];

type Progress = { done: number; total: number; currentSku: string | null; remainingMs: number | null };
type Msg = { ok: boolean; text: string } | null;

const FILTER_LABEL: Record<RecoveryViewFilter, string> = {
  ALL: "الكل",
  SAFE_MATCH: "SAFE_MATCH",
  NEEDS_REVIEW: "NEEDS_REVIEW",
  NOT_FOUND: "غير موجود",
  SESSION_REQUIRED: "بحاجة جلسة",
};

const REPORT_TONE: Record<string, string> = {
  recovered: "border-emerald-200 bg-emerald-50 text-emerald-700",
  alreadyHadImage: "border-slate-200 bg-slate-50 text-slate-600",
  skipped: "border-slate-200 bg-slate-50 text-slate-600",
  needsReview: "border-amber-200 bg-amber-50 text-amber-700",
  sessionExpired: "border-rose-200 bg-rose-50 text-rose-700",
  failed: "border-rose-200 bg-rose-50 text-rose-700",
};

export default function SnoonuBulkRecovery({
  canWrite,
  initialStorefront,
}: {
  canWrite: boolean;
  // OPS.4 deep-link seed (validated server-side by the scan action).
  initialStorefront?: string;
}) {
  const [storefront, setStorefront] = useState<string>(initialStorefront ?? "snoonu:malikas");
  const [scan, setScan] = useState<MissingImageScanResult | null>(null);
  const [tab, setTab] = useState<"safe" | "review">("safe");
  const [viewFilter, setViewFilter] = useState<RecoveryViewFilter>("ALL");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [progress, setProgress] = useState<Progress | null>(null);
  const [results, setResults] = useState<BulkItemResult[] | null>(null);
  const [reviewMarks, setReviewMarks] = useState<Record<string, string>>({});
  const [busyReviewId, setBusyReviewId] = useState<string | null>(null);
  const [msg, setMsg] = useState<Msg>(null);
  const [isScanning, startScan] = useTransition();
  // Cancel flag: checked at the TOP of the loop, so cancellation always waits
  // for the in-flight product to finish — a recovery is never interrupted.
  const cancelRef = useRef(false);
  const runningRef = useRef(false);

  const safeRows = useMemo(() => (scan ? safeRecoveryRows(scan.rows) : []), [scan]);
  const reviewRows = useMemo(() => (scan ? reviewQueueRows(scan.rows) : []), [scan]);
  const selectedRows = useMemo(() => safeRows.filter((r) => selected.has(r.productId)), [safeRows, selected]);
  const visibleRows = useMemo(() => {
    if (!scan) return [];
    const filtered = filterRecoveryRows(scan.rows, viewFilter);
    return tab === "safe" ? filtered.filter((r) => r.matchStatus !== "NEEDS_REVIEW") : filtered;
  }, [scan, viewFilter, tab]);
  const visibleSafeRows = useMemo(() => safeRecoveryRows(visibleRows), [visibleRows]);
  const allSafeSelected = safeRows.length > 0 && safeRows.every((r) => selected.has(r.productId));
  const running = progress !== null;
  const busy = running || isScanning || busyReviewId !== null;
  const report = useMemo(() => (results && !running ? summarizeBulk(results) : null), [results, running]);

  function runScan() {
    if (busy) return;
    setScan(null); setSelected(new Set()); setResults(null); setReviewMarks({}); setMsg(null); setTab("safe"); setViewFilter("ALL");
    startScan(async () => {
      const res = await scanSnoonuImageRecoveryAction(storefront);
      if ("error" in res) { setMsg({ ok: false, text: res.error }); return; }
      setScan(res);
      setSelected(new Set(safeRecoveryRows(res.rows).map((r) => r.productId)));
      if (res.summary.sessionRequired > 0 && res.summary.matched === 0) {
        setMsg({ ok: true, text: "لا توجد جلسة تاجر سنونو مفعّلة — لا مرشّحات استرجاع حتمية الآن (آمن)." });
      }
    });
  }

  function toggle(id: string) {
    setSelected((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  }

  // One product through the certified MEDIA.1C flow. The previewed SPI is
  // always pinned so a changed portal result surfaces as STALE, never a wrong write.
  async function recoverOne(row: ImagePreviewRow): Promise<BulkItemResult> {
    try {
      const res = await recoverOneSnoonuImageAction(storefront, row.productId, row.spi ?? undefined);
      if ("error" in res) return { productId: row.productId, sku: row.sku, status: "FAILED", reason: res.error };
      return { productId: row.productId, sku: row.sku, status: res.outcome.status, reason: res.outcome.reason, url: res.outcome.url };
    } catch {
      return { productId: row.productId, sku: row.sku, status: "FAILED", reason: "تعذّر الاتصال — فشل هذا المنتج فقط." };
    }
  }

  // Sequential per-product loop: live progress, partial results, cancel after
  // the current product. A failed item is recorded and the loop continues.
  async function runBulk(rows: ImagePreviewRow[]) {
    if (!canWrite || rows.length === 0 || runningRef.current || busy) return;
    runningRef.current = true;
    cancelRef.current = false;
    setMsg(null);
    setResults(null);
    const acc: BulkItemResult[] = [];
    const startedAt = Date.now();
    setProgress({ done: 0, total: rows.length, currentSku: rows[0]?.sku ?? null, remainingMs: null });
    for (const row of rows) {
      if (cancelRef.current) break; // cancel lands here — after the previous product completed
      setProgress({
        done: acc.length,
        total: rows.length,
        currentSku: row.sku,
        remainingMs: estimateRemainingMs(Date.now() - startedAt, acc.length, rows.length),
      });
      acc.push(await recoverOne(row));
      setResults([...acc]);
    }
    const cancelled = cancelRef.current && acc.length < rows.length;
    runningRef.current = false;
    setProgress(null);
    setResults(acc);
    setMsg({
      ok: true,
      text: cancelled
        ? `أُلغيت العملية بعد إكمال ${acc.length} من ${rows.length} — لم يُقطع أي منتج في المنتصف.`
        : `اكتملت العملية على ${acc.length} منتج. حدّث الفحص لرؤية الوضع الجديد.`,
    });
  }

  // Review queue: explicit per-product approval only (confirmedSpi = the
  // previewed candidate). Skipping is local — nothing is written.
  async function approveReview(row: ImagePreviewRow) {
    if (!canWrite || !row.spi || busy) return;
    setBusyReviewId(row.productId);
    const item = await recoverOne(row);
    setReviewMarks((p) => ({ ...p, [row.productId]: `${RECOVERY_STATUS_LABEL[item.status]} — ${item.reason}` }));
    setBusyReviewId(null);
  }

  function skipReview(row: ImagePreviewRow) {
    setReviewMarks((p) => ({ ...p, [row.productId]: "تم التخطي — لم يُكتب شيء." }));
  }

  function downloadCsv() {
    if (!results || results.length === 0) return;
    // UTF-8 BOM so Arabic opens correctly in Excel.
    const blob = new Blob(["\uFEFF" + buildBulkCsv(results)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `snoonu-recovery-${storefront.replace(":", "-")}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <section className="card space-y-2">
      <h2 className="text-sm font-bold text-slate-700">استرجاع الصور من سنونو</h2>

      {/* controls + top summary */}
      <div className="flex flex-wrap items-center gap-2">
        <select value={storefront} onChange={(e) => setStorefront(e.target.value)} disabled={busy} className="rounded-lg border border-slate-200 px-2 py-1 text-xs">
          {SNOONU_STOREFRONTS.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
        </select>
        <button type="button" onClick={runScan} disabled={busy} className="rounded-lg bg-slate-800 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50">
          {isScanning ? "…" : scan ? "تحديث الفحص" : "فحص (معاينة)"}
        </button>
        {scan && <span className="text-xs font-semibold text-slate-600">{buildScanSummaryLine(scan.summary)}</span>}
      </div>

      {msg && (
        <div className={`rounded-lg border px-3 py-2 text-xs ${msg.ok ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-rose-200 bg-rose-50 text-rose-700"}`} role={msg.ok ? "status" : "alert"}>
          {msg.text}
        </div>
      )}

      {/* primary actions + tabs */}
      {scan && (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-1.5" aria-label="مرشحات نتائج الاسترجاع">
            {(Object.keys(FILTER_LABEL) as RecoveryViewFilter[]).map((filter) => {
              const count = filterRecoveryRows(scan.rows, filter).length;
              return (
                <button key={filter} type="button" onClick={() => { setViewFilter(filter); setTab(filter === "NEEDS_REVIEW" ? "review" : "safe"); }} disabled={busy}
                  className={`rounded-full border px-2.5 py-1 text-[11px] font-semibold disabled:opacity-50 ${viewFilter === filter ? "border-slate-800 bg-slate-800 text-white" : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"}`}>
                  {FILTER_LABEL[filter]} ({count})
                </button>
              );
            })}
          </div>
          <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => runBulk(safeRows)}
            disabled={!canWrite || busy || safeRows.length === 0}
            title={canWrite ? undefined : "للقراءة فقط"}
            className="rounded-lg bg-emerald-700 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
          >
            {canWrite ? `استرجاع الآمن (${safeRows.length})` : "🔒 استرجاع الآمن"}
          </button>
          <button
            type="button"
            onClick={() => setTab(tab === "review" ? "safe" : "review")}
            disabled={busy}
            className={`rounded-lg border px-3 py-1.5 text-xs font-semibold disabled:opacity-50 ${tab === "review" ? "border-amber-400 bg-amber-50 text-amber-700" : "border-slate-300 text-slate-700"}`}
          >
            قائمة المراجعة ({reviewRows.length})
          </button>
          </div>
        </div>
      )}

      {/* live progress + cancel-after-current */}
      {progress && (
        <div className="space-y-1 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
          <div className="flex flex-wrap items-center gap-2 text-xs text-slate-700">
            <span className="font-semibold">{buildProgressLine(progress.done, progress.total, progress.currentSku)}</span>
            {progress.remainingMs !== null && <span className="text-muted">المتبقي تقريبًا: {formatDurationAr(progress.remainingMs)}</span>}
            <button
              type="button"
              onClick={() => { cancelRef.current = true; }}
              className="ms-auto rounded-lg border border-rose-300 px-2 py-1 text-xs font-semibold text-rose-700 hover:bg-rose-50"
            >
              إلغاء
            </button>
          </div>
          <div className="h-1.5 overflow-hidden rounded bg-slate-200">
            <div className="h-full bg-emerald-600 transition-all" style={{ width: `${progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0}%` }} />
          </div>
          <p className="text-[10px] text-muted">الإلغاء يوقف الدفعة بعد إكمال المنتج الحالي — لا يُقطع أي استرجاع في المنتصف.</p>
        </div>
      )}

      {/* final report + CSV export */}
      {report && (
        <div className="space-y-2 rounded-lg border border-slate-200 bg-white px-3 py-2">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-xs font-bold text-slate-700">التقرير النهائي ({report.total}):</span>
            {(Object.keys(BULK_REPORT_LABEL) as (keyof typeof BULK_REPORT_LABEL)[]).map((k) =>
              report[k] > 0 ? (
                <span key={k} className={`rounded-full border px-2 py-0.5 text-[11px] font-semibold ${REPORT_TONE[k]}`}>
                  {BULK_REPORT_LABEL[k]}: {report[k]}
                </span>
              ) : null,
            )}
            <button type="button" onClick={downloadCsv} className="ms-auto rounded-lg border border-slate-300 px-2 py-1 text-[11px] font-semibold text-slate-700 hover:bg-slate-50">
              تنزيل CSV
            </button>
          </div>
          {results && results.some((r) => r.status !== "RECOVERED") && (
            <ul className="max-h-40 space-y-0.5 overflow-y-auto text-[11px] text-muted">
              {results.filter((r) => r.status !== "RECOVERED").map((r) => (
                <li key={r.productId}><span className="font-medium text-slate-600">{r.sku ?? r.productId}</span> · {RECOVERY_STATUS_LABEL[r.status]} — {r.reason}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* SAFE tab: selection + Recover Selected */}
      {scan && tab === "safe" && (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
            <span className="text-xs text-muted">محدد {selectedRows.length} / {safeRows.length} آمن</span>
            <button type="button" disabled={busy || visibleSafeRows.length === 0} onClick={() => setSelected((prev) => new Set([...prev, ...visibleSafeRows.map((r) => r.productId)]))} className="rounded-lg border border-slate-200 px-2 py-1 text-xs hover:bg-white disabled:opacity-50">
              تحديد الكل
            </button>
            <button type="button" disabled={busy} onClick={() => setSelected(allSafeSelected ? new Set() : new Set(safeRows.map((r) => r.productId)))} className="rounded-lg border border-emerald-200 px-2 py-1 text-xs font-semibold text-emerald-700 hover:bg-emerald-50 disabled:opacity-50">
              تحديد SAFE_MATCH
            </button>
            <button
              type="button"
              onClick={() => runBulk(selectedRows)}
              disabled={!canWrite || busy || selectedRows.length === 0}
              title={canWrite ? undefined : "للقراءة فقط"}
              className="rounded-lg bg-slate-800 px-3 py-1 text-xs font-semibold text-white disabled:opacity-50"
            >
              {canWrite ? `اعتماد المحدد (${selectedRows.length})` : "🔒 اعتماد المحدد"}
            </button>
          </div>
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {visibleRows.slice(0, 300).map((r) => {
              const eligible = r.matchStatus === "MATCHED" && r.selectable && Boolean(r.spi && r.merchantImageUrl);
              const badge = eligible ? "SAFE_MATCH" : r.matchStatus === "NOT_FOUND" ? "غير موجود" : "بحاجة جلسة";
              return (
              <label key={r.productId} className={`rounded-xl border bg-white p-3 text-xs transition ${selected.has(r.productId) ? "border-emerald-400 ring-1 ring-emerald-200" : "border-slate-200 hover:border-slate-300"}`}>
                <div className="flex items-start gap-2">
                  {eligible ? <input type="checkbox" className="mt-1" disabled={!canWrite || busy} checked={selected.has(r.productId)} onChange={() => toggle(r.productId)} /> : <span className="mt-1 h-3.5 w-3.5 rounded border border-slate-200 bg-slate-100" aria-hidden="true" />}
                  {r.merchantImageUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={r.merchantImageUrl} alt="" className="h-16 w-16 rounded-lg border border-slate-100 object-cover" loading="lazy" />
                  ) : <span className="h-16 w-16 rounded-lg bg-slate-100 text-center text-[9px] leading-[4rem] text-slate-400">لا صورة</span>}
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-bold text-slate-700">{r.sku ?? r.productId}</div>
                    <div className={`mt-1 inline-flex rounded-full px-2 py-0.5 text-[10px] font-bold ${eligible ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-600"}`}>{badge}</div>
                    {r.spi && <div className="mt-1 text-[10px] text-muted">SPI {r.spi}</div>}
                  </div>
                </div>
                <p className="mt-2 line-clamp-2 text-[11px] text-muted" title={r.reason}>{r.reason}</p>
              </label>
              );
            })}
          </div>
          {visibleRows.length === 0 && <p className="rounded-lg border border-dashed border-slate-200 px-3 py-4 text-center text-xs text-muted">لا توجد نتائج ضمن المرشح الحالي.</p>}
        </div>
      )}

      {/* REVIEW tab: preview + explicit per-product approve / skip */}
      {scan && tab === "review" && (
        reviewRows.length === 0 ? (
          <p className="text-xs text-muted">قائمة المراجعة فارغة.</p>
        ) : (
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
            <p className="text-[11px] text-muted sm:col-span-2 xl:col-span-3">هذه المطابقات غير مؤكدة — لا تُسترجع ضمن الدفعة أبدًا. الاعتماد يسترجع المرشّح المعروض فقط بعد إعادة التحقق (جلسة + منتج + نتيجة حديثة).</p>
            {reviewRows.slice(0, 300).map((r) => {
              const mark = reviewMarks[r.productId];
              return (
                <div key={r.productId} className="rounded-xl border border-amber-200 bg-amber-50/40 p-3 text-xs">
                  <div className="flex items-start gap-2">
                  {r.merchantImageUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={r.merchantImageUrl} alt="" className="h-10 w-10 rounded object-cover" loading="lazy" />
                  ) : (
                    <span className="inline-block h-10 w-10 rounded bg-slate-100 text-center text-[9px] leading-10 text-slate-400">لا صورة</span>
                  )}
                  <div className="min-w-0">
                    <div className="font-medium text-slate-700">{r.sku ?? r.productId}{r.spi && <span className="ms-1 text-muted">SPI {r.spi}</span>}</div>
                    <div className="truncate text-[11px] text-muted" title={r.reason}>{r.reason}</div>
                  </div>
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    {mark ? (
                      <span className="text-[11px] font-semibold text-slate-600">{mark}</span>
                    ) : (
                      <>
                        <button
                          type="button"
                          onClick={() => approveReview(r)}
                          disabled={!canWrite || busy || !r.spi || !r.merchantImageUrl}
                          title={canWrite ? undefined : "للقراءة فقط"}
                          className="rounded-lg bg-amber-600 px-2 py-1 text-[11px] font-semibold text-white disabled:opacity-50"
                        >
                          {busyReviewId === r.productId ? "…" : "اعتماد واسترجاع هذه الصورة"}
                        </button>
                        <button type="button" onClick={() => skipReview(r)} disabled={busy} className="rounded-lg border border-slate-300 px-2 py-1 text-[11px] font-semibold text-slate-600 disabled:opacity-50">
                          تخطي
                        </button>
                      </>
                    )}
                    <Link href={`/v2/operations/media/discovery?productId=${r.productId}`} className="ms-auto text-[11px] text-brand hover:underline">
                      كل المرشّحات ↗
                    </Link>
                  </div>
                </div>
              );
            })}
          </div>
        )
      )}
    </section>
  );
}
