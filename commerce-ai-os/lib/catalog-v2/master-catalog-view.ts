// Pure view layer for the Malikas V2 Master Catalog (Phase UI.1).
//
// DB-free, network-free, framework-free: no "server-only", no Supabase/Next
// imports, no fetch, no Date.now(), no `any`. It projects already-read product /
// variant rows into a PII-safe, catalog-only shape, filters/searches them in
// memory, summarizes them, and maps completeness states to fixed Arabic labels.
// It never exposes inventory, channel, platform, or order fields.

// ── Domain shape (catalog-only; NO inventory/channel/platform/order fields) ───

export interface MasterCatalogProduct {
  id: string;
  sku: string | null;
  barcode: string | null;
  nameAr: string | null;
  nameEn: string | null;
  price: number | null;
  discountPrice: number | null;
  imageUrl: string | null;
  approval: string | null;
  variantCount: number;
}

/** A catalog-safe variant row (NO stock/inventory/platform/order/PII fields). */
export interface CatalogVariant {
  id: string | null;
  variantName: string | null; // variant_name
  variantNameEn: string | null; // variant_name_en
  sku: string | null;
  barcode: string | null;
  price: number | null;
}

export type CatalogFilter =
  | "all"
  | "has_variants"
  | "no_variants"
  | "missing_sku"
  | "missing_barcode"
  | "missing_image"
  | "complete"
  | "missing_multiple"
  | "approved"
  | "not_approved"
  | "has_discount"
  | "missing_price";

export type CatalogSort =
  | "readiness"
  | "name_ar"
  | "name_en"
  | "sku"
  | "price_asc"
  | "price_desc"
  | "variants_desc";

export interface CatalogFilters {
  query: string;
  filter: CatalogFilter;
}

/** Full validated URL state for the control center. */
export interface CatalogControls {
  query: string;
  filter: CatalogFilter;
  sort: CatalogSort;
  page: number; // requested page (>= 1); clamped to a real page by paginate()
}

export type CatalogSearchParams = Record<string, string | string[] | undefined> | null | undefined;

export interface CatalogSummary {
  totalProducts: number;
  withVariants: number;
  missingSku: number;
  missingBarcode: number;
  missingImage: number;
  withDiscount: number;
  missingPrice: number;
  complete: number;
  missingMultiple: number;
}

export type CompletenessState =
  | "complete"
  | "missing_sku"
  | "missing_barcode"
  | "missing_image"
  | "missing_multiple";

// ── Filters ──────────────────────────────────────────────────────────────────

const FILTER_VALUES: readonly CatalogFilter[] = [
  "all",
  "has_variants",
  "no_variants",
  "missing_sku",
  "missing_barcode",
  "missing_image",
  "complete",
  "missing_multiple",
  "approved",
  "not_approved",
  "has_discount",
  "missing_price",
];

const SORT_VALUES: readonly CatalogSort[] = [
  "readiness",
  "name_ar",
  "name_en",
  "sku",
  "price_asc",
  "price_desc",
  "variants_desc",
];

const MAX_QUERY_LENGTH = 80;
export const PAGE_SIZE = 50;
const MAX_PAGE = 1_000_000; // absurd/overflowing page requests fall back to 1

export const DEFAULT_FILTERS: CatalogFilters = { query: "", filter: "all" };
export const DEFAULT_CONTROLS: CatalogControls = { query: "", filter: "all", sort: "readiness", page: 1 };

/** First usable string of a search param (first string of an array); never coerces. */
function pickParam(v: unknown): string | null {
  if (typeof v === "string") return v;
  if (Array.isArray(v)) {
    for (const el of v) if (typeof el === "string") return el;
  }
  return null;
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  const s = pickParam(v);
  return s !== null && (allowed as readonly string[]).includes(s) ? (s as T) : fallback;
}

/** Parse untrusted GET params into safe filters. Unknown values → "all". */
export function parseCatalogFilters(params: CatalogSearchParams): CatalogFilters {
  const p: Record<string, unknown> = params && typeof params === "object" ? params : {};
  const rawQuery = pickParam(p.query);
  return {
    query: rawQuery === null ? "" : rawQuery.trim().slice(0, MAX_QUERY_LENGTH),
    filter: oneOf(p.filter, FILTER_VALUES, "all"),
  };
}

