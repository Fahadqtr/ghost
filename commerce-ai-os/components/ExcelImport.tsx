"use client";

import { useState } from "react";
import Link from "next/link";
import * as XLSX from "xlsx";
import { importProducts, type ImportRow } from "@/app/(app)/import-export/actions";
import type { Locale } from "@/lib/i18n";

// Map normalized spreadsheet headers -> product field keys (the 28-col master sheet).
const HEADER_MAP: Record<string, string> = {
  sku: "sku", barcode: "barcode",
  nameen: "name_en", namear: "name_ar",
  englishname: "name_en", arabicname: "name_ar",
  brand: "brand", brandname: "brand",
  category: "main_category", maincategory: "main_category",
  subcategory: "sub_category",
  producttype: "product_type", type: "product_type",
  color: "color", size: "size",
  price: "price", discountprice: "discount_price",
  cost: "cost",
  stockquantity: "stock_quantity", quantity: "stock_quantity", qty: "stock_quantity", stock: "stock_quantity",
  stockstatus: "stock_status",
  platformstatus: "platform_status",
  imagefilename: "image_filename", imagename: "image_filename",
  imageurl: "image_url", image: "image_url",
  descriptionen: "description_en", descriptionar: "description_ar",
  keywordsen: "keywords_en", keywordsar: "keywords_ar",
  notes: "notes",
};

const PREVIEW_COLS = [
  "sku", "name_en", "brand", "main_category", "price", "stock_quantity",
];

