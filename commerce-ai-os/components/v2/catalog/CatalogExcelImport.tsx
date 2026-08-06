"use client";

// Malikas V2 — catalog Excel import wizard (Phase UI.6). Client Component.
//
// Steps: upload → sheet (when several) → mapping → preview (tabs / filters /
// search / field picker / row selection) → TWO separate confirmed apply
// flows (updates vs creates) → result report with a formula-safe CSV export.
//
// The wizard is a THIN shell: parsing, matching, planning, duplicate
// detection and every write decision happen server-side; the file itself is
// re-sent with preview and with every apply batch, so the server never
// trusts a plan computed here. Uploading a file writes NOTHING.

import { useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  applyCatalogCreates,
  applyCatalogUpdates,
  inspectCatalogImport,
  previewCatalogImport,
  readSheetHeaders,
  type ImportPreview,
  type PreviewNewGroup,
  type PreviewUpdateRow,
} from "@/app/(v2)/v2/catalog/import/actions";
import SimilarProducts from "@/components/v2/catalog/SimilarProducts";
import { ImagePlaceholder } from "@/components/v2/catalog/CatalogPreviewDialog";
import { CATALOG_FIELD_DEFS, type CatalogImportField, type ColumnMapping } from "@/lib/products/excel-import/core";
import { reportToCsv, RESULT_LABELS, buildCatalogImportReport, type ImportRecordResult } from "@/lib/products/excel-import/report";

const MAX_FILE_BYTES = 15 * 1024 * 1024;
const UPDATE_BATCH = 50;
const CREATE_GROUP_BATCH = 10;
const CREATE_VARIANT_BATCH = 25;

type Step = "upload" | "sheets" | "mapping" | "preview" | "report";

type Tab = "product_updates" | "variant_updates" | "new_products" | "new_variants" | "problems" | "unchanged";

const TAB_LABELS: Record<Tab, string> = {
  product_updates: "تحديثات المنتجات",
  variant_updates: "تحديثات الخيارات",
  new_products: "منتجات جديدة",
  new_variants: "خيارات جديدة",
  problems: "تعارضات وأخطاء",
  unchanged: "بدون تغيير",
};

const STATUS_LABELS: Record<string, string> = {
  matched_sku: "مطابق بواسطة SKU",
  matched_barcode: "مطابق بواسطة الباركود",
  matched_both: "مطابق بواسطة SKU والباركود",
};

function defaultSelectedFields(): Set<CatalogImportField> {
  return new Set(CATALOG_FIELD_DEFS.filter((d) => d.defaultSelected).map((d) => d.field));
}