/**
 * Strictly parse the requested page. Only a plain positive integer string within
 * a sane bound is accepted; non-string, non-integer, negative, zero, NaN, or
 * excessively large values → 1. (Merely-too-high but plausible pages are left
 * as-is here and clamped to the last real page by paginate().)
 */
export function parseCatalogPage(v: unknown): number {
  const s = pickParam(v);
  if (s === null || !/^\d+$/.test(s)) return 1;
  const n = Number(s);
  if (!Number.isSafeInteger(n) || n < 1 || n > MAX_PAGE) return 1;
  return n;
}

const MAX_ID_LENGTH = 200;

/**
 * Validate a product id route parameter. Accepts only a non-empty string within
 * a sane length; anything else → null (the caller then shows the fixed
 * not-found state). Never coerces and never reflects the value anywhere.
 */
export function parseProductId(v: unknown): string | null {
  if (typeof v !== "string") return null;
  if (v.length === 0 || v.trim().length === 0 || v.length > MAX_ID_LENGTH) return null;
  return v;
}

/** Parse the full validated control state (query, filter, sort, page). */
export function parseCatalogControls(params: CatalogSearchParams): CatalogControls {
  const p: Record<string, unknown> = params && typeof params === "object" ? params : {};
  const base = parseCatalogFilters(params);
  return {
    query: base.query,
    filter: base.filter,
    sort: oneOf(p.sort, SORT_VALUES, "readiness"),
    page: parseCatalogPage(p.page),
  };
}

// ── Safe field readers (typeof guards only — never String()/coercion hooks) ──

function stringOrNull(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}
function numberOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// ── Projection (raw rows → catalog-only products; inputs never mutated) ───────

/**
 * Build the catalog products from the already-read product rows and variant
 * rows. Only whitelisted, catalog-safe fields are copied (a new object per row,
 * no spread), so inventory/channel/platform/order columns can never leak. A row
 * without a string `id` is skipped (a hostile/malformed id is never coerced).
 * Neither input array is mutated.
 */
export function projectCatalogRows(
  productRows: readonly unknown[],
  variantRows: readonly unknown[],
): MasterCatalogProduct[] {
  // Count variants per parent — only string parent ids are counted.
  const variantCounts = new Map<string, number>();
  const vRows = Array.isArray(variantRows) ? variantRows : [];
  for (const row of vRows) {
    if (!isPlainObject(row)) continue;
    const parentId = stringOrNull(row.parent_product_id);
    if (parentId === null) continue;
    variantCounts.set(parentId, (variantCounts.get(parentId) ?? 0) + 1);
  }

  const out: MasterCatalogProduct[] = [];
  const pRows = Array.isArray(productRows) ? productRows : [];
  for (const row of pRows) {
    if (!isPlainObject(row)) continue;
    const id = stringOrNull(row.id);
    if (id === null) continue; // malformed identity → skipped, never coerced
    out.push({
      id,
      sku: stringOrNull(row.sku),
      barcode: stringOrNull(row.barcode),
      nameAr: stringOrNull(row.name_ar),
      nameEn: stringOrNull(row.name_en),
      price: numberOrNull(row.price),
      discountPrice: numberOrNull(row.discount_price),
      imageUrl: stringOrNull(row.image_url),
      approval: stringOrNull(row.approval),
      variantCount: variantCounts.get(id) ?? 0,
    });
  }
  return out;
}

/**
 * Project raw product_variants rows into catalog-safe variants. Only whitelisted
 * fields are copied (a new object per row, no spread); non-plain rows are
 * skipped; values are never coerced. `parent_product_id` (used only for counting
 * upstream) and any stock/inventory/platform/order/PII fields are never copied.
 * The input array is not mutated.
 */
export function projectCatalogVariants(variantRows: readonly unknown[]): CatalogVariant[] {
  const out: CatalogVariant[] = [];
  const rows = Array.isArray(variantRows) ? variantRows : [];
  for (const row of rows) {
    if (!isPlainObject(row)) continue;
    out.push({
      id: stringOrNull(row.id),
      variantName: stringOrNull(row.variant_name),
      variantNameEn: stringOrNull(row.variant_name_en),
      sku: stringOrNull(row.sku),
      barcode: stringOrNull(row.barcode),
      price: numberOrNull(row.price),
    });
  }
  return out;
}

// ── Completeness ─────────────────────────────────────────────────────────────

