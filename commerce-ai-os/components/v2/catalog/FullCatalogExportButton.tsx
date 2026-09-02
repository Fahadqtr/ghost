"use client";

// FULL CATALOG EXCEL EXPORT — the button on /v2/catalog.
//
// Always downloads the WHOLE canonical catalog: it calls the export route with
// no query string, so the page's current search / filter / sort (e.g. a Rhode
// search) can never narrow the file. Shows a loading state while the workbook
// is generated and a clear Arabic error if it fails.

import { useRef, useState } from "react";

const LABEL = "تصدير الكتالوج الكامل Excel";
const LABEL_EN = "Export Full Catalog Excel";
const BUSY = "جارٍ إنشاء الملف…";
const FAILED = "تعذر إنشاء ملف الكتالوج. حاول مرة أخرى.";

/** Fallback name if the response carries no Content-Disposition filename. */
function fallbackName(): string {
  const now = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `malikas-full-catalog-${now.getUTCFullYear()}-${p(now.getUTCMonth() + 1)}-${p(now.getUTCDate())}-${p(
    now.getUTCHours(),
  )}${p(now.getUTCMinutes())}.xlsx`;
}

function filenameFrom(header: string | null): string {
  if (!header) return fallbackName();
  const m = /filename="([^"]+)"/.exec(header);
  return m ? m[1] : fallbackName();
}

export default function FullCatalogExportButton() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);

  async function onExport() {
    if (inFlight.current) return; // a double-click must not start a second read
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/v2/catalog/export", { method: "GET", cache: "no-store" });
      if (!res.ok) throw new Error("export failed");
      const blob = await res.blob();
      const name = filenameFrom(res.headers.get("Content-Disposition"));
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      setError(FAILED);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={onExport}
        disabled={busy}
        aria-busy={busy}
        title={LABEL_EN}
        className="btn-ghost disabled:cursor-not-allowed disabled:opacity-60"
      >
        {busy ? BUSY : LABEL}
      </button>
      {error ? (
        <span role="alert" className="text-[11px] font-medium text-red-600">
          {error}
        </span>
      ) : null}
    </div>
  );
}
