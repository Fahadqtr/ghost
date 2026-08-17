// UX.1A — pure pagination helper (framework-free).
//
// Slices a filtered result set into a single rendered page so a table never
// paints thousands of rows/checkboxes at once. The selection model (lib/ui/
// selection.ts) still holds keys for the WHOLE filtered set, so "select all
// filtered" works without rendering every row. node:test loads this directly.

export const DEFAULT_PAGE_SIZE = 25;

export interface Page<T> {
  /** the clamped 1-based page number actually shown. */
  page: number;
  /** total number of pages (>= 1). */
  pageCount: number;
  /** the items on this page. */
  pageItems: T[];
  /** total items across all pages. */
  total: number;
  /** 1-based index of the first item shown (0 when empty). */
  from: number;
  /** 1-based index of the last item shown (0 when empty). */
  to: number;
  pageSize: number;
}

/**
 * Return the requested page of `items`. `page` is 1-based and clamped into
 * [1, pageCount]; `pageSize` is coerced to a positive integer. Pure + total —
 * an empty input yields page 1 of 1 with no items.
 */
export function paginate<T>(items: readonly T[], page: number, pageSize: number = DEFAULT_PAGE_SIZE): Page<T> {
  const list = Array.isArray(items) ? items : [];
  const size = Number.isFinite(pageSize) && pageSize > 0 ? Math.floor(pageSize) : DEFAULT_PAGE_SIZE;
  const total = list.length;
  const pageCount = Math.max(1, Math.ceil(total / size));
  const clamped = Number.isFinite(page) ? Math.min(Math.max(1, Math.floor(page)), pageCount) : 1;
  const start = (clamped - 1) * size;
  const pageItems = list.slice(start, start + size);
  return {
    page: clamped,
    pageCount,
    pageItems,
    total,
    from: total === 0 ? 0 : start + 1,
    to: total === 0 ? 0 : start + pageItems.length,
    pageSize: size,
  };
}
