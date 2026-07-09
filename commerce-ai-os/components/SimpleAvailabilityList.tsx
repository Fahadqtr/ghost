"use client";

import { useMemo, useState, useTransition } from "react";
import { setProductAvailability } from "@/app/(app)/inventory/actions";
import type { Locale } from "@/lib/i18n";

export interface AvailabilityRow {
  id: string; // inventory row id
  product_name: string | null;
  product_name_ar: string | null;
  sku: string | null;
  image_url: string | null;
  in_stock: boolean;
}

// Simple-mode inventory manager: one In / Out toggle per product, no numbers.
export default function SimpleAvailabilityList({ rows, locale = "ar" }: { rows: AvailabilityRow[]; locale?: Locale }) {
  const en = locale === "en";
  const L = (ar: string, e: string) => (en ? e : ar);
  const [state, setState] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(rows.map((r) => [r.id, r.in_stock]))
  );
  const [q, setQ] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [err, setErr] = useState("");
  const [, start] = useTransition();

  const name = (r: AvailabilityRow) => (en ? r.product_name || r.product_name_ar : r.product_name_ar || r.product_name) || r.sku || "—";

  const filtered = useMemo(() => {
    const t = q.trim().toLowerCase();
    if (!t) return rows;
    return rows.filter((r) =>
      [r.product_name, r.product_name_ar, r.sku].some((v) => v && v.toLowerCase().includes(t))
    );
  }, [rows, q]);

  const outCount = rows.filter((r) => !state[r.id]).length;

  const toggle = (r: AvailabilityRow, next: boolean) => {
    if (busyId) return;
    setErr("");
    setBusyId(r.id);
    setState((s) => ({ ...s, [r.id]: next })); // optimistic
    start(async () => {
      const res = await setProductAvailability(r.id, next);
      if (!res.ok) {
        setState((s) => ({ ...s, [r.id]: !next })); // revert
        setErr(res.error ?? "");
      }
      setBusyId(null);
    });
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          className="input flex-1"
          placeholder={L("ابحث بالاسم أو SKU…", "Search by name or SKU…")}
        />
        <span className="shrink-0 rounded-full bg-slate-100 px-3 py-1 text-xs text-muted">
          {rows.length} {L("منتج", "products")} · <span className="font-bold text-red-600">{outCount} {L("نافد", "out")}</span>
        </span>
      </div>
      {err ? <p className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{err}</p> : null}

      <div className="space-y-2">
        {filtered.map((r) => {
          const inStock = state[r.id];
          return (
            <div key={r.id} className="flex items-center gap-3 rounded-xl border border-[#efe3d6] bg-white p-2.5">
              {r.image_url ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={r.image_url} alt="" className="h-11 w-11 shrink-0 rounded-lg object-cover" />
              ) : (
                <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-lg">📦</span>
              )}
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold text-ink">{name(r)}</p>
                {r.sku ? <p className="truncate text-[11px] text-muted">{r.sku}</p> : null}
              </div>
              <div className="flex shrink-0 items-center gap-1 rounded-full bg-slate-100 p-1">
                <button
                  onClick={() => toggle(r, true)}
                  disabled={busyId === r.id}
                  className={`rounded-full px-3 py-1.5 text-xs font-bold transition ${inStock ? "bg-white text-emerald-700 shadow-sm ring-1 ring-emerald-200" : "text-slate-400"}`}
                >
                  {L("متوفر", "In")}
                </button>
                <button
                  onClick={() => toggle(r, false)}
                  disabled={busyId === r.id}
                  className={`rounded-full px-3 py-1.5 text-xs font-bold transition ${!inStock ? "bg-white text-red-600 shadow-sm ring-1 ring-red-200" : "text-slate-400"}`}
                >
                  {L("نفذ", "Out")}
                </button>
              </div>
            </div>
          );
        })}
        {filtered.length === 0 ? (
          <div className="card py-8 text-center text-sm text-muted">{L("ما في نتائج.", "No matches.")}</div>
        ) : null}
      </div>
    </div>
  );
}