function hasText(v: string | null): boolean {
  return typeof v === "string" && v.trim().length > 0;
}
export function hasSku(p: MasterCatalogProduct): boolean {
  return hasText(p.sku);
}
export function hasBarcode(p: MasterCatalogProduct): boolean {
  return hasText(p.barcode);
}
export function hasImage(p: MasterCatalogProduct): boolean {
  return hasText(p.imageUrl);
}

/** Completeness over the three tracked fields: sku, barcode, image. */
export function getCompleteness(p: MasterCatalogProduct): CompletenessState {
  const missing: CompletenessState[] = [];
  if (!hasSku(p)) missing.push("missing_sku");
  if (!hasBarcode(p)) missing.push("missing_barcode");
  if (!hasImage(p)) missing.push("missing_image");
  if (missing.length === 0) return "complete";
  if (missing.length > 1) return "missing_multiple";
  return missing[0]!;
}

// ── Price, discount, approval ────────────────────────────────────────────────

/** A usable price: a finite number greater than zero. */
export function hasValidPrice(p: MasterCatalogProduct): boolean {
  return typeof p.price === "number" && Number.isFinite(p.price) && p.price > 0;
}

/**
 * A valid discount requires a usable base price and a positive discount price
 * strictly LESS than it. A discount >= the original price is never valid.
 */
export function hasValidDiscount(p: MasterCatalogProduct): boolean {
  return (
    hasValidPrice(p) &&
    typeof p.discountPrice === "number" &&
    Number.isFinite(p.discountPrice) &&
    p.discountPrice > 0 &&
    p.discountPrice < (p.price as number)
  );
}

/** Approval is normalized to a boolean; raw approval text is never surfaced. */
export function isApproved(p: MasterCatalogProduct): boolean {
  return typeof p.approval === "string" && p.approval.trim().toLowerCase() === "approved";
}

/**
 * Readiness priority for the default sort — LOWER sorts first (most in need of
 * attention). Order: missing multiple → missing SKU → missing barcode → missing
 * image → missing price → not approved → complete (last).
 */
export function readinessPriority(p: MasterCatalogProduct): number {
  const c = getCompleteness(p);
  if (c === "missing_multiple") return 0;
  if (c === "missing_sku") return 1;
  if (c === "missing_barcode") return 2;
  if (c === "missing_image") return 3;
  // sku, barcode and image are all present past this point
  if (!hasValidPrice(p)) return 4;
  if (!isApproved(p)) return 5;
  return 6;
}

// ── Search + filtering (in-memory only; no coercion of untrusted values) ──────

function matchesQuery(p: MasterCatalogProduct, q: string): boolean {
  if (q.length === 0) return true;
  const fields = [p.sku, p.barcode, p.nameAr, p.nameEn];
  for (const f of fields) {
    if (typeof f === "string" && f.toLowerCase().includes(q)) return true;
  }
  return false;
}

function matchesFilter(p: MasterCatalogProduct, filter: CatalogFilter): boolean {
  switch (filter) {
    case "all":
      return true;
    case "has_variants":
      return p.variantCount > 0;
    case "no_variants":
      return p.variantCount === 0;
    case "missing_sku":
      return !hasSku(p);
    case "missing_barcode":
      return !hasBarcode(p);
    case "missing_image":
      return !hasImage(p);
    case "complete":
      return getCompleteness(p) === "complete";
    case "missing_multiple":
      return getCompleteness(p) === "missing_multiple";
    case "approved":
      return isApproved(p);
    case "not_approved":
      return !isApproved(p);
    case "has_discount":
      return hasValidDiscount(p);
    case "missing_price":
      return !hasValidPrice(p);
    default:
      return true;
  }
}

export function filterCatalogProducts(
  products: readonly MasterCatalogProduct[],
  filters: CatalogFilters,
): MasterCatalogProduct[] {
  const q = filters.query.trim().toLowerCase();
  return (Array.isArray(products) ? products : []).filter(
    (p) => matchesFilter(p, filters.filter) && matchesQuery(p, q),
  );
}

// ── Summary (counts PRODUCTS, never variants) ────────────────────────────────

