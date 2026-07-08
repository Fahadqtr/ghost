"use client";

import { useState, useTransition } from "react";
import * as XLSX from "xlsx";
import { computeTalabatDiff, buildTalabatPackage, verifyCatalogEntries, type TalabatDiff, type VerifySummary } from "@/app/(app)/import-export/talabat-actions";

// Talabat catalog gap-closer: upload Talabat's own export, see which of OUR
// sellable products are missing over there, then download the "please add
// these" package: a sheet in Talabat's exact 10-column format (products with
// options are split into one standalone row per option — Talabat rejects
// variant products) + the matching images ZIP + a ready email text.

export default function TalabatSync() {
  const [diff, setDiff] = useState<TalabatDiff | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pkgMsg, setPkgMsg] = useState("");
  const [emailText, setEmailText] = useState("");
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [rawRows, setRawRows] = useState<Record<string, unknown>[]>([]);
  const [verify, setVerify] = useState<VerifySummary | null>(null);
  const [verifyMsg, setVerifyMsg] = useState("");
  const [busy, start] = useTransition();

  // Everything is included by default; unchecking a row drops it from BOTH
  // the Excel sheet and the images ZIP.
  const chosen = (diff?.missing ?? []).filter((m) => !excluded.has(m.product_id));
  const toggleRow = (id: string) =>
    setExcluded((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setError(null); setDiff(null); setPkgMsg(""); setEmailText(""); setExcluded(new Set()); setVerify(null); setVerifyMsg(""); setRawRows([]);
    start(async () => {
      try {
        const wb = XLSX.read(await file.arrayBuffer(), { type: "array" });
        const sheetName = wb.SheetNames[0];
        const raw: Record<string, unknown>[] = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { defval: "" });
        const d = await computeTalabatDiff(raw);
        if (!d.ok) { setError(d.error ?? "فشل التحليل."); return; }
        setDiff(d);
        setRawRows(raw);
      } catch (err) {
        setError(err instanceof Error ? err.message : "تعذّر قراءة الملف.");
      }
    });
  }

  const downloadSheet = () => {
    if (!chosen.length) return;
    setPkgMsg("…يجهّز ملف الإكسل");
    start(async () => {
      const pkg = await buildTalabatPackage(chosen.map((m) => m.product_id));
      if (!pkg.ok) { setPkgMsg(`❌ ${pkg.error}`); return; }
      const ws = XLSX.utils.json_to_sheet(pkg.rows, { header: pkg.headers });
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "Talabat");
      XLSX.writeFile(wb, `talabat-new-products-${pkg.rows.length}.xlsx`);
      setEmailText(pkg.emailText);
      const warn = [
        pkg.noPrice.length ? `⛔ ${pkg.noPrice.length} صف بدون سعر (${pkg.noPrice.slice(0, 3).map((x) => x.sku || x.name_en).join("، ")}…) — عدّلها قبل الإرسال` : "",
        pkg.splitProducts ? `🔀 ${pkg.splitProducts} منتج بخيارات انقسم لصفوف مستقلة` : "",
        pkg.noImage.length ? `⚠️ ${pkg.noImage.length} بدون صورة (${pkg.noImage.slice(0, 3).map((x) => x.sku || x.name_en).join("، ")}…)` : "",
        pkg.emptyDesc.length ? `⚠️ ${pkg.emptyDesc.length} بدون وصف إنجليزي` : "",
      ].filter(Boolean).join(" · ");
      setPkgMsg(`✅ نزل الملف (${pkg.rows.length} صف)${warn ? ` — ${warn}` : ""}`);
    });
  };

  const downloadImages = () => {
    if (!chosen.length) return;
    setPkgMsg("…يضغط الصور (قد يأخذ دقائق حسب العدد) — خلّ الصفحة مفتوحة");
    start(async () => {
      try {
        const skus = chosen.map((m) => m.sku).filter(Boolean);
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

  // Same uploaded file doubles as the ground truth for staff-entry checks.
  const runVerify = () => {
    if (!rawRows.length) return;
    setVerifyMsg("…يتحقق من مهام الكتالوج ضد ملف المنصة");
    start(async () => {
      const r = await verifyCatalogEntries(rawRows);
      if (!r.ok) { setVerifyMsg(`❌ ${r.error}`); return; }
      setVerify(r);
      setVerifyMsg(
        r.checked === 0
          ? "ما في مهام كتالوج للتحقق منها (آخر 45 يوم)."
          : `اكتمل: ${r.confirmed} مؤكد ✅${r.autoClosed ? ` (منها ${r.autoClosed} انقفلت تلقائيًا)` : ""}${r.reopened ? ` · ${r.reopened} رجعت مفتوحة ❌` : ""}`,
      );
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
        ["ناقص فيه خيارات (ينقسم)", diff.counts.withOptions],
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
            ارفع تصدير الكتالوج من لوحة طلبات → نطلع لك المنتجات الناقصة عندهم → نزّل ملف الإكسل بصيغتهم
            + الصور وأرسلهم بالإيميل. المنتجات اللي فيها خيارات تنقسم تلقائيًا لصفوف مستقلة (لأن طلبات ما يقبل الخيارات).
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

          <div className="card space-y-2">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h3 className="text-sm font-semibold text-ink">🕵️ التحقق من إدخالات الموظفين</h3>
                <p className="text-xs text-muted">
                  يطابق مهام الكتالوج (آخر 45 يوم) مع هذا الملف: المهمة المنفذة صح تتأكد ✅ وتنقفل،
                  والمعلّمة «تم» بدون ما توصل المنصة ترجع مفتوحة ❌ مع تعليق يشرح المشكلة.
                </p>
              </div>
              <button type="button" className="btn whitespace-nowrap text-sm disabled:opacity-50" onClick={runVerify} disabled={busy || !rawRows.length}>
                🕵️ تحقق الآن
              </button>
            </div>
            {verifyMsg ? <p className="text-xs text-muted">{verifyMsg}</p> : null}
            {verify?.flagged.length ? (
              <div className="max-h-60 space-y-1.5 overflow-y-auto">
                {verify.flagged.map((f, i) => (
                  <div key={i} className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-800">
                    <span className="font-semibold">{f.title}</span>
                    <span className="block">{f.detail}</span>
                  </div>
                ))}
              </div>
            ) : null}
          </div>

          {diff.missing.length ? (
            <div className="card space-y-3">
              <h3 className="text-sm font-semibold text-ink">🚀 جاهز للإرسال لطلبات ({chosen.length} من {diff.missing.length})</h3>
              {diff.counts.noPrice ? (
                <p className="rounded-lg bg-red-50 px-3 py-2 text-xs font-semibold text-red-700">
                  ⛔ {diff.counts.noPrice} منتج بدون سعر — اضغط ✏️ وحط السعر (أو شِل الصح عنه) قبل التنزيل.
                </p>
              ) : null}
              <ol className="list-decimal space-y-1 pr-5 text-xs text-muted">
                <li>راجع القائمة تحت — شِل الصح عن أي منتج ما تبي يروح، واضغط ✏️ لتعديل بياناته قبل الإرسال</li>
                <li>نزّل ملف الإكسل (بصيغة طلبات بالضبط — 10 أعمدة، وكل خيار بصف مستقل)</li>
                <li>نزّل ملف الصور المضغوط (اسم كل صورة يطابق عمود New Image Filename)</li>
                <li>انسخ نص الإيميل، أرفق الملفين، وأرسل لمسؤول حسابكم في طلبات</li>
              </ol>
              <div className="flex flex-wrap gap-2">
                <button type="button" className="btn text-xs disabled:opacity-50" onClick={downloadSheet} disabled={busy || !chosen.length}>
                  ⬇️ ملف الإكسل ({chosen.length})
                </button>
                <button type="button" className="btn-ghost text-xs disabled:opacity-50" onClick={downloadImages} disabled={busy || !chosen.length}>
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
              <p className="text-[11px] text-muted">💡 عدّلت منتجًا؟ التعديل ينحفظ في الكتالوج فورًا — نزّل ملف الإكسل من جديد بعد التعديل.</p>
              <div className="max-h-96 space-y-2 overflow-y-auto">
                {diff.missing.map((m) => (
                  <div key={m.product_id} className={`flex items-center gap-2 rounded-xl border border-[#efe3d6] p-2 ${excluded.has(m.product_id) ? "bg-slate-50 opacity-60" : "bg-white/60"}`}>
                    <input type="checkbox" checked={!excluded.has(m.product_id)} onChange={() => toggleRow(m.product_id)} className="h-4 w-4 shrink-0" />
                    {m.image_url ? (
                      /* eslint-disable-next-line @next/next/no-img-element */
                      <img src={m.image_url} alt="" loading="lazy" className="h-12 w-12 shrink-0 rounded-lg border border-[#efe3d6] bg-white object-cover" />
                    ) : (
                      <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg border border-dashed border-amber-300 bg-amber-50 text-[10px] text-amber-700">بدون صورة</div>
                    )}
                    <div className="min-w-0 flex-1 text-xs">
                      <p className="truncate font-semibold text-ink">{m.name_en || m.product_id}</p>
                      <p className="mt-0.5 text-muted">
                        {m.sku ?? "—"}
                        {m.hasVariants ? <span className="mr-1 rounded bg-amber-100 px-1 text-[10px] text-amber-800">🔀 ينقسم لخيارات</span> : null}
                        {m.noPrice ? <span className="mr-1 rounded bg-red-100 px-1 text-[10px] font-semibold text-red-700">⛔ بدون سعر</span> : null}
                      </p>
                    </div>
                    <a href={`/products/${m.product_id}`} target="_blank" rel="noreferrer" className="btn-ghost shrink-0 px-2 py-1 text-xs">✏️ تعديل</a>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="card text-center text-sm text-muted">✅ كل المنتجات المؤهلة موجودة في طلبات — ما في شي ناقص.</div>
          )}

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
