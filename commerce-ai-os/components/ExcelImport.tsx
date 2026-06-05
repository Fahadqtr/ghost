"use client";

import { useState } from "react";
import * as XLSX from "xlsx";
import { importProducts, type ImportRow } from "@/app/(app)/import-export/actions";

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

export default function ExcelImport() {
  const [rows, setRows] = useState<ImportRow[]>([]);
  const [fileName, setFileName] = useState("");
  const [unmapped, setUnmapped] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    setError(null); setResult(null); setRows([]); setUnmapped([]);
    const file = e.target.files?.[0];
    if (!file) return;
    setFileName(file.name);

    try {
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { type: "array" });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      const raw: Record<string, unknown>[] = XLSX.utils.sheet_to_json(sheet, { defval: "" });

      if (raw.length === 0) { setError("The first sheet has no rows."); return; }

      const headers = Object.keys(raw[0]);
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
      setError(err instanceof Error ? err.message : "Could not parse the file.");
    }
  }

  async function commit() {
    if (!confirm(`Import ${rows.length} product(s) into the database? This writes real rows.`)) return;
    setBusy(true); setError(null); setResult(null);
    const res = await importProducts(rows);
    setBusy(false);
    if (res?.error) {
      setError(res.error + (res.skipped?.length ? `\nSkipped:\n- ${res.skipped.join("\n- ")}` : ""));
      return;
    }
    let msg = `Imported ${res?.imported ?? 0} product(s).`;
    if (res?.skipped?.length) msg += ` Skipped ${res.skipped.length}: ${res.skipped.join("; ")}`;
    setResult(msg);
    setRows([]);
  }

  return (
    <div className="card space-y-3">
      <div>
        <h3 className="text-sm font-semibold text-ink">Upload Excel (.xlsx)</h3>
        <p className="text-xs text-muted">Parsed in your browser and mapped to the 28 master-sheet columns. Review the preview, then confirm to write.</p>
      </div>

      <input type="file" accept=".xlsx,.xls,.csv" onChange={onFile} className="block text-sm" />

      {error ? <pre className="whitespace-pre-wrap rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{error}</pre> : null}
      {result ? <p className="rounded-lg bg-green-50 px-3 py-2 text-sm text-green-700">{result}</p> : null}

      {rows.length > 0 ? (
        <>
          <div className="flex items-center justify-between text-sm">
            <span className="text-slate-600">{fileName} · {rows.length} row(s) mapped</span>
            <button onClick={commit} disabled={busy} className="btn-primary disabled:opacity-60">
              {busy ? "Importing…" : `Confirm import (${rows.length})`}
            </button>
          </div>
          {unmapped.length > 0 ? (
            <p className="text-xs text-amber-600">Ignored unmapped columns: {unmapped.join(", ")}</p>
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
          {rows.length > 20 ? <p className="text-xs text-muted">Showing first 20 of {rows.length}.</p> : null}
        </>
      ) : null}
    </div>
  );
}
