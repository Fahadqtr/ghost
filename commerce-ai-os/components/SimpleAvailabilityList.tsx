"use client";

import { useMemo, useState, useTransition } from "react";
import { setProductAvailability, setManyAvailability, setVariantAvailability } from "@/app/(app)/inventory/actions";
import type { Locale } from "@/lib/i18n";

// Module-scoped so it isn't re-created on every render (React Compiler).
function AvailToggle({ on, onIn, onOut, disabled, inLabel, outLabel }: {
  on: boolean; onIn: () => void; onOut: () => void; disabled?: boolean; inLabel: string; outLabel: string;
}) {
  return (
    <span className="flex shrink-0 items-center gap-1 rounded-full bg-slate-100 p-1">
      <button onClick={onIn} disabled={disabled} className={`rounded-full px-3 py-1.5 text-xs font-bold transition ${on ? "bg-white text-emerald-700 shadow-sm ring-1 ring-emerald-200" : "text-slate-400"}`}>{inLabel}</button>
      <button onClick={onOut} disabled={disabled} className={`rounded-full px-3 py-1.5 text-xs font-bold transition ${!on ? "bg-white text-red-600 shadow-sm ring-1 ring-red-200" : "text-slate-400"}`}>{outLabel}</button>
    </span>
  );
}

export interface AvailabilityVariant {
  id: string;
  name: string | null;
  in_stock: boolean;
}
export interface AvailabilityRow {
  id: string; // inventory row id
  product_name: string | null;
  product_name_ar: string | null;
  sku: string | null;
  image_url: string | null;
  in_stock: boolean;
  variants: AvailabilityVariant[];
}

