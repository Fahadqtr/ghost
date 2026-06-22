"use client";

import { useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import BarcodeScanner from "@/components/BarcodeScanner";
import { shelfOf } from "@/lib/shelf";
import {
  updateInventory,
  bulkUpdateInventory,
  importInventoryBySku,
  pushStockToShopify,
  setLocation,
  saveShelfStock,
  type BulkUpdate,
} from "@/app/(app)/inventory/actions";
import { compareSlot } from "@/lib/shelf";

export interface InventoryRow {
  id: string;
  product_name: string | null;
  product_name_ar: string | null;
  sku: string | null;
  barcode: string | null;
  location: string | null;
  image_url: string | null;
  category: string | null;
  stock_quantity: number | null;
  low_stock_threshold: number | null;
  sold_quantity: number | null;
  updated_at: string | null;
}

type Status = "out" | "low" | "ok";
type SortKey = "product" | "sku" | "stock" | "threshold" | "sold" | "status" | "updated";

function statusOf(stock: number | null, threshold: number | null): Status {
  if (stock == null || stock <= 0) return "out";
  if (threshold != null && stock <= threshold) return "low";
  return "ok";
}

const statusRank: Record<Status, number> = { out: 0, low: 1, ok: 2 };

function fmtDate(s: string | null): string {
  if (!s) return "—";
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "2-digit" });
}

function csvEscape(v: unknown): string {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Minimal CSV parser (handles quoted fields + commas/newlines). */
function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let cur: string[] = [];
  let field = "";
  let i = 0;
  let inQ = false;
  text = text.replace(/^﻿/, "");
  while (i < text.length) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQ = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"') { inQ = true; i++; continue; }
    if (c === ",") { cur.push(field); field = ""; i++; continue; }
    if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      cur.push(field); field = "";
      if (cur.some((x) => x !== "")) rows.push(cur);
      cur = []; i++; continue;
    }
    field += c; i++;
  }
  if (field !== "" || cur.length) { cur.push(field); if (cur.some((x) => x !== "")) rows.push(cur); }
  if (rows.length === 0) return [];
  const header = rows[0].map((h) => h.trim().toLowerCase());
  return rows.slice(1).map((r) => {
    const o: Record<string, string> = {};
    header.forEach((h, idx) => (o[h] = (r[idx] ?? "").trim()));
    return o;
  });
}

