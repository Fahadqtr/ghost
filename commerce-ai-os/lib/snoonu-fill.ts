// Pure, DB-free logic for filling a Snoonu bulk-update sheet's SKU + Barcode
// columns from our catalog. Match a sheet row to a product by SPI (snoonu_id,
// exact) first, then by normalized name (En, then Ar) as a fallback. Unit-tested.

export interface CatalogCodeRow {
  snoonu_id?: string | null;
  sku?: string | null;
  barcode?: string | null;
  name_en?: string | null;
  name_ar?: string | null;
}

export interface FillItem { spi?: string | null; nameEn?: string | null; nameAr?: string | null }
export interface FillResult { sku: string; barcode: string; matched: "spi" | "name" | null }

export function normName(v: unknown): string {
  if (v == null) return "";
  let s = String(v);
  s = s.replace(/[’‘]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, "-");
  try { s = s.normalize("NFKC"); } catch { /* older runtimes */ }
  s = s.toLowerCase().replace(/[‎‏]/g, "");
  return s.replace(/\s+/g, " ").trim();
}

const clean = (v: unknown): string => String(v ?? "").trim();

export interface CodeIndex {
  bySpi: Map<string, { sku: string; barcode: string }>;
  byName: Map<string, { sku: string; barcode: string }>;
}

/**
 * Build lookup maps from catalog rows. Only rows that actually carry a code
 * (sku or barcode) are indexed, so a match always yields a real value. The first
 * row wins on duplicate keys (stable).
 */
export function buildCodeIndex(rows: CatalogCodeRow[]): CodeIndex {
  const bySpi = new Map<string, { sku: string; barcode: string }>();
  const byName = new Map<string, { sku: string; barcode: string }>();
  for (const r of rows ?? []) {
    const sku = clean(r.sku); const barcode = clean(r.barcode);
    if (!sku && !barcode) continue;
    const code = { sku, barcode };
    const spi = clean(r.snoonu_id);
    if (spi && !bySpi.has(spi)) bySpi.set(spi, code);
    const en = normName(r.name_en); if (en && !byName.has(en)) byName.set(en, code);
    const ar = normName(r.name_ar); if (ar && !byName.has(ar)) byName.set(ar, code);
  }
  return { bySpi, byName };
}

/** Resolve one sheet row to a {sku, barcode} — SPI first, then name. */
export function matchCode(item: FillItem, index: CodeIndex): FillResult {
  const spi = clean(item.spi);
  if (spi) { const c = index.bySpi.get(spi); if (c) return { ...c, matched: "spi" }; }
  const en = normName(item.nameEn); if (en) { const c = index.byName.get(en); if (c) return { ...c, matched: "name" }; }
  const ar = normName(item.nameAr); if (ar) { const c = index.byName.get(ar); if (c) return { ...c, matched: "name" }; }
  return { sku: "", barcode: "", matched: null };
}

/** Batch-resolve, aligned to the input order. */
export function fillCodes(items: FillItem[], index: CodeIndex): FillResult[] {
  return (items ?? []).map((it) => matchCode(it, index));
}
