"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CATEGORIES } from "@/lib/constants";
import { setProductApproval } from "@/app/(app)/products/actions";

const PAGE_SIZE = 50;
const CHANNELS = ["Shopify", "Snoonu", "Talabat", "Rafeeq"] as const;

export interface ProductRow {
  id: string;
  image_url: string | null;
  sku: string | null;
  snoonu_id: string | null;
  barcode: string | null;
  name_en: string | null;
  name_ar: string | null;
  main_category: string | null;
  approval: string | null;
  rejection_reason: string | null;
  platform_status: string | null;
  price: number | null;
  discount_price: number | null;
  stock: number | null;
  variant_count: number;
  channels: Record<string, string>;
}

function Thumb({ url, alt }: { url: string | null; alt: string }) {
  // Fixed-size BOX owns the dimensions; the img fills it at 100% (never relies
  // on intrinsic size or height:auto, so a 1:1 image fills the 48x48 square).
  return (
    <div className="h-12 w-12 shrink-0 overflow-hidden rounded bg-slate-100 ring-1 ring-slate-200">
      {url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={url} alt={alt} width={48} height={48} loading="lazy"
          className="block h-full w-full object-cover" />
      ) : (
        <div className="flex h-full w-full items-center justify-center text-slate-300" title="No image">📦</div>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status?: string }) {
  const s = status ?? "—";
  const cls =
    s === "Active" ? "bg-green-100 text-green-700"
    : s === "Draft" ? "bg-amber-100 text-amber-700"
    : s === "Not Listed" ? "bg-slate-100 text-slate-500"
    : "bg-transparent text-slate-300";
  return <span className={`badge ${cls}`}>{s}</span>;
}

const apprCls = (s: string) =>
  s === "Approved" ? "bg-green-100 text-green-700"
  : s === "Rejected" ? "bg-red-100 text-red-700"
  : s === "SentAI" ? "bg-amber-100 text-amber-700"
  : "bg-slate-100 text-slate-400";

// Inline approve/reject straight from the list — no need to open the product.
// stopPropagation keeps the row-click (navigate to detail) from firing.
function RowApproval({ id, value }: { id: string; value: string | null }) {
  const [val, setVal] = useState(value ?? "");
  const [busy, start] = useTransition();
  return (
    <select
      value={val}
      disabled={busy}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => {
        e.stopPropagation();
        const v = e.target.value;
        const prev = val;
        setVal(v);
        start(async () => {
          const res = await setProductApproval(id, v);
          if (res?.error) { setVal(prev); alert(res.error); }
        });
      }}
      className={`badge cursor-pointer border-0 outline-none ${apprCls(val)} ${busy ? "opacity-50" : ""}`}
      title="غيّر حالة الاعتماد"
    >
      <option value="">بدون</option>
      <option value="Approved">معتمد</option>
      <option value="Rejected">مرفوض</option>
      <option value="SentAI">SentAI</option>
    </select>
  );
}

