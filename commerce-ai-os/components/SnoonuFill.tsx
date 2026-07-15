"use client";

import { useState } from "react";
import * as XLSX from "xlsx";
import { snoonuFillCodes, type FillItem, type SnoonuFillResponse } from "@/app/(app)/import-export/snoonu-actions";

// Upload a Snoonu bulk-update sheet → fill the SKU + Barcode columns from our
// catalog (matched by SPI, then name) → download the SAME file, ready to
// re-upload to the Merchant Portal. Read-only against the catalog.

const SHEET = "Catalog Update";

// Find the header row + the SPI/SKU/Barcode/name columns by scanning the top rows.
function locate(ws: XLSX.WorkSheet): { headerRow: number; c: { spi: number; sku: number; barcode: number; en: number; ar: number } } | null {
  const ref = ws["!ref"]; if (!ref) return null;
  const range = XLSX.utils.decode_range(ref);
  for (let r = range.s.r; r <= Math.min(range.s.r + 6, range.e.r); r++) {
    const cols = { spi: -1, sku: -1, barcode: -1, en: -1, ar: -1 };
    for (let c = range.s.c; c <= range.e.c; c++) {
      const cell = ws[XLSX.utils.encode_cell({ r, c })];
      const t = String(cell?.v ?? "").toLowerCase().replace(/[^a-z]/g, "");
      if (t === "spi") cols.spi = c;
      else if (t === "sku") cols.sku = c;
      else if (t === "barcode") cols.barcode = c;
      else if (t.startsWith("productnameen")) cols.en = c;
      else if (t.startsWith("productnamear")) cols.ar = c;
    }
    if (cols.sku >= 0 && cols.barcode >= 0 && (cols.spi >= 0 || cols.en >= 0)) return { headerRow: r, c: cols };
  }
  return null;
}

export default function SnoonuFill({ locale = "ar" }: { locale?: "ar" | "en" }) {
  const en = locale === "en";
  const L = (ar: string, e: string) => (en ? e : ar);

  const [fileName, setFileName] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [res, setRes] = useState<SnoonuFillResponse["counts"] | null>(null);

  const onFile = async (file: File) => {
    setBusy(true); setErr(""); setRes(null); setFileName(file.name);
    try {
      const wb = XLSX.read(await file.arrayBuffer(), { type: "array" });
      const ws = wb.Sheets[SHEET] ?? wb.Sheets[wb.SheetNames.find((n) => n.toLowerCase().includes("catalog")) ?? ""];
      if (!ws) throw new Error(L(`ما لقيت ورقة «${SHEET}» في الملف.`, `Sheet "${SHEET}" not found.`));
      const loc = locate(ws);
      if (!loc) throw new Error(L("ما قدرت أحدّد أعمدة SKU/Barcode في الملف.", "Couldn't find the SKU/Barcode columns."));
      const range = XLSX.utils.decode_range(ws["!ref"]!);
      const { c } = loc;

      // Collect data rows (below the header).
      const rowIdx: number[] = [];
      const items: FillItem[] = [];
      for (let r = loc.headerRow + 1; r <= range.e.r; r++) {
        const get = (col: number) => (col < 0 ? "" : String(ws[XLSX.utils.encode_cell({ r, c: col })]?.v ?? "").trim());
        const spi = get(c.spi), nameEn = get(c.en), nameAr = get(c.ar);
        if (!spi && !nameEn && !nameAr) continue; // skip blank rows
        rowIdx.push(r);
        items.push({ spi, nameEn, nameAr });
      }
      if (!items.length) throw new Error(L("ما فيه صفوف منتجات.", "No product rows found."));

      const out = await snoonuFillCodes(items);
      if (!out.ok) throw new Error(out.error || L("فشلت التعبئة.", "Fill failed."));

      // Write SKU + Barcode (as text) back into the SAME worksheet.
      out.results.forEach((fr, i) => {
        const r = rowIdx[i];
        if (fr.sku) ws[XLSX.utils.encode_cell({ r, c: c.sku })] = { t: "s", v: fr.sku };
        if (fr.barcode) ws[XLSX.utils.encode_cell({ r, c: c.barcode })] = { t: "s", v: String(fr.barcode) };
      });

      // Download the filled workbook.
      const bytes = XLSX.write(wb, { type: "array", bookType: "xlsx" });
      const blob = new Blob([bytes], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = file.name.replace(/\.xlsx$/i, "") + "_filled.xlsx";
      document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);

      setRes(out.counts);
    } catch (e) {
      setErr(e instanceof Error ? e.message : L("تعذّرت المعالجة.", "Processing failed."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card space-y-3">
      <div className="flex items-center gap-2">
        <span className="text-lg">🧾</span>
        <h2 className="text-sm font-semibold text-ink">{L("تعبئة SKU + الباركود لملف سنون", "Fill SKU + Barcode for a Snoonu sheet")}</h2>
      </div>
      <p className="text-xs text-muted">{L(
        "ارفع ملف سنون (Catalog Update)، ونعبّي عمودي SKU والباركود من كتالوجنا (مطابقة بالـ SPI ثم بالاسم)، ثم نزّل نفس الملف جاهز للرفع.",
        "Upload the Snoonu sheet; we fill the SKU + Barcode columns from our catalog (matched by SPI then name) and download the same file, ready to re-upload.",
      )}</p>

      <label className={`inline-flex cursor-pointer items-center gap-2 rounded-lg border border-[#efe3d6] px-3 py-2 text-sm ${busy ? "opacity-50" : ""}`}>
        📤 {busy ? L("يعالج…", "Processing…") : L("اختر ملف سنون (.xlsx)", "Choose Snoonu file (.xlsx)")}
        <input type="file" accept=".xlsx" className="hidden" disabled={busy}
          onChange={(e) => { const f = e.target.files?.[0]; if (f) void onFile(f); e.target.value = ""; }} />
      </label>
      {fileName ? <p className="text-[11px] text-muted" dir="ltr">{fileName}</p> : null}

      {err ? <p className="rounded-lg bg-red-50 px-3 py-1.5 text-xs text-red-700" dir="auto">{err}</p> : null}

      {res ? (
        <div className="space-y-1 rounded-lg bg-emerald-50/60 px-3 py-2 text-[11px] text-emerald-800">
          <p className="font-bold">✅ {L("تم — نُزّل الملف المعبّى", "Done — filled file downloaded")}</p>
          <p>{L("صفوف", "Rows")}: {res.rows} · {L("عُبّئت", "Filled")}: {res.filled} · {L("بالـSPI", "by SPI")}: {res.bySpi} · {L("بالاسم", "by name")}: {res.byName} · {L("بدون كود", "no code")}: {res.unmatched}</p>
          {res.unmatched > 0 ? <p className="text-amber-700">{L("الصفوف بدون كود = منتجات مب موجودة في كتالوجنا (أضِفها من صفحة Snoonu Sync لتوليد كود).", "Rows with no code = products not in our catalog (add them via Snoonu Sync to generate codes).")}</p> : null}
        </div>
      ) : null}
    </div>
  );
}