function normalize(h: string) {
  return h.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export default function ExcelImport({ locale = "ar" }: { locale?: Locale }) {
  const en = locale === "en";
  const L = (ar: string, e: string) => (en ? e : ar);
  const [rows, setRows] = useState<ImportRow[]>([]);
  const [fileName, setFileName] = useState("");
  const [unmapped, setUnmapped] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [isSnoonu, setIsSnoonu] = useState(false);

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    setError(null); setResult(null); setRows([]); setUnmapped([]); setIsSnoonu(false);
    const file = e.target.files?.[0];
    if (!file) return;
    setFileName(file.name);

    try {
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { type: "array" });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      const raw: Record<string, unknown>[] = XLSX.utils.sheet_to_json(sheet, { defval: "" });

      if (raw.length === 0) { setError(L("الورقة الأولى لا تحتوي على أي صفوف.", "The first sheet has no rows.")); return; }

      const headers = Object.keys(raw[0]);
      // A Snoonu "AllExportData" file → wrong importer. Route to Snoonu Sync
      // instead of mangling it here (it matches by SPI id, not by SKU).
      if (headers.some((h) => normalize(h) === "spiuniqueidentifier")) { setIsSnoonu(true); return; }
      const mapping: Record<string, string> = {};
      const notMapped: string[] = [];
      for (const h of headers) {
        const field = HEADER_MAP[normalize(h)];
        if (field) mapping[h] = field;
        else notMapped.push(h);
      }

      const mapped: ImportRow[] = raw.map((r) => {
        const out: ImportRow = {};
        for (const [header, field] of Object.entries(mapping)) {
          out[field] = String(r[header] ?? "").trim();
        }
        return out;
      });

      setRows(mapped);
      setUnmapped(notMapped);
    } catch (err) {
      setError(err instanceof Error ? err.message : L("تعذّر تحليل الملف.", "Could not parse the file."));
    }
  }

  async function commit() {
    if (!confirm(L(`استيراد ${rows.length} منتج إلى قاعدة البيانات؟ هذا يكتب صفوفًا حقيقية.`, `Import ${rows.length} product(s) into the database? This writes real rows.`))) return;
    setBusy(true); setError(null); setResult(null);
    const res = await importProducts(rows);
    setBusy(false);
    if (res?.error) {
      setError(res.error + (res.skipped?.length ? `\n${L("تم تخطّي:", "Skipped:")}\n- ${res.skipped.join("\n- ")}` : ""));
      return;
    }
    let msg = L(`تم استيراد ${res?.imported ?? 0} منتج.`, `Imported ${res?.imported ?? 0} product(s).`);
    if (res?.skipped?.length) msg += L(` تم تخطّي ${res.skipped.length}: ${res.skipped.join("; ")}`, ` Skipped ${res.skipped.length}: ${res.skipped.join("; ")}`);
    setResult(msg);
    setRows([]);
  }

  return (
    <div className="card space-y-3">
      <div>
        <h3 className="text-sm font-semibold text-ink">{L("رفع ملف Excel (.xlsx)", "Upload Excel (.xlsx)")}</h3>
        <p className="text-xs text-muted">{L("يُحلَّل في متصفحك ويُطابَق على أعمدة الورقة الرئيسية الـ28. راجع المعاينة ثم أكّد للكتابة.", "Parsed in your browser and mapped to the 28 master-sheet columns. Review the preview, then confirm to write.")}</p>
      </div>

      <input type="file" accept=".xlsx,.xls,.csv" onChange={onFile} className="block text-sm" />

      {error ? <pre className="whitespace-pre-wrap rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{error}</pre> : null}
      {result ? <p className="rounded-lg bg-green-50 px-3 py-2 text-sm text-green-700">{result}</p> : null}

      {isSnoonu ? (
        <div className="space-y-2 rounded-lg border border-violet-200 bg-violet-50 px-3 py-3 text-sm">
          <p className="font-semibold text-violet-900">{L("هذا ملف تصدير من سنونو 🔄", "This is a Snoonu export 🔄")}</p>
          <p className="text-xs text-violet-800">{L("هذا الملف يُطابَق عبر معرّف سنونو (SPI) مب عبر SKU — استخدم صفحة «مزامنة سنونو»: تطابق بالـ id، تعرض الفروق، وتضيف المنتجات الجديدة ببياناتها.", "This file is matched by Snoonu ID (SPI), not by SKU — use the Snoonu Sync page: it matches by id, shows a diff, and adds new products with their data.")}</p>
          <Link href="/import-export/snoonu-sync" className="inline-flex rounded-lg bg-violet-600 px-3 py-1.5 text-xs font-bold text-white">{L("← افتح مزامنة سنونو", "Open Snoonu Sync →")}</Link>
        </div>
      ) : null}

      {rows.length > 0 ? (
        <>
          <div className="flex items-center justify-between text-sm">
            <span className="text-slate-600">{fileName} · {L(`${rows.length} صف مُطابَق`, `${rows.length} row(s) mapped`)}</span>
            <button onClick={commit} disabled={busy} className="btn-primary disabled:opacity-60">
              {busy ? L("جارٍ الاستيراد…", "Importing…") : L(`تأكيد الاستيراد (${rows.length})`, `Confirm import (${rows.length})`)}
            </button>
          </div>
          {unmapped.length > 0 ? (
            <p className="text-xs text-amber-600">{L("أعمدة غير مُطابَقة تم تجاهلها:", "Ignored unmapped columns:")} {unmapped.join(", ")}</p>
          ) : null}
          <div className="overflow-x-auto rounded-lg border border-slate-200">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-left text-muted">
                  {PREVIEW_COLS.map((c) => <th key={c} className="px-3 py-2 font-medium">{c}</th>)}
                </tr>
              </thead>
              <tbody>
                {rows.slice(0, 20).map((r, i) => (
                  <tr key={i} className="border-b border-slate-100">
                    {PREVIEW_COLS.map((c) => <td key={c} className="px-3 py-1.5 text-slate-700">{r[c] ?? ""}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {rows.length > 20 ? <p className="text-xs text-muted">{L(`عرض أول 20 من ${rows.length}.`, `Showing first 20 of ${rows.length}.`)}</p> : null}
        </>
      ) : null}
    </div>
  );
}
