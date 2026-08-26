"use client";

// RAFEEQ.FULLSYNC.1 — Rafeeq file-sync surface (presentational + client state).
//
// Four Arabic-first cards over the canonical-catalog → Rafeeq workflow:
//   1) FULL CATALOG        — generate كتالوج رفيق الكامل (rafeeq-full-….zip);
//   2) NEW PRODUCTS PENDING — the derived queue (exportable AND not in any SENT
//      package) + توليد ملف المنتجات الجديدة;
//   3) PACKAGE HISTORY     — durable Generated/Sent state; the owner-only
//      «تم الإرسال إلى رفيق» is the ONLY thing that establishes the baseline;
//   4) RAFEEQ ID RECONCILIATION — upload the returned file → read-only preview
//      → owner-only apply.
// It holds only view state — no I/O beyond the gated route/actions, no identity
// derivation, no conflict resolution, and it never fabricates history (an
// unmigrated store is shown as غير متاح).

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  markPackageSentAction,
  previewReturnedFileAction,
  applyReturnedFileAction,
  type ReturnedPreviewVM,
} from "@/app/(v2)/v2/export/rafeeq-fullsync-actions";
import { rafeeqJobErrorMessageAr } from "@/lib/export/rafeeq/package-job-errors";
// RAFEEQ.PKGJOB — the SHARED job-flow client (also used by the INT.2D export
// surface): idempotent start → bounded steps → streamed download. Responses
// are read as structured JSON only — raw bodies never reach the page.
import { driveRafeeqPackageJob, rafeeqJobDownloadUrl } from "@/lib/export/rafeeq/package-job-client";
import { RAFEEQ_GUIDE_PNG } from "@/lib/export/rafeeq/email-draft";
import { rafeeqSendErrorMessageAr } from "@/lib/export/rafeeq/email-send";
import { validateRecipients } from "@/lib/mail/config";

export interface RafeeqFullSyncPackageVM {
  id: string;
  mode: "FULL" | "NEW";
  outputFilename: string;
  productCount: number;
  imageCount: number;
  generatedAt: string | null;
  generatedBy: string | null;
  sentAt: string | null;
  sentBy: string | null;
  /** set when a later FULL package replaced this (still unsent) one. */
  supersededAt: string | null;
}

/** One downloadable completed artifact (no regeneration — direct download). */
export interface RafeeqArtifactVM {
  jobId: string;
  mode: "FULL" | "NEW";
  filename: string;
  totalBytes: number;
  generatedAt: string;
  productCount: number;
  imageCount: number;
  packageId: string | null;
  sentAt: string | null;
}

export interface RafeeqFullSyncVM {
  canWrite: boolean;
  isOwner: boolean;
  deliveryAvailable: boolean;
  hasBaseline: boolean;
  /** native-option stats — one Rafeeq product identity per canonical product. */
  stats: {
    canonicalProducts: number;
    productsWithOptions: number;
    optionCount: number;
    physicalRows: number;
    /** differing-price parents encoded as PRICE ON SELECTION + full prices. */
    priceOnSelection: number;
  };
  full: { includable: number; trueBlockers: number; needsReviewIncluded: number };
  pending: { count: number; rows: { id: string; sku: string; title: string; kind: "NEW" | "OPTION_UPDATE" }[]; truncated: boolean };
  packages: RafeeqFullSyncPackageVM[];
  recon: { activeMappings: number; needsReview: number };
  /** latest COMPLETE storage-verified artifacts (download-only, never regenerates). */
  lastCompleted: { full: RafeeqArtifactVM | null; newPending: RafeeqArtifactVM | null };
  /** recent downloadable artifacts (both modes), newest first. */
  artifactHistory: RafeeqArtifactVM[];
}

/** The email draft JSON served by /api/export/rafeeq/package/jobs/<id>/email. */
interface RafeeqEmailDraftVM {
  to: string;
  subject: string;
  html: string;
  /** MOBILE-SAFE plain text — the «نسخ للإيميل» copy target (never raw HTML). */
  textEmail: string;
  textAr: string;
  attachments: string[];
  zipTooLargeForEmail: boolean;
}

/** Preflight JSON for the owner-only direct send (GET …/jobs/<id>/send). */
interface RafeeqSendPreflightVM {
  configured: boolean;
  from: string | null;
  attachmentMaxBytes: number;
  subject: string;
  zipFilename: string;
  zipTotalBytes: number;
  zipAttachable: boolean;
  attachments: { filename: string; bytes: number; kind: "xlsx" | "manifest" | "zip" }[];
  generatedAt: string;
  productCount: number;
  imageCount: number;
  packageId: string | null;
  savedRecipient: string;
}

function fmtBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

const RECON_STATUS_LABEL: Record<string, string> = {
  matched_insert: "ربط جديد",
  matched_update: "تحديث مُعرّف",
  resolve_needs_review: "حلّ تعارض",
  already_mapped: "مربوط مسبقاً",
  missing_id: "بدون مُعرّف",
  invalid_id: "مُعرّف غير صالح",
  unmatchable: "تعذّرت المطابقة",
  unknown_sku: "SKU غير معروف",
  ambiguous_sku: "SKU غامض",
  barcode_mismatch: "باركود غير مطابق",
  duplicate_external_id: "مُعرّف مكرّر",
  conflict_external_id: "مُعرّف مربوط بمنتج آخر",
  conflict_existing_mapping: "يتعارض مع ربط قائم",
};
const APPLYABLE = new Set(["matched_insert", "matched_update", "resolve_needs_review"]);

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("ar", { dateStyle: "medium", timeStyle: "short" });
  } catch {
    return iso;
  }
}