export function summarizeCatalog(products: readonly MasterCatalogProduct[]): CatalogSummary {
  const list = Array.isArray(products) ? products : [];
  return {
    totalProducts: list.length,
    withVariants: list.filter((p) => p.variantCount > 0).length,
    missingSku: list.filter((p) => !hasSku(p)).length,
    missingBarcode: list.filter((p) => !hasBarcode(p)).length,
    missingImage: list.filter((p) => !hasImage(p)).length,
    withDiscount: list.filter((p) => hasValidDiscount(p)).length,
    missingPrice: list.filter((p) => !hasValidPrice(p)).length,
    complete: list.filter((p) => getCompleteness(p) === "complete").length,
    missingMultiple: list.filter((p) => getCompleteness(p) === "missing_multiple").length,
  };
}

// ── Sorting (deterministic, non-mutating) ────────────────────────────────────

/** Compare two nullable strings; missing values always sort LAST. */
function compareStrings(a: string | null, b: string | null): number {
  const av = hasText(a) ? (a as string).trim().toLowerCase() : null;
  const bv = hasText(b) ? (b as string).trim().toLowerCase() : null;
  if (av === null && bv === null) return 0;
  if (av === null) return 1;
  if (bv === null) return -1;
  return av.localeCompare(bv);
}

/** Compare two prices; missing/invalid always sort LAST regardless of direction. */
function comparePrices(a: MasterCatalogProduct, b: MasterCatalogProduct, direction: 1 | -1): number {
  const av = hasValidPrice(a) ? (a.price as number) : null;
  const bv = hasValidPrice(b) ? (b.price as number) : null;
  if (av === null && bv === null) return 0;
  if (av === null) return 1;
  if (bv === null) return -1;
  return (av - bv) * direction;
}

function primaryCompare(a: MasterCatalogProduct, b: MasterCatalogProduct, sort: CatalogSort): number {
  switch (sort) {
    case "name_ar":
      return compareStrings(a.nameAr, b.nameAr);
    case "name_en":
      return compareStrings(a.nameEn, b.nameEn);
    case "sku":
      return compareStrings(a.sku, b.sku);
    case "price_asc":
      return comparePrices(a, b, 1);
    case "price_desc":
      return comparePrices(a, b, -1);
    case "variants_desc":
      return b.variantCount - a.variantCount;
    case "readiness":
    default:
      return readinessPriority(a) - readinessPriority(b);
  }
}

/**
 * Sort a COPY of the products by the chosen key, with a deterministic
 * tie-breaker on the product id. The input array is never mutated.
 */
export function sortCatalogProducts(
  products: readonly MasterCatalogProduct[],
  sort: CatalogSort,
): MasterCatalogProduct[] {
  const arr = [...(Array.isArray(products) ? products : [])];
  arr.sort((a, b) => primaryCompare(a, b, sort) || a.id.localeCompare(b.id));
  return arr;
}

// ── Pagination (pure) ────────────────────────────────────────────────────────

export interface CatalogPage {
  page: number; // clamped current page (always in [1, totalPages])
  pageSize: number;
  totalItems: number;
  totalPages: number; // at least 1
  startIndex: number; // 0-based index of the first item on this page
  items: MasterCatalogProduct[];
}

/**
 * Slice a page out of an already filtered+sorted list. `requestedPage` above the
 * real page count is clamped to the last page (never a false empty state); an
 * empty list yields one empty page.
 */
export function paginateCatalog(
  products: readonly MasterCatalogProduct[],
  requestedPage: number,
  pageSize: number = PAGE_SIZE,
): CatalogPage {
  const list = Array.isArray(products) ? products : [];
  const size = Number.isSafeInteger(pageSize) && pageSize > 0 ? pageSize : PAGE_SIZE;
  const totalItems = list.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / size));
  const req = Number.isSafeInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1;
  const page = Math.min(req, totalPages);
  const startIndex = (page - 1) * size;
  return { page, pageSize: size, totalItems, totalPages, startIndex, items: list.slice(startIndex, startIndex + size) };
}

// ── URL state (preserve query/filter/sort across pagination) ─────────────────

/**
 * Canonical control → query-param builder shared by every catalog link. Emits
 * ONLY non-default values, in a fixed order (query, filter, sort, page), all
 * encoded by URLSearchParams. Never mutates `controls`.
 */
function catalogControlParams(controls: CatalogControls, page: number): URLSearchParams {
  const params = new URLSearchParams();
  if (controls.query) params.set("query", controls.query);
  if (controls.filter !== "all") params.set("filter", controls.filter);
  if (controls.sort !== "readiness") params.set("sort", controls.sort);
  if (Number.isSafeInteger(page) && page > 1) params.set("page", `${page}`);
  return params;
}

