"use client";

import { Fragment, useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import BarcodeScanner from "@/components/BarcodeScanner";
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
  notes: string | null;
  price: number | null;
  discount_price: number | null;
  stock: number | null;
  variant_count: number;
  variants?: { name: string | null; barcode: string }[];
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
  const [scanning, setScanning] = useState(false);
  const [cat, setCat] = useState("");
  const [appr, setAppr] = useState("");
  const [stk, setStk] = useState("");
  const [plat, setPlat] = useState("");
  const [grp, setGrp] = useState("");
  const [page, setPage] = useState(1);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggleExpand = (id: string) =>
    setExpanded((s) => {
      const n = new Set(s);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return products.filter((p) => {
      const matchesQ =
        !needle ||
        (p.name_en ?? "").toLowerCase().includes(needle) ||
        (p.name_ar ?? "").toLowerCase().includes(needle) ||
        (p.sku ?? "").toLowerCase().includes(needle) ||
        (p.barcode ?? "").toLowerCase().includes(needle) ||
        (p.variants ?? []).some((v) => v.barcode.toLowerCase().includes(needle));
      const matchesCat = !cat || p.main_category === cat;
      const matchesAppr = !appr || (appr === "none" ? !p.approval : p.approval === appr);
      const n = Number(p.stock);
      const matchesStk = !stk
        || (stk === "out" ? !(n > 0)
          : stk === "low" ? (n > 0 && n < 10)
          : stk === "in" ? n >= 10 : true);
      const matchesPlat = !plat || (plat === "active" ? p.platform_status === "Active" : p.platform_status !== "Active");
      const rr = p.rejection_reason ?? "";
      const matchesGrp = !grp || (
        grp === "new" ? (p.notes ?? "").startsWith("Imported from Snoonu sync")
        : grp === "image" ? rr.includes("صورة")
        : grp === "unavail" ? rr.includes("غير متاح")
        : grp === "variants" ? p.variant_count > 0
        : true);
      return matchesQ && matchesCat && matchesAppr && matchesStk && matchesPlat && matchesGrp;
    });
  }, [products, q, cat, appr, stk, plat, grp]);

  useEffect(() => { setPage(1); }, [q, cat, appr, stk, plat, grp]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const current = Math.min(page, totalPages);
  const start = (current - 1) * PAGE_SIZE;
  const visible = filtered.slice(start, start + PAGE_SIZE);

  // الخيار(ات) اللي باركودها يطابق نص البحث الحالي — لإظهار أي خيار «ضربت» عليه
  const matchedVariants = (p: ProductRow) => {
    const n = q.trim().toLowerCase();
    if (!n) return [] as { name: string | null; barcode: string }[];
    return (p.variants ?? []).filter((v) => v.barcode.toLowerCase().includes(n));
  };
  const VariantHits = ({ p }: { p: ProductRow }) => {
    const hits = matchedVariants(p);
    if (hits.length === 0) return null;
    return (
      <div className="mt-1 flex flex-wrap gap-1">
        {hits.map((v, i) => (
          <span key={i} className="inline-block rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-medium text-emerald-800">
            🎯 خيار: {v.name || "—"} · <span className="font-mono">{v.barcode}</span>
          </span>
        ))}
      </div>
    );
  };

  // المنتج «مفتوح» إذا وسّعه المستخدم أو طابق البحث أحد باركودات خياراته
  const isOpen = (p: ProductRow) => expanded.has(p.id) || matchedVariants(p).length > 0;
  // قائمة خيارات المنتج (اسم + باركود) تُعرض داخل القائمة بدون فتح المنتج
  const VariantList = ({ p }: { p: ProductRow }) => {
    const n = q.trim().toLowerCase();
    const vs = p.variants ?? [];
    if (vs.length === 0) return <div className="px-2 py-1 text-xs text-slate-400">لا توجد خيارات لهذا المنتج.</div>;
    return (
      <div className="space-y-1">
        {vs.map((v, i) => {
          const hit = !!n && v.barcode.toLowerCase().includes(n);
          return (
            <div
              key={i}
              className={`flex items-center justify-between gap-3 rounded px-2 py-1 text-xs ${hit ? "bg-emerald-100 font-medium text-emerald-800" : "text-slate-600"}`}
            >
              <span className="truncate">{hit ? "🎯 " : ""}{v.name || `خيار ${i + 1}`}</span>
              <span className="flex-none font-mono">{v.barcode || "—"}</span>
            </div>
          );
        })}
      </div>
    );
  };

  return (
    <div className="space-y-4">
      {scanning && (
        <BarcodeScanner
          onDetected={(code) => {
            setQ(code.trim());
            setScanning(false);
          }}
          onClose={() => setScanning(false)}
        />
      )}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="relative flex w-full sm:max-w-xs">
          <input
            className="input w-full pr-9"
            placeholder="Search name (EN/AR), SKU, barcode (incl. variants)…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <button
            type="button"
            className="absolute right-1 top-1/2 -translate-y-1/2 rounded p-1 text-base leading-none hover:bg-slate-100"
            title="Scan barcode with camera"
            aria-label="Scan barcode"
            onClick={() => setScanning(true)}
          >
            📷
          </button>
        </div>
        <select className="input sm:max-w-xs" value={cat} onChange={(e) => setCat(e.target.value)}>
          <option value="">All categories</option>
          {CATEGORIES.map((c) => (<option key={c} value={c}>{c}</option>))}
        </select>
        <select className="input sm:max-w-[12rem]" value={appr} onChange={(e) => setAppr(e.target.value)}>
          <option value="">كل الحالات</option>
          <option value="Approved">Approved · معتمد</option>
          <option value="Rejected">Rejected · مرفوض</option>
          <option value="SentAI">SentAI</option>
          <option value="none">بدون حالة</option>
        </select>
        <select className="input sm:max-w-[14rem]" value={grp} onChange={(e) => setGrp(e.target.value)}>
          <option value="">كل المجموعات</option>
          <option value="variants">🎚️ له خيارات · variants</option>
          <option value="new">🆕 جديد · من سنونو</option>
          <option value="image">🚫 مرفوض · بسبب الصورة</option>
          <option value="unavail">⛔ مرفوض · غير متاح على سنونو</option>
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

      {/* Cards (mobile) */}
      <div className="space-y-3 md:hidden">
        {filtered.length === 0 ? (
          <div className="card text-center text-sm text-slate-400">No products found.</div>
        ) : (
          visible.map((p) => (
            <div
              key={p.id}
              onClick={() => router.push(`/products/${p.id}`)}
              className="card flex cursor-pointer gap-3 p-3"
            >
              <Thumb url={p.image_url} alt={p.name_en ?? p.sku ?? "product"} />
              <div className="min-w-0 flex-1 space-y-1">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="truncate font-medium text-ink">{p.name_en ?? "—"}</div>
                    {p.name_ar ? <div className="truncate text-xs text-muted" dir="rtl">{p.name_ar}</div> : null}
                    <VariantHits p={p} />
                  </div>
                  <RowApproval id={p.id} value={p.approval} />
                </div>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
                  {p.sku ? <span>SKU {p.sku}</span> : null}
                  {p.main_category ? <span>{p.main_category}</span> : null}
                  {p.variant_count > 0 ? (
                    <button
                      onClick={(e) => { e.stopPropagation(); toggleExpand(p.id); }}
                      className="font-medium text-brand"
                    >
                      {p.variant_count} options {isOpen(p) ? "▴" : "▾"}
                    </button>
                  ) : null}
                </div>
                {isOpen(p) && (p.variants?.length ?? 0) > 0 ? (
                  <div onClick={(e) => e.stopPropagation()} className="rounded-lg bg-slate-50 p-2">
                    <VariantList p={p} />
                  </div>
                ) : null}
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <span className="text-slate-600">
                    {p.price != null ? `${p.price} QAR` : "—"}
                    {p.discount_price != null ? <span className="ml-1 text-green-700">→ {p.discount_price}</span> : null}
                  </span>
                  {p.stock == null ? null
                    : Number(p.stock) <= 0 ? <span className="badge bg-red-100 text-red-700">نافد</span>
                    : Number(p.stock) < 10 ? <span className="text-amber-700">stock {p.stock}</span>
                    : <span className="text-slate-600">stock {p.stock}</span>}
                </div>
                <div className="flex flex-wrap gap-1 pt-0.5">
                  {CHANNELS.map((c) => (
                    <span key={c} className="text-[10px]">
                      <span className="text-slate-400">{c}:</span> <StatusBadge status={p.channels[c]} />
                    </span>
                  ))}
                </div>
              </div>
            </div>
          ))
        )}
      </div>

      {/* Table (desktop / tablet) */}
      <div className="card hidden overflow-x-auto p-0 md:block">
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
                <Fragment key={p.id}>
                <tr
                  onClick={() => router.push(`/products/${p.id}`)}
                  className="cursor-pointer border-b border-slate-100 hover:bg-slate-50"
                >
                  <td className="px-3 py-2"><Thumb url={p.image_url} alt={p.name_en ?? p.sku ?? "product"} /></td>
                  <td className="px-3 py-3 font-medium text-ink">{p.name_en ?? "—"}<VariantHits p={p} /></td>
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
                  <td className="px-3 py-3 text-slate-600">
                    {p.variant_count > 0 ? (
                      <button
                        onClick={(e) => { e.stopPropagation(); toggleExpand(p.id); }}
                        className="font-medium text-brand hover:underline"
                        title="عرض الخيارات"
                      >
                        {p.variant_count} {isOpen(p) ? "▴" : "▾"}
                      </button>
                    ) : "—"}
                  </td>
                  {CHANNELS.map((c) => (
                    <td key={c} className="px-3 py-3"><StatusBadge status={p.channels[c]} /></td>
                  ))}
                </tr>
                {isOpen(p) && (p.variants?.length ?? 0) > 0 ? (
                  <tr className="border-b border-slate-100 bg-slate-50/60">
                    <td colSpan={16} className="px-6 py-2">
                      <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted">خيارات المنتج</div>
                      <VariantList p={p} />
                    </td>
                  </tr>
                ) : null}
                </Fragment>
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