export default function RafeeqFullSync({ vm }: { vm: RafeeqFullSyncVM }) {
  const router = useRouter();
  const [busy, setBusy] = useState<"full" | "new" | "preview" | "apply" | string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errorRef, setErrorRef] = useState<string | null>(null);
  const [retryKind, setRetryKind] = useState<"full" | "new" | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number; phase: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [preview, setPreview] = useState<ReturnedPreviewVM | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  // "إيميل رفيق" — draft loaded READ-ONLY from a completed job; never auto-sent.
  const [emailDraft, setEmailDraft] = useState<RafeeqEmailDraftVM | null>(null);
  const [emailJobId, setEmailJobId] = useState<string | null>(null);
  const [emailLoading, setEmailLoading] = useState(false);
  const [emailTo, setEmailTo] = useState("");
  const [copied, setCopied] = useState<string | null>(null);
  // owner-only direct-send confirmation modal (nothing sends without «إرسال الآن»).
  const [sendOpen, setSendOpen] = useState(false);

  async function openEmailDraft(jobId: string) {
    setEmailLoading(true); setEmailDraft(null); setCopied(null); setEmailJobId(jobId);
    try {
      const res = await fetch(`/api/export/rafeeq/package/jobs/${jobId}/email`);
      const isJson = (res.headers.get("content-type") ?? "").includes("application/json");
      if (!res.ok || !isJson) { setError(rafeeqJobErrorMessageAr("network")); return; }
      const draft = (await res.json()) as RafeeqEmailDraftVM;
      setEmailDraft(draft);
      setEmailTo(draft.to);
    } catch {
      setError(rafeeqJobErrorMessageAr("network"));
    } finally {
      setEmailLoading(false);
    }
  }

  async function copyText(label: string, text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(label);
    } catch {
      setCopied(null);
    }
  }

  const latestGenerated = vm.packages[0] ?? null;
  const latestSent = vm.packages.find((p) => p.sentAt !== null) ?? null;

  // RAFEEQ.PKGJOB — job-based generation: start (idempotent/resumable) → drive
  // bounded steps → streamed download of the stored artifact. Retrying after a
  // failure resumes the SAME job (no duplicate generation, no duplicate
  // package-history rows). Errors render fixed Arabic messages + a short
  // reference id — never a raw response body.
  function failGenerate(kind: "full" | "new", code: string, refId: string | null) {
    setError(rafeeqJobErrorMessageAr(code));
    setErrorRef(refId);
    setRetryKind(kind);
  }

  async function generate(kind: "full" | "new") {
    if (busy) return;
    setBusy(kind); setError(null); setErrorRef(null); setRetryKind(null); setNotice(null); setProgress(null);
    try {
      const done = await driveRafeeqPackageJob(kind === "full" ? "full" : "new_pending", (s) =>
        setProgress({ done: s.productsDone, total: s.productsTotal, phase: s.phase }),
      );
      if (!done.ok) { failGenerate(kind, done.code, done.refId); return; }
      const status = done.value;

      setProgress(null);
      const filename = status.artifact?.filename ?? "rafeeq-export.zip";
      const a = document.createElement("a");
      a.href = rafeeqJobDownloadUrl(status.jobId);
      a.download = filename;
      document.body.appendChild(a); a.click(); a.remove();
      setNotice(
        status.packageRecorded
          ? `تم توليد ${filename} (${status.productsTotal} منتج) وتسجيله بحالة «مُولّد — لم يُرسل». التوليد لا يُغيّر قائمة الانتظار.`
          : `تم توليد ${filename} (${status.productsTotal} منتج). تعذّر تسجيل الحزمة في السجل الدائم (الترحيل غير مُطبَّق؟).`,
      );
      router.refresh();
      // post-generation UX: prepare the Rafeeq email draft for THIS package.
      void openEmailDraft(status.jobId);
    } catch {
      failGenerate(kind, "network", null);
    } finally {
      setBusy(null);
      setProgress(null);
    }
  }

  async function markSent(id: string) {
    if (busy) return;
    setBusy(id); setError(null); setNotice(null);
    try {
      const r = await markPackageSentAction(id);
      if (!r.ok) { setError(r.error); return; }
      setNotice("تم تعليم الحزمة كمُرسَلة إلى رفيق — أصبحت خطّ الأساس لقائمة المنتجات الجديدة.");
      router.refresh();
    } catch {
      setError("تعذّر تنفيذ الإجراء — حاول مرة أخرى.");
    } finally {
      setBusy(null);
    }
  }

  async function previewFile() {
    const file = fileRef.current?.files?.[0];
    if (!file || busy) return;
    setBusy("preview"); setError(null); setNotice(null); setPreview(null);
    try {
      const fd = new FormData();
      fd.set("file", file);
      const r = await previewReturnedFileAction(fd);
      if (!r.ok) { setError(r.error); return; }
      setPreview(r.preview);
    } catch {
      setError("تعذّرت معاينة الملف — حاول مرة أخرى.");
    } finally {
      setBusy(null);
    }
  }

  async function applyFile() {
    const file = fileRef.current?.files?.[0];
    if (!file || busy) return;
    setBusy("apply"); setError(null); setNotice(null);
    try {
      const fd = new FormData();
      fd.set("file", file);
      const r = await applyReturnedFileAction(fd);
      if (!r.ok) { setError(r.error); return; }
      setNotice(
        `تم تطبيق ${r.applied} تحديث مُعرّف (ربط جديد: ${r.inserted} · تحديث: ${r.updated} · حلّ تعارض: ${r.needsReviewResolved}` +
          (r.failed > 0 ? ` · فشل: ${r.failed}` : "") + ").",
      );
      setPreview(null);
      if (fileRef.current) fileRef.current.value = "";
      router.refresh();
    } catch {
      setError("تعذّر تطبيق التحديثات — حاول مرة أخرى.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-4">
      <p className="text-[11px] text-muted">
        الكتالوج الرئيسي هو مصدر الحقيقة الوحيد لرفيق — الملفات تُولَّد دائماً منه مباشرة.
        «جديد» يعني: صفّ البيع لم يُضمَّن بعد في حزمة عُلِّمت صراحة «تم الإرسال إلى رفيق» — لا علاقة له بوجود مُعرّف رفيق أو تاريخ الإنشاء.
      </p>

      {/* Sellable flattening stats — each product CHOICE is its own Rafeeq row */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
        <StatCard value={vm.stats.canonicalProducts} label="منتجات رفيق (هويات)" emphasize />
        <StatCard value={vm.stats.productsWithOptions} label="منتجات بخيارات" />
        <StatCard value={vm.stats.optionCount} label="خيارات" />
        <StatCard value={vm.stats.physicalRows} label="صفوف الملف الفعلية" />
        <StatCard value={vm.stats.priceOnSelection} label="سعر عند الاختيار (PRICE ON SELECTION)" />
      </div>
      <p className="text-[11px] text-muted">
        رفيق يستقبل المنتج ذا الخيارات كمنتج واحد بمجموعة خيارات أصلية — الملف يكرّر صفّ الأب
        مرة لكل خيار (نفس الاسم والسعر والباركود والصورة) وتتغيّر خلايا الخيار فقط.
        الخيار ليس منتجاً مستقلاً أبداً، وإضافة خيار لمنتج مُرسَل تُعيده كـ«تحديث خيارات» لا كمنتج جديد.
      </p>

      {error && (
        <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700" dir="auto">
          <span>{error}</span>
          {errorRef && (
            <span className="ms-2 text-[10px] text-rose-400" dir="ltr">
              (مرجع: {errorRef})
            </span>
          )}
          {retryKind && (
            <button
              type="button"
              onClick={() => generate(retryKind)}
              disabled={busy !== null}
              className="ms-3 rounded border border-rose-300 px-2 py-0.5 text-[11px] hover:bg-rose-100 disabled:opacity-50"
            >
              إعادة المحاولة
            </button>
          )}
        </div>
      )}
      {progress && (
        <div className="rounded-lg border border-sky-200 bg-sky-50 px-3 py-2 text-xs text-sky-800" dir="auto">
          جارٍ توليد الحزمة… {progress.phase === "finalize" ? "إنهاء الملف والفهرس" : `${progress.done} / ${progress.total} منتج`}
        </div>
      )}
      {notice && <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-900" dir="auto">{notice}</div>}
      {(emailLoading || emailDraft) && (
        <RafeeqEmailSection
          draft={emailDraft}
          loading={emailLoading}
          jobId={emailJobId}
          isOwner={vm.isOwner}
          to={emailTo}
          onTo={setEmailTo}
          copied={copied}
          onCopy={copyText}
          onSend={() => setSendOpen(true)}
          onClose={() => setEmailDraft(null)}
        />
      )}
      {sendOpen && emailJobId && <RafeeqSendModal jobId={emailJobId} onClose={() => setSendOpen(false)} />}

      <div className="grid gap-4 lg:grid-cols-2">
        {/* 1 — FULL CATALOG */}
        <section className="card space-y-2">
          <h3 className="text-sm font-semibold text-ink">كتالوج رفيق الكامل</h3>
          <div className="grid grid-cols-3 gap-2 text-center text-xs">
            <Stat label="قابل للتصدير" value={vm.full.includable} />
            <Stat label="محظور (سبب حقيقي)" value={vm.full.trueBlockers} />
            <Stat label="تعارض هوية (يُضمَّن كجديد)" value={vm.full.needsReviewIncluded} />
          </div>
          <p className="text-[11px] text-muted">
            صف واحد لكل منتج، صور باسم SKU، والمنتجات ذات تعارض الهوية تُضمَّن بعلامة
            {" "}<span dir="ltr" className="font-mono">new product</span> — لا يُخمَّن مُعرّف أبداً.
          </p>
          {vm.canWrite ? (
            <button type="button" onClick={() => generate("full")} disabled={busy !== null || vm.full.includable === 0} className="btn-primary disabled:cursor-not-allowed disabled:opacity-50">
              {busy === "full" ? "جارٍ التوليد…" : `توليد كتالوج رفيق الكامل (${vm.full.includable})`}
            </button>
          ) : (
            <span className="text-[11px] text-muted">🔒 التوليد متاح لأصحاب صلاحية التعديل فقط.</span>
          )}
          <div className="grid grid-cols-1 gap-1 text-[11px] text-muted">
            <span>آخر توليد: {latestGenerated ? `${fmtDate(latestGenerated.generatedAt)} (${latestGenerated.productCount} منتج)` : "—"}</span>
            <span>آخر إرسال: {latestSent ? `${fmtDate(latestSent.sentAt)} — ${latestSent.outputFilename}` : "لم يُرسل شيء بعد"}</span>
          </div>
          <DownloadLast
            label="تنزيل آخر حزمة مكتملة"
            artifact={vm.lastCompleted.full}
            onEmail={vm.canWrite ? openEmailDraft : null}
            emailBusy={emailLoading}
          />
        </section>

        {/* 2 — NEW PRODUCTS PENDING */}
        <section className="card space-y-2">
          <h3 className="text-sm font-semibold text-ink">منتجات جديدة بانتظار الإرسال</h3>
          {!vm.deliveryAvailable ? (
            <p className="text-[11px] text-amber-700">
              سجل الإرسال الدائم غير متاح (الترحيل لم يُطبَّق بعد) — لا يمكن اشتقاق قائمة الانتظار بأمانة.
            </p>
          ) : (
            <>
              <div className="text-2xl font-bold text-ink tabular-nums">{vm.pending.count}</div>
              {!vm.hasBaseline && (
                <p className="text-[11px] text-amber-700">
                  لا يوجد خطّ أساس بعد — كل المنتجات القابلة للتصدير تُعتبر بانتظار الإرسال حتى تُعلَّم أول حزمة كاملة «تم الإرسال».
                </p>
              )}
              {vm.pending.rows.length > 0 && (
                <div className="max-h-40 overflow-y-auto rounded-lg border border-slate-200">
                  <table className="w-full text-right text-[11px]">
                    <tbody>
                      {vm.pending.rows.map((r) => (
                        <tr key={r.id} className="border-b border-slate-100 last:border-0">
                          <td className="px-2 py-1 font-mono" dir="ltr">{r.sku}</td>
                          <td className="px-2 py-1 text-ink">{r.title}</td>
                          <td className="px-2 py-1">
                            <span className={`rounded px-1.5 py-0.5 text-[10px] ${r.kind === "OPTION_UPDATE" ? "bg-amber-50 text-amber-700" : "bg-emerald-50 text-emerald-700"}`}>
                              {r.kind === "OPTION_UPDATE" ? "تحديث خيارات" : "جديد"}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {vm.pending.truncated && <p className="text-[10px] text-muted">القائمة مختصرة — العدد الكامل أعلاه.</p>}
              {vm.canWrite ? (
                <button type="button" onClick={() => generate("new")} disabled={busy !== null || vm.pending.count === 0} className="btn-primary disabled:cursor-not-allowed disabled:opacity-50">
                  {busy === "new" ? "جارٍ التوليد…" : `تحميل ملف المنتجات الجديدة (${vm.pending.count})`}
                </button>
              ) : null}
              <DownloadLast
                label="تنزيل آخر ملف مكتمل"
                artifact={vm.lastCompleted.newPending}
                onEmail={vm.canWrite ? openEmailDraft : null}
                emailBusy={emailLoading}
              />
              {vm.canWrite ? (
                <span className="hidden" />
              ) : (
                <span className="text-[11px] text-muted">🔒 التوليد متاح لأصحاب صلاحية التعديل فقط.</span>
              )}
              <p className="text-[10px] text-muted">توليد الملف أو تنزيله لا يمسح القائمة — فقط «تم الإرسال إلى رفيق» يفعل.</p>
            </>
          )}
        </section>
      </div>

      {/* الحزم السابقة — download-only history (no regeneration ever) */}
      {vm.artifactHistory.length > 0 && (
        <details className="card">
          <summary className="cursor-pointer text-sm font-semibold text-ink">الحزم السابقة ({vm.artifactHistory.length})</summary>
          <div className="mt-2 overflow-x-auto">
            <table className="w-full min-w-[640px] text-right text-[11px]">
              <thead className="text-muted">
                <tr>
                  <th className="px-2 py-1 font-medium">الملف</th>
                  <th className="px-2 py-1 font-medium">النوع</th>
                  <th className="px-2 py-1 font-medium">التاريخ</th>
                  <th className="px-2 py-1 font-medium">منتجات</th>
                  <th className="px-2 py-1 font-medium">الحالة</th>
                  <th className="px-2 py-1 font-medium">تنزيل</th>
                </tr>
              </thead>
              <tbody>
                {vm.artifactHistory.map((a) => (
                  <tr key={a.jobId} className="border-t border-slate-100">
                    <td className="px-2 py-1 font-mono" dir="ltr">{a.filename}</td>
                    <td className="px-2 py-1">{a.mode === "FULL" ? "كامل" : "جديد"}</td>
                    <td className="px-2 py-1">{fmtDate(a.generatedAt)}</td>
                    <td className="px-2 py-1 tabular-nums">{a.productCount}</td>
                    <td className="px-2 py-1">{a.sentAt ? "أُرسلت" : "لم تُرسل"}</td>
                    <td className="px-2 py-1">
                      <a href={rafeeqJobDownloadUrl(a.jobId)} download={a.filename} className="btn-ghost px-2 py-0.5 text-[11px]">تنزيل</a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}

      {/* 3 — PACKAGE HISTORY */}
      <section className="card space-y-2">
        <h3 className="text-sm font-semibold text-ink">سجل حزم رفيق</h3>
        {!vm.deliveryAvailable ? (
          <p className="text-[11px] text-muted">السجل غير متاح (لا بيانات ملفّقة).</p>
        ) : vm.packages.length === 0 ? (
          <p className="text-[11px] text-muted">لم تُولَّد أي حزمة بعد.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-right text-xs">
              <thead className="border-b border-slate-200 bg-slate-50 text-[11px] text-muted">
                <tr>
                  <th className="px-3 py-2 font-medium">التاريخ</th>
                  <th className="px-3 py-2 font-medium">الوضع</th>
                  <th className="px-3 py-2 font-medium">الملف</th>
                  <th className="px-3 py-2 font-medium">منتجات</th>
                  <th className="px-3 py-2 font-medium">الحالة</th>
                  <th className="px-3 py-2 font-medium">الإجراء</th>
                </tr>
              </thead>
              <tbody>
                {vm.packages.map((p) => (
                  <tr key={p.id} className="border-b border-slate-100 last:border-0">
                    <td className="px-3 py-2 text-muted">{fmtDate(p.generatedAt)}</td>
                    <td className="px-3 py-2">{p.mode === "FULL" ? "كامل" : "جديد"}</td>
                    <td className="px-3 py-2 font-mono text-[10px]" dir="ltr">{p.outputFilename || "—"}</td>
                    <td className="px-3 py-2 tabular-nums">{p.productCount}</td>
                    <td className="px-3 py-2">
                      {p.sentAt ? (
                        <span className="rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[10px] text-emerald-700">
                          أُرسل · {fmtDate(p.sentAt)}
                        </span>
                      ) : p.supersededAt ? (
                        <span className="rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[10px] text-slate-500" title={fmtDate(p.supersededAt)}>
                          تم تجاوزها بحزمة أحدث
                        </span>
                      ) : (
                        <span className="rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[10px] text-amber-700">
                          مُولّد — لم يُرسل
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      {p.sentAt ? (
                        <span className="text-[10px] text-muted" dir="ltr">{p.sentBy ?? ""}</span>
                      ) : p.supersededAt ? (
                        <span className="text-[10px] text-muted">—</span>
                      ) : vm.isOwner ? (
                        <button type="button" onClick={() => markSent(p.id)} disabled={busy !== null} className="rounded-lg border border-emerald-300 bg-emerald-50 px-2 py-1 text-[11px] text-emerald-800 hover:bg-emerald-100 disabled:opacity-50">
                          {busy === p.id ? "جارٍ…" : "تم الإرسال إلى رفيق"}
                        </button>
                      ) : (
                        <span className="text-[10px] text-muted">🔒 للمالك فقط</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* 4 — RAFEEQ ID RECONCILIATION */}
      <section className="card space-y-2">
        <h3 className="text-sm font-semibold text-ink">مطابقة مُعرّفات رفيق (الملف المرتجع)</h3>
        <div className="grid grid-cols-2 gap-2 text-center text-xs sm:max-w-xs">
          <Stat label="ربط نشط" value={vm.recon.activeMappings} />
          <Stat label="بحاجة لمراجعة" value={vm.recon.needsReview} />
        </div>
        <p className="text-[11px] text-muted">
          المطابقة تتم عبر SKU (من عمود IMAGE NAME) والباركود فقط — لا مطابقة بالاسم إطلاقاً.
          المعاينة لا تكتب شيئاً؛ التطبيق للمالك فقط وبعد المعاينة.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <input ref={fileRef} type="file" accept=".xlsx,.xls" className="text-xs" aria-label="ملف رفيق المرتجع" onChange={() => setPreview(null)} />
          <button type="button" onClick={previewFile} disabled={busy !== null} className="btn-ghost disabled:opacity-50">
            {busy === "preview" ? "جارٍ المعاينة…" : "معاينة الملف المرتجع"}
          </button>
          {preview && vm.isOwner && preview.counts.applicable > 0 && (
            <button type="button" onClick={applyFile} disabled={busy !== null} className="btn-primary disabled:opacity-50">
              {busy === "apply" ? "جارٍ التطبيق…" : `تطبيق ${preview.counts.applicable} تحديث مُعرّف`}
            </button>
          )}
          {preview && !vm.isOwner && preview.counts.applicable > 0 && (
            <span className="text-[11px] text-muted">🔒 التطبيق متاح للمالك فقط.</span>
          )}
        </div>
        {preview && (
          <div className="space-y-2">
            <div className="flex flex-wrap gap-1.5 text-[11px]">
              <Chip tone="emerald" label={`قابل للتطبيق: ${preview.counts.applicable}`} />
              <Chip tone="emerald" label={`حلّ تعارض: ${preview.counts.needsReviewResolved}`} />
              <Chip tone="slate" label={`مربوط مسبقاً: ${preview.counts.alreadyMapped}`} />
              <Chip tone="amber" label={`بدون مُعرّف: ${preview.counts.missingId}`} />
              <Chip tone="rose" label={`مكرّر: ${preview.counts.duplicates}`} />
              <Chip tone="rose" label={`تعارض: ${preview.counts.conflicts}`} />
              <Chip tone="rose" label={`SKU غير معروف: ${preview.counts.unknownSku}`} />
              <Chip tone="rose" label={`غير صالح: ${preview.counts.invalid}`} />
            </div>
            <div className="max-h-64 overflow-auto rounded-lg border border-slate-200">
              <table className="w-full min-w-[640px] text-right text-[11px]">
                <thead className="border-b border-slate-200 bg-slate-50 text-muted">
                  <tr>
                    <th className="px-2 py-1 font-medium">صف</th>
                    <th className="px-2 py-1 font-medium">barcode (SKU الأب)</th>
                    <th className="px-2 py-1 font-medium">SKU</th>
                    <th className="px-2 py-1 font-medium">المُعرّف المرتجع</th>
                    <th className="px-2 py-1 font-medium">النتيجة</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.entries.map((e) => (
                    <tr key={e.rowNumber} className="border-b border-slate-100 last:border-0">
                      <td className="px-2 py-1 tabular-nums">{e.rowNumber}</td>
                      <td className="px-2 py-1 font-mono text-[10px]" dir="ltr">{e.barcode ?? "—"}</td>
                      <td className="px-2 py-1 font-mono text-[10px]" dir="ltr">{e.matchedSku ?? e.skuToken ?? "—"}</td>
                      <td className="px-2 py-1 font-mono text-[10px]" dir="ltr">{e.returnedId ?? "—"}</td>
                      <td className="px-2 py-1">
                        <span className={`rounded px-1.5 py-0.5 text-[10px] ${APPLYABLE.has(e.status) ? "bg-emerald-50 text-emerald-700" : e.status === "already_mapped" ? "bg-slate-50 text-slate-600" : "bg-rose-50 text-rose-600"}`}>
                          {RECON_STATUS_LABEL[e.status] ?? e.status}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {preview.entriesTruncated && <p className="text-[10px] text-muted">المعاينة مختصرة إلى 500 صف — الإحصاءات أعلاه تشمل الملف كاملاً.</p>}
          </div>
        )}
      </section>
    </div>
  );
}

function StatCard({ value, label, emphasize }: { value: number; label: string; emphasize?: boolean }) {
  return (
    <div className={`rounded-lg border p-3 text-center ${emphasize ? "border-brand bg-brand-light" : "border-slate-200"}`}>
      <div className={`text-xl font-bold tabular-nums ${emphasize ? "text-brand" : "text-ink"}`}>{value}</div>
      <div className="mt-0.5 text-[10px] text-muted">{label}</div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-slate-200 px-2 py-1.5 text-center">
      <div className="text-sm font-semibold text-ink tabular-nums">{value}</div>
      <div className="text-[10px] text-muted">{label}</div>
    </div>
  );
}

function Chip({ tone, label }: { tone: "emerald" | "amber" | "rose" | "slate"; label: string }) {
  const cls: Record<string, string> = {
    emerald: "border-emerald-200 bg-emerald-50 text-emerald-700",
    amber: "border-amber-200 bg-amber-50 text-amber-700",
    rose: "border-rose-200 bg-rose-50 text-rose-700",
    slate: "border-slate-200 bg-slate-50 text-slate-600",
  };
  return <span className={`rounded-full border px-2 py-0.5 ${cls[tone]}`}>{label}</span>;
}

/**
 * Direct download of the latest COMPLETED artifact of a mode. Owner rule:
 * this NEVER creates a job and never regenerates — it is a plain link to the
 * existing streamed-download route for a job that already finished, and it
 * keeps working while a NEW job is running. When no completed artifact
 * exists (running/failed/incomplete/missing files were all skipped) it shows
 * a disabled action with the exact required message.
 */
function DownloadLast({
  label,
  artifact,
  onEmail,
  emailBusy,
}: {
  label: string;
  artifact: RafeeqArtifactVM | null;
  onEmail: ((jobId: string) => void | Promise<void>) | null;
  emailBusy: boolean;
}) {
  if (!artifact) {
    return (
      <div className="space-y-1 border-t border-slate-100 pt-2">
        <button type="button" disabled className="btn-ghost w-full cursor-not-allowed text-xs opacity-50">
          {label}
        </button>
        <p className="text-[10px] text-muted">لا توجد حزمة مكتملة جاهزة للتنزيل</p>
      </div>
    );
  }
  return (
    <div className="space-y-1 border-t border-slate-100 pt-2">
      <div className="flex flex-wrap items-center gap-2">
        <a
          href={rafeeqJobDownloadUrl(artifact.jobId)}
          download={artifact.filename}
          className="btn-ghost flex-1 text-center text-xs"
        >
          {label}
        </a>
        {onEmail && (
          <button
            type="button"
            className="btn-ghost text-xs"
            disabled={emailBusy}
            onClick={() => void onEmail(artifact.jobId)}
          >
            تحضير إيميل رفيق
          </button>
        )}
      </div>
      <p className="text-[10px] text-muted" dir="rtl">
        <span className="font-mono text-[10px]" dir="ltr">{artifact.filename}</span>
        {" · "}{artifact.productCount} منتج · {artifact.imageCount} صورة · {fmtBytes(artifact.totalBytes)} · {fmtDate(artifact.generatedAt)} ·{" "}
        {artifact.sentAt ? (
          <span className="text-emerald-700">أُرسلت {fmtDate(artifact.sentAt)}</span>
        ) : (
          <span className="text-amber-700">لم تُرسل</span>
        )}
      </p>
    </div>
  );
}

/**
 * «إيميل رفيق» — the completed-package email panel. Primary mobile workflow:
 * «نسخ للإيميل» copies the MOBILE-SAFE plain-text draft (never raw HTML
 * source) so it pastes cleanly into Outlook/Titan/Gmail mobile. The rendered
 * HTML preview stays available behind «فتح المعاينة» (fully sandboxed iframe
 * via srcDoc — never dangerouslySetInnerHTML), and the raw-HTML copy is a
 * clearly-labeled developer action hidden under an advanced menu. Direct
 * sending exists ONLY behind the owner-only «إرسال إلى رفيق» confirmation
 * modal — nothing is ever sent automatically from this panel.
 */
function RafeeqEmailSection({
  draft,
  loading,
  jobId,
  isOwner,
  to,
  onTo,
  copied,
  onCopy,
  onSend,
  onClose,
}: {
  draft: RafeeqEmailDraftVM | null;
  loading: boolean;
  jobId: string | null;
  isOwner: boolean;
  to: string;
  onTo: (v: string) => void;
  copied: string | null;
  onCopy: (label: string, text: string) => void | Promise<void>;
  onSend: () => void;
  onClose: () => void;
}) {
  const [showPreview, setShowPreview] = useState(false);
  if (loading) {
    return (
      <section className="card space-y-2">
        <h3 className="text-sm font-semibold text-ink">إيميل رفيق</h3>
        <p className="text-xs text-muted">جارٍ تجهيز مسودة الإيميل من بيانات الحزمة الفعلية…</p>
      </section>
    );
  }
  if (!draft) return null;
  const copyBtn = (label: string, text: string, title: string, primary = false) => (
    <button type="button" className={`${primary ? "btn-primary" : "btn-ghost"} text-xs`} onClick={() => void onCopy(label, text)}>
      {copied === label ? "✓ تم النسخ" : title}
    </button>
  );
  return (
    <section className="card space-y-3">
      <div className="flex items-start justify-between gap-2">
        <h3 className="text-sm font-semibold text-ink">إيميل رفيق — مسودة جاهزة</h3>
        <button type="button" aria-label="إغلاق" className="text-sm text-muted hover:text-ink" onClick={onClose}>✕</button>
      </div>
      <p className="text-[11px] text-amber-800">
        لن يُرسل أي إيميل تلقائياً — «نسخ للإيميل» ينسخ نصاً نظيفاً يلصق مباشرة في تطبيق البريد على
        الجوال، و«إرسال إلى رفيق» (للمالك فقط) يتطلب تأكيداً صريحاً قبل أي إرسال.
      </p>
      {/* primary actions — the mobile workflow first, never raw HTML */}
      <div className="flex flex-wrap items-center gap-1.5">
        {copyBtn("textEmail", draft.textEmail, "نسخ للإيميل", true)}
        {copyBtn("subject", draft.subject, "نسخ الموضوع")}
        <button type="button" className="btn-ghost text-xs" onClick={() => setShowPreview((v) => !v)}>
          {showPreview ? "إغلاق المعاينة" : "فتح المعاينة"}
        </button>
        {jobId && (
          <a href={rafeeqJobDownloadUrl(jobId)} download className="btn-ghost text-xs">تنزيل الملفات</a>
        )}
        {isOwner && jobId && (
          <button type="button" className="btn-primary text-xs" onClick={onSend}>إرسال إلى رفيق</button>
        )}
      </div>
      <div className="grid gap-2 text-xs sm:grid-cols-[auto_1fr]">
        <label className="pt-1.5 text-muted" htmlFor="rafeeq-email-to">إلى</label>
        <input
          id="rafeeq-email-to"
          type="email"
          dir="ltr"
          value={to}
          onChange={(e) => onTo(e.target.value)}
          placeholder="rafeeq@example.com"
          className="input font-mono text-xs"
        />
        <span className="pt-1.5 text-muted">الموضوع</span>
        <input readOnly dir="ltr" value={draft.subject} className="input font-mono text-[11px]" />
      </div>
      {showPreview && (
        <div className="space-y-1">
          <span className="text-[11px] font-medium text-muted">معاينة الإيميل (HTML مُصيَّر — كما سيظهر لدى رفيق)</span>
          <iframe
            title="Rafeeq email preview"
            sandbox=""
            srcDoc={draft.html}
            className="h-96 w-full rounded-lg border border-slate-200 bg-white"
          />
        </div>
      )}
      <div className="space-y-1">
        <div className="flex items-center justify-between">
          <span className="text-[11px] font-medium text-muted">الملخص بالعربية</span>
          {copyBtn("text", draft.textAr, "نسخ النص")}
        </div>
        <pre dir="rtl" className="max-h-48 overflow-auto whitespace-pre-wrap rounded-lg border border-slate-200 bg-slate-50 p-2 text-[11px] leading-relaxed text-ink">{draft.textAr}</pre>
      </div>
      <div className="space-y-1">
        <span className="text-[11px] font-medium text-muted">قائمة المرفقات المطلوبة</span>
        <ul className="list-inside list-disc text-[11px] text-ink">
          {draft.attachments.map((a) => (
            <li key={a}>
              <span className="font-mono text-[10px]" dir="ltr">{a}</span>
              {a === RAFEEQ_GUIDE_PNG && (
                <>
                  {" — "}
                  <a href={`/${RAFEEQ_GUIDE_PNG}`} download className="text-brand underline">تنزيل الدليل المصوّر</a>
                </>
              )}
            </li>
          ))}
        </ul>
        {draft.zipTooLargeForEmail && (
          <p className="text-[11px] text-amber-800">ملف ZIP كبير — سيُشارَك بشكل منفصل (المسودة تتضمن هذه الملاحظة).</p>
        )}
      </div>
      {/* developer/debug action — clearly labeled, never the normal user path */}
      <details>
        <summary className="cursor-pointer text-[10px] text-muted">خيارات متقدمة</summary>
        <div className="pt-1.5">{copyBtn("html", draft.html, "نسخ HTML للمطور")}</div>
      </details>
    </section>
  );
}

/**
 * Owner-only direct-send confirmation modal. Shows the EXACT From/To/CC/
 * Subject/attachment list + sizes/limits/counts from the send preflight, and
 * transmits ONLY after the explicit «إرسال الآن» click. An unconfigured mail
 * provider or an over-limit package disables sending with a clear reason —
 * copy and download stay available either way. Sending never regenerates the
 * package and never marks the Rafeeq SENT baseline.
 */
function RafeeqSendModal({ jobId, onClose }: { jobId: string; onClose: () => void }) {
  const [pf, setPf] = useState<RafeeqSendPreflightVM | null>(null);
  const [pfError, setPfError] = useState<string | null>(null);
  const [to, setTo] = useState("");
  const [cc, setCc] = useState("");
  const [includeZip, setIncludeZip] = useState(false);
  const [saveRecipient, setSaveRecipient] = useState(false);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [sentResult, setSentResult] = useState<{ messageId: string | null; auditRecorded: boolean; attachmentFilenames: string[] } | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/export/rafeeq/package/jobs/${jobId}/send`);
        const isJson = (res.headers.get("content-type") ?? "").includes("application/json");
        if (!isJson) { if (!cancelled) setPfError(rafeeqSendErrorMessageAr("send_failed")); return; }
        const body = await res.json();
        if (cancelled) return;
        if (!res.ok) { setPfError(typeof body?.message_ar === "string" ? body.message_ar : rafeeqSendErrorMessageAr(body?.error)); return; }
        setPf(body as RafeeqSendPreflightVM);
        setTo((body as RafeeqSendPreflightVM).savedRecipient ?? "");
      } catch {
        if (!cancelled) setPfError(rafeeqSendErrorMessageAr("send_failed"));
      }
    })();
    return () => { cancelled = true; };
  }, [jobId]);

  const recipients = validateRecipients(to, cc);
  const canSend = !!pf && pf.configured && recipients.ok && !sending && !sentResult;

  async function confirmSend() {
    if (!canSend) return;
    setSending(true); setSendError(null);
    try {
      const res = await fetch(`/api/export/rafeeq/package/jobs/${jobId}/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to, cc, includeZip: includeZip && !!pf?.zipAttachable, saveRecipient }),
      });
      const isJson = (res.headers.get("content-type") ?? "").includes("application/json");
      if (!isJson) { setSendError(rafeeqSendErrorMessageAr("send_failed")); return; }
      const body = await res.json();
      if (!res.ok) { setSendError(typeof body?.message_ar === "string" ? body.message_ar : rafeeqSendErrorMessageAr(body?.error)); return; }
      setSentResult(body as { messageId: string | null; auditRecorded: boolean; attachmentFilenames: string[] });
    } catch {
      setSendError(rafeeqSendErrorMessageAr("send_failed"));
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true">
      <div className="card max-h-[90vh] w-full max-w-lg space-y-3 overflow-y-auto">
        <div className="flex items-start justify-between gap-2">
          <h3 className="text-sm font-semibold text-ink">إرسال إلى رفيق — تأكيد</h3>
          <button type="button" aria-label="إغلاق" className="text-sm text-muted hover:text-ink" onClick={onClose}>✕</button>
        </div>
        {pfError && <p className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">{pfError}</p>}
        {!pf && !pfError && <p className="text-xs text-muted">جارٍ تجهيز تفاصيل الإرسال…</p>}
        {pf && (
          <>
            {!pf.configured && (
              <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-900">
                لم يتم إعداد مزود البريد بعد — أضف إعدادات SMTP (متغيرات البيئة MAIL_HOST / MAIL_PORT /
                MAIL_SECURE / MAIL_USERNAME / MAIL_PASSWORD / MAIL_FROM_NAME / MAIL_FROM_ADDRESS) ثم أعد المحاولة.
                الإرسال معطّل حتى ذلك الحين، والنسخ والتنزيل متاحان.
              </p>
            )}
            <div className="grid gap-2 text-xs sm:grid-cols-[auto_1fr]">
              <span className="pt-1.5 text-muted">من</span>
              <input readOnly dir="ltr" value={pf.from ?? "— غير مُعد —"} className="input font-mono text-[11px]" />
              <label className="pt-1.5 text-muted" htmlFor="rafeeq-send-to">إلى</label>
              <input id="rafeeq-send-to" type="text" dir="ltr" value={to} onChange={(e) => setTo(e.target.value)} placeholder="rafeeq@example.com" className="input font-mono text-xs" />
              <label className="pt-1.5 text-muted" htmlFor="rafeeq-send-cc">نسخة (CC)</label>
              <input id="rafeeq-send-cc" type="text" dir="ltr" value={cc} onChange={(e) => setCc(e.target.value)} placeholder="اختياري" className="input font-mono text-xs" />
              <span className="pt-1.5 text-muted">الموضوع</span>
              <input readOnly dir="ltr" value={pf.subject} className="input font-mono text-[11px]" />
            </div>
            {!recipients.ok && to.trim() !== "" && (
              <p className="text-[11px] text-rose-700">عنوان البريد غير صالح — تحقق من حقل المستلمين.</p>
            )}
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-2 text-[11px]" dir="rtl">
              <div>الحزمة: <span className="font-mono text-[10px]" dir="ltr">{pf.zipFilename}</span> ({fmtBytes(pf.zipTotalBytes)})</div>
              <div>توليد: {fmtDate(pf.generatedAt)} · {pf.productCount} منتج · {pf.imageCount} صورة</div>
              <div className="pt-1 font-medium">المرفقات:</div>
              <ul className="list-inside list-disc">
                {pf.attachments.filter((a) => a.kind !== "zip" || includeZip).map((a) => (
                  <li key={a.filename}><span className="font-mono text-[10px]" dir="ltr">{a.filename}</span> — {fmtBytes(a.bytes)}</li>
                ))}
              </ul>
              <div className="pt-1">
                إجمالي المرفقات: {fmtBytes(pf.attachments.filter((a) => a.kind !== "zip" || includeZip).reduce((s, a) => s + a.bytes, 0))}
                {" "}(الحد: {fmtBytes(pf.attachmentMaxBytes)})
              </div>
            </div>
            {pf.zipAttachable ? (
              <label className="flex items-center gap-2 text-[11px] text-ink">
                <input type="checkbox" checked={includeZip} onChange={(e) => setIncludeZip(e.target.checked)} />
                إرفاق ملف ZIP الكامل أيضاً
              </label>
            ) : (
              <p className="text-[11px] text-amber-800">
                الحزمة أكبر من الحد المسموح للإرسال عبر البريد. سيُرسل الإيميل مع ملف الإكسل والفهرس فقط،
                ونص الإيميل يوضح أن الحزمة الكاملة ستُشارك بشكل منفصل (تنزيل الملفات يبقى متاحاً).
              </p>
            )}
            <label className="flex items-center gap-2 text-[11px] text-muted">
              <input type="checkbox" checked={saveRecipient} onChange={(e) => setSaveRecipient(e.target.checked)} />
              حفظ هذا العنوان كمستلم رفيق الافتراضي (إعداد صريح للمالك)
            </label>
            {sendError && <p className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">{sendError}</p>}
            {sentResult ? (
              <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-900">
                ✓ تم الإرسال عبر مزود البريد.
                {sentResult.messageId && <> معرف الرسالة: <span className="font-mono text-[10px]" dir="ltr">{sentResult.messageId}</span></>}
                {!sentResult.auditRecorded && <div className="pt-1 text-amber-800">تنبيه: لم يُسجَّل سجل التدقيق (جدول rafeeq_email_deliveries غير مهيأ).</div>}
                <div className="pt-1 text-[10px] text-emerald-800">
                  ملاحظة: هذا الإرسال لا يغيّر حالة «تم الإرسال إلى رفيق» — تعليم الحزمة كمُرسلة يبقى إجراءً منفصلاً.
                </div>
              </div>
            ) : (
              <div className="flex items-center justify-end gap-2">
                <button type="button" className="btn-ghost text-xs" onClick={onClose}>إلغاء</button>
                <button type="button" className="btn-primary text-xs disabled:cursor-not-allowed disabled:opacity-50" disabled={!canSend} onClick={() => void confirmSend()}>
                  {sending ? "جارٍ الإرسال…" : "إرسال الآن"}
                </button>
              </div>
            )}
            {sentResult && (
              <div className="flex items-center justify-end">
                <button type="button" className="btn-ghost text-xs" onClick={onClose}>إغلاق</button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
