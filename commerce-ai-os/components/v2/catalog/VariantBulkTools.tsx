"use client";

// Malikas V2 — Variant bulk tools (UX.4E-5). Presentational ONLY: a compact,
// mobile-first RTL panel of bulk actions shown above the variant list in both
// the Create wizard and the Edit form. It holds only its own small input state
// (how many rows to add, the stock value to set); every ACTION is a callback the
// parent form provides, which applies the shared PURE transforms in
// lib/products/variant-bulk to its own row state and then re-runs the shared
// validation. No data access, no business rules, no SKU/barcode/validation
// logic here. The add-count is guarded by the shared withinAddBatchLimit
// predicate so an oversized batch is blocked (never partially added).

import { useState } from "react";
import { withinAddBatchLimit, MAX_BULK_ADD_BATCH } from "@/lib/products/variant-bulk";

const BATCH_LIMIT_MSG = `لا يمكن إضافة أكثر من ${MAX_BULK_ADD_BATCH} صفوف دفعة واحدة.`;

export default function VariantBulkTools({
  selectedCount,
  canRestore = false,
  onAddRows,
  onFillMissingPrice,
  onSetSelectedStock,
  onGenerateMissingSku,
  onGenerateMissingBarcode,
  onGenerateMissingIdentity,
  onDeleteSelected,
  onRestoreSelected,
  onRemoveEmptyRows,
  disabled = false,
  busy = false,
}: {
  selectedCount: number;
  canRestore?: boolean;
  onAddRows: (count: number) => void;
  onFillMissingPrice: () => void;
  onSetSelectedStock: (quantity: string) => void;
  onGenerateMissingSku: () => void;
  onGenerateMissingBarcode: () => void;
  onGenerateMissingIdentity: () => void;
  onDeleteSelected: () => void;
  onRestoreSelected: () => void;
  onRemoveEmptyRows: () => void;
  disabled?: boolean;
  busy?: boolean;
}) {
  const [addCount, setAddCount] = useState("1");
  const [stockValue, setStockValue] = useState("");
  const [msg, setMsg] = useState<string | null>(null);

  const off = disabled || busy;
  const noSelection = selectedCount === 0;
  const btn = "btn-ghost px-2 py-1 text-xs disabled:opacity-50";
  const field = "w-16 rounded-lg border border-[#e8cdb5] px-2 py-1 text-xs";

  function add() {
    const n = Number(addCount);
    if (!withinAddBatchLimit(n)) {
      setMsg(BATCH_LIMIT_MSG);
      return;
    }
    setMsg(null);
    onAddRows(n);
  }

  return (
    <div dir="rtl" className="flex flex-col gap-2 rounded-xl border border-[#efe3d6] bg-[#fdf8f2] p-2">
      <div className="flex flex-wrap items-center gap-2">
        {/* add multiple */}
        <div className="flex items-center gap-1">
          <input
            type="number"
            min={1}
            max={MAX_BULK_ADD_BATCH}
            inputMode="numeric"
            aria-label="عدد الصفوف"
            className={field}
            value={addCount}
            onChange={(e) => setAddCount(e.target.value)}
            disabled={off}
          />
          <button type="button" className={btn} disabled={off} onClick={add}>
            إضافة صفوف
          </button>
        </div>

        <span className="mx-1 h-4 w-px bg-[#e8cdb5]" aria-hidden />

        {/* fill / generate the missing (blanks only) */}
        <button type="button" className={btn} disabled={off} onClick={onFillMissingPrice}>
          تعبئة السعر الناقص
        </button>
        <button type="button" className={btn} disabled={off} onClick={onGenerateMissingSku}>
          توليد SKU الناقص
        </button>
        <button type="button" className={btn} disabled={off} onClick={onGenerateMissingBarcode}>
          توليد باركود ناقص
        </button>
        <button type="button" className={btn} disabled={off} onClick={onGenerateMissingIdentity}>
          {busy ? "جارٍ…" : "توليد الهوية الناقصة"}
        </button>

        <span className="mx-1 h-4 w-px bg-[#e8cdb5]" aria-hidden />

        {/* cleanup */}
        <button type="button" className={btn} disabled={off} onClick={onRemoveEmptyRows}>
          حذف الصفوف الفارغة
        </button>
      </div>

      {/* selection-scoped actions */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[11px] text-[#8a7968]">المحدد: {selectedCount}</span>
        <div className="flex items-center gap-1">
          <input
            type="number"
            min={0}
            inputMode="numeric"
            aria-label="الكمية للمحدد"
            className={field}
            value={stockValue}
            onChange={(e) => setStockValue(e.target.value)}
            disabled={off || noSelection}
          />
          <button
            type="button"
            className={btn}
            disabled={off || noSelection}
            onClick={() => onSetSelectedStock(stockValue)}
          >
            تعيين الكمية للمحدد
          </button>
        </div>
        <button type="button" className={`${btn} text-rose-600`} disabled={off || noSelection} onClick={onDeleteSelected}>
          حذف المحدد
        </button>
        {canRestore ? (
          <button type="button" className={btn} disabled={off || noSelection} onClick={onRestoreSelected}>
            استرجاع المحدد
          </button>
        ) : null}
      </div>

      {msg ? <p className="text-[11px] text-rose-600">{msg}</p> : null}
    </div>
  );
}
