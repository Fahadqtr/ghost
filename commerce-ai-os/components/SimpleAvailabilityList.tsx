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
  id: string; // inventory row id (React/state key)
  product_id: string | null; // availability target (products.stock_status is product-keyed)
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
  const [avail, setAvail] = useState<"all" | "in" | "out">("all");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [bulkBusy, startBulk] = useTransition();
  const [zoom, setZoom] = useState<AvailabilityRow | null>(null);
  const [err, setErr] = useState("");
  // Which bulk action is awaiting in-app confirmation (true = all in, false =
  // all out, null = none). We use an inline bar instead of window.confirm(),
  // which is silently suppressed inside installed PWAs / in-app webviews.
  const [confirmBulk, setConfirmBulk] = useState<null | boolean>(null);
  const [, start] = useTransition();

  const name = (r: AvailabilityRow) => (en ? r.product_name || r.product_name_ar : r.product_name_ar || r.product_name) || r.sku || "—";

  const filtered = useMemo(() => {
    const t = q.trim().toLowerCase();
    return rows.filter((r) => {
      if (avail === "in" && !state[r.id]) return false;
      if (avail === "out" && state[r.id]) return false;
      if (t && ![r.product_name, r.product_name_ar, r.sku].some((v) => v && v.toLowerCase().includes(t))) return false;
      return true;
    });
  }, [rows, q, avail, state]);

  const outCount = rows.filter((r) => !state[r.id]).length;
  const inCount = rows.length - outCount;

  const toggle = (r: AvailabilityRow, next: boolean) => {
    if (busyId) return;
    if (!r.product_id) { setErr(L("الصنف غير مرتبط بمنتج.", "Item isn’t linked to a product.")); return; }
    const productId = r.product_id;
    setErr(""); setBusyId(r.id);
    setState((s) => ({ ...s, [r.id]: next }));
    start(async () => {
      const res = await setProductAvailability(productId, next);
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

  // Step 1: tapping «الكل نفذ/متوفر» opens the inline confirm bar.
  const requestBulk = (inStock: boolean) => {
    if (filtered.length === 0) return;
    setErr("");
    setConfirmBulk(inStock);
  };

  // Step 2: confirming runs the bulk update against the currently-shown list.
  const doBulk = () => {
    if (confirmBulk === null) return;
    const inStock = confirmBulk;
    const rowsToApply = filtered.filter((r) => r.product_id);
    const ids = rowsToApply.map((r) => r.id); // inventory-row keys for optimistic state
    const productIds = rowsToApply.map((r) => r.product_id as string); // engine target
    setConfirmBulk(null);
    if (productIds.length === 0) return;
    setErr("");
    startBulk(async () => {
      const res = await setManyAvailability(productIds, inStock);
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
          <button disabled={bulkBusy} onClick={() => requestBulk(true)} className="rounded-lg bg-emerald-600 px-3 py-2 text-xs font-bold text-white disabled:opacity-50">✅ {L("الكل متوفر", "All In")}</button>
          <button disabled={bulkBusy} onClick={() => requestBulk(false)} className="rounded-lg bg-red-600 px-3 py-2 text-xs font-bold text-white disabled:opacity-50">🚫 {L("الكل نفذ", "All Out")}</button>
        </div>
      </div>

      {/* In-app confirm bar for the bulk switch (window.confirm is suppressed in PWAs). */}
      {confirmBulk !== null ? (
        <div className="flex flex-col gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between">
          <span className="text-xs font-bold text-amber-900">
            {L(
              `تأكيد: علّم ${filtered.length} منتج «${confirmBulk ? "متوفر" : "نافد"}»؟`,
              `Mark ${filtered.length} products "${confirmBulk ? "In stock" : "Out of stock"}"?`
            )}
          </span>
          <span className="flex shrink-0 items-center gap-1.5">
            <button disabled={bulkBusy} onClick={doBulk} className={`rounded-lg px-3 py-1.5 text-xs font-bold text-white disabled:opacity-50 ${confirmBulk ? "bg-emerald-600" : "bg-red-600"}`}>
              {bulkBusy ? L("...يطبّق", "Applying…") : L("تأكيد", "Confirm")}
            </button>
            <button disabled={bulkBusy} onClick={() => setConfirmBulk(null)} className="rounded-lg bg-white px-3 py-1.5 text-xs font-bold text-slate-600 ring-1 ring-slate-200 disabled:opacity-50">
              {L("إلغاء", "Cancel")}
            </button>
          </span>
        </div>
      ) : null}

      {/* Availability filter */}
      <div className="flex flex-wrap gap-2">
        {([
          { key: "all", label: L("الكل", "All"), n: rows.length, on: "bg-brand text-white" },
          { key: "in", label: `✅ ${L("متوفر", "In")}`, n: inCount, on: "bg-emerald-600 text-white" },
          { key: "out", label: `⛔ ${L("نفذ", "Out")}`, n: outCount, on: "bg-red-600 text-white" },
        ] as const).map((c) => (
          <button key={c.key} type="button" onClick={() => setAvail(c.key)} aria-pressed={avail === c.key}
            className={`rounded-full px-3 py-1 text-xs font-semibold ${avail === c.key ? c.on : "bg-slate-100 text-slate-600"}`}>
            {c.label} ({c.n})
          </button>
        ))}
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