export default function InventoryTable({
  rows,
  categories = [],
  slots = [],
  hasLocation = false,
  placements = {},
  hasShelfStock = false,
}: {
  rows: InventoryRow[];
  categories?: string[];
  slots?: string[];
  hasLocation?: boolean;
  placements?: Record<string, { location: string; quantity: number }[]>;
  hasShelfStock?: boolean;
}) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);

  const [q, setQ] = useState("");
  const [scanning, setScanning] = useState(false);
  const [statusFilter, setStatusFilter] = useState<"all" | Status>("all");
  const [catFilter, setCatFilter] = useState("");
  const [shelfFilter, setShelfFilter] = useState("");
  const [editLoc, setEditLoc] = useState<InventoryRow | null>(null); // multi-shelf editor target

  // Shelves a product occupies (multi-shelf if shelf_stock is on, else single).
  const rowShelves = (r: InventoryRow): string[] => {
    const p = placements[r.id];
    if (hasShelfStock && p && p.length) {
      return Array.from(new Set(p.map((x) => shelfOf(x.location)).filter(Boolean) as string[]));
    }
    const s = shelfOf(r.location);
    return s ? [s] : [];
  };

  const shelves = useMemo(() => {
    const set = new Set<string>();
    slots.forEach((c) => { const s = shelfOf(c); if (s) set.add(s); });
    Object.values(placements).forEach((arr) =>
      arr.forEach((x) => { const s = shelfOf(x.location); if (s) set.add(s); })
    );
    rows.forEach((r) => { const s = shelfOf(r.location); if (s) set.add(s); });
    return Array.from(set).sort();
  }, [slots, rows, placements]);
  const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" }>({ key: "stock", dir: "asc" });

  const [edits, setEdits] = useState<Record<string, { stock?: string; threshold?: string }>>({});
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [bulkValue, setBulkValue] = useState("");
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [pending, startTransition] = useTransition();

  const orig = (r: InventoryRow) => ({
    stock: r.stock_quantity?.toString() ?? "",
    threshold: r.low_stock_threshold?.toString() ?? "",
  });
  const curStock = (r: InventoryRow) => edits[r.id]?.stock ?? orig(r).stock;
  const curThreshold = (r: InventoryRow) => edits[r.id]?.threshold ?? orig(r).threshold;
  const isDirty = (r: InventoryRow) => {
    const e = edits[r.id];
    if (!e) return false;
    const o = orig(r);
    return (e.stock !== undefined && e.stock !== o.stock) || (e.threshold !== undefined && e.threshold !== o.threshold);
  };

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return rows.filter((r) => {
      const matchesQ =
        !needle ||
        (r.product_name ?? "").toLowerCase().includes(needle) ||
        (r.product_name_ar ?? "").includes(q.trim()) ||
        (r.sku ?? "").toLowerCase().includes(needle) ||
        (r.barcode ?? "").toLowerCase().includes(needle);
      const st = statusOf(Number(curStock(r)) || 0, Number(curThreshold(r)) || null);
      const matchesStatus = statusFilter === "all" || st === statusFilter;
      const matchesCat = !catFilter || r.category === catFilter;
      const matchesShelf = !shelfFilter || rowShelves(r).includes(shelfFilter);
      return matchesQ && matchesStatus && matchesCat && matchesShelf;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, q, statusFilter, catFilter, shelfFilter, edits]);

  const sorted = useMemo(() => {
    const dir = sort.dir === "asc" ? 1 : -1;
    const val = (r: InventoryRow) => {
      switch (sort.key) {
        case "product": return (r.product_name ?? "").toLowerCase();
        case "sku": return (r.sku ?? "").toLowerCase();
        case "stock": return Number(curStock(r)) || 0;
        case "threshold": return Number(curThreshold(r)) || 0;
        case "sold": return r.sold_quantity ?? 0;
        case "status": return statusRank[statusOf(Number(curStock(r)) || 0, Number(curThreshold(r)) || null)];
        case "updated": return r.updated_at ? new Date(r.updated_at).getTime() : 0;
      }
    };
    return [...filtered].sort((a, b) => {
      const va = val(a) as any, vb = val(b) as any;
      return va < vb ? -dir : va > vb ? dir : 0;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtered, sort, edits]);

  const dirtyRows = rows.filter(isDirty);
  const selectedRows = sorted.filter((r) => selected.has(r.id));
  const allVisibleSelected = sorted.length > 0 && sorted.every((r) => selected.has(r.id));

  function setStock(id: string, v: string) {
    setEdits((e) => ({ ...e, [id]: { ...e[id], stock: v } }));
  }
  function setThreshold(id: string, v: string) {
    setEdits((e) => ({ ...e, [id]: { ...e[id], threshold: v } }));
  }
  function clearEdits(ids: string[]) {
    setEdits((e) => {
      const n = { ...e };
      ids.forEach((id) => delete n[id]);
      return n;
    });
  }

  function toggleSelect(id: string) {
    setSelected((s) => {
      const n = new Set(s);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  }
  function toggleSelectAll() {
    setSelected((s) => {
      if (allVisibleSelected) {
        const n = new Set(s);
        sorted.forEach((r) => n.delete(r.id));
        return n;
      }
      const n = new Set(s);
      sorted.forEach((r) => n.add(r.id));
      return n;
    });
  }

  function saveOne(r: InventoryRow) {
    startTransition(async () => {
      const res = await updateInventory(r.id, { stock_quantity: curStock(r), low_stock_threshold: curThreshold(r) });
      if (res && "error" in res && res.error) {
        setRowErrors((e) => ({ ...e, [r.id]: res.error! }));
      } else {
        setRowErrors((e) => { const n = { ...e }; delete n[r.id]; return n; });
        clearEdits([r.id]);
        router.refresh();
      }
    });
  }

  function saveAll() {
    if (dirtyRows.length === 0) return;
    const updates: BulkUpdate[] = dirtyRows.map((r) => ({
      id: r.id,
      stock_quantity: curStock(r),
      low_stock_threshold: curThreshold(r),
    }));
    startTransition(async () => {
      const res = await bulkUpdateInventory(updates);
      setMsg({
        kind: res.failed ? "err" : "ok",
        text: res.failed ? `Saved ${res.ok}, ${res.failed} failed: ${res.errors.join("; ")}` : `Saved ${res.ok} change${res.ok === 1 ? "" : "s"}.`,
      });
      clearEdits(dirtyRows.map((r) => r.id));
      router.refresh();
    });
  }

  function applyBulkValue() {
    const v = bulkValue.trim();
    if (v === "" || selected.size === 0) return;
    setEdits((e) => {
      const n = { ...e };
      selectedRows.forEach((r) => (n[r.id] = { ...n[r.id], stock: v }));
      return n;
    });
  }

  function exportCsv() {
    const header = ["sku", "name_en", "name_ar", "category", "stock_quantity", "low_stock_threshold", "sold_quantity", "status", "updated_at"];
    const lines = [header.join(",")];
    for (const r of sorted) {
      const st = statusOf(Number(curStock(r)) || 0, Number(curThreshold(r)) || null);
      lines.push([r.sku, r.product_name, r.product_name_ar, r.category, curStock(r), curThreshold(r), r.sold_quantity ?? 0, st, r.updated_at].map(csvEscape).join(","));
    }
    const blob = new Blob(["﻿" + lines.join("\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `inventory_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function onImportFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const parsed = parseCsv(String(reader.result || ""));
      const items = parsed
        .map((row) => ({
          sku: row.sku ?? row["sku "] ?? "",
          stock_quantity: row.stock_quantity ?? row.stock ?? row.quantity ?? "",
          low_stock_threshold: row.low_stock_threshold ?? row.threshold ?? "",
        }))
        .filter((r) => r.sku);
      if (items.length === 0) {
        setMsg({ kind: "err", text: "No rows with a 'sku' column found in the CSV." });
        return;
      }
      startTransition(async () => {
        const res = await importInventoryBySku(items);
        setMsg({
          kind: res.notFound || res.failed ? "err" : "ok",
          text: `Imported ${res.updated} · not-found ${res.notFound} · failed ${res.failed}${res.missing.length ? ` (missing: ${res.missing.slice(0, 8).join(", ")}${res.missing.length > 8 ? "…" : ""})` : ""}`,
        });
        router.refresh();
      });
    };
    reader.readAsText(file);
    e.target.value = "";
  }

  function pushSelected() {
    if (selected.size === 0) return;
    const items = selectedRows
      .map((r) => ({ sku: r.sku ?? "", quantity: Number(curStock(r)) || 0 }))
      .filter((it) => it.sku);
    startTransition(async () => {
      const res = await pushStockToShopify(items);
      if (!res.configured) setMsg({ kind: "err", text: res.message });
      else
        setMsg({
          kind: res.failed ? "err" : "ok",
          text: `Pushed ${res.pushed} to Shopify · ${res.failed} failed${res.errors.length ? `: ${res.errors.join("; ")}` : ""}`,
        });
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-shadow
  function LocationCell({ id, value }: { id: string; value: string | null }) {
    const [val, setVal] = useState(value ?? "");
    const [savePending, startSave] = useTransition();
    const commit = () => {
      const next = val.trim().toUpperCase();
      setVal(next);
      if (next === (value ?? "")) return;
      startSave(async () => {
        await setLocation(id, next);
        router.refresh();
      });
    };
    return (
      <input
        list="slot-codes"
        className="input w-24 uppercase"
        placeholder="—"
        value={val}
        disabled={savePending}
        onChange={(e) => setVal(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
      />
    );
  }

  const Th = ({ k, label, num }: { k: SortKey; label: string; num?: boolean }) => (
    <th
      className={`px-4 py-3 font-medium ${num ? "text-right" : "text-left"} cursor-pointer select-none hover:text-ink`}
      onClick={() => setSort((s) => ({ key: k, dir: s.key === k && s.dir === "asc" ? "desc" : "asc" }))}
    >
      {label} {sort.key === k ? (sort.dir === "asc" ? "▲" : "▼") : ""}
    </th>
  );

  return (
    <div className="space-y-3">
      {/* Camera barcode scanner */}
      {scanning && (
        <BarcodeScanner
          onDetected={(code) => {
            setQ(code.trim());
            setScanning(false);
          }}
          onClose={() => setScanning(false)}
        />
      )}

      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex sm:max-w-xs">
          <input
            className="input w-full pr-9"
            placeholder="Search name / SKU / barcode…"
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
        <select className="input w-auto" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as any)}>
          <option value="all">All statuses</option>
          <option value="out">Out of stock</option>
          <option value="low">Low stock</option>
          <option value="ok">OK</option>
        </select>
        {categories.length > 0 && (
          <select className="input w-auto" value={catFilter} onChange={(e) => setCatFilter(e.target.value)}>
            <option value="">All categories</option>
            {categories.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        )}
        {hasLocation && shelves.length > 0 && (
          <select className="input w-auto" value={shelfFilter} onChange={(e) => setShelfFilter(e.target.value)}>
            <option value="">All shelves</option>
            {shelves.map((s) => (
              <option key={s} value={s}>Shelf {s}</option>
            ))}
          </select>
        )}
        <span className="text-sm text-muted">{sorted.length} of {rows.length}</span>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <button className="btn-ghost px-3 py-1 text-xs" onClick={exportCsv}>Export CSV</button>
          <button className="btn-ghost px-3 py-1 text-xs" onClick={() => fileRef.current?.click()}>Import CSV</button>
          <input ref={fileRef} type="file" accept=".csv,text/csv" className="hidden" onChange={onImportFile} />
          <button
            className="btn-primary px-3 py-1 text-xs disabled:opacity-50"
            disabled={dirtyRows.length === 0 || pending}
            onClick={saveAll}
          >
            {pending ? "Saving…" : `Save all (${dirtyRows.length})`}
          </button>
        </div>
      </div>

      {/* Bulk bar */}
      {selected.size > 0 && (
        <div className="card flex flex-wrap items-center gap-3 border-blue-200 bg-blue-50 py-3 text-sm">
          <span className="font-medium text-blue-900">{selected.size} selected</span>
          <div className="flex items-center gap-2">
            <span className="text-slate-600">Set stock to</span>
            <input className="input w-24" type="number" value={bulkValue} onChange={(e) => setBulkValue(e.target.value)} placeholder="50" />
            <button className="btn-ghost px-3 py-1 text-xs disabled:opacity-50" disabled={bulkValue.trim() === ""} onClick={applyBulkValue}>
              Apply
            </button>
          </div>
          <button className="btn-ghost px-3 py-1 text-xs" onClick={pushSelected} disabled={pending}>
            Push to Shopify
          </button>
          <button className="btn-ghost px-3 py-1 text-xs" onClick={() => setSelected(new Set())}>Clear selection</button>
        </div>
      )}

      {/* Message */}
      {msg && (
        <div className={`card py-2 text-sm ${msg.kind === "ok" ? "border-green-200 bg-green-50 text-green-800" : "border-amber-200 bg-amber-50 text-amber-800"}`}>
          {msg.text}
          <button className="ml-3 text-xs underline" onClick={() => setMsg(null)}>dismiss</button>
        </div>
      )}

      {/* Shared slot-code suggestions for the Location inputs */}
      {hasLocation && (
        <datalist id="slot-codes">
          {slots.map((c) => <option key={c} value={c} />)}
        </datalist>
      )}

      {/* Table */}
      <div className="card overflow-x-auto p-0">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-200 text-left text-xs uppercase text-muted">
              <th className="px-3 py-3">
                <input type="checkbox" checked={allVisibleSelected} onChange={toggleSelectAll} aria-label="Select all" />
              </th>
              <Th k="product" label="Product" />
              <Th k="sku" label="SKU" />
              {hasLocation && <th className="px-4 py-3 font-medium text-left">Location</th>}
              <Th k="stock" label="Stock" num />
              <Th k="threshold" label="Low threshold" num />
              <Th k="sold" label="Sold" num />
              <Th k="status" label="Status" />
              <Th k="updated" label="Updated" />
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody>
            {sorted.length === 0 ? (
              <tr><td colSpan={hasLocation ? 10 : 9} className="px-4 py-8 text-center text-slate-400">No inventory rows.</td></tr>
            ) : (
              sorted.map((r) => {
                const st = statusOf(Number(curStock(r)) || 0, Number(curThreshold(r)) || null);
                const badge =
                  st === "out" ? "bg-red-100 text-red-700" : st === "low" ? "bg-amber-100 text-amber-700" : "bg-green-100 text-green-700";
                const dirty = isDirty(r);
                return (
                  <tr key={r.id} className="border-b border-slate-100 hover:bg-slate-50">
                    <td className="px-3 py-3">
                      <input type="checkbox" checked={selected.has(r.id)} onChange={() => toggleSelect(r.id)} aria-label="Select row" />
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        {r.image_url ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={r.image_url} alt="" className="h-8 w-8 flex-none rounded object-cover" loading="lazy" />
                        ) : (
                          <div className="h-8 w-8 flex-none rounded bg-slate-100" />
                        )}
                        <div className="min-w-0">
                          <div className="truncate font-medium text-ink">{r.product_name ?? "—"}</div>
                          {r.product_name_ar ? <div className="truncate text-xs text-muted" dir="rtl">{r.product_name_ar}</div> : null}
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-slate-600">{r.sku ?? "—"}</td>
                    {hasLocation && (
                      <td className="px-4 py-3">
                        {hasShelfStock ? (
                          <ShelfStockCell row={r} placements={placements[r.id] ?? []} onEdit={() => setEditLoc(r)} />
                        ) : (
                          <LocationCell id={r.id} value={r.location} />
                        )}
                      </td>
                    )}
                    <td className="px-4 py-3 text-right">
                      <input className="input w-20 text-right" type="number" value={curStock(r)} onChange={(e) => setStock(r.id, e.target.value)} />
                    </td>
                    <td className="px-4 py-3 text-right">
                      <input className="input w-20 text-right" type="number" value={curThreshold(r)} onChange={(e) => setThreshold(r.id, e.target.value)} />
                    </td>
                    <td className="px-4 py-3 text-right text-slate-600">{r.sold_quantity ?? 0}</td>
                    <td className="px-4 py-3">
                      <span className={`badge ${badge}`}>{st === "out" ? "Out" : st === "low" ? "Low" : "OK"}</span>
                    </td>
                    <td className="px-4 py-3 text-xs text-muted">{fmtDate(r.updated_at)}</td>
                    <td className="px-4 py-3 text-right">
                      {rowErrors[r.id] ? (
                        <span className="text-xs text-red-600" title={rowErrors[r.id]}>Error</span>
                      ) : (
                        <button
                          className="btn-ghost px-3 py-1 text-xs disabled:opacity-40"
                          disabled={!dirty || pending}
                          onClick={() => saveOne(r)}
                        >
                          Save
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {editLoc && hasShelfStock && (
        <LocationsEditor
          row={editLoc}
          placements={placements[editLoc.id] ?? []}
          slots={slots}
          onClose={() => setEditLoc(null)}
        />
      )}
    </div>
  );
}

/** Compact read-only summary of where a product's units sit, with an edit button. */
function ShelfStockCell({
  row,
  placements,
  onEdit,
}: {
  row: InventoryRow;
  placements: { location: string; quantity: number }[];
  onEdit: () => void;
}) {
  const placed = placements.reduce((s, p) => s + p.quantity, 0);
  const total = row.stock_quantity ?? 0;
  const sorted = placements.slice().sort((a, b) => compareSlot(a.location, b.location));
  return (
    <div className="flex items-center gap-2">
      <button className="flex flex-wrap gap-1 text-left" onClick={onEdit} title="Edit shelf locations">
        {sorted.length === 0 ? (
          <span className="text-slate-400">— set —</span>
        ) : (
          sorted.map((p) => (
            <span key={p.location} className="rounded bg-slate-100 px-1.5 py-0.5 text-xs">
              <span className="font-mono font-medium">{p.location}</span>
              <span className="text-slate-500">·{p.quantity}</span>
            </span>
          ))
        )}
      </button>
      <button className="flex-none text-slate-400 hover:text-ink" onClick={onEdit} title="Edit">✎</button>
      {placed !== total && (
        <span
          className="flex-none rounded bg-amber-100 px-1.5 py-0.5 text-[10px] text-amber-700"
          title="Placed units don't match the total stock"
        >
          {placed}/{total}
        </span>
      )}
    </div>
  );
}

/** Modal to edit a product's per-shelf distribution (multiple location+qty rows). */
function LocationsEditor({
  row,
  placements,
  slots,
  onClose,
}: {
  row: InventoryRow;
  placements: { location: string; quantity: number }[];
  slots: string[];
  onClose: () => void;
}) {
  const router = useRouter();
  const [rowsState, setRowsState] = useState<{ location: string; quantity: string }[]>(
    placements.length
      ? placements.map((p) => ({ location: p.location, quantity: String(p.quantity) }))
      : [{ location: "", quantity: "" }]
  );
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);

  const total = row.stock_quantity ?? 0;
  const placed = rowsState.reduce((s, r) => s + (Math.max(0, Math.floor(Number(r.quantity) || 0))), 0);

  const set = (i: number, k: "location" | "quantity", v: string) =>
    setRowsState((rs) => rs.map((r, idx) => (idx === i ? { ...r, [k]: v } : r)));
  const add = () => setRowsState((rs) => [...rs, { location: "", quantity: "" }]);
  const remove = (i: number) => setRowsState((rs) => rs.filter((_, idx) => idx !== i));

  function save() {
    start(async () => {
      const res = await saveShelfStock(
        row.id,
        rowsState.map((r) => ({ location: r.location, quantity: Number(r.quantity) || 0 }))
      );
      if (res && "error" in res && res.error) { setErr(res.error); return; }
      router.refresh();
      onClose();
    });
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="w-full max-w-md rounded-xl bg-white p-4 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-1 text-sm font-semibold text-ink">{row.product_name ?? row.sku}</div>
        <div className="mb-3 text-xs text-muted">
          Set how many units sit in each shelf. Total stock becomes the sum ={" "}
          <span className="font-semibold text-ink">{placed}</span>
          {total !== placed && <span className="text-amber-700"> (was {total})</span>}.
        </div>

        <datalist id="loc-editor-slots">
          {slots.map((c) => <option key={c} value={c} />)}
        </datalist>

        <div className="space-y-2">
          {rowsState.map((r, i) => (
            <div key={i} className="flex items-center gap-2">
              <input
                list="loc-editor-slots"
                className="input flex-1 font-mono uppercase"
                placeholder="A1"
                value={r.location}
                onChange={(e) => set(i, "location", e.target.value)}
              />
              <input
                className="input w-24 text-right"
                type="number"
                min={0}
                placeholder="qty"
                value={r.quantity}
                onChange={(e) => set(i, "quantity", e.target.value)}
              />
              <button className="flex-none text-slate-400 hover:text-red-600" onClick={() => remove(i)} title="Remove">✕</button>
            </div>
          ))}
        </div>

        <button className="btn-ghost mt-2 px-3 py-1 text-xs" onClick={add}>+ Add shelf</button>

        {err && <div className="mt-2 text-xs text-red-600">{err}</div>}

        <div className="mt-4 flex justify-end gap-2">
          <button className="btn-ghost px-3 py-1.5 text-sm" onClick={onClose} disabled={pending}>Cancel</button>
          <button className="btn-primary px-4 py-1.5 text-sm disabled:opacity-50" onClick={save} disabled={pending}>
            {pending ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
