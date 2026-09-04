"use client";

// INT.2B.2 — Talabat package generation controls (client).
//
// Shows the operator-facing PRE-generation preview (§11) computed server-side
// from the certified INT.2B preview, then generates the "Ready" package via the
// writer-gated API route and surfaces the POST-generation summary (§17). It
// holds only view state; it never re-derives a rule and never publishes. The
// "Generate Ready Package" mode packages every NOT-blocked sellable row; blocked
// rows can never be included.

import { useEffect, useRef, useState } from "react";
import type { ExportReasonCode } from "@/lib/export/validation";
import {
  driveTalabatPackageJob,
  talabatJobDownloadUrl,
  formatDuration,
  formatClock,
  formatBytes,
  estimateRemainingMs,
  jobErrorMessage,
  type TalabatJobStatus,
} from "@/lib/export/talabat/package-job-client";
import { TALABAT_JOB_STAGE_AR } from "@/lib/export/talabat/package-job-errors";

export interface TalabatPlanVM {
  products: number;
  sellableRows: number;
  simpleProducts: number;
  variantRows: number;
  ready: number;
  warnings: number;
  blocked: number;
  rowsIncluded: number;
  imagesExpected: number;
  imagesSharedFromProduct: number;
  blockersByReason: Partial<Record<ExportReasonCode, number>>;
}


const REASON_LABEL: Record<string, string> = {
  MISSING_SKU: "SKU مفقود",
  DUPLICATE_SKU: "SKU مكرّر",
  MISSING_BARCODE: "باركود مفقود",
  DUPLICATE_BARCODE: "باركود مكرّر",
  INVALID_BARCODE: "صيغة باركود غير قياسية",
  MISSING_IMAGE: "صورة مفقودة",
  IMAGE_SHARED_FROM_PRODUCT: "الصورة مشتركة من المنتج",
  MISSING_TITLE: "عنوان مفقود",
  MISSING_PRICE: "سعر مفقود",
  MISSING_CATEGORY: "فئة مفقودة",
  LIFECYCLE_NOT_ELIGIBLE: "غير مؤهّل (دورة الحياة)",
  IDENTITY_MISSING: "هوية مفقودة",
  IDENTITY_CONFLICT: "تعارض في الهوية",
  VARIANT_NOT_READY: "متغيّر غير جاهز",
  UNSUPPORTED: "غير مدعوم",
};

