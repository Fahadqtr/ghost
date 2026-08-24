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

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  markPackageSentAction,
  previewReturnedFileAction,
  applyReturnedFileAction,
  type ReturnedPreviewVM,
} from "@/app/(v2)/v2/export/rafeeq-fullsync-actions";

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
}

export interface RafeeqFullSyncVM {
  canWrite: boolean;
  isOwner: boolean;
  deliveryAvailable: boolean;
  hasBaseline: boolean;
  full: { includable: number; trueBlockers: number; needsReviewIncluded: number };
  pending: { count: number; rows: { id: string; sku: string; title: string }[]; truncated: boolean };
  packages: RafeeqFullSyncPackageVM[];
  recon: { activeMappings: number; needsReview: number };
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
  const [notice, setNotice] = useState<string | null>(null);
  const [preview, setPreview] = useState<ReturnedPreviewVM | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const latestGenerated = vm.packages[0] ?? null;
  const latestSent = vm.packages.find((p) => p.sentAt !== null) ?? null;

  async function generate(kind: "full" | "new") {
    if (busy) return;
    setBusy(kind); setError(null); setNotice(null);
    try {
      const res = await fetch(`/api/export/rafeeq/package`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: kind === "full" ? "full" : "new_pending" }),
      });
      if (!res.ok) { setError((await res.text().catch(() => "")) || "تعذّر توليد الحزمة الآن."); return; }
      const filename = res.headers.get("X-Rafeeq-Output-Filename") ?? "rafeeq-export.zip";
      const recorded = res.headers.get("X-Rafeeq-Package-Recorded") === "1";
      const rows = res.headers.get("X-Rafeeq-Product-Rows") ?? "0";
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = filename;
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
      setNotice(
        recorded
          ? `تم توليد ${filename} (${rows} منتج) وتسجيله بحالة «مُولّد — لم يُرسل». التوليد لا يُغيّر قائمة الانتظار.`
          : `تم توليد ${filename} (${rows} منتج). تعذّر تسجيل الحزمة في السجل الدائم (الترحيل غير مُطبَّق؟).`,
      );
      router.refresh();
    } catch {
      setError("تعذّر الاتصال بالخادم — الرجاء المحاولة لاحقاً.");
    } finally {
      setBusy(null);
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
        «جديد» يعني: لم يُضمَّن بعد في حزمة عُلِّمت صراحة «تم الإرسال إلى رفيق» — لا علاقة له بوجود مُعرّف رفيق أو تاريخ الإنشاء.
      </p>

      {error && <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700" dir="auto">{error}</div>}
      {notice && <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-900" dir="auto">{notice}</div>}

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
              ) : (
                <span className="text-[11px] text-muted">🔒 التوليد متاح لأصحاب صلاحية التعديل فقط.</span>
              )}
              <p className="text-[10px] text-muted">توليد الملف أو تنزيله لا يمسح القائمة — فقط «تم الإرسال إلى رفيق» يفعل.</p>
            </>
          )}
        </section>
      </div>

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
                      ) : (
                        <span className="rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[10px] text-amber-700">
                          مُولّد — لم يُرسل
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      {p.sentAt ? (
                        <span className="text-[10px] text-muted" dir="ltr">{p.sentBy ?? ""}</span>
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
                    <th className="px-2 py-1 font-medium">IMAGE NAME</th>
                    <th className="px-2 py-1 font-medium">SKU</th>
                    <th className="px-2 py-1 font-medium">المُعرّف المرتجع</th>
                    <th className="px-2 py-1 font-medium">النتيجة</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.entries.map((e) => (
                    <tr key={e.rowNumber} className="border-b border-slate-100 last:border-0">
                      <td className="px-2 py-1 tabular-nums">{e.rowNumber}</td>
                      <td className="px-2 py-1 font-mono text-[10px]" dir="ltr">{e.imageName || "—"}</td>
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
