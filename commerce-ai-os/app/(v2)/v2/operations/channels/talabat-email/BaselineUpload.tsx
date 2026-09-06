"use client";

// رفع آخر ملف طلبات — Upload Latest Talabat Baseline.
//
// Everything downstream is a claim about Talabat's catalog, and this file is
// where that claim comes from. So the card reports what was actually accepted —
// filename, rows, detected headers, content fingerprint, when — rather than a
// bare "uploaded". A new file with different content invalidates artifacts
// generated from the old one, and the card says so instead of letting a stale
// workbook look current.

import { useState } from "react";
import { useRouter } from "next/navigation";

type Active = {
  filename: string;
  byteLength: number;
  rowCount: number;
  fingerprint: string;
  uploadedAtIso: string;
  detectedHeaders: string[];
};

export default function BaselineUpload({ active }: { active: Active | null }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<(Active & { invalidatesExistingArtifacts: boolean }) | null>(null);

  async function upload(file: File) {
    setBusy(true); setError(null); setResult(null);
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch("/api/export/talabat/email/baseline", { method: "POST", body: form });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(typeof body?.message_ar === "string" ? body.message_ar : "تعذّر رفع الملف.");
        return;
      }
      setResult(body);
      router.refresh();
    } catch {
      setError("تعذّر الاتصال بالخادم.");
    } finally { setBusy(false); }
  }

  const shown = result ?? active;

  return (
    <section className="card space-y-3">
      <div>
        <h2 className="text-base font-semibold text-slate-800">رفع آخر ملف طلبات</h2>
        <p className="text-sm text-slate-500">
          ملف Excel الرسمي من طلبات (.xlsx، ورقة <span className="font-mono">Products</span>).
          كل المقارنات والملفات المولّدة تُبنى عليه.
        </p>
      </div>

      <input
        type="file" accept=".xlsx" disabled={busy}
        onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); }}
        className="block w-full text-sm file:me-3 file:rounded-lg file:border-0 file:bg-slate-900 file:px-3 file:py-2 file:text-white"
      />
      {busy ? <p className="text-sm text-slate-500">جارٍ التحقق والرفع…</p> : null}
      {error ? <p className="rounded-lg border border-rose-200 bg-rose-50 p-2 text-sm text-rose-700" role="alert">{error}</p> : null}

      {shown ? (
        <div className="space-y-1 rounded-lg border border-slate-200 p-3 text-sm">
          <p><span className="text-slate-500">الملف الحالي:</span> <span className="font-mono">{shown.filename}</span></p>
          <p>
            <span className="text-slate-500">الصفوف:</span> {shown.rowCount} ·{" "}
            <span className="text-slate-500">الحجم:</span> {(shown.byteLength / 1024).toFixed(0)} ك.ب
          </p>
          <p><span className="text-slate-500">بصمة الملف:</span> <span className="font-mono">{shown.fingerprint}</span></p>
          <p><span className="text-slate-500">تاريخ الرفع:</span> {shown.uploadedAtIso}</p>
          <p className="text-xs text-slate-500">
            الأعمدة المكتشفة: <span className="font-mono">{shown.detectedHeaders.join(" · ")}</span>
          </p>
          <p className="text-emerald-700">الحالة: صالح</p>
          {result?.invalidatesExistingArtifacts ? (
            <p className="rounded border border-amber-200 bg-amber-50 p-2 text-amber-900">
              هذا ملف مختلف عن السابق — الملفات المولّدة سابقاً لم تعد صالحة للإرسال، أعد التوليد.
            </p>
          ) : null}
        </div>
      ) : (
        <p className="rounded-lg border border-amber-200 bg-amber-50 p-2 text-sm text-amber-900" role="status">
          لا يوجد ملف طلبات مرفوع بعد — التوليد متوقف حتى يُرفع ملف صالح.
        </p>
      )}
    </section>
  );
}