export default function TalabatPackageControls({ plan }: { plan: TalabatPlanVM }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorStage, setErrorStage] = useState<string | null>(null);
  /** STEP 76 — the failure is a finalization stall, not a lost package. */
  const [resumable, setResumable] = useState(false);
  const [job, setJob] = useState<TalabatJobStatus | null>(null);
  const [result, setResult] = useState<TalabatJobStatus | null>(null);
  /** epoch ms when THIS generation began — state, not a ref, so the elapsed
   *  clock can be derived during render without reading a ref. */
  const [startedAtMs, setStartedAtMs] = useState<number | null>(null);
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  const stoppedRef = useRef(false);

  const blockerEntries = Object.entries(plan.blockersByReason).filter(([, n]) => (n ?? 0) > 0);

  // Advance the elapsed clock once a second while a generation is in flight.
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(t);
  }, [busy]);

  // Stop driving if the component unmounts mid-generation. The job itself is
  // durable and resumable — a later click RESUMES it rather than restarting.
  useEffect(() => () => { stoppedRef.current = true; }, []);

  async function generate() {
    // Guard 1 of 2 against a double-click creating two jobs; the server's
    // idempotent start is the authoritative guard.
    if (busy) return;
    setBusy(true);
    setError(null);
    setErrorStage(null);
    setResumable(false);
    setResult(null);
    stoppedRef.current = false;
    setStartedAtMs(Date.now());
    setNowMs(Date.now());

    // Track the latest status locally: the `job` state setter is async, so the
    // failure branch must not read a stale render value for the stage.
    let last: TalabatJobStatus | null = null;
    const res = await driveTalabatPackageJob({
      mode: "ready",
      onProgress: (s) => { last = s; setJob(s); },
      shouldStop: () => stoppedRef.current,
    });
    if (!res.ok) {
      setError(jobErrorMessage(res.code));
      const lastStatus = last as TalabatJobStatus | null;
      const stage = lastStatus?.stage;
      setErrorStage(stage ? (TALABAT_JOB_STAGE_AR[stage] ?? stage) : null);
      // STEP 76 — when the images are already packaged and the archive is
      // durable, the retry CONTINUES the same job; it never restarts download.
      setResumable(lastStatus?.resumable === true || res.code === "upload_incomplete");
    } else if (res.value.status === "completed") {
      setResult(res.value);
    }
    setBusy(false);
  }

  const elapsedMs = startedAtMs === null ? 0 : Math.max(0, nowMs - startedAtMs);
  const etaMs = job === null ? null : estimateRemainingMs({
    elapsedMs, current: job.progressCurrent, total: job.progressTotal,
  });

  return (
    <section className="card space-y-4">
      <div className="space-y-1">
        <h2 className="text-sm font-semibold text-ink">توليد حزمة طلبات</h2>
        <p className="text-[11px] text-muted">
          يتم إنشاء ملف <span dir="ltr">talabat-products.xlsx</span> مع مجلد الصور <span dir="ltr">images/</span> باسم
          الـ SKU لكل صف قابل للبيع (المنتج البسيط صف واحد، وكل متغيّر صف مستقل). الصفوف المحظورة لا تُصدَّر أبداً.
        </p>
      </div>

      {/* Pre-generation preview (§11) */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <PlanCard value={plan.ready} label="جاهز" tone="emerald" />
        <PlanCard value={plan.warnings} label="تحذير" tone="amber" />
        <PlanCard value={plan.blocked} label="محظور (مُستبعَد)" tone="rose" />
        <PlanCard value={plan.rowsIncluded} label="صفوف ستُضمَّن" tone="ink" />
      </div>
      <div className="grid grid-cols-2 gap-2 text-[11px] text-muted sm:grid-cols-4">
        <Stat label="منتجات" value={plan.products} />
        <Stat label="صفوف قابلة للبيع" value={plan.sellableRows} />
        <Stat label="منتجات بسيطة" value={plan.simpleProducts} />
        <Stat label="صفوف متغيّرات" value={plan.variantRows} />
        <Stat label="صور متوقّعة" value={plan.imagesExpected} />
        <Stat label="صور مشتركة من المنتج" value={plan.imagesSharedFromProduct} />
      </div>

      {plan.imagesSharedFromProduct > 0 ? (
        <div className="rounded-lg border border-sky-200 bg-sky-50 px-3 py-2 text-[11px] text-sky-800" dir="rtl">
          {plan.imagesSharedFromProduct} صف يستخدم صورة المنتج المشتركة (لا يوجد نموذج صور خاص بالمتغيّرات بعد) —
          هذا للعلم فقط ولا يمنع التصدير. الصور الخاصة بكل متغيّر ستُضاف في مشروع «صور المتغيّرات» لاحقاً.
        </div>
      ) : null}

      {blockerEntries.length > 0 ? (
        <div className="space-y-1">
          <div className="text-[11px] font-semibold text-ink">أسباب الحظر (مُستبعَدة من الحزمة)</div>
          <div className="flex flex-wrap gap-1.5">
            {blockerEntries.map(([code, n]) => (
              <span key={code} className="rounded-full border border-rose-200 bg-rose-50 px-2 py-0.5 text-[11px] text-rose-700">
                {REASON_LABEL[code] ?? code} · {n}
              </span>
            ))}
          </div>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={generate}
          disabled={busy || plan.rowsIncluded === 0}
          className="btn-primary disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? "جارٍ التوليد…" : "توليد حزمة الجاهزة"}
        </button>
        <button type="button" disabled className="btn-ghost cursor-not-allowed opacity-50" title="غير متاح في هذه المرحلة">
          نشر إلى طلبات (غير متاح)
        </button>
        {plan.rowsIncluded === 0 ? (
          <span className="text-[11px] text-muted">لا توجد صفوف جاهزة للتصدير حالياً.</span>
        ) : null}
      </div>

      {/* RUNNING — stage, progress bar, counts, elapsed and an approximate ETA. */}
      {busy && job ? (
        <div className="space-y-2 rounded-lg border border-slate-200 bg-slate-50 p-3">
          <div className="flex items-center justify-between text-xs font-semibold text-ink">
            <span>جاري توليد الحزمة…</span>
            <span dir="ltr">{job.progressPercent}%</span>
          </div>
          <div
            className="h-2 w-full overflow-hidden rounded-full bg-slate-200"
            role="progressbar"
            aria-valuenow={job.progressPercent}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div className="h-full rounded-full bg-brand transition-all" style={{ width: `${job.progressPercent}%` }} />
          </div>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[11px] text-muted sm:grid-cols-3">
            <ResultRow label="المرحلة" value={TALABAT_JOB_STAGE_AR[job.stage] ?? job.stage} />
            <ResultRow label="تم" value={`${job.progressCurrent} / ${job.progressTotal} صورة`} />
            <ResultRow label="الحجم حتى الآن" value={formatBytes(job.bytesDone)} />
            <ResultRow label="الوقت المنقضي" value={formatDuration(elapsedMs)} ltr />
            <ResultRow
              label="الوقت المتبقي التقريبي"
              value={etaMs === null ? "—" : formatDuration(etaMs)}
              ltr
            />
            <ResultRow label="بدأ" value={formatClock(job.startedAt)} ltr />
            <ResultRow label="آخر تحديث" value={formatClock(job.updatedAt)} ltr />
          </div>
          <p className="text-[10px] text-muted">
            الوقت المتبقي تقديري تقريبي. يمكنك ترك الصفحة مفتوحة — التوليد يتم على دفعات ويُستأنف من حيث توقف.
          </p>
        </div>
      ) : null}

      {/* FAILED — fixed Arabic copy only; never a raw platform error page. */}
      {error ? (
        <div className="space-y-1 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700" dir="auto">
          <div className="font-semibold">{resumable ? "فشل رفع الحزمة النهائية" : "فشل توليد الحزمة"}</div>
          {errorStage ? <div className="text-[11px]">المرحلة: {errorStage}</div> : null}
          <div className="text-[11px]">السبب: {error}</div>
          {resumable ? (
            <div className="text-[11px] font-medium">
              الصور محفوظة ولن تحتاج إلى إعادة تجهيزها — يمكنك متابعة الرفع من حيث توقف.
            </div>
          ) : null}
          {job?.error?.refId ? (
            <div className="text-[10px] text-rose-500" dir="ltr">ref: {job.error.refId}</div>
          ) : null}
          <button type="button" onClick={generate} disabled={busy} className="btn-ghost mt-1 text-[11px]">
            {resumable ? "متابعة رفع الحزمة" : "إعادة المحاولة"}
          </button>
        </div>
      ) : null}

      {/* COMPLETED — artifact facts. No email, no publish, nothing marked sent. */}
      {result && result.artifact ? (
        <div className="space-y-2 rounded-lg border border-emerald-200 bg-emerald-50 p-3">
          <div className="text-xs font-semibold text-emerald-800">تم توليد الحزمة بنجاح</div>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[11px] text-emerald-900 sm:grid-cols-3">
            <ResultRow label="الملف" value={result.artifact.filename} ltr />
            <ResultRow label="الصفوف" value={String(result.artifact.rowCount)} />
            <ResultRow label="المنتجات" value={String(result.artifact.productCount)} />
            <ResultRow label="الصور" value={String(result.artifact.imageCount)} />
            <ResultRow label="الحجم" value={formatBytes(result.artifact.totalBytes)} ltr />
            {result.artifact.sha256 ? <ResultRow label="SHA256" value={result.artifact.sha256.slice(0, 16)} ltr /> : null}
            <ResultRow label="بصمة المانيفست" value={result.artifact.manifestFingerprint.slice(0, 16)} ltr />
            <ResultRow label="وقت التوليد" value={formatClock(result.completedAt ?? result.updatedAt)} ltr />
            <ResultRow label="مزامنة الربط" value={result.mappingsSynced ? "تمت" : "لم تتم"} />
          </div>
          <a href={talabatJobDownloadUrl(result.jobId)} className="btn-ghost inline-block text-[11px]" download>
            تنزيل الحزمة
          </a>
        </div>
      ) : null}
    </section>
  );
}

function PlanCard({ value, label, tone }: { value: number; label: string; tone: "ink" | "emerald" | "amber" | "rose" }) {
  const toneCls: Record<string, string> = {
    ink: "border-slate-200 text-ink",
    emerald: "border-emerald-200 bg-emerald-50 text-emerald-700",
    amber: "border-amber-200 bg-amber-50 text-amber-700",
    rose: "border-rose-200 bg-rose-50 text-rose-700",
  };
  return (
    <div className={`rounded-lg border p-3 text-center ${toneCls[tone]}`}>
      <div className="text-xl font-bold">{value}</div>
      <div className="mt-0.5 text-[10px] text-muted">{label}</div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-slate-200 px-2 py-1.5 text-center">
      <div className="text-sm font-semibold text-ink">{value}</div>
      <div className="text-[10px] text-muted">{label}</div>
    </div>
  );
}

function ResultRow({ label, value, ltr }: { label: string; value: string; ltr?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-emerald-700">{label}</span>
      <span className="font-mono" dir={ltr ? "ltr" : undefined}>{value || "—"}</span>
    </div>
  );
}
