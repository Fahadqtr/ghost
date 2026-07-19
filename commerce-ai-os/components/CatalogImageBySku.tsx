"use client";

import { useState } from "react";
import { applyCatalogImageBySku } from "@/app/(app)/products/image-actions";
import { skuFromFilename, summarizeOutcomes, type ApplyOutcome } from "@/lib/products/image-apply-compute";
import type { Locale } from "@/lib/i18n";

// Drop a whole folder of <sku>.jpg photos; each file is matched to the catalog
// product whose SKU equals the filename and set as that product's primary image.
// No per-product picking — the filename IS the match key (the same convention
// the manager/supervisor image tools already use). Files whose SKU isn't in the
// catalog are reported, not silently dropped.
type Row = { name: string; sku: string; state: "queued" | "applied" | "noProduct" | "failed"; msg?: string };

export default function CatalogImageBySku({ locale = "ar" }: { locale?: Locale }) {
  const en = locale === "en";
  const L = (ar: string, e: string) => (en ? e : ar);
  const [rows, setRows] = useState<Row[]>([]);
  const [files, setFiles] = useState<File[]>([]);
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(0);
  const [summary, setSummary] = useState<ApplyOutcome | null>(null);

  function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const picked = Array.from(e.target.files ?? []).filter((f) => f.type.startsWith("image/"));
    setFiles(picked);
    setRows(picked.map((f) => ({ name: f.name, sku: skuFromFilename(f.name), state: "queued" })));
    setSummary(null);
    setDone(0);
    e.target.value = "";
  }

  async function run() {
    if (running || files.length === 0) return;
    setRunning(true); setSummary(null); setDone(0);
    const outcomes: Array<"applied" | "noProduct" | "failed"> = [];

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const sku = skuFromFilename(file.name);
      let state: Row["state"] = "failed";
      let msg: string | undefined;
      if (!sku) {
        state = "noProduct"; msg = L("اسم ملف بدون SKU", "filename has no SKU");
      } else {
        try {
          const fd = new FormData();
          fd.set("file", file);
          fd.set("sku", sku);
          const r: any = await applyCatalogImageBySku(fd);
          if (r?.ok) state = "applied";
          else if (r?.code === "no_product") { state = "noProduct"; msg = L("مو في الكتالوج", "not in catalog"); }
          else { state = "failed"; msg = r?.error || L("فشل", "failed"); }
        } catch (e: any) {
          state = "failed"; msg = e?.message || L("فشل", "failed");
        }
      }
      outcomes.push(state === "applied" ? "applied" : state === "noProduct" ? "noProduct" : "failed");
      setRows((prev) => { const n = [...prev]; n[i] = { ...n[i], state, msg }; return n; });
      setDone(i + 1);
    }

    setSummary(summarizeOutcomes(outcomes));
    setRunning(false);
  }

  const badge = (s: Row["state"]) =>
    s === "applied" ? "text-emerald-600" : s === "noProduct" ? "text-amber-600" : s === "failed" ? "text-red-600" : "text-slate-400";
  const label = (s: Row["state"]) =>
    s === "applied" ? L("✓ طُبّقت", "✓ applied")
      : s === "noProduct" ? L("⚠ مو بالكتالوج", "⚠ no product")
      : s === "failed" ? L("✕ فشل", "✕ failed")
      : L("…", "…");

  return (
    <div className="card space-y-3">
      <div>
        <h3 className="text-sm font-semibold text-ink">{L("تطبيق الصور بالـ SKU", "Apply images by SKU")}</h3>
        <p className="text-xs text-muted">
          {L(
            "اختر مجلد الصور المسمّاة بالـ SKU (مثل mk2087.jpg). كل صورة تنربط بمنتجها في الكتالوج وتصير الصورة الأساسية تلقائياً.",
            "Pick a folder of SKU-named photos (e.g. mk2087.jpg). Each is linked to its catalog product and set as the primary image automatically.",
          )}
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <label className={`shrink-0 cursor-pointer rounded-full px-4 py-2 text-xs font-bold ${files.length ? "bg-slate-100 text-slate-700" : "bg-brand text-white"} ${running ? "opacity-50" : ""}`}>
          {files.length ? L(`📁 ${files.length} صورة مختارة`, `📁 ${files.length} images picked`) : L("📁 اختر الصور", "📁 Pick images")}
          <input type="file" accept="image/*" multiple className="hidden" disabled={running} onChange={onPick} />
        </label>
        <button type="button" onClick={run} disabled={running || files.length === 0}
          className="btn-primary px-5 py-2 text-sm disabled:opacity-50">
          {running ? L(`جارٍ التطبيق… ${done}/${files.length}`, `Applying… ${done}/${files.length}`) : L(`▶ طبّق الكل (${files.length})`, `▶ Apply all (${files.length})`)}
        </button>
      </div>

      {summary ? (
        <div className="flex flex-wrap gap-3 rounded-lg bg-slate-50 px-3 py-2 text-xs">
          <span className="font-semibold text-emerald-700">{L("طُبّقت", "Applied")}: {summary.applied}</span>
          <span className="font-semibold text-amber-700">{L("مو بالكتالوج", "No product")}: {summary.noProduct}</span>
          <span className="font-semibold text-red-700">{L("فشل", "Failed")}: {summary.failed}</span>
        </div>
      ) : null}

      {rows.length ? (
        <div className="max-h-72 space-y-1 overflow-y-auto">
          {rows.map((r, i) => (
            <div key={`${r.name}-${i}`} className="flex items-center justify-between gap-2 rounded-lg border border-[#efe3d6] px-2.5 py-1.5 text-xs">
              <span className="min-w-0 flex-1 truncate">
                <span className="font-mono text-slate-500">{r.sku || "—"}</span>
                <span className="text-slate-400"> · {r.name}</span>
              </span>
              <span className={`shrink-0 font-semibold ${badge(r.state)}`}>
                {label(r.state)}{r.msg ? ` · ${r.msg}` : ""}
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
