"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { CATEGORIES, platformBy } from "@/lib/constants";
import { setPlatformApproval, rejectPlatformProducts, type PlatformProduct } from "@/app/(app)/platforms/actions";
import RejectByPaste from "@/components/RejectByPaste";

const PAGE_SIZE = 50;

const apprCls = (s: string) =>
  s === "Approved" ? "bg-green-100 text-green-700"
  : s === "Rejected" ? "bg-red-100 text-red-700"
  : s === "SentAI" ? "bg-amber-100 text-amber-700"
  : "bg-slate-100 text-slate-400";

function Thumb({ url, alt }: { url: string | null; alt: string }) {
  return (
    <div className="h-12 w-12 shrink-0 overflow-hidden rounded bg-slate-100 ring-1 ring-slate-200">
      {url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={url} alt={alt} width={48} height={48} loading="lazy" className="block h-full w-full object-cover" />
      ) : (
        <div className="flex h-full w-full items-center justify-center text-slate-300" title="No image">📦</div>
      )}
    </div>
  );
}

// Inline approve/reject for ONE product on THIS platform.
function RowApproval({ id, platform, value }: { id: string; platform: string; value: string | null }) {
  const [val, setVal] = useState(value ?? "");
  const [busy, start] = useTransition();
  return (
    <select
      value={val}
      disabled={busy}
      onChange={(e) => {
        const v = e.target.value;
        const prev = val;
        setVal(v);
        start(async () => {
          const res = await setPlatformApproval([id], platform, v);
          if (res?.error) { setVal(prev); alert(res.error); }
        });
      }}
      className={`badge cursor-pointer border-0 outline-none ${apprCls(val)} ${busy ? "opacity-50" : ""}`}
      title="غيّر حالة الاعتماد لهذه المنصة"
    >
      <option value="">بدون</option>
      <option value="Approved">معتمد</option>
      <option value="Rejected">مرفوض</option>
      <option value="SentAI">SentAI</option>
    </select>
  );
}

