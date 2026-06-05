"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { CATEGORIES } from "@/lib/constants";

const PAGE_SIZE = 50;

export interface ProductRow {
  id: string;
  sku: string | null;
  name_en: string | null;
  brand_name: string | null;
  main_category: string | null;
  price: number | null;
  stock_quantity: number | null;
  stock_status: string | null;
  variant_count: number;
}

export default function ProductTable({ products }: { products: ProductRow[] }) {
  const [q, setQ] = useState("");
  const [cat, setCat] = useState("");

  const [page, setPage] = useState(1);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return products.filter((p) => {
      const matchesQ =
        !needle ||
        (p.name_en ?? "").toLowerCase().includes(needle) ||
        (p.sku ?? "").toLowerCase().includes(needle);
      const matchesCat = !cat || p.main_category === cat;
      return matchesQ && matchesCat;
    });
  }, [products, q, cat]);

  // Reset to first page whenever the filter result changes.
  useEffect(() => { setPage(1); }, [q, cat]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const current = Math.min(page, totalPages);
  const start = (current - 1) * PAGE_SIZE;
  const visible = filtered.slice(start, start + PAGE_SIZE);

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <input
          className="input sm:max-w-xs"
          placeholder="Search by name or SKU…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <select className="input sm:max-w-xs" value={cat} onChange={(e) => setCat(e.target.value)}>
          <option value="">All categories</option>
          {CATEGORIES.map((c) => (<option key={c} value={c}>{c}</option>))}
        </select>
        <span className="text-sm text-muted sm:ml-auto">
          {filtered.length === products.length
            ? `${products.length} products`
            : `${filtered.length} of ${products.length}`}
        </span>
      </div>

      <div className="card overflow-x-auto p-0">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-200 text-left text-xs uppercase text-muted">
              <th className="px-4 py-3 font-medium">Name</th>
              <th className="px-4 py-3 font-medium">SKU</th>
              <th className="px-4 py-3 font-medium">Brand</th>
              <th className="px-4 py-3 font-medium">Category</th>
              <th className="px-4 py-3 font-medium">Price</th>
              <th className="px-4 py-3 font-medium">Stock</th>
              <th className="px-4 py-3 font-medium">Variants</th>
              <th className="px-4 py-3 font-medium"></th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr><td colSpan={8} className="px-4 py-8 text-center text-slate-400">No products found.</td></tr>
            ) : (
              visible.map((p) => (
                <tr key={p.id} className="border-b border-slate-100 hover:bg-slate-50">
                  <td className="px-4 py-3 font-medium text-ink">{p.name_en ?? "—"}</td>
                  <td className="px-4 py-3 text-slate-600">{p.sku ?? "—"}</td>
                  <td className="px-4 py-3 text-slate-600">{p.brand_name ?? "—"}</td>
                  <td className="px-4 py-3 text-slate-600">{p.main_category ?? "—"}</td>
                  <td className="px-4 py-3 text-slate-600">{p.price ?? "—"}</td>
                  <td className="px-4 py-3 text-slate-600">{p.stock_quantity ?? "—"}</td>
                  <td className="px-4 py-3 text-slate-600">{p.variant_count > 0 ? p.variant_count : "—"}</td>
                  <td className="px-4 py-3 text-right">
                    <Link href={`/products/${p.id}`} className="text-brand hover:underline">Edit</Link>
                  </td>
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
            <button
              className="btn-ghost px-3 py-1.5 text-sm disabled:opacity-40"
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={current <= 1}
            >
              ← Prev
            </button>
            <span className="text-sm text-slate-600">Page {current} / {totalPages}</span>
            <button
              className="btn-ghost px-3 py-1.5 text-sm disabled:opacity-40"
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={current >= totalPages}
            >
              Next →
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
