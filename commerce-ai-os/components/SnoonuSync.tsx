"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import * as XLSX from "xlsx";
import {
  computeSnoonuDiff, applySnoonuUpdates,
  type SnoonuDiff, type SnoonuExportRow, type ApplyResult,
} from "@/app/(app)/import-export/snoonu-actions";

const SHEET = "NonFoodProducts";

// normalized export header -> our field. SKU/Barcode are deliberately ignored
// (unreliable in Snoonu). Match key is `id` (= products.snoonu_id).
const HEADER_MAP: Record<string, keyof SnoonuExportRow> = {
  id: "id",
  nameen: "name_en", namear: "name_ar",
  descriptionen: "description_en", descriptionar: "description_ar",
  price: "price", discount: "discount",
  approval: "approval",
  isfeatured: "is_featured", ispromoted: "is_promoted", hasbuy1get1: "has_buy1get1",
};
const norm = (h: string) => h.toLowerCase().replace(/[^a-z0-9]/g, "");

export default function SnoonuSync() {
  const [fileName, setFileName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [diff, setDiff] = useState<SnoonuDiff | null>(null);
  const [rows, setRows] = useState<SnoonuExportRow[]>([]);

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    setError(null); setDiff(null);
    const file = e.target.files?.[0];
    if (!file) return;
    setFileName(file.name);
    setBusy(true);
    try {
      const wb = XLSX.read(await file.arrayBuffer(), { type: "array" });
      if (!wb.SheetNames.includes(SHEET)) {
        setError(`Sheet "${SHEET}" not found. Sheets in file: ${wb.SheetNames.join(", ")}`);
        setBusy(false); return;
      }
      const raw: Record<string, unknown>[] = XLSX.utils.sheet_to_json(wb.Sheets[SHEET], { defval: "" });
      if (!raw.length) { setError(`Sheet "${SHEET}" has no rows.`); setBusy(false); return; }

      const headers = Object.keys(raw[0]);
      const map: Record<string, keyof SnoonuExportRow> = {};
      for (const h of headers) { const f = HEADER_MAP[norm(h)]; if (f) map[h] = f; }
      if (!Object.values(map).includes("id")) {
        setError(`No "id" column found (needed to match by snoonu_id). Headers: ${headers.join(", ")}`);
        setBusy(false); return;
      }
      const rows: SnoonuExportRow[] = raw.map((r) => {
        const out: any = {};
        for (const [h, f] of Object.entries(map)) out[f] = String(r[h] ?? "").trim();
        return out;
      }).filter((r) => r.id);

      setRows(rows);
      const result = await computeSnoonuDiff(rows);
      if (!result.ok) setError(result.error ?? "Diff failed.");
      setDiff(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not parse the file.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="card space-y-3">
        <div>
          <h3 className="text-sm font-semibold text-ink">Upload Snoonu export</h3>
          <p className="text-xs text-muted">
            Parses sheet <code>{SHEET}</code> and matches by <code>id</code> → <code>products.snoonu_id</code>.
            SKU/barcode are ignored. This step is read-only — it only previews a diff.
          </p>
        </div>
        <input type="file" accept=".xlsx,.xls" onChange={onFile} disabled={busy} className="block text-sm" />
        {fileName ? <p className="text-xs text-muted">{fileName}{busy ? " · analyzing…" : ""}</p> : null}
        {error ? <pre className="whitespace-pre-wrap rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{error}</pre> : null}
      </div>

      {diff?.ok ? <DiffReport diff={diff} rows={rows} /> : null}
    </div>
  );
}

function DiffReport({ diff, rows }: { diff: SnoonuDiff; rows: SnoonuExportRow[] }) {
  const c = diff.counts;
  const router = useRouter();
  const [applying, startApply] = useTransition();
  const [result, setResult] = useState<ApplyResult | null>(null);

  function apply() {
    if (!confirm(`Apply ${c.updated} product update(s)? This writes to the database. NEW and MISSING are left untouched.`)) return;
    setResult(null);
    startApply(async () => {
      const res = await applySnoonuUpdates(rows);
      setResult(res);
      if (res.ok) router.refresh();
    });
  }

  return (
    <div className="space-y-4">
      {/* summary */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        <Stat label="Export rows" value={c.exportRows} />
        <Stat label="Matched" value={c.matched} />
        <Stat label="Will update" value={c.updated} accent="amber" />
        <Stat label="New (review)" value={c.newCount} accent="violet" />
        <Stat label="Missing (review)" value={c.missing} accent="slate" />
      </div>

      {diff.missingOptionalCols.length ? (
        <div className="card border-amber-200 bg-amber-50 text-sm text-amber-800">
          <strong>Note:</strong> these export fields have no matching DB column yet, so they’re excluded from the diff/sync:{" "}
          <code>{diff.missingOptionalCols.join(", ")}</code>. Add the columns to sync them.
        </div>
      ) : null}

      {/* UPDATED */}
      <Section title={`UPDATED — ${c.updated} product(s) with changed fields`}>
        {diff.updated.length === 0 ? <Empty text="Nothing to update." /> : (
          <div className="space-y-2">
            {diff.updated.slice(0, 200).map((u) => (
              <div key={u.product_id} className="rounded-lg border border-slate-200 p-3">
                <div className="mb-1 flex items-center justify-between">
                  <span className="text-sm font-medium text-ink">{u.name_en || "—"}</span>
                  <span className="font-mono text-[10px] text-muted">{u.snoonu_id}</span>
                </div>
                <ul className="space-y-0.5 text-xs">
                  {u.changes.map((ch, i) => (
                    <li key={i} className="flex flex-wrap gap-1">
                      <span className="font-medium text-slate-600">{ch.field}:</span>
                      <span className="text-red-600 line-through">{trunc(ch.old)}</span>
                      <span className="text-slate-400">→</span>
                      <span className="text-green-700">{trunc(ch.new)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
            {diff.updated.length > 200 ? <p className="text-xs text-muted">…and {diff.updated.length - 200} more.</p> : null}
          </div>
        )}
      </Section>

      {/* NEW */}
      <Section title={`NEW on Snoonu — ${c.newCount} (not in our DB; review, not auto-created)`}>
        {diff.newProducts.length === 0 ? <Empty text="No new products." /> : (
          <ul className="grid grid-cols-1 gap-1 text-xs sm:grid-cols-2">
            {diff.newProducts.slice(0, 200).map((n, i) => (
              <li key={i} className="flex gap-2"><span className="font-mono text-[10px] text-muted">{n.id}</span><span className="text-slate-700">{n.name_en || "—"}</span></li>
            ))}
            {diff.newProducts.length > 200 ? <li className="text-muted">…and {diff.newProducts.length - 200} more.</li> : null}
          </ul>
        )}
      </Section>

      {/* MISSING */}
      <Section title={`MISSING from this export — ${c.missing} (candidate "not listed on Snoonu")`}>
        {diff.missing.length === 0 ? <Empty text="All our products appear in the export." /> : (
          <ul className="grid grid-cols-1 gap-1 text-xs sm:grid-cols-2">
            {diff.missing.slice(0, 200).map((m, i) => (
              <li key={i} className="flex gap-2"><span className="text-slate-600">{m.sku ?? "—"}</span><span className="text-slate-700">{m.name_en || "—"}</span></li>
            ))}
            {diff.missing.length > 200 ? <li className="text-muted">…and {diff.missing.length - 200} more.</li> : null}
          </ul>
        )}
      </Section>

      {/* Apply */}
      <div className="card flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-muted">
          Apply writes the {c.updated} update(s) — matched rows only. NEW and MISSING are never auto-created/deleted.
        </p>
        <button
          onClick={apply}
          disabled={applying || c.updated === 0}
          className="btn-primary disabled:opacity-50"
        >
          {applying ? "Applying…" : `Apply ${c.updated} update(s)`}
        </button>
      </div>

      {result ? (
        result.ok ? (
          <div className="card border-green-200 bg-green-50 text-sm text-green-800">
            ✓ Applied. Products updated: <strong>{result.productsUpdated}</strong> · field writes: {result.fieldWrites}
            {result.failed ? ` · failed: ${result.failed}` : ""} · columns: {result.columnsWritten.join(", ") || "—"}.
            <span className="block text-xs text-green-700">Matched {result.matched}, unchanged {result.unchanged}. Re-upload the export to see a clean diff.</span>
          </div>
        ) : (
          <div className="card border-red-200 bg-red-50 text-sm text-red-700">Apply failed: {result.error}</div>
        )
      ) : null}
    </div>
  );
}

const trunc = (s: string) => (s.length > 60 ? s.slice(0, 60) + "…" : s);
function Stat({ label, value, accent }: { label: string; value: number; accent?: string }) {
  const color = accent === "amber" ? "text-amber-700" : accent === "violet" ? "text-brand-dark" : "text-ink";
  return <div className="card"><p className="text-xs text-muted">{label}</p><p className={`text-xl font-semibold ${color}`}>{value}</p></div>;
}
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return <div className="card"><h3 className="mb-3 text-sm font-semibold text-ink">{title}</h3>{children}</div>;
}
function Empty({ text }: { text: string }) { return <p className="text-sm text-slate-400">{text}</p>; }
