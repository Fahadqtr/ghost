// OPS.2 — Media Center core (PURE). No `@/` imports, no server-only, no DB —
// node:test loads it directly.
//
// The Media Center is an ORCHESTRATION module: it performs NO reads and NO writes
// and duplicates NO media logic. This module is pure metadata analysis over image
// rows the server has already read (products' primary image + the product_images
// gallery). It computes: media health, duplicate detection (filename/url — never
// perceptual hashing, which does not exist here), the dashboard card model, and
// filtering. Recovery/upload themselves are delegated to the existing CH.6B /
// media-actions boundaries by the server layer — never re-implemented here.

export interface MediaProductRow {
  productId: string;
  sku: string | null;
  nameEn: string | null;
  nameAr: string | null;
  brandId: string | null;
  category: string | null;
  imageUrl: string | null; // products.image_url — the authoritative primary
  imageFilename: string | null; // products.image_filename
  galleryCount: number; // number of product_images rows for this product
}

/** A raw product_images row (for same-product + cross-product duplicate scans). */
export interface GalleryImageRow {
  productId: string;
  url: string | null;
  filename: string | null;
}

// ── url/filename normalization ────────────────────────────────────────────────
/** Strip the cache-bust query (?t=…) so two writes of the same object compare equal. */
export function baseUrl(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  if (t === "") return null;
  const q = t.indexOf("?");
  return (q >= 0 ? t.slice(0, q) : t).toLowerCase();
}
export function normName(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim().toLowerCase();
  return t === "" ? null : t;
}

// ── media status ──────────────────────────────────────────────────────────────
export type MediaStatus = "HAS_PRIMARY" | "MISSING" | "DUPLICATE";

export function mediaStatus(row: MediaProductRow, isDuplicate: boolean): MediaStatus {
  if (baseUrl(row.imageUrl) === null) return "MISSING";
  if (isDuplicate) return "DUPLICATE";
  return "HAS_PRIMARY";
}

// ── media health (0–100). Factors limited to signals we actually have; resolution
//    and broken-URL are DEFERRED (no reusable measurement) and never scored. ────
export interface MediaHealth {
  score: number;
  factors: { primaryExists: boolean; hasGallery: boolean; noDuplicate: boolean };
}
const W_PRIMARY = 60;
const W_GALLERY = 25;
const W_NODUP = 15;

export function computeMediaHealth(row: MediaProductRow, isDuplicate: boolean): MediaHealth {
  const primaryExists = baseUrl(row.imageUrl) !== null;
  const hasGallery = row.galleryCount > 1; // primary + at least one extra
  const noDuplicate = !isDuplicate;
  const score = (primaryExists ? W_PRIMARY : 0) + (hasGallery ? W_GALLERY : 0) + (noDuplicate ? W_NODUP : 0);
  return { score, factors: { primaryExists, hasGallery, noDuplicate } };
}

export type HealthTone = "good" | "warn" | "bad";
export function mediaHealthTone(score: number): HealthTone {
  if (score >= 80) return "good";
  if (score >= 50) return "warn";
  return "bad";
}

// ── duplicate detection (filename + url; cross-product AND same-product) ───────
export type DuplicateKind = "cross_product_url" | "cross_product_filename" | "same_product_url";
export interface DuplicateGroup {
  kind: DuplicateKind;
  value: string;
  productIds: string[];
}

/**
 * Detect duplicates from metadata only. NEVER auto-deletes; this is a read-only
 * report. Perceptual/pixel hashing is out of scope (no reusable backing).
 */
export function detectDuplicates(rows: readonly MediaProductRow[], gallery: readonly GalleryImageRow[]): DuplicateGroup[] {
  const groups: DuplicateGroup[] = [];

  // cross-product: same primary url or same primary filename on ≥2 distinct products
  const byUrl = new Map<string, Set<string>>();
  const byName = new Map<string, Set<string>>();
  for (const r of rows) {
    const u = baseUrl(r.imageUrl);
    if (u) (byUrl.get(u) ?? byUrl.set(u, new Set()).get(u)!).add(r.productId);
    const n = normName(r.imageFilename);
    if (n) (byName.get(n) ?? byName.set(n, new Set()).get(n)!).add(r.productId);
  }
  for (const [value, ids] of byUrl) if (ids.size > 1) groups.push({ kind: "cross_product_url", value, productIds: [...ids].sort() });
  for (const [value, ids] of byName) if (ids.size > 1) groups.push({ kind: "cross_product_filename", value, productIds: [...ids].sort() });

  // same-product: the same url appears more than once within one product's gallery
  const perProduct = new Map<string, Map<string, number>>();
  for (const g of gallery) {
    const u = baseUrl(g.url);
    if (!u) continue;
    const m = perProduct.get(g.productId) ?? perProduct.set(g.productId, new Map()).get(g.productId)!;
    m.set(u, (m.get(u) ?? 0) + 1);
  }
  for (const [productId, urls] of perProduct) {
    for (const [value, count] of urls) if (count > 1) groups.push({ kind: "same_product_url", value, productIds: [productId] });
  }
  return groups;
}

/** Product ids that participate in any cross-product duplicate group. */
export function duplicateProductIds(groups: readonly DuplicateGroup[]): Set<string> {
  const out = new Set<string>();
  for (const g of groups) if (g.kind !== "same_product_url") for (const id of g.productIds) out.add(id);
  return out;
}

