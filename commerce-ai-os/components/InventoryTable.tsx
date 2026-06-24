"use client";

import { Fragment, useMemo, useRef, useState, useTransition } from "react";
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
  saveVariantShelfStock,
  bulkAssignShelf,
  bulkAssignVariantShelf,
  type BulkUpdate,
} from "@/app/(app)/inventory/actions";
import { compareSlot } from "@/lib/shelf";

export interface Variant {
  id: string;
  variant_name: string | null;
  sku: string | null;
  barcode: string | null;
  color: string | null;
  size: string | null;
  stock_quantity: number | null;
}

export interface InventoryRow {
  id: string;
  product_id: string | null;
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
  variantsByProduct = {},
  variantPlacements = {},
  hasVariantShelf = false,
}: {
  rows: InventoryRow[];
  categories?: string[];
  slots?: string[];
  hasLocation?: boolean;
  placements?: Record<string, { location: string; quantity: number }[]>;
  hasShelfStock?: boolean;
  variantsByProduct?: Record<string, Variant[]>;
  variantPlacements?: Record<string, { location: string; quantity: number }[]>;
  hasVariantShelf?: boolean;
}) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);

  const [q, setQ] = useState("");
  const [scanning, setScanning] = useState(false);
  const [statusFilter, setStatusFilter] = useState<"all" | Status>("all");
  const [catFilter, setCatFilter] = useState("");
  const [shelfFilter, setShelfFilter] = useState("");
  const [editTarget, setEditTarget] = useState<EditTarget | null>(null); // shelf editor (product or variant)
  const [expanded, setExpanded] = useState<Set<string>>(new Set()); // product rows showing their variants
  const toggleExpand = (id: string) =>
    setExpanded((prev) => {
      const n = new Set(prev);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });

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
  const [selectedVariants, setSelectedVariants] = useState<Set<string>>(new Set());
  const toggleVariant = (id: string) =>
    setSelectedVariants((s) => {
      const n = new Set(s);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [bulkValue, setBulkValue] = useState("");
  const [bulkSlot, setBulkSlot] = useState("");
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

  // Does any of this product's options match the search? (barcode / sku / name)
  const variantMatch = (r: InventoryRow, needle: string) => {
    if (!needle) return false;
    const vs = (r.product_id && variantsByProduct[r.product_id]) || [];
    return vs.some(
      (v) =>
        (v.barcode ?? "").toLowerCase().includes(needle) ||
        (v.sku ?? "").toLowerCase().includes(needle) ||
        (v.variant_name ?? "").toLowerCase().includes(needle)
    );
  };

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return rows.filter((r) => {
      const matchesQ =
        !needle ||
        (r.product_name ?? "").toLowerCase().includes(needle) ||
        (r.product_name_ar ?? "").includes(q.trim()) ||
        (r.sku ?? "").toLowerCase().includes(needle) ||
        (r.barcode ?? "").toLowerCase().includes(needle) ||
        variantMatch(r, needle);
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

  function assignSelectedToShelf() {
    const slot = bulkSlot.trim().toUpperCase();
    const pids = [...selected];
    const vids = [...selectedVariants];
    if (!slot || (pids.length === 0 && vids.length === 0)) return;
    startTransition(async () => {
      let errText = "";
      let total = 0;
      if (pids.length) {
        const r = await bulkAssignShelf(pids, slot);
        if (r && "error" in r && r.error) errText = r.error;
        else total += (r as any)?.done ?? pids.length;
      }
      if (!errText && vids.length) {
        const r = await bulkAssignVariantShelf(vids, slot);
        if (r && "error" in r && r.error) errText = r.error;
        else total += (r as any)?.done ?? vids.length;
      }
      if (errText) {
        setMsg({ kind: "err", text: errText });
        return;
      }
      setMsg({ kind: "ok", text: `أُضيف ${total} عنصر للرفّ ${slot}` });
      setSelected(new Set());
      setSelectedVariants(new Set());
      setBulkSlot("");
      router.refresh();
    });
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
        <div className="relative flex w-full sm:w-auto sm:max-w-xs">
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
      {(selected.size > 0 || selectedVariants.size > 0) && (
        <div className="card flex flex-wrap items-center gap-3 border-blue-200 bg-blue-50 py-3 text-sm">
          <span className="font-medium text-blue-900">
            {selected.size > 0 ? `${selected.size} منتج` : ""}
            {selected.size > 0 && selectedVariants.size > 0 ? " + " : ""}
            {selectedVariants.size > 0 ? `${selectedVariants.size} خيار` : ""} محدّد
          </span>
          <div className="flex items-center gap-2">
            <span className="text-slate-600">Set stock to</span>
            <input className="input w-24" type="number" value={bulkValue} onChange={(e) => setBulkValue(e.target.value)} placeholder="50" />
            <button className="btn-ghost px-3 py-1 text-xs disabled:opacity-50" disabled={bulkValue.trim() === ""} onClick={applyBulkValue}>
              Apply
            </button>
          </div>
          {hasLocation && (
            <div className="flex items-center gap-2">
              <span className="text-slate-600">أضف للرفّ</span>
              <input
                list="slot-codes"
                className="input w-24 uppercase"
                placeholder="A1"
                value={bulkSlot}
                onChange={(e) => setBulkSlot(e.target.value)}
              />
              <button
                className="btn-ghost px-3 py-1 text-xs disabled:opacity-50"
                disabled={bulkSlot.trim() === "" || pending}
                onClick={assignSelectedToShelf}
              >
                إضافة
              </button>
            </div>
          )}
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

      {/* Cards (mobile) */}
      <div className="space-y-3 md:hidden">
        {sorted.length === 0 ? (
          <div className="card text-center text-sm text-slate-400">No inventory rows.</div>
        ) : (
          sorted.map((r) => {
            const st = statusOf(Number(curStock(r)) || 0, Number(curThreshold(r)) || null);
            const badge =
              st === "out" ? "bg-red-100 text-red-700" : st === "low" ? "bg-amber-100 text-amber-700" : "bg-green-100 text-green-700";
            const dirty = isDirty(r);
            const variants = (r.product_id && variantsByProduct[r.product_id]) || [];
            const isExpanded = expanded.has(r.id) || variantMatch(r, q.trim().toLowerCase());
            const vThr = Number(curThreshold(r)) || 0;
            const vOut = variants.filter((v) => (v.stock_quantity ?? 0) <= 0).length;
            const vLow = variants.filter((v) => (v.stock_quantity ?? 0) > 0 && (v.stock_quantity ?? 0) <= vThr).length;
            return (
              <div key={r.id} className="card space-y-3 p-3">
                {/* Header: select + image + name + status */}
                <div className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    className="mt-1 flex-none"
                    checked={selected.has(r.id)}
                    onChange={() => toggleSelect(r.id)}
                    aria-label="Select row"
                  />
                  {r.image_url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={r.image_url} alt="" className="h-10 w-10 flex-none rounded object-cover" loading="lazy" />
                  ) : (
                    <div className="h-10 w-10 flex-none rounded bg-slate-100" />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="font-medium text-ink">{r.product_name ?? "—"}</div>
                    {r.product_name_ar ? <div className="truncate text-xs text-muted" dir="rtl">{r.product_name_ar}</div> : null}
                    <div className="mt-0.5 text-xs text-muted">{r.sku ?? "—"}</div>
                  </div>
                  <span className={`badge flex-none ${badge}`}>{st === "out" ? "Out" : st === "low" ? "Low" : "OK"}</span>
                </div>

                {/* Variant alerts */}
                {variants.length > 0 && (
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <span className="text-muted">{variants.length} options</span>
                    {vOut > 0 ? (
                      <span className="rounded bg-red-100 px-1.5 py-0.5 font-medium text-red-700">⚠ {vOut} out</span>
                    ) : vLow > 0 ? (
                      <span className="rounded bg-amber-100 px-1.5 py-0.5 font-medium text-amber-700">⚠ {vLow} low</span>
                    ) : null}
                  </div>
                )}

                {/* Stock + threshold */}
                <div className="flex items-end gap-3">
                  <label className="flex-1">
                    <span className="label">Stock</span>
                    <input className="input text-right" type="number" value={curStock(r)} onChange={(e) => setStock(r.id, e.target.value)} />
                  </label>
                  <label className="flex-1">
                    <span className="label">Alert at</span>
                    <input className="input text-right" type="number" value={curThreshold(r)} onChange={(e) => setThreshold(r.id, e.target.value)} />
                  </label>
                </div>

                {/* Shelves */}
                {hasLocation && (
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-medium text-muted">Shelves</span>
                    {hasShelfStock ? (
                      variants.length > 0 ? (
                        <button className="text-xs font-medium text-blue-600 hover:underline" onClick={() => toggleExpand(r.id)}>
                          {isExpanded ? "Hide options ▾" : "Per option ▸"}
                        </button>
                      ) : (
                        <ShelfStockCell
                          row={r}
                          placements={placements[r.id] ?? []}
                          save={(rs) => saveShelfStock(r.id, rs)}
                          onEdit={() =>
                            setEditTarget({
                              title: r.product_name ?? r.sku ?? "Product",
                              total: r.stock_quantity ?? 0,
                              placements: placements[r.id] ?? [],
                              save: (rs) => saveShelfStock(r.id, rs),
                            })
                          }
                        />
                      )
                    ) : (
                      <LocationCell id={r.id} value={r.location} />
                    )}
                  </div>
                )}

                {/* Variant sub-cards */}
                {isExpanded &&
                  variants.map((v) => {
                    const q = v.stock_quantity ?? 0;
                    const vname = v.variant_name ?? [v.color, v.size].filter(Boolean).join(" / ") ?? "Option";
                    return (
                      <div key={v.id} className="ml-1 flex items-center justify-between gap-2 border-l-2 border-slate-100 py-1 pl-3">
                        <input
                          type="checkbox"
                          className="flex-none"
                          checked={selectedVariants.has(v.id)}
                          onChange={() => toggleVariant(v.id)}
                          aria-label="Select option"
                        />
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm font-medium text-ink">{vname}</div>
                          <div className="text-xs text-muted">
                            Qty{" "}
                            <span className={q <= 0 ? "font-semibold text-red-700" : q <= vThr ? "font-semibold text-amber-700" : "text-slate-600"}>{q}</span>
                            {q <= 0 ? <span className="ml-1 text-red-700">· Out</span> : q <= vThr ? <span className="ml-1 text-amber-700">· Low</span> : null}
                          </div>
                        </div>
                        {hasLocation && hasVariantShelf && (
                          <ShelfStockCell
                            row={{ id: v.id, stock_quantity: v.stock_quantity } as InventoryRow}
                            placements={variantPlacements[v.id] ?? []}
                            save={(rs) => saveVariantShelfStock(v.id, rs)}
                            onEdit={() =>
                              setEditTarget({
                                title: `${r.product_name ?? ""} — ${vname}`,
                                total: v.stock_quantity ?? 0,
                                placements: variantPlacements[v.id] ?? [],
                                save: (rs) => saveVariantShelfStock(v.id, rs),
                              })
                            }
                          />
                        )}
                      </div>
                    );
                  })}

                {/* Footer */}
                <div className="flex items-center justify-between border-t border-slate-100 pt-2">
                  <span className="text-xs text-muted">{fmtDate(r.updated_at)} · sold {r.sold_quantity ?? 0}</span>
                  {rowErrors[r.id] ? (
                    <span className="text-xs text-red-600" title={rowErrors[r.id]}>Error</span>
                  ) : (
                    <button
                      className="btn-primary px-4 py-1.5 text-xs disabled:opacity-40"
                      disabled={!dirty || pending}
                      onClick={() => saveOne(r)}
                    >
                      Save
                    </button>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Table (desktop / tablet) */}
      <div className="card hidden overflow-x-auto p-0 md:block">
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
                const variants = (r.product_id && variantsByProduct[r.product_id]) || [];
                const isExpanded = expanded.has(r.id) || variantMatch(r, q.trim().toLowerCase());
                const colCount = hasLocation ? 10 : 9;
                // Variant-level low/out alerts (reuse the product's threshold per option).
                const vThr = Number(curThreshold(r)) || 0;
                const vOut = variants.filter((v) => (v.stock_quantity ?? 0) <= 0).length;
                const vLow = variants.filter((v) => (v.stock_quantity ?? 0) > 0 && (v.stock_quantity ?? 0) <= vThr).length;
                return (
                  <Fragment key={r.id}>
                  <tr className="border-b border-slate-100 hover:bg-slate-50">
                    <td className="px-3 py-3">
                      <input type="checkbox" checked={selected.has(r.id)} onChange={() => toggleSelect(r.id)} aria-label="Select row" />
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        {variants.length > 0 ? (
                          <button
                            className="flex-none text-slate-400 hover:text-ink"
                            onClick={() => toggleExpand(r.id)}
                            title={isExpanded ? "Hide options" : `Show ${variants.length} options`}
                          >
                            {isExpanded ? "▾" : "▸"}
                          </button>
                        ) : (
                          <span className="w-3 flex-none" />
                        )}
                        {r.image_url ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={r.image_url} alt="" className="h-8 w-8 flex-none rounded object-cover" loading="lazy" />
                        ) : (
                          <div className="h-8 w-8 flex-none rounded bg-slate-100" />
                        )}
                        <div className="min-w-0">
                          <div className="truncate font-medium text-ink">
                            {r.product_name ?? "—"}
                            {variants.length > 0 && (
                              <span className="ml-1 text-xs text-muted">· {variants.length} options</span>
                            )}
                            {vOut > 0 ? (
                              <span className="ml-1 rounded bg-red-100 px-1.5 py-0.5 text-[10px] font-medium text-red-700">
                                ⚠ {vOut} out
                              </span>
                            ) : vLow > 0 ? (
                              <span className="ml-1 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-700">
                                ⚠ {vLow} low
                              </span>
                            ) : null}
                          </div>
                          {r.product_name_ar ? <div className="truncate text-xs text-muted" dir="rtl">{r.product_name_ar}</div> : null}
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-slate-600">{r.sku ?? "—"}</td>
                    {hasLocation && (
                      <td className="px-4 py-3">
                        {hasShelfStock ? (
                          variants.length > 0 ? (
                            <button className="text-xs font-medium text-blue-600 hover:underline" onClick={() => toggleExpand(r.id)}>
                              {isExpanded ? "Hide options ▾" : "Per option ▸"}
                            </button>
                          ) : (
                            <ShelfStockCell
                              row={r}
                              placements={placements[r.id] ?? []}
                              save={(rs) => saveShelfStock(r.id, rs)}
                              onEdit={() =>
                                setEditTarget({
                                  title: r.product_name ?? r.sku ?? "Product",
                                  total: r.stock_quantity ?? 0,
                                  placements: placements[r.id] ?? [],
                                  save: (rs) => saveShelfStock(r.id, rs),
                                })
                              }
                            />
                          )
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
                  {isExpanded &&
                    variants.map((v) => (
                      <tr key={v.id} className="border-b border-slate-100 bg-slate-50/60 text-sm">
                        <td className="px-3 py-2 text-center">
                          <input
                            type="checkbox"
                            checked={selectedVariants.has(v.id)}
                            onChange={() => toggleVariant(v.id)}
                            aria-label="Select option"
                          />
                        </td>
                        <td className="px-4 py-2" colSpan={2}>
                          <div className="flex items-center gap-2 pl-8">
                            <span className="text-slate-400">└</span>
                            <span className="font-medium text-ink">
                              {v.variant_name ?? [v.color, v.size].filter(Boolean).join(" / ") ?? "Option"}
                            </span>
                            {v.sku && <span className="text-xs text-muted">{v.sku}</span>}
                          </div>
                        </td>
                        {hasLocation && (
                          <td className="px-4 py-2">
                            {hasVariantShelf ? (
                              <ShelfStockCell
                                row={{ id: v.id, stock_quantity: v.stock_quantity } as InventoryRow}
                                placements={variantPlacements[v.id] ?? []}
                                save={(rs) => saveVariantShelfStock(v.id, rs)}
                                onEdit={() =>
                                  setEditTarget({
                                    title: `${r.product_name ?? ""} — ${v.variant_name ?? [v.color, v.size].filter(Boolean).join(" / ")}`,
                                    total: v.stock_quantity ?? 0,
                                    placements: variantPlacements[v.id] ?? [],
                                    save: (rs) => saveVariantShelfStock(v.id, rs),
                                  })
                                }
                              />
                            ) : (
                              <span className="text-xs text-slate-400">run variant setup</span>
                            )}
                          </td>
                        )}
                        <td className="px-4 py-2 text-right">
                          {(() => {
                            const q = v.stock_quantity ?? 0;
                            const cls = q <= 0 ? "text-red-700 font-semibold" : q <= vThr ? "text-amber-700 font-semibold" : "text-slate-600";
                            return <span className={cls}>{q}</span>;
                          })()}
                        </td>
                        <td className="px-4 py-2" colSpan={5}>
                          {(() => {
                            const q = v.stock_quantity ?? 0;
                            if (q <= 0) return <span className="badge bg-red-100 text-red-700">Out</span>;
                            if (q <= vThr) return <span className="badge bg-amber-100 text-amber-700">Low</span>;
                            return null;
                          })()}
                        </td>
                      </tr>
                    ))}
                  </Fragment>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {editTarget && (
        <LocationsEditor
          target={editTarget}
          slots={slots}
          onClose={() => setEditTarget(null)}
        />
      )}
    </div>
  );
}

type SaveFn = (rows: { location: string; quantity: number }[]) => Promise<any>;
type EditTarget = {
  title: string;
  total: number;
  placements: { location: string; quantity: number }[];
  save: SaveFn;
};

/** Compact read-only summary of where a product's units sit, with an edit button. */
function ShelfStockCell({
  row,
  placements,
  save,
  onEdit,
}: {
  row: InventoryRow;
  placements: { location: string; quantity: number }[];
  save: SaveFn;
  onEdit: () => void;
}) {
  const router = useRouter();
  const [syncing, startSync] = useTransition();
  const placed = placements.reduce((s, p) => s + p.quantity, 0);
  const total = row.stock_quantity ?? 0;
  const sorted = placements.slice().sort((a, b) => compareSlot(a.location, b.location));

  const syncTotal = () =>
    startSync(async () => {
      await save(placements.map((p) => ({ location: p.location, quantity: p.quantity })));
      router.refresh();
    });
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
        <button
          className="flex-none rounded bg-amber-100 px-1.5 py-0.5 text-[10px] text-amber-700 hover:bg-amber-200 disabled:opacity-50"
          title="Tap to set total stock = placed units"
          onClick={syncTotal}
          disabled={syncing}
        >
          {syncing ? "…" : `set ${total}→${placed}`}
        </button>
      )}
    </div>
  );
}

/** Modal to edit a product's OR variant's per-shelf distribution. */
function LocationsEditor({
  target,
  slots,
  onClose,
}: {
  target: EditTarget;
  slots: string[];
  onClose: () => void;
}) {
  const router = useRouter();
  const [rowsState, setRowsState] = useState<{ location: string; quantity: string }[]>(
    target.placements.length
      ? target.placements.map((p) => ({ location: p.location, quantity: String(p.quantity) }))
      : [{ location: "", quantity: "" }]
  );
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);

  const total = target.total;
  const placed = rowsState.reduce((s, r) => s + (Math.max(0, Math.floor(Number(r.quantity) || 0))), 0);

  const set = (i: number, k: "location" | "quantity", v: string) =>
    setRowsState((rs) => rs.map((r, idx) => (idx === i ? { ...r, [k]: v } : r)));
  const add = () => setRowsState((rs) => [...rs, { location: "", quantity: "" }]);
  const remove = (i: number) => setRowsState((rs) => rs.filter((_, idx) => idx !== i));

  function save() {
    start(async () => {
      const res = await target.save(rowsState.map((r) => ({ location: r.location, quantity: Number(r.quantity) || 0 })));
      if (res && "error" in res && res.error) { setErr(res.error); return; }
      router.refresh();
      onClose();
    });
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="w-full max-w-md rounded-xl bg-white p-4 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-1 text-sm font-semibold text-ink">{target.title}</div>
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
