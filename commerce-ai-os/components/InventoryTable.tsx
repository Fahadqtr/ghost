"use client";

import { useMemo, useState, useTransition } from "react";
import { updateInventory } from "@/app/(app)/inventory/actions";

export interface InventoryRow {
  id: string;
  product_name: string | null;
  sku: string | null;
  stock_quantity: number | null;
  low_stock_threshold: number | null;
  sold_quantity: number | null;
}

function isLow(r: InventoryRow) {
  return (
    r.stock_quantity != null &&
    r.low_stock_threshold != null &&
    r.stock_quantity <= r.low_stock_threshold
  );
}

export default function InventoryTable({ rows }: { rows: InventoryRow[] }) {
  const [q, setQ] = useState("");
  const [lowOnly, setLowOnly] = useState(false);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return rows.filter((r) => {
      const matchesQ =
        !needle ||
        (r.product_name ?? "").toLowerCase().includes(needle) ||
        (r.sku ?? "").toLowerCase().includes(needle);
      return matchesQ && (!lowOnly || isLow(r));
    });
  }, [rows, q, lowOnly]);

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <input className="input sm:max-w-xs" placeholder="Search…" value={q} onChange={(e) => setQ(e.target.value)} />
        <label className="flex items-center gap-2 text-sm text-slate-600">
          <input type="checkbox" checked={lowOnly} onChange={(e) => setLowOnly(e.target.checked)} />
          Low stock only
        </label>
        <span className="text-sm text-muted sm:ml-auto">{filtered.length} of {rows.length}</span>
      </div>

      <div className="card overflow-x-auto p-0">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-200 text-left text-xs uppercase text-muted">
              <th className="px-4 py-3 font-medium">Product</th>
              <th className="px-4 py-3 font-medium">SKU</th>
              <th className="px-4 py-3 font-medium">Stock</th>
              <th className="px-4 py-3 font-medium">Low threshold</th>
              <th className="px-4 py-3 font-medium">Sold</th>
              <th className="px-4 py-3 font-medium">Status</th>
              <th className="px-4 py-3 font-medium"></th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr><td colSpan={7} className="px-4 py-8 text-center text-slate-400">No inventory rows.</td></tr>
            ) : (
              filtered.map((r) => <Row key={r.id} row={r} />)
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Row({ row }: { row: InventoryRow }) {
  const [stock, setStock] = useState(row.stock_quantity?.toString() ?? "");
  const [threshold, setThreshold] = useState(row.low_stock_threshold?.toString() ?? "");
  const [pending, startTransition] = useTransition();
  const [saved, setSaved] = useState(false);

  const dirty =
    stock !== (row.stock_quantity?.toString() ?? "") ||
    threshold !== (row.low_stock_threshold?.toString() ?? "");

  const low = isLow({ ...row, stock_quantity: Number(stock), low_stock_threshold: Number(threshold) });

  function save() {
    startTransition(async () => {
      await updateInventory(row.id, { stock_quantity: stock, low_stock_threshold: threshold });
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    });
  }

  return (
    <tr className="border-b border-slate-100 hover:bg-slate-50">
      <td className="px-4 py-3 font-medium text-ink">{row.product_name ?? "—"}</td>
      <td className="px-4 py-3 text-slate-600">{row.sku ?? "—"}</td>
      <td className="px-4 py-3">
        <input className="input w-24" type="number" value={stock} onChange={(e) => setStock(e.target.value)} />
      </td>
      <td className="px-4 py-3">
        <input className="input w-24" type="number" value={threshold} onChange={(e) => setThreshold(e.target.value)} />
      </td>
      <td className="px-4 py-3 text-slate-600">{row.sold_quantity ?? 0}</td>
      <td className="px-4 py-3">
        {low ? (
          <span className="badge bg-red-100 text-red-700">Low</span>
        ) : (
          <span className="badge bg-green-100 text-green-700">OK</span>
        )}
      </td>
      <td className="px-4 py-3 text-right">
        {saved ? (
          <span className="text-xs text-green-600">Saved ✓</span>
        ) : (
          <button className="btn-ghost px-3 py-1 text-xs disabled:opacity-50" disabled={!dirty || pending} onClick={save}>
            {pending ? "Saving…" : "Save"}
          </button>
        )}
      </td>
    </tr>
  );
}
