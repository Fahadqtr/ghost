"use client";

// UX.1A — sticky bulk selection toolbar.
//
// Stays pinned to the top of a table section while scrolling so the bulk controls
// and the selection counter are always visible. Offers the three select levels
// (current page / all filtered / clear) and an always-visible "Selected: X of Y"
// counter. The primary bulk action (e.g. "Apply Selected") is passed in as
// children so this toolbar never duplicates an existing action — it hosts it.

import { formatSelectionCount } from "@/lib/ui/selection";

export default function SelectionToolbar({
  selectedCount,
  total,
  pageCount,
  pageAllSelected,
  onSelectPage,
  onSelectAllFiltered,
  onClear,
  children,
}: {
  selectedCount: number;
  total: number;
  /** number of selectable keys on the current page (enables "select page"). */
  pageCount: number;
  /** whether every selectable key on the current page is already selected. */
  pageAllSelected: boolean;
  onSelectPage: () => void;
  onSelectAllFiltered: () => void;
  onClear: () => void;
  children?: React.ReactNode;
}) {
  const hasSelection = selectedCount > 0;
  return (
    <div
      className={`sticky top-0 z-20 flex flex-wrap items-center gap-2 rounded-xl border px-3 py-2 backdrop-blur ${
        hasSelection ? "border-blue-300 bg-blue-50/90" : "border-slate-200 bg-white/90"
      }`}
    >
      {/* Always-visible selection counter */}
      <div className="flex items-center gap-1.5 text-sm">
        <span className="font-medium text-slate-600">المحدد:</span>
        <span className={`font-bold tabular-nums ${hasSelection ? "text-blue-700" : "text-slate-500"}`}>
          {formatSelectionCount(selectedCount, total)}
        </span>
      </div>

      <span className="mx-1 hidden h-4 w-px bg-slate-200 sm:block" aria-hidden />

      {/* Three-level select controls */}
      <div className="flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          onClick={onSelectPage}
          disabled={pageCount === 0 || pageAllSelected}
          className="rounded-lg border border-slate-300 px-2.5 py-1 text-xs font-medium hover:bg-slate-50 disabled:opacity-40"
        >
          تحديد الصفحة
        </button>
        <button
          type="button"
          onClick={onSelectAllFiltered}
          disabled={total === 0 || selectedCount >= total}
          className="rounded-lg border border-slate-300 px-2.5 py-1 text-xs font-medium hover:bg-slate-50 disabled:opacity-40"
        >
          تحديد كل النتائج ({total})
        </button>
        <button
          type="button"
          onClick={onClear}
          disabled={!hasSelection}
          className="rounded-lg border border-slate-300 px-2.5 py-1 text-xs font-medium hover:bg-slate-50 disabled:opacity-40"
        >
          مسح التحديد
        </button>
      </div>

      {/* Primary bulk action (hosted, never duplicated) */}
      {children ? <div className="ms-auto flex flex-wrap items-center gap-2">{children}</div> : null}
    </div>
  );
}
