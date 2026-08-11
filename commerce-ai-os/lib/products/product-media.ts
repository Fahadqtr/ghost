// Product media contract + pure reducer (UX.4C-1).
//
// PURE — no I/O, no framework imports, no side effects. node:test loads this
// directly.
//
// One place decides what a product's photos are, so the V2 detail page, the V2
// edit page, and any future media surface all read the SAME shape. The rules:
//   • `products.image_url` is the AUTHORITATIVE primary pointer. The gallery row
//     whose `url` equals it is the primary.
//   • If no gallery row matches (e.g. a V2-created product that has image_url
//     but no product_images row yet), the primary is SYNTHESIZED from image_url
//     (+ image_filename), id null.
//   • `is_primary` is a FALLBACK only — used to pick a primary when there is no
//     image_url at all.
//   • Ordering is deterministic: primary first, then the rest by sort_order
//     ascending with the original row order as a stable tie-breaker.
// The derived `isPrimary` on each item reflects the CHOSEN primary — never the
// raw column — so image_url always wins over a stale is_primary flag.

/** One product photo, normalized. `id` is null for a synthesized primary that
 *  has no product_images row behind it. */
export interface ProductMediaItem {
  id: string | null;
  url: string;
  filename: string | null;
  isPrimary: boolean;
  sortOrder: number;
}

/** The full media state for one product. `primary` is always `images[0]` when
 *  any media exists, or null when the product has no photo at all. */
export interface ProductMediaState {
  primary: ProductMediaItem | null;
  images: ProductMediaItem[];
}

/** The empty state — a product with no photo. */
export const EMPTY_PRODUCT_MEDIA: ProductMediaState = { primary: null, images: [] };

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function strOrNull(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t === "" ? null : v;
}

function sortOrderOf(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** A row as it arrives from product_images, carrying its original index so the
 *  ordering tie-break stays stable across engines. */
interface NormalizedRow {
  id: string | null;
  url: string;
  filename: string | null;
  isPrimaryRaw: boolean;
  sortOrder: number;
  index: number;
}

function normalizeRows(rows: readonly unknown[]): NormalizedRow[] {
  const out: NormalizedRow[] = [];
  const seen = new Set<string>();
  let i = 0;
  for (const raw of rows) {
    if (typeof raw !== "object" || raw === null) continue;
    const row = raw as Record<string, unknown>;
    const url = str(row.url).trim();
    if (url === "") continue; // a row without a usable url is not a photo
    if (seen.has(url)) continue; // de-dup by url, first occurrence wins
    seen.add(url);
    out.push({
      id: typeof row.id === "string" ? row.id : null,
      url,
      filename: strOrNull(row.filename),
      isPrimaryRaw: row.is_primary === true,
      sortOrder: sortOrderOf(row.sort_order),
      index: i,
    });
    i += 1;
  }
  return out;
}

/** Deterministic gallery order: sort_order ascending, original order as the
 *  stable tie-break. */
function byOrder(a: NormalizedRow, b: NormalizedRow): number {
  if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
  return a.index - b.index;
}

function toItem(row: NormalizedRow, isPrimary: boolean): ProductMediaItem {
  return { id: row.id, url: row.url, filename: row.filename, isPrimary, sortOrder: row.sortOrder };
}

/**
 * Reduce `products.image_url` / `products.image_filename` + the product's
 * `product_images` rows into a single, deterministic ProductMediaState.
 */
export function toProductMediaState(
  imageUrl: string | null | undefined,
  imageFilename: string | null | undefined,
  rows: readonly unknown[],
): ProductMediaState {
  const primaryUrl = str(imageUrl).trim();
  const items = normalizeRows(rows);

  // 1) image_url points at a gallery row → that row is the primary.
  if (primaryUrl !== "") {
    const matchIdx = items.findIndex((r) => r.url === primaryUrl);
    if (matchIdx >= 0) {
      const primaryRow = items[matchIdx];
      const rest = items.filter((_, i) => i !== matchIdx).sort(byOrder);
      const images = [toItem(primaryRow, true), ...rest.map((r) => toItem(r, false))];
      return { primary: images[0], images };
    }
    // 2) image_url set but NO gallery row matches → synthesize the primary from
    //    image_url (+ image_filename). Its id is null (no product_images row).
    const synthesized: ProductMediaItem = {
      id: null,
      url: primaryUrl,
      filename: strOrNull(imageFilename),
      isPrimary: true,
      sortOrder: 0,
    };
    const rest = [...items].sort(byOrder).map((r) => toItem(r, false));
    const images = [synthesized, ...rest];
    return { primary: images[0], images };
  }

  // 3) No image_url at all → fall back to the is_primary flag, else the first
  //    row by order. No rows → empty.
  if (items.length === 0) return { primary: null, images: [] };
  const ordered = [...items].sort(byOrder);
  const primaryPos = ordered.findIndex((r) => r.isPrimaryRaw);
  const pos = primaryPos >= 0 ? primaryPos : 0;
  const primaryRow = ordered[pos];
  const rest = ordered.filter((_, i) => i !== pos);
  const images = [toItem(primaryRow, true), ...rest.map((r) => toItem(r, false))];
  return { primary: images[0], images };
}