// Simple-mode inventory manager: In / Out toggle per product (and per option),
// tap a product to enlarge it, and a select-all bulk switch.
export default function SimpleAvailabilityList({ rows, locale = "ar" }: { rows: AvailabilityRow[]; locale?: Locale }) {
  const en = locale === "en";
  const L = (ar: string, e: string) => (en ? e : ar);
  const [state, setState] = useState<Record<string, boolean>>(() => Object.fromEntries(rows.map((r) => [r.id, r.in_stock])));
  const [vstate, setVstate] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(rows.flatMap((r) => r.variants.map((v) => [v.id, v.in_stock])))
  );
  const [q, setQ] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [bulkBusy, startBulk] = useTransition();
  const [zoom, setZoom] = useState<AvailabilityRow | null>(null);
  const [err, setErr] = useState("");
  const [, start] = useTransition();

  const name = (r: AvailabilityRow) => (en ? r.product_name || r.product_name_ar : r.product_name_ar || r.product_name) || r.sku || "—";

  const filtered = useMemo(() => {
    const t = q.trim().toLowerCase();
    if (!t) return rows;
    return rows.filter((r) => [r.product_name, r.product_name_ar, r.sku].some((v) => v && v.toLowerCase().includes(t)));
  }, [rows, q]);

  const outCount = rows.filter((r) => !state[r.id]).length;

  const toggle = (r: AvailabilityRow, next: boolean) => {
    if (busyId) return;
    setErr(""); setBusyId(r.id);
    setState((s) => ({ ...s, [r.id]: next }));
    start(async () => {
      const res = await setProductAvailability(r.id, next);
      if (!res.ok) { setState((s) => ({ ...s, [r.id]: !next })); setErr(res.error ?? ""); }
      setBusyId(null);
    });
  };

  const toggleVar = (v: AvailabilityVariant, next: boolean) => {
    if (busyId) return;
    setErr(""); setBusyId(v.id);
    setVstate((s) => ({ ...s, [v.id]: next }));
    start(async () => {
      const res = await setVariantAvailability(v.id, next);
      if (!res.ok) { setVstate((s) => ({ ...s, [v.id]: !next })); setErr(res.error ?? ""); }
      setBusyId(null);
    });
  };

  const bulk = (inStock: boolean) => {
    const ids = filtered.map((r) => r.id);
    if (ids.length === 0) return;
    const word = inStock ? L("متوفر", "In stock") : L("نافد", "Out of stock");
    if (!confirm(L(`تأكيد: علّم ${ids.length} منتج «${word}»؟`, `Mark ${ids.length} products "${word}"?`))) return;
    setErr("");
    startBulk(async () => {
      const res = await setManyAvailability(ids, inStock);
      if (!res.ok) { setErr(res.error ?? ""); return; }
      setState((s) => { const n = { ...s }; ids.forEach((id) => (n[id] = inStock)); return n; });
    });
  };

  const inL = L("متوفر", "In"), outL = L("نفذ", "Out");

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <input value={q} onChange={(e) => setQ(e.target.value)} className="input flex-1" placeholder={L("ابحث بالاسم أو SKU…", "Search by name or SKU…")} />
        <div className="flex items-center gap-1">
          <button disabled={bulkBusy} onClick={() => bulk(true)} className="rounded-lg bg-emerald-600 px-3 py-2 text-xs font-bold text-white disabled:opacity-50">✅ {L("الكل متوفر", "All In")}</button>
          <button disabled={bulkBusy} onClick={() => bulk(false)} className="rounded-lg bg-red-600 px-3 py-2 text-xs font-bold text-white disabled:opacity-50">🚫 {L("الكل نفذ", "All Out")}</button>
        </div>
      </div>
      <p className="text-xs text-muted">
        {L("المعروض", "Showing")} {filtered.length} · <span className="font-bold text-red-600">{outCount} {L("نافد", "out")}</span>
        {q ? L(" · زر «الكل» يطبّق على المعروض فقط", " · “All” applies to the shown list only") : null}
      </p>
      {err ? <p className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{err}</p> : null}

      <div className="space-y-2">
        {filtered.map((r) => {
          const inStock = state[r.id];
          return (
            <div key={r.id} className="rounded-xl border border-[#efe3d6] bg-white p-2.5">
              <div className="flex items-center gap-3">
                <button onClick={() => setZoom(r)} className="shrink-0" title={L("تكبير", "Enlarge")}>
                  {r.image_url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={r.image_url} alt="" className="h-12 w-12 rounded-lg object-cover" />
                  ) : (
                    <span className="flex h-12 w-12 items-center justify-center rounded-lg bg-slate-100 text-lg">📦</span>
                  )}
                </button>
                <button onClick={() => setZoom(r)} className="min-w-0 flex-1 text-start">
                  <p className="truncate text-sm font-semibold text-ink">{name(r)}</p>
                  <p className="truncate text-[11px] text-muted">
                    {r.sku ?? ""}{r.variants.length > 0 ? ` · 🎚️ ${r.variants.length} ${L("خيار", "options")}` : ""}
                  </p>
                </button>
                <AvailToggle on={inStock} onIn={() => toggle(r, true)} onOut={() => toggle(r, false)} disabled={busyId === r.id} inLabel={inL} outLabel={outL} />
              </div>
            </div>
          );
        })}
        {filtered.length === 0 ? <div className="card py-8 text-center text-sm text-muted">{L("ما في نتائج.", "No matches.")}</div> : null}
      </div>

      {zoom ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={() => setZoom(null)}>
          <div className="max-h-[90dvh] w-full max-w-md overflow-y-auto rounded-2xl bg-white p-4" onClick={(e) => e.stopPropagation()}>
            <div className="mb-3 flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="text-base font-bold text-ink">{name(zoom)}</p>
                {zoom.sku ? <p className="text-xs text-muted">{zoom.sku}</p> : null}
              </div>
              <button onClick={() => setZoom(null)} className="rounded-full bg-slate-100 px-3 py-1 text-sm font-bold">✕</button>
            </div>
            {zoom.image_url ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={zoom.image_url} alt="" className="mb-3 max-h-[50dvh] w-full rounded-xl object-contain" />
            ) : null}
            <div className="flex items-center justify-between gap-2 rounded-xl bg-slate-50 p-3">
              <span className="text-sm font-semibold text-ink">{L("المنتج", "Product")}</span>
              <AvailToggle on={state[zoom.id]} onIn={() => toggle(zoom, true)} onOut={() => toggle(zoom, false)} disabled={busyId === zoom.id} inLabel={inL} outLabel={outL} />
            </div>
            {zoom.variants.length > 0 ? (
              <div className="mt-2 space-y-1.5">
                <p className="text-xs font-semibold text-muted">🎚️ {L("الخيارات", "Options")}</p>
                {zoom.variants.map((v) => (
                  <div key={v.id} className="flex items-center justify-between gap-2 rounded-lg border border-slate-100 p-2">
                    <span className="min-w-0 flex-1 truncate text-sm text-slate-700">{v.name || "—"}</span>
                    <AvailToggle on={vstate[v.id]} onIn={() => toggleVar(v, true)} onOut={() => toggleVar(v, false)} disabled={busyId === v.id} inLabel={inL} outLabel={outL} />
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