export default function CatalogExcelImport() {
  const [step, setStep] = useState<Step>("upload");
  const [file, setFile] = useState<File | null>(null);
  const [sheets, setSheets] = useState<{ name: string; rows: number }[]>([]);
  const [sheetName, setSheetName] = useState<string>("");
  const [mapping, setMapping] = useState<ColumnMapping[]>([]);
  const [formulaCells, setFormulaCells] = useState(0);
  const [fields, setFields] = useState<Set<CatalogImportField>>(defaultSelectedFields());
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [tab, setTab] = useState<Tab>("product_updates");
  const [filter, setFilter] = useState<string>("all");
  const [search, setSearch] = useState("");
  const [selectedUpdates, setSelectedUpdates] = useState<Set<number>>(new Set());
  const [selectedGroups, setSelectedGroups] = useState<Set<number>>(new Set());
  const [selectedNewVariants, setSelectedNewVariants] = useState<Set<number>>(new Set());
  const [expandedRow, setExpandedRow] = useState<number | null>(null);
  const [confirm, setConfirm] = useState<"updates" | "creates" | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number; label: string } | null>(null);
  const [results, setResults] = useState<ImportRecordResult[]>([]);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // ── step 1: upload ─────────────────────────────────────────────────────────

  async function onPickFile(f: File | null) {
    setError(null);
    if (!f) return;
    if (f.size > MAX_FILE_BYTES) {
      setError("حجم الملف أكبر من المسموح (15 ميغابايت).");
      return;
    }
    if (!f.name.toLowerCase().endsWith(".xlsx")) {
      setError("نوع الملف غير مدعوم — المطلوب ملف ‎.xlsx.");
      return;
    }
    setFile(f);
    setBusy(true);
    try {
      const fd = new FormData();
      fd.set("file", f);
      const res = await inspectCatalogImport(fd);
      if ("error" in res) {
        setError(res.error);
        setFile(null);
        return;
      }
      setSheets(res.data.sheets);
      if (res.data.headers) {
        setSheetName(res.data.headers.sheetName);
        setMapping(res.data.headers.mapping);
        setFormulaCells(res.data.headers.formulaCells);
        setStep("mapping");
      } else {
        setStep("sheets");
      }
    } finally {
      setBusy(false);
    }
  }

  async function chooseSheet(name: string) {
    if (!file || busy) return;
    setBusy(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.set("file", file);
      fd.set("sheet", name);
      const res = await readSheetHeaders(fd);
      if ("error" in res) {
        setError(res.error);
        return;
      }
      setSheetName(res.data.sheetName);
      setMapping(res.data.mapping);
      setFormulaCells(res.data.formulaCells);
      setStep("mapping");
    } finally {
      setBusy(false);
    }
  }

  // ── step 3: mapping ────────────────────────────────────────────────────────

  function setColumnField(index: number, field: string) {
    setMapping((ms) =>
      ms.map((m) =>
        m.index === index ? { ...m, field: field === "" ? null : (field as CatalogImportField), status: "auto" } : m,
      ),
    );
  }

  const mappingProblem = useMemo(() => {
    const used = new Map<string, number>();
    for (const m of mapping) {
      if (!m.field) continue;
      used.set(m.field, (used.get(m.field) ?? 0) + 1);
    }
    for (const [f, n] of used) if (n > 1) return `الحقل «${CATALOG_FIELD_DEFS.find((d) => d.field === f)?.label ?? f}» مربوط بأكثر من عمود.`;
    if (!used.has("sku") && !used.has("barcode")) return "يجب ربط عمود SKU أو الباركود على الأقل.";
    return null;
  }, [mapping]);

  async function runPreview() {
    if (!file || busy || mappingProblem) return;
    setBusy(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.set("file", file);
      fd.set("sheet", sheetName);
      fd.set("mapping", JSON.stringify(mapping.map((m) => ({ index: m.index, header: m.header, field: m.field }))));
      fd.set("fields", [...fields].join(","));
      const res = await previewCatalogImport(fd);
      if ("error" in res) {
        setError(res.error);
        return;
      }
      setPreview(res.data);
      setSelectedUpdates(new Set(res.data.updates.filter((u) => u.plan.changedCount > 0).map((u) => u.rowNum)));
      setSelectedGroups(new Set(res.data.newGroups.filter((g) => !g.blockedReason).map((g) => g.mainRowNum)));
      setSelectedNewVariants(new Set(res.data.newVariants.filter((v) => !v.blockedReason).map((v) => v.rowNum)));
      setTab(res.data.updates.some((u) => u.recordKind === "product") ? "product_updates" : res.data.newGroups.length > 0 ? "new_products" : "product_updates");
      setStep("preview");
    } finally {
      setBusy(false);
    }
  }

  // ── step 4: preview helpers ────────────────────────────────────────────────

  const visibleUpdates: PreviewUpdateRow[] = useMemo(() => {
    if (!preview) return [];
    const kind = tab === "product_updates" ? "product" : "variant";
    let rows = preview.updates.filter((u) => u.recordKind === kind);
    if (filter === "will_change") rows = rows.filter((u) => u.plan.changedCount > 0);
    if (filter === "warnings") rows = rows.filter((u) => u.plan.changes.some((c) => c.warning || c.error));
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      rows = rows.filter(
        (u) => (u.sku ?? "").toLowerCase().includes(q) || (u.barcode ?? "").includes(q) || u.displayName.toLowerCase().includes(q),
      );
    }
    return rows;
  }, [preview, tab, filter, search]);

  const visibleGroups: PreviewNewGroup[] = useMemo(() => {
    if (!preview) return [];
    let gs = preview.newGroups;
    if (filter === "blocked") gs = gs.filter((g) => g.blockedReason);
    if (filter === "needs_review") gs = gs.filter((g) => g.similar.level !== "none");
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      gs = gs.filter((g) => (g.mainSku ?? "").includes(q) || g.displayName.toLowerCase().includes(q));
    }
    return gs;
  }, [preview, filter, search]);

  function toggle(set: Set<number>, n: number, apply: (s: Set<number>) => void) {
    const next = new Set(set);
    if (next.has(n)) next.delete(n);
    else next.add(n);
    apply(next);
  }

  // ── step 5: apply (batched, separate confirmations) ────────────────────────

  function baseFormData(): FormData {
    const fd = new FormData();
    fd.set("file", file as File);
    fd.set("sheet", sheetName);
    fd.set("mapping", JSON.stringify(mapping.map((m) => ({ index: m.index, header: m.header, field: m.field }))));
    fd.set("fields", [...fields].join(","));
    return fd;
  }

  async function runUpdates() {
    if (!file || !preview || busy) return;
    setConfirm(null);
    setBusy(true);
    setError(null);
    const rows = preview.updates.filter((u) => selectedUpdates.has(u.rowNum));
    const fingerprints: Record<string, string> = {};
    for (const u of rows) fingerprints[String(u.rowNum)] = u.plan.fingerprint;
    const all: ImportRecordResult[] = [];
    try {
      for (let i = 0; i < rows.length; i += UPDATE_BATCH) {
        const batch = rows.slice(i, i + UPDATE_BATCH);
        setProgress({ done: i, total: rows.length, label: "جارٍ تطبيق التحديثات…" });
        const fd = baseFormData();
        fd.set("rows", JSON.stringify(batch.map((b) => b.rowNum)));
        fd.set("fingerprints", JSON.stringify(fingerprints));
        const res = await applyCatalogUpdates(fd);
        if ("error" in res) {
          setError(res.error);
          break;
        }
        all.push(...res.data.results);
      }
      setResults(all);
      setStep("report");
    } finally {
      setProgress(null);
      setBusy(false);
    }
  }

  async function runCreates() {
    if (!file || !preview || busy) return;
    setConfirm(null);
    setBusy(true);
    setError(null);
    const groups = preview.newGroups.filter((g) => selectedGroups.has(g.mainRowNum) && !g.blockedReason);
    const newVars = preview.newVariants.filter((v) => selectedNewVariants.has(v.rowNum) && !v.blockedReason);
    const parentFingerprints: Record<string, string> = {};
    for (const v of newVars) parentFingerprints[String(v.rowNum)] = v.parentFingerprint;
    const all: ImportRecordResult[] = [];
    try {
      const total = groups.length + newVars.length;
      let done = 0;
      for (let i = 0; i < groups.length; i += CREATE_GROUP_BATCH) {
        const batch = groups.slice(i, i + CREATE_GROUP_BATCH);
        setProgress({ done, total, label: "جارٍ إنشاء المنتجات الجديدة…" });
        const fd = baseFormData();
        fd.set("groups", JSON.stringify(batch.map((g) => g.mainRowNum)));
        fd.set("newVariants", JSON.stringify([]));
        fd.set("parentFingerprints", JSON.stringify({}));
        const res = await applyCatalogCreates(fd);
        if ("error" in res) {
          setError(res.error);
          break;
        }
        all.push(...res.data.results);
        done += batch.length;
      }
      for (let i = 0; i < newVars.length; i += CREATE_VARIANT_BATCH) {
        const batch = newVars.slice(i, i + CREATE_VARIANT_BATCH);
        setProgress({ done, total, label: "جارٍ إضافة الخيارات الجديدة…" });
        const fd = baseFormData();
        fd.set("groups", JSON.stringify([]));
        fd.set("newVariants", JSON.stringify(batch.map((v) => v.rowNum)));
        fd.set("parentFingerprints", JSON.stringify(parentFingerprints));
        const res = await applyCatalogCreates(fd);
        if ("error" in res) {
          setError(res.error);
          break;
        }
        all.push(...res.data.results);
        done += batch.length;
      }
      setResults(all);
      setStep("report");
    } finally {
      setProgress(null);
      setBusy(false);
    }
  }

  function downloadCsv() {
    const csv = reportToCsv(results);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "catalog-import-report.csv";
    a.click();
    URL.revokeObjectURL(url);
  }

  // ── render ─────────────────────────────────────────────────────────────────

  const summary = preview ? buildCatalogImportReport(results) : null;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-lg font-semibold text-ink">تحديث الكتالوج من Excel</h1>
        <Link href="/v2/catalog" className="btn-ghost" aria-disabled={busy}>
          رجوع للكتالوج
        </Link>
      </div>

      {error ? (
        <div role="alert" className="card border-rose-200 bg-rose-50 text-sm text-rose-700">
          {error}
        </div>
      ) : null}

      {progress ? (
        <div className="card space-y-2">
          <div className="text-sm text-ink">{progress.label}</div>
          <div className="h-2 w-full overflow-hidden rounded-full bg-[#f1e6d8]">
            <div
              className="h-2 rounded-full bg-brand transition-all"
              style={{ width: `${progress.total === 0 ? 0 : Math.round((progress.done / progress.total) * 100)}%` }}
            />
          </div>
          <div className="text-xs text-muted">
            {progress.done} / {progress.total}
          </div>
        </div>
      ) : null}

      {/* Step 1: upload */}
      {step === "upload" ? (
        <section className="card space-y-3">
          <h2 className="text-sm font-semibold text-ink">١ · رفع ملف Excel</h2>
          <p className="text-xs text-muted">
            ‎.xlsx فقط · حتى 15 ميغابايت · حتى 5000 صف. رفع الملف لا يحفظ ولا يغيّر أي شيء — كل تعديل يمر بمعاينة وتأكيد.
          </p>
          <input
            ref={fileInputRef}
            id="import-file"
            type="file"
            accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            className="hidden"
            onChange={(e) => void onPickFile(e.target.files?.[0] ?? null)}
          />
          <button type="button" className="btn-primary disabled:opacity-60" disabled={busy} onClick={() => fileInputRef.current?.click()}>
            {busy ? "جارٍ الفحص…" : "اختيار ملف Excel"}
          </button>
        </section>
      ) : null}

      {/* Step 2: sheet selection */}
      {step === "sheets" ? (
        <section className="card space-y-3">
          <h2 className="text-sm font-semibold text-ink">٢ · اختيار الورقة</h2>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {sheets.map((s) => (
              <button key={s.name} type="button" disabled={busy} onClick={() => void chooseSheet(s.name)} className="rounded-xl border border-[#efe3d6] bg-white p-3 text-right hover:shadow-md">
                <div className="text-sm font-semibold text-ink">{s.name}</div>
                <div className="text-xs text-muted">≈ {s.rows} صفًا</div>
              </button>
            ))}
          </div>
        </section>
      ) : null}

      {/* Step 3: mapping */}
      {step === "mapping" ? (
        <section className="card space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-semibold text-ink">٣ · ربط الأعمدة (عمود Excel ← حقل الكتالوج)</h2>
            <span className="text-xs text-muted">الورقة: {sheetName}</span>
          </div>
          {formulaCells > 0 ? (
            <p className="text-xs text-amber-700">الملف يحتوي {formulaCells} خلية معادلات — ستُقرأ القيم المحفوظة فقط ولن تُنفَّذ أي معادلة.</p>
          ) : null}
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-right text-xs text-muted">
                  <th className="p-2">عمود Excel</th>
                  <th className="p-2">حقل الكتالوج</th>
                  <th className="p-2">الحالة</th>
                </tr>
              </thead>
              <tbody>
                {mapping.map((m) => (
                  <tr key={m.index} className="border-t border-[#f5ece1]">
                    <td className="p-2 font-medium text-ink" dir="ltr">{m.header || `عمود ${m.index + 1}`}</td>
                    <td className="p-2">
                      <select className="select-input" value={m.field ?? ""} onChange={(e) => setColumnField(m.index, e.target.value)}>
                        <option value="">— غير مستخدم —</option>
                        {CATALOG_FIELD_DEFS.map((d) => (
                          <option key={d.field} value={d.field}>
                            {d.label}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="p-2 text-xs">
                      {m.status === "auto" && m.field ? <span className="text-emerald-700">تم التعرف عليه تلقائيًا</span> : null}
                      {m.status === "needs_confirm" ? <span className="text-amber-700">يحتاج تأكيد</span> : null}
                      {m.status === "ignored" ? <span className="text-muted">غير مستخدم (محظور من الاستيراد)</span> : null}
                      {m.status === "unknown" && !m.field ? <span className="text-muted">غير معروف</span> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="space-y-2 border-t border-[#f5ece1] pt-3">
            <h3 className="text-xs font-semibold text-ink">الحقول المسموح بتحديثها في هذه العملية</h3>
            <div className="flex flex-wrap gap-2">
              {CATALOG_FIELD_DEFS.map((d) => (
                <label key={d.field} className={"flex items-center gap-1 rounded-full border px-2 py-1 text-xs " + (fields.has(d.field) ? "border-brand bg-brand-light text-brand" : "border-[#efe3d6] text-muted")}>
                  <input
                    type="checkbox"
                    className="accent-current"
                    checked={fields.has(d.field)}
                    onChange={() => {
                      const next = new Set(fields);
                      if (next.has(d.field)) next.delete(d.field);
                      else next.add(d.field);
                      setFields(next);
                    }}
                  />
                  {d.label}
                </label>
              ))}
            </div>
            <p className="text-xs text-muted">الافتراضي الآمن: الاسم والوصف والسعر فقط. SKU والباركود والاعتماد غير محددة افتراضيًا.</p>
          </div>

          {mappingProblem ? <p className="text-sm text-rose-700">{mappingProblem}</p> : null}
          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn-primary disabled:opacity-60" disabled={busy || !!mappingProblem} onClick={() => void runPreview()}>
              {busy ? "جارٍ التحليل والمطابقة…" : "تحليل ومعاينة"}
            </button>
            <button type="button" className="btn-ghost" disabled={busy} onClick={() => setStep(sheets.length > 1 ? "sheets" : "upload")}>
              رجوع
            </button>
          </div>
        </section>
      ) : null}

      {/* Step 4: preview */}
      {step === "preview" && preview ? (
        <>
          {preview.partialSnapshot ? (
            <div className="card border-amber-200 bg-amber-50 text-sm text-amber-800">تم فحص جزء من الكتالوج فقط ضمن الحد الآمن للقراءة.</div>
          ) : null}

          {/* tabs */}
          <div className="flex flex-wrap gap-2">
            {(Object.keys(TAB_LABELS) as Tab[]).map((t) => {
              const count =
                t === "product_updates" ? preview.summary.productUpdates
                : t === "variant_updates" ? preview.summary.variantUpdates
                : t === "new_products" ? preview.summary.newProducts
                : t === "new_variants" ? preview.summary.newVariants
                : t === "problems" ? preview.summary.problems
                : preview.summary.unchanged;
              return (
                <button
                  key={t}
                  type="button"
                  onClick={() => { setTab(t); setFilter("all"); }}
                  className={"rounded-full px-3 py-1 text-xs font-medium " + (tab === t ? "bg-brand text-white" : "bg-[#f5ece1] text-ink")}
                >
                  {TAB_LABELS[t]} ({count})
                </button>
              );
            })}
          </div>

          {/* search + filter */}
          <div className="card grid grid-cols-1 gap-3 sm:grid-cols-3">
            <label className="flex flex-col gap-1 sm:col-span-2">
              <span className="label">بحث (SKU أو باركود أو اسم)</span>
              <input className="input" value={search} onChange={(e) => setSearch(e.target.value)} />
            </label>
            <label className="flex flex-col gap-1">
              <span className="label">فلتر</span>
              <select className="select-input" value={filter} onChange={(e) => setFilter(e.target.value)}>
                <option value="all">الكل</option>
                <option value="will_change">سيتغير</option>
                <option value="warnings">تحذيرات وأخطاء</option>
                <option value="blocked">متعارض</option>
                <option value="needs_review">يحتاج مراجعة</option>
              </select>
            </label>
          </div>

          {/* updates tabs */}
          {tab === "product_updates" || tab === "variant_updates" ? (
            <section className="card space-y-2">
              {visibleUpdates.length === 0 ? (
                <p className="text-sm text-muted">لا توجد صفوف مطابقة.</p>
              ) : (
                visibleUpdates.map((u) => (
                  <div key={u.rowNum} className="rounded-xl border border-[#efe3d6] bg-white p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <label className="flex items-center gap-2 text-sm font-semibold text-ink">
                        <input
                          type="checkbox"
                          checked={selectedUpdates.has(u.rowNum)}
                          disabled={u.plan.changedCount === 0}
                          onChange={() => toggle(selectedUpdates, u.rowNum, setSelectedUpdates)}
                        />
                        {u.displayName}
                      </label>
                      <div className="flex items-center gap-2 text-xs text-muted">
                        <span dir="ltr">{u.sku ?? "—"}</span>
                        <span>صف {u.rowNum}</span>
                        <span>{STATUS_LABELS[u.matchStatus] ?? u.matchStatus}</span>
                        <span>{u.plan.changedCount} حقول ستتغير</span>
                        <button type="button" className="btn-ghost text-xs" onClick={() => setExpandedRow(expandedRow === u.rowNum ? null : u.rowNum)}>
                          {expandedRow === u.rowNum ? "إخفاء" : "عرض التفاصيل"}
                        </button>
                      </div>
                    </div>
                    {expandedRow === u.rowNum ? (
                      <div className="mt-2 overflow-x-auto border-t border-[#f5ece1] pt-2">
                        <table className="w-full text-xs">
                          <thead>
                            <tr className="text-right text-muted">
                              <th className="p-1">الحقل</th>
                              <th className="p-1">القيمة الحالية</th>
                              <th className="p-1">قيمة Excel</th>
                              <th className="p-1">القرار</th>
                            </tr>
                          </thead>
                          <tbody>
                            {u.plan.changes.map((c) => (
                              <tr
                                key={c.field}
                                className={
                                  c.error ? "bg-rose-50 text-rose-700"
                                  : c.warning ? "bg-amber-50 text-amber-800"
                                  : c.equal ? "text-muted"
                                  : c.decision === "update" ? "bg-emerald-50 text-emerald-800"
                                  : "text-muted"
                                }
                              >
                                <td className="p-1 font-medium">{c.label}</td>
                                <td className="p-1">{c.current ?? "—"}</td>
                                <td className="p-1">{c.excel ?? "— (مسح)"}</td>
                                <td className="p-1">
                                  {c.error ?? c.warning ?? (c.equal ? "لا تغيير" : c.decision === "update" ? "تحديث" : "تجاهل")}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    ) : null}
                  </div>
                ))
              )}
            </section>
          ) : null}

          {/* new products tab */}
          {tab === "new_products" ? (
            <section className="space-y-3">
              {visibleGroups.length === 0 ? (
                <div className="card text-sm text-muted">لا توجد منتجات جديدة.</div>
              ) : (
                visibleGroups.map((g) => (
                  <div key={g.mainRowNum} className={"card space-y-2 " + (g.blockedReason ? "border-rose-200" : "")}>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <label className="flex items-center gap-2 text-sm font-semibold text-ink">
                        <input
                          type="checkbox"
                          checked={selectedGroups.has(g.mainRowNum)}
                          disabled={!!g.blockedReason}
                          onChange={() => toggle(selectedGroups, g.mainRowNum, setSelectedGroups)}
                        />
                        {g.displayName}
                      </label>
                      <div className="flex items-center gap-2 text-xs text-muted">
                        <span dir="ltr">{g.mainSku ?? "SKU سيُولّد"}</span>
                        <span>صف {g.mainRowNum}</span>
                        {g.variants.length > 0 ? <span>{g.variants.length} خيارات</span> : null}
                        <span className="rounded-full bg-amber-50 px-2 py-0.5 text-amber-700">يحتاج صورة</span>
                      </div>
                    </div>
                    {g.blockedReason ? <p className="text-sm text-rose-700">{g.blockedReason}</p> : null}
                    {g.missing.length > 0 ? <p className="text-xs text-muted">ناقص: {g.missing.join("، ")}</p> : null}
                    {g.variants.length > 0 ? (
                      <div className="text-xs text-muted">
                        الخيارات: {g.variants.map((v) => v.sku ?? v.name).join(" · ")}
                      </div>
                    ) : null}
                    {g.similar.level !== "none" ? (
                      <SimilarProducts level={g.similar.level} cards={g.similar.cards} total={g.similar.total} />
                    ) : null}
                    <p className="text-xs text-muted">
                      سيُنشأ غير معتمد وبدون أي مزامنة، ثم أكمل صورته من «تعديل المنتج» أو{" "}
                      <Link href="/v2/catalog/new" className="underline">منشئ الذكاء الاصطناعي</Link>.
                    </p>
                  </div>
                ))
              )}
            </section>
          ) : null}

          {/* new variants tab */}
          {tab === "new_variants" ? (
            <section className="space-y-3">
              {preview.newVariants.length === 0 ? (
                <div className="card text-sm text-muted">لا توجد خيارات جديدة لمنتجات موجودة.</div>
              ) : (
                preview.newVariants.map((v) => (
                  <div key={v.rowNum} className="card space-y-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <label className="flex items-center gap-2 text-sm font-semibold text-ink">
                        <input type="checkbox" checked={selectedNewVariants.has(v.rowNum)} onChange={() => toggle(selectedNewVariants, v.rowNum, setSelectedNewVariants)} />
                        خيار جديد: {v.name}
                      </label>
                      <span className="text-xs text-muted" dir="ltr">{v.sku}</span>
                    </div>
                    {v.parent ? (
                      <div className="flex items-center gap-3 rounded-lg border border-[#efe3d6] p-2">
                        {v.parent.imageUrl ? (
                          // eslint-disable-next-line @next/next/no-img-element -- catalog image URL
                          <img src={v.parent.imageUrl} alt={v.parent.nameAr ?? ""} className="h-12 w-12 rounded-lg border border-[#efe3d6] object-cover" />
                        ) : (
                          <ImagePlaceholder className="h-12 w-12" />
                        )}
                        <div className="min-w-0 text-xs text-muted">
                          <div className="truncate text-sm font-medium text-ink">{v.parent.nameAr ?? v.parent.nameEn ?? v.parent.sku}</div>
                          <div dir="ltr">{v.parent.sku} · {v.parent.variantCount} خيارات حالية</div>
                        </div>
                      </div>
                    ) : null}
                    <p className="text-xs text-muted">سيُضاف إلى خيارات المنتج الحالية دون أي تغيير أو إعادة ترقيم لها.</p>
                  </div>
                ))
              )}
            </section>
          ) : null}

          {/* problems tab */}
          {tab === "problems" ? (
            <section className="card space-y-1">
              {preview.problems.length === 0 ? (
                <p className="text-sm text-muted">لا توجد تعارضات أو أخطاء.</p>
              ) : (
                preview.problems.map((pr) => (
                  <div key={`${pr.rowNum}-${pr.message}`} className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-rose-50 p-2 text-xs text-rose-700">
                    <span>صف {pr.rowNum} · {pr.kind === "variant" ? "خيار منتج" : pr.kind === "product" ? "منتج رئيسي" : "غير معروف"}</span>
                    <span dir="ltr">{pr.sku ?? pr.barcode ?? "—"}</span>
                    <span>{pr.message}</span>
                  </div>
                ))
              )}
            </section>
          ) : null}

          {/* unchanged tab */}
          {tab === "unchanged" ? (
            <section className="card text-sm text-muted">
              {preview.unchangedRows.length === 0 ? "لا توجد صفوف بدون تغيير." : `${preview.unchangedRows.length} صفًا مطابقًا للكتالوج تمامًا — لن يتغير.`}
            </section>
          ) : null}

          {/* apply bars — TWO separate operations */}
          <div className="card flex flex-wrap items-center gap-2">
            <button type="button" className="btn-primary disabled:opacity-60" disabled={busy || selectedUpdates.size === 0} onClick={() => setConfirm("updates")}>
              تطبيق تحديثات المنتجات المحددة ({selectedUpdates.size})
            </button>
            <button
              type="button"
              className="btn-primary disabled:opacity-60"
              disabled={busy || selectedGroups.size + selectedNewVariants.size === 0}
              onClick={() => setConfirm("creates")}
            >
              إنشاء المنتجات الجديدة المحددة ({selectedGroups.size + selectedNewVariants.size})
            </button>
            <button type="button" className="btn-ghost" disabled={busy} onClick={() => setStep("mapping")}>
              رجوع للربط
            </button>
          </div>
        </>
      ) : null}

      {/* confirmation dialogs */}
      {confirm && preview ? (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-4 sm:items-center" role="dialog" aria-modal="true">
          <div className="w-full max-w-lg space-y-3 rounded-2xl bg-white p-5">
            {confirm === "updates" ? (
              <>
                <h2 className="text-base font-semibold text-ink">تأكيد تحديث المنتجات</h2>
                <ul className="space-y-1 text-sm text-muted">
                  <li>منتجات مختارة: {preview.updates.filter((u) => selectedUpdates.has(u.rowNum) && u.recordKind === "product").length}</li>
                  <li>خيارات مختارة: {preview.updates.filter((u) => selectedUpdates.has(u.rowNum) && u.recordKind === "variant").length}</li>
                  <li>الحقول المفعّلة: {[...fields].map((f) => CATALOG_FIELD_DEFS.find((d) => d.field === f)?.label ?? f).join("، ") || "—"}</li>
                  <li>تعارضات مستبعدة: {preview.summary.problems}</li>
                </ul>
                <p className="text-xs text-muted">سيُعاد التحقق من كل سجل وقت التطبيق، وأي سجل تغيّر بعد المعاينة سيُتخطى بأمان.</p>
                <div className="flex gap-2">
                  <button type="button" className="btn-primary" onClick={() => void runUpdates()}>تأكيد التحديث</button>
                  <button type="button" className="btn-ghost" onClick={() => setConfirm(null)}>إلغاء</button>
                </div>
              </>
            ) : (
              <>
                <h2 className="text-base font-semibold text-ink">تأكيد إنشاء المنتجات الجديدة</h2>
                <ul className="space-y-1 text-sm text-muted">
                  <li>منتجات جديدة: {selectedGroups.size}</li>
                  <li>خيارات تابعة: {preview.newGroups.filter((g) => selectedGroups.has(g.mainRowNum)).reduce((n, g) => n + g.variants.length, 0)}</li>
                  <li>خيارات لمنتجات موجودة: {selectedNewVariants.size}</li>
                  <li>تحتاج صورة لاحقًا: {selectedGroups.size}</li>
                  <li>تحتوي تشابهًا محتملًا: {preview.newGroups.filter((g) => selectedGroups.has(g.mainRowNum) && g.similar.level !== "none").length}</li>
                </ul>
                <p className="text-xs text-muted">كل منتج جديد يُنشأ غير معتمد، بلا نشر ولا مزامنة لأي منصة، وSKU/الباركود يُعاد فحصهما وقت الإنشاء.</p>
                <div className="flex gap-2">
                  <button type="button" className="btn-primary" onClick={() => void runCreates()}>تأكيد الإنشاء</button>
                  <button type="button" className="btn-ghost" onClick={() => setConfirm(null)}>إلغاء</button>
                </div>
              </>
            )}
          </div>
        </div>
      ) : null}

      {/* Step 6: report */}
      {step === "report" ? (
        <section className="card space-y-3">
          <h2 className="text-sm font-semibold text-ink">تقرير النتائج</h2>
          {summary ? (
            <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-5">
              <div className="rounded-lg bg-emerald-50 p-2 text-emerald-700">منتجات محدّثة: {summary.productUpdated}</div>
              <div className="rounded-lg bg-emerald-50 p-2 text-emerald-700">خيارات محدّثة: {summary.variantUpdated}</div>
              <div className="rounded-lg bg-emerald-50 p-2 text-emerald-700">منتجات منشأة: {summary.productCreated}</div>
              <div className="rounded-lg bg-emerald-50 p-2 text-emerald-700">خيارات منشأة: {summary.variantCreated}</div>
              <div className="rounded-lg bg-[#f5ece1] p-2 text-ink">تم التخطي: {summary.skipped}</div>
              <div className="rounded-lg bg-rose-50 p-2 text-rose-700">تعارض: {summary.conflict}</div>
              <div className="rounded-lg bg-rose-50 p-2 text-rose-700">فشل: {summary.failed}</div>
              <div className="rounded-lg bg-amber-50 p-2 text-amber-700">تغير بعد المعاينة: {summary.changedAfterPreview}</div>
              <div className="rounded-lg bg-amber-50 p-2 text-amber-700">يحتاج مراجعة: {summary.needsReview}</div>
              <div className="rounded-lg bg-amber-50 p-2 text-amber-700">يحتاج صورة: {summary.needsImage}</div>
            </div>
          ) : null}
          <div className="max-h-96 overflow-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-right text-muted">
                  <th className="p-1">صف</th>
                  <th className="p-1">النوع</th>
                  <th className="p-1">SKU</th>
                  <th className="p-1">الحالة</th>
                  <th className="p-1">الرسالة</th>
                </tr>
              </thead>
              <tbody>
                {results.map((r, i) => (
                  <tr key={`${r.rowNum}-${i}`} className="border-t border-[#f5ece1]">
                    <td className="p-1">{r.rowNum}</td>
                    <td className="p-1">{r.recordKind === "product" ? "منتج رئيسي" : "خيار منتج"}</td>
                    <td className="p-1" dir="ltr">{r.sku ?? "—"}</td>
                    <td className="p-1">{RESULT_LABELS[r.status]}</td>
                    <td className="p-1">{r.message}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn-ghost" onClick={downloadCsv}>
              تنزيل تقرير CSV
            </button>
            <button type="button" className="btn-ghost" onClick={() => setStep("preview")}>
              رجوع للمعاينة
            </button>
            <Link href="/v2/catalog" className="btn-primary">
              فتح الكتالوج
            </Link>
          </div>
        </section>
      ) : null}
    </div>
  );
}