/**
 * Build a `/v2/catalog` href for a given page, preserving the current query,
 * filter and sort. Only non-default params are emitted, so page-1 default links
 * stay clean. Values are encoded via URLSearchParams (never reflected raw).
 */
export function catalogHref(controls: CatalogControls, page: number): string {
  const qs = catalogControlParams(controls, page).toString();
  return qs ? `/v2/catalog?${qs}` : "/v2/catalog";
}

/**
 * Build a `/v2/catalog/<id>` detail href that carries the CURRENT catalog
 * controls (query, filter, sort, page) so the detail page can restore the exact
 * list view. The id is encoded as a path segment; control values reuse the same
 * canonical names + omission rules as catalogHref (defaults → clean URL). Never
 * mutates `controls` and never emits arbitrary extra params.
 */
export function catalogDetailHref(id: string, controls: CatalogControls): string {
  const base = `/v2/catalog/${encodeURIComponent(id)}`;
  const qs = catalogControlParams(controls, controls.page).toString();
  return qs ? `${base}?${qs}` : base;
}

// ── Fixed Arabic labels (never reflect unknown/raw text) ─────────────────────

const COMPLETENESS_LABELS: Record<CompletenessState, string> = {
  complete: "مكتمل",
  missing_sku: "ناقص SKU",
  missing_barcode: "ناقص باركود",
  missing_image: "ناقص صورة",
  missing_multiple: "ناقص أكثر من حقل",
};

/** Prototype-safe fixed-label lookup (own string key only; else fallback). */
function fixedLabel<T extends object>(labels: T, key: unknown, fallback: string): string {
  if (typeof key !== "string") return fallback;
  if (!Object.hasOwn(labels, key)) return fallback;
  const value = (labels as Record<string, unknown>)[key];
  return typeof value === "string" ? value : fallback;
}

export function getCompletenessLabel(state: CompletenessState): string {
  return fixedLabel(COMPLETENESS_LABELS, state, COMPLETENESS_LABELS.complete);
}

/** Fixed approval label — never reflects the raw approval text. */
export function getApprovalLabel(p: MasterCatalogProduct): string {
  return isApproved(p) ? "معتمد" : "غير معتمد";
}

/** Display name: Arabic first, then English; otherwise a dash. */
export function getDisplayName(p: MasterCatalogProduct): string {
  if (hasText(p.nameAr)) return p.nameAr as string;
  if (hasText(p.nameEn)) return p.nameEn as string;
  return "—";
}

/** Variant display name: Arabic first, then English; otherwise a dash. */
export function getVariantDisplayName(v: CatalogVariant): string {
  if (hasText(v.variantName)) return v.variantName as string;
  if (hasText(v.variantNameEn)) return v.variantNameEn as string;
  return "—";
}

// ── Filter option lists (for the GET <form> select) ──────────────────────────

export interface CatalogFilterOption {
  value: CatalogFilter;
  label: string;
}
export const CATALOG_FILTER_OPTIONS: readonly CatalogFilterOption[] = [
  { value: "all", label: "الكل" },
  { value: "complete", label: "مكتمل" },
  { value: "missing_multiple", label: "ناقص أكثر من حقل" },
  { value: "missing_sku", label: "ناقص SKU" },
  { value: "missing_barcode", label: "ناقص باركود" },
  { value: "missing_image", label: "ناقص صورة" },
  { value: "missing_price", label: "بدون سعر" },
  { value: "has_discount", label: "عليه خصم" },
  { value: "approved", label: "معتمد" },
  { value: "not_approved", label: "غير معتمد" },
  { value: "has_variants", label: "لديه خيارات" },
  { value: "no_variants", label: "بدون خيارات" },
];

export interface CatalogSortOption {
  value: CatalogSort;
  label: string;
}
export const CATALOG_SORT_OPTIONS: readonly CatalogSortOption[] = [
  { value: "readiness", label: "الأولوية (نقص البيانات)" },
  { value: "name_ar", label: "الاسم (عربي)" },
  { value: "name_en", label: "الاسم (إنجليزي)" },
  { value: "sku", label: "SKU" },
  { value: "price_asc", label: "السعر (تصاعدي)" },
  { value: "price_desc", label: "السعر (تنازلي)" },
  { value: "variants_desc", label: "الأكثر خيارات" },
];
