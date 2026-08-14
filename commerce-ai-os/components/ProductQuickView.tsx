"use client";

import { useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { setProductApproval, setProductStatus } from "@/app/(app)/products/actions";
import { setProductAvailability } from "@/app/(app)/inventory/actions";
import { isAvailable } from "@/lib/availability/read";
import { PriceCell } from "@/components/ProductTable";
import type { ProductRow } from "@/components/ProductTable";
import type { Locale } from "@/lib/i18n";

const CHANNELS = ["Shopify", "Snoonu", "Talabat", "Rafeeq"] as const;

const apprCls = (s: string) =>
  s === "Approved" ? "bg-green-100 text-green-700"
  : s === "Rejected" ? "bg-red-100 text-red-700"
  : s === "SentAI" ? "bg-amber-100 text-amber-700"
  : "bg-slate-100 text-slate-500";

// A tap-to-open quick card for one product: see it big and change approval,
// status and availability right here — without leaving the catalog list.
export default function ProductQuickView({
  product: p, locale = "ar", simpleMode = false, approval, status, stock, stock_status,
  onClose, onApproval, onStatus, onAvailability,
}: {
  product: ProductRow;
  locale?: Locale;
  simpleMode?: boolean;
  approval: string | null;
  status: string | null;
  stock: number | null;
  stock_status: string | null;
  onClose: () => void;
  onApproval: (v: string) => void;
  onStatus: (v: string) => void;
  onAvailability: (inStock: boolean) => void;
}) {
  const en = locale === "en";
  const L = (ar: string, e: string) => (en ? e : ar);
  const [busy, start] = useTransition();
  const [msg, setMsg] = useState("");

  // Close on Escape.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const active = status === "Active";
  // INV.2F — availability is the EXPLICIT product state, never derived from quantity.
  const inStock = isAvailable(stock_status);

  const changeApproval = (v: string) => {
    const prev = approval ?? "";
    onApproval(v); setMsg("");
    start(async () => {
      const r = await setProductApproval(p.id, v);
      if (r?.error) { onApproval(prev); setMsg(`❌ ${r.error}`); }
    });
  };
  const toggleStatus = () => {
    const next = active ? "Draft" : "Active";
    const prev = status ?? "Draft";
    onStatus(next); setMsg("");
    start(async () => {
      const r = await setProductStatus(p.id, next);
      if (r?.error) { onStatus(prev); setMsg(`❌ ${r.error}`); }
    });
  };
  const toggleAvail = () => {
    const next = !inStock;
    onAvailability(next); setMsg(""); // optimistic explicit availability; no quantity write
    start(async () => {
      const r = await setProductAvailability(p.id, next);
      if (r?.error) { onAvailability(inStock); setMsg(`❌ ${r.error}`); }
    });
  };

  return (
    <div
      role="dialog" aria-modal="true" aria-label={L("بطاقة المنتج", "Product card")}
      onClick={onClose}
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-4"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="max-h-[92vh] w-full max-w-lg overflow-y-auto rounded-t-2xl bg-white p-4 shadow-xl sm:rounded-2xl"
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-bold text-ink">{L("بطاقة المنتج", "Product card")}</h2>
          <button type="button" onClick={onClose} aria-label={L("إغلاق", "Close")}
            className="rounded-full p-1 text-lg leading-none text-slate-500 hover:bg-slate-100">✕</button>
        </div>

        <div className="flex gap-3">
          <div className="h-28 w-28 shrink-0 overflow-hidden rounded-lg bg-slate-100 ring-1 ring-slate-200">
            {p.image_url ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={p.image_url} alt={p.name_en ?? p.sku ?? "product"} width={112} height={112} className="block h-full w-full object-cover" />
            ) : <div className="flex h-full w-full items-center justify-center text-3xl text-slate-300">📦</div>}
          </div>
          <div className="min-w-0 flex-1">
            <div className="font-bold text-ink">{p.name_en ?? "—"}</div>
            {p.name_ar ? <div className="text-sm text-muted" dir="rtl">{p.name_ar}</div> : null}
            <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted">
              {p.main_category ? <span>{p.main_category}</span> : null}
              {p.sku ? <span>SKU {p.sku}</span> : null}
              {p.barcode ? <span dir="ltr">{p.barcode}</span> : null}
            </div>
            <div className="mt-1 text-sm text-slate-700 tabular-nums">
              <PriceCell p={p} en={en} />
            </div>
          </div>
        </div>

        {/* Quick edits */}
        <div className="mt-4 space-y-3 border-t border-[#efe3d6] pt-3">
          {/* Approval */}
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-semibold text-muted">{L("الاعتماد", "Approval")}</span>
            <select value={approval ?? ""} disabled={busy} onChange={(e) => changeApproval(e.target.value)}
              className={`badge cursor-pointer border-0 outline-hidden ${apprCls(approval ?? "")} ${busy ? "opacity-50" : ""}`}>
              <option value="">{L("بدون", "None")}</option>
              <option value="Approved">{L("معتمد", "Approved")}</option>
              <option value="Rejected">{L("مرفوض", "Rejected")}</option>
              <option value="SentAI">SentAI</option>
            </select>
          </div>

          {/* Status */}
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-semibold text-muted">{L("الحالة", "Status")}</span>
            <button type="button" onClick={toggleStatus} disabled={busy} aria-pressed={active}
              className={`badge cursor-pointer ${active ? "bg-green-100 text-green-700" : "bg-slate-100 text-slate-500"} ${busy ? "opacity-50" : ""}`}>
              {active ? L("مفعّل ✓", "Active ✓") : L("غير مفعّل", "Draft")}
            </button>
          </div>

          {/* Availability */}
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-semibold text-muted">{L("التوفّر", "Availability")}</span>
            {simpleMode ? (
              <button type="button" onClick={toggleAvail} disabled={busy} aria-pressed={inStock}
                className={`badge cursor-pointer ${inStock ? "bg-emerald-100 text-emerald-700" : "bg-red-100 text-red-700"} ${busy ? "opacity-50" : ""}`}>
                {inStock ? L("متوفر ✓", "In stock ✓") : L("نفذ", "Out")}
              </button>
            ) : (
              <span className={`badge ${stock == null ? "bg-slate-100 text-slate-400" : Number(stock) <= 0 ? "bg-red-100 text-red-700" : Number(stock) < 10 ? "bg-amber-100 text-amber-700" : "bg-slate-100 text-slate-600"}`}>
                {stock == null ? "—" : Number(stock) <= 0 ? L("نافد", "Out") : `${L("مخزون", "stock")} ${stock}`}
              </span>
            )}
          </div>

          {/* Channels */}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="text-xs font-semibold text-muted">{L("القنوات", "Channels")}</span>
            {CHANNELS.map((c) => {
              const s = p.channels[c] ?? "—";
              const cls = s === "Active" ? "bg-green-100 text-green-700" : s === "Draft" ? "bg-amber-100 text-amber-700" : "bg-slate-100 text-slate-400";
              return <span key={c} className="text-[11px]"><span className="text-slate-400">{c}:</span> <span className={`badge ${cls}`}>{s}</span></span>;
            })}
          </div>

          {p.variants?.length ? (
            <div>
              <span className="text-xs font-semibold text-muted">{L("الخيارات", "Options")}</span>
              <div className="mt-1 max-h-28 space-y-1 overflow-y-auto rounded-lg bg-slate-50 p-2">
                {p.variants.map((v, i) => (
                  <div key={i} className="flex items-center justify-between gap-3 text-xs text-slate-600">
                    <span className="truncate">{v.name || L(`خيار ${i + 1}`, `Option ${i + 1}`)}</span>
                    <span className="flex-none font-mono">{v.barcode || "—"}</span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </div>

        {msg ? <p className="mt-2 rounded bg-red-50 px-2 py-1 text-xs text-red-700">{msg}</p> : null}

        <Link href={`/products/${p.id}`} className="btn-primary mt-4 block w-full text-center">
          {L("فتح الصفحة الكاملة للتعديل ←", "Open full editor →")}
        </Link>
      </div>
    </div>
  );
}