// ── dashboard cards ───────────────────────────────────────────────────────────
export type CardTone = "neutral" | "good" | "warn" | "bad";
export interface MediaCard {
  key: string;
  label: string;
  /** null ⇒ deferred/entry-point metric (computed in a linked workflow, not here). */
  value: number | null;
  tone: CardTone;
  href: string;
  note?: string;
}

export const MEDIA_ROUTES = {
  media: "/v2/operations/media",
  imageHealth: "/import-export", // existing catalog image-health scan (broken URLs)
  shopifySync: "/import-export", // existing Shopify store-side image push
} as const;

const problemTone = (n: number): CardTone => (n > 0 ? "warn" : "good");

export interface MediaDashboard {
  cards: MediaCard[];
  totals: {
    products: number;
    missing: number;
    withMultiple: number;
    duplicates: number;
    withPrimary: number;
    averageHealth: number;
  };
}

export function buildMediaDashboard(rows: readonly MediaProductRow[], groups: readonly DuplicateGroup[]): MediaDashboard {
  const dupIds = duplicateProductIds(groups);
  let missing = 0;
  let withMultiple = 0;
  let withPrimary = 0;
  let healthSum = 0;
  for (const r of rows) {
    const isDup = dupIds.has(r.productId);
    const h = computeMediaHealth(r, isDup);
    healthSum += h.score;
    if (baseUrl(r.imageUrl) === null) missing += 1;
    else withPrimary += 1;
    if (r.galleryCount > 1) withMultiple += 1;
  }
  const duplicates = dupIds.size;
  const products = rows.length;
  const averageHealth = products > 0 ? Math.round(healthSum / products) : 0;

  const cards: MediaCard[] = [
    { key: "products", label: "المنتجات", value: products, tone: "neutral", href: MEDIA_ROUTES.media },
    { key: "missing", label: "صور ناقصة", value: missing, tone: problemTone(missing), href: MEDIA_ROUTES.media },
    { key: "multiple", label: "صور متعددة", value: withMultiple, tone: "good", href: MEDIA_ROUTES.media },
    { key: "duplicates", label: "صور مكررة", value: duplicates, tone: problemTone(duplicates), href: MEDIA_ROUTES.media },
    // Deferred / entry-point metrics — no reusable measurement in-scope; each
    // links to the workflow that computes it. Shown as ↗, never a fabricated 0.
    { key: "low_resolution", label: "دقة منخفضة", value: null, tone: "neutral", href: MEDIA_ROUTES.imageHealth, note: "غير مُقاس" },
    { key: "imported_today", label: "مستورد اليوم", value: null, tone: "neutral", href: MEDIA_ROUTES.media, note: "غير متتبَّع" },
    { key: "recovered_snoonu", label: "مسترجع (سنونو)", value: null, tone: "neutral", href: MEDIA_ROUTES.media, note: "سجل التنفيذ" },
    { key: "recovered_shopify", label: "مسترجع (شوبيفاي)", value: null, tone: "neutral", href: MEDIA_ROUTES.shopifySync },
    { key: "manual_upload", label: "رفع يدوي مطلوب", value: missing, tone: problemTone(missing), href: MEDIA_ROUTES.media, note: "غير الحتمية" },
    { key: "broken", label: "صور معطوبة", value: null, tone: "neutral", href: MEDIA_ROUTES.imageHealth, note: "افحص عبر صحة الصور" },
  ];

  return { cards, totals: { products, missing, withMultiple, duplicates, withPrimary, averageHealth } };
}

// ── missing-images queue ──────────────────────────────────────────────────────
export interface MissingImageItem {
  productId: string;
  sku: string | null;
  name: string | null;
  brandId: string | null;
  category: string | null;
  suggestedAction: "RECOVER_SNOONU" | "UPLOAD";
}

export function buildMissingQueue(rows: readonly MediaProductRow[]): MissingImageItem[] {
  const out: MissingImageItem[] = [];
  for (const r of rows) {
    if (baseUrl(r.imageUrl) !== null) continue;
    out.push({
      productId: r.productId,
      sku: r.sku,
      name: r.nameAr ?? r.nameEn,
      brandId: r.brandId,
      category: r.category,
      // deterministic source availability is confirmed only by the CH.6B scan;
      // the default suggestion is manual upload, upgraded to RECOVER_SNOONU when
      // the recovery preview marks the product MATCHED.
      suggestedAction: "UPLOAD",
    });
  }
  return out;
}

// ── filters ───────────────────────────────────────────────────────────────────
export type MediaFilter = "all" | "missing" | "has_primary" | "multiple" | "duplicate";

export function applyMediaFilter<T extends MediaProductRow>(rows: readonly T[], filter: MediaFilter, dupIds: ReadonlySet<string>): T[] {
  switch (filter) {
    case "missing":
      return rows.filter((r) => baseUrl(r.imageUrl) === null);
    case "has_primary":
      return rows.filter((r) => baseUrl(r.imageUrl) !== null);
    case "multiple":
      return rows.filter((r) => r.galleryCount > 1);
    case "duplicate":
      return rows.filter((r) => dupIds.has(r.productId));
    case "all":
    default:
      return rows.slice();
  }
}

export function searchRows<T extends MediaProductRow>(rows: readonly T[], q: string): T[] {
  const needle = q.trim().toLowerCase();
  if (!needle) return rows.slice();
  return rows.filter((r) =>
    `${r.sku ?? ""} ${r.nameEn ?? ""} ${r.nameAr ?? ""} ${r.brandId ?? ""} ${r.category ?? ""}`.toLowerCase().includes(needle),
  );
}
