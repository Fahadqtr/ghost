"use client";

import { Fragment, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import BarcodeScanner from "@/components/BarcodeScanner";
import { shelfOf } from "@/lib/shelf";
import type { Locale } from "@/lib/i18n";
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
  locale = "ar",
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
  locale?: Locale;
}) {
  const en = locale === "en";
  const L = (ar: string, e: string) => (en ? e : ar);
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
  // Quick-select: toggle ALL of a product's options at once.
  const productVariantIds = (r: InventoryRow) =>
    ((r.product_id && variantsByProduct[r.product_id]) || []).map((v) => v.id);
  const allVariantsSelected = (r: InventoryRow) => {
    const ids = productVariantIds(r);
    return ids.length > 0 && ids.every((id) => selectedVariants.has(id));
  };
  const toggleAllVariants = (r: InventoryRow) => {
    const ids = productVariantIds(r);
    setSelectedVariants((s) => {
      const n = new Set(s);
      const all = ids.length > 0 && ids.every((id) => n.has(id));
      ids.forEach((id) => (all ? n.delete(id) : n.add(id)));
      return n;
    });
  };
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
        text: res.failed
          ? L(`حُفظ ${res.ok}، وفشل ${res.failed}: ${res.errors.join("; ")}`, `Saved ${res.ok}, ${res.failed} failed: ${res.errors.join("; ")}`)
          : L(`حُفظ ${res.ok} ${res.ok === 1 ? "تغيير" : "تغييرًا"}.`, `Saved ${res.ok} change${res.ok === 1 ? "" : "s"}.`),
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
        setMsg({ kind: "err", text: L("لم يُعثر على صفوف تحتوي عمود 'sku' في ملف CSV.", "No rows with a 'sku' column found in the CSV.") });
        return;
      }
      startTransition(async () => {
        const res = await importInventoryBySku(items);
        setMsg({
          kind: res.notFound || res.failed ? "err" : "ok",
          text: L(
            `استُورد ${res.updated} · غير موجود ${res.notFound} · فشل ${res.failed}${res.missing.length ? ` (مفقود: ${res.missing.slice(0, 8).join(", ")}${res.missing.length > 8 ? "…" : ""})` : ""}`,
            `Imported ${res.updated} · not-found ${res.notFound} · failed ${res.failed}${res.missing.length ? ` (missing: ${res.missing.slice(0, 8).join(", ")}${res.missing.length > 8 ? "…" : ""})` : ""}`
          ),
        });
        router.refresh();
      });
    };
    reader.readAsText(file);
    e.target.value = "";
  }

  function assignSelectedToShelf() {
    const slot = bulkSlot.trim().toUpperCase();
    // A product that has options stores its shelf stock on the OPTIONS, not on
    // the product row — so a selected variant-product is expanded into its
    // options here. Only optionless products go through the product path.
    const pids: string[] = [];
    const variantIds = new Set(selectedVariants);
    for (const rowId of selected) {
      const r = rows.find((x) => x.id === rowId);
      const vs = (r?.product_id && variantsByProduct[r.product_id]) || [];
      if (vs.length > 0) vs.forEach((v) => variantIds.add(v.id));
      else pids.push(rowId);
    }
    const vids = [...variantIds];
    if (!slot || (pids.length === 0 && vids.length === 0)) return;
    // If the "Set stock to" field is filled, place that quantity (and set each
    // item's stock to it) — so 0-stock options also land on the shelf.
    const raw = bulkValue.trim();
    const setQty = raw === "" ? undefined : Math.max(0, Math.floor(Number(raw) || 0));
    startTransition(async () => {
      let errText = "";
      let total = 0;
      // Both actions may return a partial result ({ done, error }): count what
      // succeeded AND surface the error, then still refresh so the UI reflects
      // the rows that did move.
      if (pids.length) {
        const r = (await bulkAssignShelf(pids, slot, setQty)) as any;
        if (r?.error) errText = r.error;
        total += r?.done ?? (r?.error ? 0 : pids.length);
      }
      if (vids.length) {
        const r = (await bulkAssignVariantShelf(vids, slot, setQty)) as any;
        if (r?.error) errText = errText ? `${errText} | ${r.error}` : r.error;
        total += r?.done ?? (r?.error ? 0 : vids.length);
      }
      const qtyNote = setQty != null ? L(` (كمية ${setQty})`, ` (qty ${setQty})`) : "";
      if (errText) {
        setMsg({ kind: "err", text: total > 0 ? L(`أُضيف ${total}، لكن: ${errText}`, `Added ${total}, but: ${errText}`) : errText });
      } else {
        setMsg({ kind: "ok", text: L(`أُضيف ${total} عنصر للرفّ ${slot}${qtyNote}`, `Added ${total} item${total === 1 ? "" : "s"} to shelf ${slot}${qtyNote}`) });
      }
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
      if (!res.configured) {
        setMsg({ kind: "err", text: res.message ?? L("Shopify غير مربوط بعد.", "Shopify isn't connected yet.") });
      } else if (res.reason === "missing_location") {
        setMsg({ kind: "err", text: L("تعذّرت مزامنة Shopify: لا يوجد موقع مخزون.", "Shopify sync failed: no inventory location.") });
      } else {
        const problems = res.failed + res.missing;
        setMsg({
          kind: problems ? "err" : "ok",
          text: L(
            `أُرسل ${res.pushed} إلى Shopify${res.failed ? ` · ${res.failed} فشل` : ""}${res.missing ? ` · ${res.missing} غير موجود` : ""}`,
            `Pushed ${res.pushed} to Shopify${res.failed ? ` · ${res.failed} failed` : ""}${res.missing ? ` · ${res.missing} not found` : ""}`
          ),
        });
      }
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
            placeholder={L("ابحث بالاسم / SKU / الباركود…", "Search name / SKU / barcode…")}
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <button
            type="button"
            className="absolute right-1 top-1/2 -translate-y-1/2 rounded-sm p-1 text-base leading-none hover:bg-slate-100"
            title={L("امسح الباركود بالكاميرا", "Scan barcode with camera")}
            aria-label={L("مسح الباركود", "Scan barcode")}
            onClick={() => setScanning(true)}
          >
            📷
          </button>
        </div>
        <select className="input w-auto" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as any)}>
          <option value="all">{L("كل الحالات", "All statuses")}</option>
          <option value="out">{L("نافد", "Out of stock")}</option>
          <option value="low">{L("مخزون منخفض", "Low stock")}</option>
          <option value="ok">{L("متوفّر", "OK")}</option>
        </select>
        {categories.length > 0 && (
          <select className="input w-auto" value={catFilter} onChange={(e) => setCatFilter(e.target.value)}>
            <option value="">{L("كل الفئات", "All categories")}</option>
            {categories.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        )}
        {hasLocation && shelves.length > 0 && (
          <select className="input w-auto" value={shelfFilter} onChange={(e) => setShelfFilter(e.target.value)}>
            <option value="">{L("كل الأرفف", "All shelves")}</option>
            {shelves.map((s) => (
              <option key={s} value={s}>{L(`رف ${s}`, `Shelf ${s}`)}</option>
            ))}
          </select>
        )}
        <span className="text-sm text-muted">{L(`${sorted.length} من ${rows.length}`, `${sorted.length} of ${rows.length}`)}</span>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <button className="btn-ghost px-3 py-1 text-xs" onClick={exportCsv}>{L("تصدير CSV", "Export CSV")}</button>
          <button className="btn-ghost px-3 py-1 text-xs" onClick={() => fileRef.current?.click()}>{L("استيراد CSV", "Import CSV")}</button>
          <input ref={fileRef} type="file" accept=".csv,text/csv" className="hidden" onChange={onImportFile} />
          <button
            className="btn-primary px-3 py-1 text-xs disabled:opacity-50"
            disabled={dirtyRows.length === 0 || pending}
            onClick={saveAll}
          >
            {pending ? L("جارٍ الحفظ…", "Saving…") : L(`حفظ الكل (${dirtyRows.length})`, `Save all (${dirtyRows.length})`)}
          </button>
        </div>
      </div>

      {/* Bulk bar */}
      {(selected.size > 0 || selectedVariants.size > 0) && (
        <div className="card flex flex-wrap items-center gap-3 border-blue-200 bg-blue-50 py-3 text-sm">
          <span className="font-medium text-blue-900">
            {selected.size > 0 ? L(`${selected.size} منتج`, `${selected.size} product${selected.size === 1 ? "" : "s"}`) : ""}
            {selected.size > 0 && selectedVariants.size > 0 ? " + " : ""}
            {selectedVariants.size > 0 ? L(`${selectedVariants.size} خيار`, `${selectedVariants.size} option${selectedVariants.size === 1 ? "" : "s"}`) : ""}
            {" "}{L("محدّد", "selected")}
          </span>
          <div className="flex items-center gap-2">
            <span className="text-slate-600">{L("اضبط المخزون على", "Set stock to")}</span>
            <input className="input w-24" type="number" value={bulkValue} onChange={(e) => setBulkValue(e.target.value)} placeholder="50" />
            <button className="btn-ghost px-3 py-1 text-xs disabled:opacity-50" disabled={bulkValue.trim() === ""} onClick={applyBulkValue}>
              {L("تطبيق", "Apply")}
            </button>
          </div>
          {hasLocation && (
            <div className="flex items-center gap-2">
              <span className="text-slate-600">{L("أضف للرفّ", "Add to shelf")}</span>
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
                title={bulkValue.trim() !== "" ? L(`يضع كمية ${bulkValue.trim()} لكل عنصر`, `Places qty ${bulkValue.trim()} for each item`) : L("يضع المخزون الحالي لكل عنصر", "Places current stock for each item")}
              >
                {L("إضافة", "Add")}
              </button>
              {bulkValue.trim() !== "" && (
                <span className="text-xs text-blue-700">{L(`كمية ${bulkValue.trim()} لكل عنصر`, `Qty ${bulkValue.trim()} per item`)}</span>
              )}
            </div>
          )}
          <button className="btn-ghost px-3 py-1 text-xs" onClick={pushSelected} disabled={pending}>
            {L("إرسال إلى Shopify", "Push to Shopify")}
          </button>
          <button className="btn-ghost px-3 py-1 text-xs" onClick={() => { setSelected(new Set()); setSelectedVariants(new Set()); }}>{L("مسح التحديد", "Clear selection")}</button>
        </div>
      )}

      {/* Message */}
      {msg && (
        <div className={`card py-2 text-sm ${msg.kind === "ok" ? "border-green-200 bg-green-50 text-green-800" : "border-amber-200 bg-amber-50 text-amber-800"}`}>
          {msg.text}
          <button className="ml-3 text-xs underline" onClick={() => setMsg(null)}>{L("إغلاق", "dismiss")}</button>
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
          <div className="card text-center text-sm text-slate-400">{L("لا توجد عناصر مخزون.", "No inventory rows.")}</div>
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
                    aria-label={L("تحديد الصف", "Select row")}
                  />
                  {r.image_url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={r.image_url} alt="" className="h-10 w-10 flex-none rounded-sm object-cover" loading="lazy" />
                  ) : (
                    <div className="h-10 w-10 flex-none rounded-sm bg-slate-100" />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="font-medium text-ink">{r.product_name ?? "—"}</div>
                    {r.product_name_ar ? <div className="truncate text-xs text-muted" dir="rtl">{r.product_name_ar}</div> : null}
                    <div className="mt-0.5 text-xs text-muted">{r.sku ?? "—"}</div>
                  </div>
                  <span className={`badge flex-none ${badge}`}>{st === "out" ? L("نافد", "Out") : st === "low" ? L("منخفض", "Low") : L("متوفّر", "OK")}</span>
                </div>

                {/* Variant alerts */}
                {variants.length > 0 && (
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <span className="text-muted">{L(`${variants.length} خيار`, `${variants.length} options`)}</span>
                    {vOut > 0 ? (
                      <span className="rounded-sm bg-red-100 px-1.5 py-0.5 font-medium text-red-700">⚠ {L(`${vOut} نافد`, `${vOut} out`)}</span>
                    ) : vLow > 0 ? (
                      <span className="rounded-sm bg-amber-100 px-1.5 py-0.5 font-medium text-amber-700">⚠ {L(`${vLow} منخفض`, `${vLow} low`)}</span>
                    ) : null}
                  </div>
                )}

                {/* Stock + threshold */}
                <div className="flex items-end gap-3">
                  <label className="flex-1">
                    <span className="label">{L("المخزون", "Stock")}</span>
                    <input className="input text-right" type="number" value={curStock(r)} onChange={(e) => setStock(r.id, e.target.value)} />
                  </label>
                  <label className="flex-1">
                    <span className="label">{L("تنبيه عند", "Alert at")}</span>
                    <input className="input text-right" type="number" value={curThreshold(r)} onChange={(e) => setThreshold(r.id, e.target.value)} />
                  </label>
                </div>

                {/* Shelves */}
                {hasLocation && (
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-medium text-muted">{L("الأرفف", "Shelves")}</span>
                    {hasShelfStock ? (
                      variants.length > 0 ? (
                        <button className="text-xs font-medium text-blue-600 hover:underline" onClick={() => toggleExpand(r.id)}>
                          {isExpanded ? L("إخفاء الخيارات ▾", "Hide options ▾") : L("لكل خيار ▸", "Per option ▸")}
                        </button>
                      ) : (
                        <ShelfStockCell
                          en={en}
                          row={r}
                          placements={placements[r.id] ?? []}
                          save={(rs) => saveShelfStock(r.id, rs)}
                          onEdit={() =>
                            setEditTarget({
                              title: r.product_name ?? r.sku ?? L("منتج", "Product"),
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
                {isExpanded && variants.length > 0 && (
                  <label className="ml-1 flex items-center gap-2 border-l-2 border-slate-100 py-1 pl-3 text-xs font-medium text-blue-700">
                    <input
                      type="checkbox"
                      checked={allVariantsSelected(r)}
                      onChange={() => toggleAllVariants(r)}
                      aria-label={L("تحديد كل الخيارات", "Select all options")}
                    />
                    {allVariantsSelected(r) ? L("مسح تحديد الخيارات", "Clear option selection") : L(`تحديد كل الخيارات (${variants.length})`, `Select all options (${variants.length})`)}
                  </label>
                )}
                {isExpanded &&
                  variants.map((v) => {
                    const q = v.stock_quantity ?? 0;
                    const vname = v.variant_name ?? [v.color, v.size].filter(Boolean).join(" / ") ?? L("خيار", "Option");
                    return (
                      <div key={v.id} className="ml-1 flex items-center justify-between gap-2 border-l-2 border-slate-100 py-1 pl-3">
                        <input
                          type="checkbox"
                          className="flex-none"
                          checked={selectedVariants.has(v.id)}
                          onChange={() => toggleVariant(v.id)}
                          aria-label={L("تحديد الخيار", "Select option")}
                        />
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm font-medium text-ink">{vname}</div>
                          <div className="text-xs text-muted">
                            {L("الكمية", "Qty")}{" "}
                            <span className={q <= 0 ? "font-semibold text-red-700" : q <= vThr ? "font-semibold text-amber-700" : "text-slate-600"}>{q}</span>
                            {q <= 0 ? <span className="ml-1 text-red-700">· {L("نافد", "Out")}</span> : q <= vThr ? <span className="ml-1 text-amber-700">· {L("منخفض", "Low")}</span> : null}
                          </div>
                        </div>
                        {hasLocation && hasVariantShelf && (
                          <ShelfStockCell
                            en={en}
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
                  <span className="text-xs text-muted">{fmtDate(r.updated_at)} · {L("مُباع", "sold")} {r.sold_quantity ?? 0}</span>
                  {rowErrors[r.id] ? (
                    <span className="text-xs text-red-600" title={rowErrors[r.id]}>{L("خطأ", "Error")}</span>
                  ) : (
                    <button
                      className="btn-primary px-4 py-1.5 text-xs disabled:opacity-40"
                      disabled={!dirty || pending}
                      onClick={() => saveOne(r)}
                    >
                      {L("حفظ", "Save")}
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
                <input type="checkbox" checked={allVisibleSelected} onChange={toggleSelectAll} aria-label={L("تحديد الكل", "Select all")} />
              </th>
              <Th k="product" label={L("المنتج", "Product")} />
              <Th k="sku" label={L("SKU", "SKU")} />
              {hasLocation && <th className="px-4 py-3 font-medium text-left">{L("الموقع", "Location")}</th>}
              <Th k="stock" label={L("المخزون", "Stock")} num />
              <Th k="threshold" label={L("حد التنبيه", "Low threshold")} num />
              <Th k="sold" label={L("المباع", "Sold")} num />
              <Th k="status" label={L("الحالة", "Status")} />
              <Th k="updated" label={L("آخر تحديث", "Updated")} />
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody>
            {sorted.length === 0 ? (
              <tr><td colSpan={hasLocation ? 10 : 9} className="px-4 py-8 text-center text-slate-400">{L("لا توجد عناصر مخزون.", "No inventory rows.")}</td></tr>
            ) : (
              sorted.map((r) => {
                const st = statusOf(Number(curStock(r)) || 0, Number(curThreshold(r)) || null);
                const badge =
                  st === "out" ? "bg-red-100 text-red-700" : st === "low" ? "bg-amber-100 text-amber-700" : "bg-green-100 text-green-700";
                const dirty = isDirty(r);
                const variants = (r.product_id && variantsByProduct[r.product_id]) || [];
                const isExpanded = expanded.has(r.id) || variantMatch(r, q.trim().toLowerCase());
                // Variant-level low/out alerts (reuse the product's threshold per option).
                const vThr = Number(curThreshold(r)) || 0;
                const vOut = variants.filter((v) => (v.stock_quantity ?? 0) <= 0).length;
                const vLow = variants.filter((v) => (v.stock_quantity ?? 0) > 0 && (v.stock_quantity ?? 0) <= vThr).length;
                return (
                  <Fragment key={r.id}>
                  <tr className="border-b border-slate-100 hover:bg-slate-50">
                    <td className="px-3 py-3">
                      <input type="checkbox" checked={selected.has(r.id)} onChange={() => toggleSelect(r.id)} aria-label={L("تحديد الصف", "Select row")} />
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        {variants.length > 0 ? (
                          <button
                            className="flex-none text-slate-400 hover:text-ink"
                            onClick={() => toggleExpand(r.id)}
                            title={isExpanded ? L("إخفاء الخيارات", "Hide options") : L(`عرض ${variants.length} خيار`, `Show ${variants.length} options`)}
                          >
                            {isExpanded ? "▾" : "▸"}
                          </button>
                        ) : (
                          <span className="w-3 flex-none" />
                        )}
                        {r.image_url ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={r.image_url} alt="" className="h-8 w-8 flex-none rounded-sm object-cover" loading="lazy" />
                        ) : (
                          <div className="h-8 w-8 flex-none rounded-sm bg-slate-100" />
                        )}
                        <div className="min-w-0">
                          <div className="truncate font-medium text-ink">
                            {r.product_name ?? "—"}
                            {variants.length > 0 && (
                              <span className="ml-1 text-xs text-muted">· {L(`${variants.length} خيار`, `${variants.length} options`)}</span>
                            )}
                            {vOut > 0 ? (
                              <span className="ml-1 rounded-sm bg-red-100 px-1.5 py-0.5 text-[10px] font-medium text-red-700">
                                ⚠ {L(`${vOut} نافد`, `${vOut} out`)}
                              </span>
                            ) : vLow > 0 ? (
                              <span className="ml-1 rounded-sm bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-700">
                                ⚠ {L(`${vLow} منخفض`, `${vLow} low`)}
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
                              {isExpanded ? L("إخفاء الخيارات ▾", "Hide options ▾") : L("لكل خيار ▸", "Per option ▸")}
                            </button>
                          ) : (
                            <ShelfStockCell
                              en={en}
                              row={r}
                              placements={placements[r.id] ?? []}
                              save={(rs) => saveShelfStock(r.id, rs)}
                              onEdit={() =>
                                setEditTarget({
                                  title: r.product_name ?? r.sku ?? L("منتج", "Product"),
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
                      <span className={`badge ${badge}`}>{st === "out" ? L("نافد", "Out") : st === "low" ? L("منخفض", "Low") : L("متوفّر", "OK")}</span>
                    </td>
                    <td className="px-4 py-3 text-xs text-muted">{fmtDate(r.updated_at)}</td>
                    <td className="px-4 py-3 text-right">
                      {rowErrors[r.id] ? (
                        <span className="text-xs text-red-600" title={rowErrors[r.id]}>{L("خطأ", "Error")}</span>
                      ) : (
                        <button
                          className="btn-ghost px-3 py-1 text-xs disabled:opacity-40"
                          disabled={!dirty || pending}
                          onClick={() => saveOne(r)}
                        >
                          {L("حفظ", "Save")}
                        </button>
                      )}
                    </td>
                  </tr>
                  {isExpanded && variants.length > 0 && (
                    <tr className="border-b border-slate-100 bg-slate-50/60 text-xs">
                      <td className="px-3 py-1.5 text-center">
                        <input
                          type="checkbox"
                          checked={allVariantsSelected(r)}
                          onChange={() => toggleAllVariants(r)}
                          aria-label={L("تحديد كل الخيارات", "Select all options")}
                        />
                      </td>
                      <td className="px-4 py-1.5 font-medium text-blue-700" colSpan={12}>
                        <button type="button" className="hover:underline" onClick={() => toggleAllVariants(r)}>
                          {allVariantsSelected(r) ? L("مسح تحديد الخيارات", "Clear option selection") : L(`تحديد كل الخيارات (${variants.length})`, `Select all options (${variants.length})`)}
                        </button>
                      </td>
                    </tr>
                  )}
                  {isExpanded &&
                    variants.map((v) => (
                      <tr key={v.id} className="border-b border-slate-100 bg-slate-50/60 text-sm">
                        <td className="px-3 py-2 text-center">
                          <input
                            type="checkbox"
                            checked={selectedVariants.has(v.id)}
                            onChange={() => toggleVariant(v.id)}
                            aria-label={L("تحديد الخيار", "Select option")}
                          />
                        </td>
                        <td className="px-4 py-2" colSpan={2}>
                          <div className="flex items-center gap-2 pl-8">
                            <span className="text-slate-400">└</span>
                            <span className="font-medium text-ink">
                              {v.variant_name ?? [v.color, v.size].filter(Boolean).join(" / ") ?? L("خيار", "Option")}
                            </span>
                            {v.sku && <span className="text-xs text-muted">{v.sku}</span>}
                          </div>
                        </td>
                        {hasLocation && (
                          <td className="px-4 py-2">
                            {hasVariantShelf ? (
                              <ShelfStockCell
                                en={en}
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
                              <span className="text-xs text-slate-400">{L("شغّل إعداد الخيارات", "run variant setup")}</span>
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
                            if (q <= 0) return <span className="badge bg-red-100 text-red-700">{L("نافد", "Out")}</span>;
                            if (q <= vThr) return <span className="badge bg-amber-100 text-amber-700">{L("منخفض", "Low")}</span>;
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
          en={en}
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
  en,
  row,
  placements,
  save,
  onEdit,
}: {
  en: boolean;
  row: InventoryRow;
  placements: { location: string; quantity: number }[];
  save: SaveFn;
  onEdit: () => void;
}) {
  const L = (ar: string, e: string) => (en ? e : ar);
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
      <button className="flex flex-wrap gap-1 text-left" onClick={onEdit} title={L("تعديل مواقع الأرفف", "Edit shelf locations")}>
        {sorted.length === 0 ? (
          <span className="text-slate-400">{L("— حدّد —", "— set —")}</span>
        ) : (
          sorted.map((p) => (
            <span key={p.location} className="rounded-sm bg-slate-100 px-1.5 py-0.5 text-xs">
              <span className="font-mono font-medium">{p.location}</span>
              <span className="text-slate-500">·{p.quantity}</span>
            </span>
          ))
        )}
      </button>
      <button className="flex-none text-slate-400 hover:text-ink" onClick={onEdit} title={L("تعديل", "Edit")}>✎</button>
      {placed !== total && (
        <button
          className="flex-none rounded-sm bg-amber-100 px-1.5 py-0.5 text-[10px] text-amber-700 hover:bg-amber-200 disabled:opacity-50"
          title={L("اضغط لجعل إجمالي المخزون = القطع الموزّعة", "Tap to set total stock = placed units")}
          onClick={syncTotal}
          disabled={syncing}
        >
          {syncing ? "…" : L(`اضبط ${total}→${placed}`, `set ${total}→${placed}`)}
        </button>
      )}
    </div>
  );
}

/** Modal to edit a product's OR variant's per-shelf distribution. */
function LocationsEditor({
  en,
  target,
  slots,
  onClose,
}: {
  en: boolean;
  target: EditTarget;
  slots: string[];
  onClose: () => void;
}) {
  const L = (ar: string, e: string) => (en ? e : ar);
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
          {L("حدّد عدد القطع في كل رف. يصبح إجمالي المخزون مجموعها =", "Set how many units sit in each shelf. Total stock becomes the sum =")}{" "}
          <span className="font-semibold text-ink">{placed}</span>
          {total !== placed && <span className="text-amber-700"> {L(`(كان ${total})`, `(was ${total})`)}</span>}.
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
                placeholder={L("الكمية", "qty")}
                value={r.quantity}
                onChange={(e) => set(i, "quantity", e.target.value)}
              />
              <button className="flex-none text-slate-400 hover:text-red-600" onClick={() => remove(i)} title={L("إزالة", "Remove")}>✕</button>
            </div>
          ))}
        </div>

        <button className="btn-ghost mt-2 px-3 py-1 text-xs" onClick={add}>{L("+ أضف رفًّا", "+ Add shelf")}</button>

        {err && <div className="mt-2 text-xs text-red-600">{err}</div>}

        <div className="mt-4 flex justify-end gap-2">
          <button className="btn-ghost px-3 py-1.5 text-sm" onClick={onClose} disabled={pending}>{L("إلغاء", "Cancel")}</button>
          <button className="btn-primary px-4 py-1.5 text-sm disabled:opacity-50" onClick={save} disabled={pending}>
            {pending ? L("جارٍ الحفظ…", "Saving…") : L("حفظ", "Save")}
          </button>
        </div>
      </div>
    </div>
  );
}