export default function ProductTable({ products }: { products: ProductRow[] }) {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [cat, setCat] = useState("");
  const [appr, setAppr] = useState("");
  const [stk, setStk] = useState("");
  const [plat, setPlat] = useState("");
  const [page, setPage] = useState(1);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return products.filter((p) => {
      const matchesQ =
        !needle ||
        (p.name_en ?? "").toLowerCase().includes(needle) ||
        (p.name_ar ?? "").toLowerCase().includes(needle) ||
        (p.sku ?? "").toLowerCase().includes(needle) ||
        (p.barcode ?? "").toLowerCase().includes(needle);
      const matchesCat = !cat || p.main_category === cat;
      const matchesAppr = !appr || (
        appr === "none" ? !p.approval
        : appr === "image" ? (p.approval === "Rejected" && (p.rejection_reason ?? "").includes("صورة"))
        : p.approval === appr);
      const n = Number(p.stock);
      const matchesStk = !stk
        || (stk === "out" ? !(n > 0)
          : stk === "low" ? (n > 0 && n < 10)
          : stk === "in" ? n >= 10 : true);
      const matchesPlat = !plat || (plat === "active" ? p.platform_status === "Active" : p.platform_status !== "Active");
      return matchesQ && matchesCat && matchesAppr && matchesStk && matchesPlat;
    });
  }, [products, q, cat, appr, stk, plat]);

  useEffect(() => { setPage(1); }, [q, cat, appr, stk, plat]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const current = Math.min(page, totalPages);
  const start = (current - 1) * PAGE_SIZE;
  const visible = filtered.slice(start, start + PAGE_SIZE);

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <input
          className="input sm:max-w-xs"
          placeholder="Search name (EN/AR), SKU, barcode…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <select className="input sm:max-w-xs" value={cat} onChange={(e) => setCat(e.target.value)}>
          <option value="">All categories</option>
          {CATEGORIES.map((c) => (<option key={c} value={c}>{c}</option>))}
        </select>
        <select className="input sm:max-w-[12rem]" value={appr} onChange={(e) => setAppr(e.target.value)}>
          <option value="">كل الحالات</option>
          <option value="Approved">Approved · معتمد</option>
          <option value="Rejected">Rejected · مرفوض</option>
          <option value="image">مرفوض · بسبب الصورة</option>
          <option value="SentAI">SentAI</option>
          <option value="none">بدون حالة</option>
        </select>
        <select className="input sm:max-w-[12rem]" value={stk} onChange={(e) => setStk(e.target.value)}>
          <option value="">كل المخزون</option>
          <option value="out">Out of stock · نافد</option>
          <option value="low">Low · منخفض (1-9)</option>
          <option value="in">In stock · متوفّر (10+)</option>
        </select>
        <select className="input sm:max-w-[12rem]" value={plat} onChange={(e) => setPlat(e.target.value)}>
          <option value="">مفعّل + غير مفعّل</option>
          <option value="active">مفعّل · Active</option>
          <option value="inactive">غير مفعّل · Draft</option>
        </select>
        <span className="text-sm text-muted sm:ml-auto">
          {filtered.length === products.length ? `${products.length} products` : `${filtered.length} of ${products.length}`}
        </span>
      </div>

      <div className="card overflow-x-auto p-0">
        <table className="w-full min-w-[1200px] text-sm">
          <thead>
            <tr className="border-b border-slate-200 text-left text-xs uppercase text-muted">
              <th className="px-3 py-3 font-medium"></th>
              <th className="px-3 py-3 font-medium">Name EN</th>
              <th className="px-3 py-3 font-medium">Name AR</th>
              <th className="px-3 py-3 font-medium">SKU</th>
              <th className="px-3 py-3 font-medium">Snoonu ID</th>
              <th className="px-3 py-3 font-medium">Barcode</th>
              <th className="px-3 py-3 font-medium">Category</th>
              <th className="px-3 py-3 font-medium">Approval</th>
              <th className="px-3 py-3 font-medium">Price</th>
              <th className="px-3 py-3 font-medium">Disc.</th>
              <th className="px-3 py-3 font-medium">Stock</th>
              <th className="px-3 py-3 font-medium">Var.</th>
              {CHANNELS.map((c) => (<th key={c} className="px-3 py-3 font-medium">{c}</th>))}
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr><td colSpan={16} className="px-4 py-8 text-center text-slate-400">No products found.</td></tr>
            ) : (
              visible.map((p) => (
                <tr
                  key={p.id}
                  onClick={() => router.push(`/products/${p.id}`)}
                  className="cursor-pointer border-b border-slate-100 hover:bg-slate-50"
                >
                  <td className="px-3 py-2"><Thumb url={p.image_url} alt={p.name_en ?? p.sku ?? "product"} /></td>
                  <td className="px-3 py-3 font-medium text-ink">{p.name_en ?? "—"}</td>
                  <td className="px-3 py-3 text-slate-600" dir="rtl">{p.name_ar ?? "—"}</td>
                  <td className="px-3 py-3 text-slate-600">{p.sku ?? "—"}</td>
                  <td className="px-3 py-3 font-mono text-xs text-slate-500" title={p.snoonu_id ?? ""}>
                    {p.snoonu_id ? p.snoonu_id.slice(0, 8) + "…" : "—"}
                  </td>
                  <td className="px-3 py-3 text-slate-600">{p.barcode ?? "—"}</td>
                  <td className="px-3 py-3 text-slate-600">{p.main_category ?? "—"}</td>
                  <td className="px-3 py-3"><RowApproval id={p.id} value={p.approval} /></td>
                  <td className="px-3 py-3 text-slate-600">{p.price ?? "—"}</td>
                  <td className="px-3 py-3 text-slate-600">{p.discount_price ?? "—"}</td>
                  <td className="px-3 py-3">
                    {p.stock == null ? <span className="text-slate-400">—</span>
                      : Number(p.stock) <= 0 ? <span className="badge bg-red-100 text-red-700">نافد</span>
                      : Number(p.stock) < 10 ? <span className="text-amber-700">{p.stock}</span>
                      : <span className="text-slate-600">{p.stock}</span>}
                  </td>
                  <td className="px-3 py-3 text-slate-600">{p.variant_count > 0 ? p.variant_count : "—"}</td>
                  {CHANNELS.map((c) => (
                    <td key={c} className="px-3 py-3"><StatusBadge status={p.channels[c]} /></td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {filtered.length > PAGE_SIZE ? (
        <div className="flex flex-col items-center justify-between gap-3 sm:flex-row">
          <span className="text-sm text-muted">
            Showing {start + 1}–{Math.min(start + PAGE_SIZE, filtered.length)} of {filtered.length}
          </span>
          <div className="flex items-center gap-2">
            <button className="btn-ghost px-3 py-1.5 text-sm disabled:opacity-40" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={current <= 1}>← Prev</button>
            <span className="text-sm text-slate-600">Page {current} / {totalPages}</span>
            <button className="btn-ghost px-3 py-1.5 text-sm disabled:opacity-40" onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={current >= totalPages}>Next →</button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
