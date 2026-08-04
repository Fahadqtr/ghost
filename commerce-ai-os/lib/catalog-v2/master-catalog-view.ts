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

export type CatalogFilter =
  | "all"
  | "has_variants"
  | "no_variants"
  | "missing_sku"
  | "missing_barcode"
  | "missing_image";

export interface CatalogFilters {
  query: string;
  filter: CatalogFilter;
}

export type CatalogSearchParams = Record<string, string | string[] | undefined> | null | undefined;

export interface CatalogSummary {
  totalProducts: number;
  withVariants: number;
  missingSku: number;
  missingBarcode: number;
  missingImage: number;
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
];

const MAX_QUERY_LENGTH = 80;

export const DEFAULT_FILTERS: CatalogFilters = { query: "", filter: "all" };

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
  };
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

/** Display name: Arabic first, then English; otherwise a dash. */
export function getDisplayName(p: MasterCatalogProduct): string {
  if (hasText(p.nameAr)) return p.nameAr as string;
  if (hasText(p.nameEn)) return p.nameEn as string;
  return "—";
}

// ── Filter option lists (for the GET <form> select) ──────────────────────────

export interface CatalogFilterOption {
  value: CatalogFilter;
  label: string;
}
export const CATALOG_FILTER_OPTIONS: readonly CatalogFilterOption[] = [
  { value: "all", label: "الكل" },
  { value: "has_variants", label: "لديه خيارات" },
  { value: "no_variants", label: "بدون خيارات" },
  { value: "missing_sku", label: "ناقص SKU" },
  { value: "missing_barcode", label: "ناقص باركود" },
  { value: "missing_image", label: "ناقص صورة" },
];
