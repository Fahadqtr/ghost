"use client";

import { useState, useTransition } from "react";
import * as XLSX from "xlsx";
import { computeTalabatDiff, buildTalabatPackage, type TalabatDiff } from "@/app/(app)/import-export/talabat-actions";

// Talabat catalog gap-closer: upload Talabat's own export, see which of OUR
// sellable products (Approved, no options — Talabat rejects variant products)
// are missing over there, then download the "please add these" package:
// a sheet in Talabat's exact 10-column format + the matching images ZIP +
// a ready email text. Talabat's team does the adding — we just hand it over.

export default function TalabatSync() {
  const [diff, setDiff] = useState<TalabatDiff | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pkgMsg, setPkgMsg] = useState("");
  const [emailText, setEmailText] = useState("");
  const [busy, start] = useTransition();

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setError(null); setDiff(null); setPkgMsg(""); setEmailText("");
    start(async () => {
      try {
        const wb = XLSX.read(await file.arrayBuffer(), { type: "array" });
        const sheetName = wb.SheetNames[0];
        const raw: Record<string, unknown>[] = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { defval: "" });
        const d = await computeTalabatDiff(raw);
        if (!d.ok) { setError(d.error ?? "فشل التحليل."); return; }
        setDiff(d);
      } catch (err) {
        setError(err instanceof Error ? err.message : "تعذّر قراءة الملف.");
      }
    });
  }

  const downloadSheet = () => {
    if (!diff?.missing.length) return;
    setPkgMsg("…يجهّز ملف الإكسل");
    start(async () => {
      const pkg = await buildTalabatPackage(diff.missing.map((m) => m.product_id));
      if (!pkg.ok) { setPkgMsg(`❌ ${pkg.error}`); return; }
      const ws = XLSX.utils.json_to_sheet(pkg.rows, { header: pkg.headers });
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "Talabat");
      XLSX.writeFile(wb, `talabat-new-products-${pkg.rows.length}.xlsx`);
      setEmailText(pkg.emailText);
      const warn = [
        pkg.noImage.length ? `⚠️ ${pkg.noImage.length} بدون صورة (${pkg.noImage.slice(0, 3).map((x) => x.sku || x.name_en).join("، ")}…)` : "",
        pkg.emptyDesc.length ? `⚠️ ${pkg.emptyDesc.length} بدون وصف إنجليزي` : "",
      ].filter(Boolean).join(" · ");
      setPkgMsg(`✅ نزل الملف (${pkg.rows.length} منتج)${warn ? ` — ${warn}` : ""}`);
    });
  };

  const downloadImages = () => {
    if (!diff?.missing.length) return;
    setPkgMsg("…يضغط الصور (قد يأخذ دقائق حسب العدد) — خلّ الصفحة مفتوحة");
    start(async () => {
      try {
        const skus = diff.missing.map((m) => m.sku).filter(Boolean);
        const res = await fetch("/api/export/images", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ skus }),
        });
        if (!res.ok) { setPkgMsg(`❌ فشل تجهيز الصور (HTTP ${res.status})`); return; }
        const blob = await res.blob();
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = `talabat-images-${skus.length}.zip`;
        a.click();
        URL.revokeObjectURL(a.href);
        setPkgMsg(`✅ نزل ملف الصور (${skus.length} SKU)`);
      } catch (e) {
        setPkgMsg(`❌ ${e instanceof Error ? e.message : "فشل تنزيل الصور"}`);
      }
    });
  };

  const copyEmail = () => {
    navigator.clipboard?.writeText(emailText);
    setPkgMsg("✅ انتسخ نص الإيميل — أرفق الملفين وأرسله");
  };

  const tiles: [string, number][] = diff?.ok
    ? [
        ["في الكتالوج", diff.counts.ours],
        ["مؤهل لطلبات", diff.counts.eligible],
        ["مستبعد (فيه خيارات)", diff.counts.excludedVariants],
        ["غير معتمد", diff.counts.notApproved],
        ["في ملف طلبات", diff.counts.theirRows],
        ["متطابق", diff.counts.matched],
        ["ناقص في طلبات", diff.counts.missing],
        ["في طلبات فقط", diff.counts.extraOnTalabat],
      ]
    : [];

  return (
    <div className="space-y-4">
      <div className="card space-y-3">
        <div>
          <h3 className="text-sm font-semibold text-ink">مقارنة كتالوج طلبات (Talabat)</h3>
          <p className="text-xs text-muted">
            ارفع تصدير الكتالوج من لوحة طلبات → نطلع لك المنتجات الناقصة عندهم (المنتجات اللي فيها خيارات
            مستبعدة تلقائيًا لأن طلبات ما يقبلها) → نزّل ملف الإكسل بصيغتهم + الصور وأرسلهم بالإيميل.
          </p>
        </div>
        <input type="file" accept=".xlsx,.xls,.csv" onChange={onFile} disabled={busy} className="block text-sm" />
        {busy && !diff ? <p className="text-xs text-muted">…يحلّل الملف ويقارن</p> : null}
        {error ? <pre className="whitespace-pre-wrap rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{error}</pre> : null}
      </div>

      {diff?.ok ? (
        <>
          <div className="card grid grid-cols-2 gap-2 text-center text-xs sm:grid-cols-4">
            {tiles.map(([label, n]) => (
              <div key={label} className="rounded-lg bg-[#faf6f0] p-2">
                <div className="text-lg font-bold text-ink">{n}</div>
                <div className="text-muted">{label}</div>
              </div>
            ))}
          </div>

          {diff.missing.length ? (
            <div className="card space-y-3">
              <h3 className="text-sm font-semibold text-ink">🚀 جاهز للإرسال لطلبات ({diff.missing.length} منتج)</h3>
              <ol className="list-decimal space-y-1 pr-5 text-xs text-muted">
                <li>نزّل ملف الإكسل (بصيغة طلبات بالضبط — 10 أعمدة)</li>
                <li>نزّل ملف الصور المضغوط (اسم كل صورة يطابق عمود New Image Filename)</li>
                <li>انسخ نص الإيميل، أرفق الملفين، وأرسل لمسؤول حسابكم في طلبات</li>
              </ol>
              <div className="flex flex-wrap gap-2">
                <button type="button" className="btn text-xs disabled:opacity-50" onClick={downloadSheet} disabled={busy}>
                  ⬇️ ملف الإكسل ({diff.missing.length})
                </button>
                <button type="button" className="btn-ghost text-xs disabled:opacity-50" onClick={downloadImages} disabled={busy}>
                  🖼️ ملف الصور (ZIP)
                </button>
                {emailText ? (
                  <button type="button" className="btn-ghost text-xs" onClick={copyEmail}>
                    ✉️ انسخ نص الإيميل
                  </button>
                ) : null}
              </div>
              {pkgMsg ? <p className="text-xs text-muted">{pkgMsg}</p> : null}
              {emailText ? (
                <pre dir="auto" className="max-h-40 overflow-y-auto whitespace-pre-wrap rounded-lg bg-[#faf6f0] p-3 text-xs text-ink/80">{emailText}</pre>
              ) : null}
              <details>
                <summary className="cursor-pointer text-xs font-semibold text-ink">عرض القائمة ({diff.missing.length})</summary>
                <div className="mt-2 max-h-60 space-y-1 overflow-y-auto text-xs text-muted">
                  {diff.missing.map((m) => <div key={m.product_id}>{m.name_en || m.product_id}{m.sku ? ` — ${m.sku}` : ""}</div>)}
                </div>
              </details>
            </div>
          ) : (
            <div className="card text-center text-sm text-muted">✅ كل المنتجات المؤهلة موجودة في طلبات — ما في شي ناقص.</div>
          )}

          {diff.excludedVariants.length ? (
            <details className="card">
              <summary className="cursor-pointer text-sm font-semibold text-ink">مستبعد — فيه خيارات ({diff.excludedVariants.length})</summary>
              <p className="mt-1 text-xs text-muted">طلبات ما يقبل منتجات بخيارات — هذي ما تنرسل. إذا تبي وحدة منها تروح لطلبات، حوّل كل خيار لمنتج مستقل في الكتالوج.</p>
              <div className="mt-2 max-h-60 space-y-1 overflow-y-auto text-xs text-muted">
                {diff.excludedVariants.map((m) => <div key={m.product_id}>{m.name_en || m.product_id}{m.sku ? ` — ${m.sku}` : ""}</div>)}
              </div>
            </details>
          ) : null}

          {diff.extraOnTalabat.length ? (
            <details className="card">
              <summary className="cursor-pointer text-sm font-semibold text-ink">في طلبات وما تعرّفنا عليه ({diff.extraOnTalabat.length})</summary>
              <p className="mt-1 text-xs text-muted">صفوف في ملف طلبات ما طابقت أي منتج عندنا (SKU أو باركود أو اسم) — راجعها يدويًا.</p>
              <div className="mt-2 max-h-60 space-y-1 overflow-y-auto text-xs text-muted">
                {diff.extraOnTalabat.slice(0, 300).map((m, i) => <div key={i}>{m.name || m.sku}{m.sku && m.name ? ` — ${m.sku}` : ""}</div>)}
              </div>
            </details>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