export default function PlatformHub({ platform, products }: { platform: string; products: PlatformProduct[] }) {
  const meta = platformBy(platform);
  const [q, setQ] = useState("");
  const [cat, setCat] = useState("");
  const [appr, setAppr] = useState("");
  const [page, setPage] = useState(1);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return products.filter((p) => {
      const matchesQ = !needle
        || (p.name_en ?? "").toLowerCase().includes(needle)
        || (p.name_ar ?? "").toLowerCase().includes(needle)
        || (p.sku ?? "").toLowerCase().includes(needle);
      const matchesCat = !cat || p.main_category === cat;
      const matchesAppr = !appr || (appr === "none" ? !p.approval : p.approval === appr);
      return matchesQ && matchesCat && matchesAppr;
    });
  }, [products, q, cat, appr]);

  useEffect(() => { setPage(1); }, [q, cat, appr]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const current = Math.min(page, totalPages);
  const start = (current - 1) * PAGE_SIZE;
  const visible = filtered.slice(start, start + PAGE_SIZE);

  // Counts for the quick summary chips.
  const counts = useMemo(() => {
    let approved = 0, rejected = 0, none = 0;
    for (const p of products) {
      if (p.approval === "Approved") approved++;
      else if (p.approval === "Rejected") rejected++;
      else if (!p.approval) none++;
    }
    return { approved, rejected, none };
  }, [products]);

  // Bind the platform into the shared reject tool's (ids, reason) action.
  const rejectForPlatform = (ids: string[], reason: string) => rejectPlatformProducts(ids, platform, reason);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="badge bg-green-100 text-green-700">معتمد {counts.approved}</span>
        <span className="badge bg-red-100 text-red-700">مرفوض {counts.rejected}</span>
        <span className="badge bg-slate-100 text-slate-500">بدون حالة {counts.none}</span>
        <span className="text-muted">· {products.length} منتج (نفس الماستر)</span>
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <input className="input sm:max-w-xs" placeholder="بحث بالاسم (EN/AR) أو SKU…" value={q} onChange={(e) => setQ(e.target.value)} />
        <select className="input sm:max-w-xs" value={cat} onChange={(e) => setCat(e.target.value)}>
          <option value="">كل الفئات</option>
          {CATEGORIES.map((c) => (<option key={c} value={c}>{c}</option>))}
        </select>
        <select className="input sm:max-w-[12rem]" value={appr} onChange={(e) => setAppr(e.target.value)}>
          <option value="">كل الحالات</option>
          <option value="Approved">Approved · معتمد</option>
          <option value="Rejected">Rejected · مرفوض</option>
          <option value="SentAI">SentAI</option>
          <option value="none">بدون حالة</option>
        </select>
        <span className="text-sm text-muted sm:ml-auto">
          {filtered.length === products.length ? `${products.length} منتج` : `${filtered.length} من ${products.length}`}
        </span>
      </div>

      <div className="card overflow-x-auto p-0">
        <table className="w-full min-w-[800px] text-sm">
          <thead>
            <tr className="border-b border-slate-200 text-left text-xs uppercase text-muted">
              <th className="px-3 py-3 font-medium"></th>
              <th className="px-3 py-3 font-medium">Name EN</th>
              <th className="px-3 py-3 font-medium">Name AR</th>
              <th className="px-3 py-3 font-medium">SKU</th>
              <th className="px-3 py-3 font-medium">Category</th>
              <th className="px-3 py-3 font-medium">Price</th>
              <th className="px-3 py-3 font-medium">حالة {meta?.label ?? platform}</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr><td colSpan={7} className="px-4 py-8 text-center text-slate-400">ما في منتجات.</td></tr>
            ) : (
              visible.map((p) => (
                <tr key={p.id} className="border-b border-slate-100 hover:bg-slate-50">
                  <td className="px-3 py-2"><Thumb url={p.image_url} alt={p.name_en ?? p.sku ?? "product"} /></td>
                  <td className="px-3 py-3 font-medium text-ink">{p.name_en ?? "—"}</td>
                  <td className="px-3 py-3 text-slate-600" dir="rtl">{p.name_ar ?? "—"}</td>
                  <td className="px-3 py-3 text-slate-600">{p.sku ?? "—"}</td>
                  <td className="px-3 py-3 text-slate-600">{p.main_category ?? "—"}</td>
                  <td className="px-3 py-3 text-slate-600">{p.price ?? "—"}</td>
                  <td className="px-3 py-3">
                    <RowApproval id={p.id} platform={platform} value={p.approval} />
                    {p.approval === "Rejected" && p.rejection_reason
                      ? <p className="mt-0.5 text-[11px] text-red-700">{p.rejection_reason}</p> : null}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {filtered.length > PAGE_SIZE ? (
        <div className="flex flex-col items-center justify-between gap-3 sm:flex-row">
          <span className="text-sm text-muted">عرض {start + 1}–{Math.min(start + PAGE_SIZE, filtered.length)} من {filtered.length}</span>
          <div className="flex items-center gap-2">
            <button className="btn-ghost px-3 py-1.5 text-sm disabled:opacity-40" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={current <= 1}>← السابق</button>
            <span className="text-sm text-slate-600">صفحة {current} / {totalPages}</span>
            <button className="btn-ghost px-3 py-1.5 text-sm disabled:opacity-40" onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={current >= totalPages}>التالي →</button>
          </div>
        </div>
      ) : null}

      <RejectByPaste
        title={`رفض المرفوضة من ${meta?.label ?? platform} (لصق / صورة شاشة)`}
        description={`الصق أسماء المنتجات المرفوضة (أو SKU)، سطر لكل منتج — أو ارفع صورة شاشة — نطابقها بالماستر وترفضها دفعة على ${meta?.label ?? platform} فقط. باقي المنصات والماستر ما تتأثر.`}
        uploadLabel={`📷 ارفع صورة شاشة من ${meta?.label ?? platform}`}
        defaultReason={`مرفوض على ${meta?.label ?? platform}`}
        rejectAction={meta?.master ? undefined : rejectForPlatform}
        showApprovalBadge={!!meta?.master}
        confirmLabel={`على ${meta?.label ?? platform}`}
      />
    </div>
  );
}
