// FULL CATALOG EXCEL EXPORT — the PURE sheet builder.
//
// Turns raw rows from products / product_images / product_variants /
// external_channel_listings into four sheets of STRING cells. It performs no
// I/O, creates no client and reads no environment: the server route fetches the
// rows and hands them here, so every shaping rule below is unit-testable.
//
// EXPORT CONTRACT (owner):
//   • EVERY canonical product — ACTIVE, DRAFT, STOPPED, unapproved,
//     PENDING-SNOONU, barcode-less, image-less, variant-less. No filtering of
//     any kind. This is database truth, not the catalog page's filtered view.
//   • Nulls are shown as empty cells, never collapsed or hidden away.
//   • Identity-bearing values (id, sku, barcode, SPI, GID, external ids) are
//     emitted as TEXT so Excel can never reformat a long digit string into
//     scientific notation or drop a leading zero. That is why every cell here
//     is a string and the writer marks the whole sheet as text.

/** Raw `products` row (only the columns the export reads). */
export interface ExportProductRow {
  id: string;
  sku: string | null;
  barcode: string | null;
  name_en: string | null;
  name_ar: string | null;
  description_en: string | null;
  description_ar: string | null;
  brand_id: string | null;
  main_category: string | null;
  sub_category: string | null;
  price: number | string | null;
  discount_price: number | string | null;
  cost: number | string | null;
  lifecycle_state: string | null;
  approval: string | null;
  rejection_reason: string | null;
  stock_status: string | null;
  stock_quantity: number | string | null;
  image_url: string | null;
  image_filename: string | null;
  product_type: string | null;
  color: string | null;
  size: string | null;
  keywords_en: string | null;
  keywords_ar: string | null;
  is_featured: boolean | null;
  is_promoted: boolean | null;
  has_buy1get1: boolean | null;
  notes: string | null;
  snoonu_id: string | null;
  pure_seoul_id: string | null;
  pure_seoul_status: string | null;
  rafeeq_product_id: string | null;
  platform_status: string | null;
  created_at: string | null;
  updated_at: string | null;
}

export interface ExportImageRow {
  id: string;
  product_id: string;
  url: string | null;
  filename: string | null;
  is_primary: boolean | null;
  sort_order: number | string | null;
  created_at: string | null;
}

export interface ExportVariantRow {
  id: string;
  parent_product_id: string;
  variant_name: string | null;
  variant_name_en: string | null;
  sku: string | null;
  barcode: string | null;
  color: string | null;
  size: string | null;
  price: number | string | null;
  stock_quantity: number | string | null;
  stock_status: string | null;
  created_at: string | null;
}

export interface ExportListingRow {
  id: string;
  product_id: string;
  channel_key: string | null;
  storefront_key: string | null;
  external_product_id: string | null;
  external_variant_id: string | null;
  identity_type: string | null;
  mapping_status: string | null;
  exported_sku: string | null;
  exported_barcode: string | null;
  variant_id: string | null;
  variant_sku: string | null;
  metadata: unknown;
  created_at: string | null;
  updated_at: string | null;
}

export interface ExportLookupRow {
  id: string;
  name: string | null;
}

export interface FullCatalogInput {
  products: readonly ExportProductRow[];
  images: readonly ExportImageRow[];
  variants: readonly ExportVariantRow[];
  listings: readonly ExportListingRow[];
  brands: readonly ExportLookupRow[];
  categories: readonly ExportLookupRow[];
}

export interface FullCatalogSheets {
  products: string[][];
  images: string[][];
  variants: string[][];
  listings: string[][];
}

/** The four sheet names, in workbook order. */
export const FULL_CATALOG_SHEET_NAMES = ["Products", "Images", "Variants", "Channel Listings"] as const;

/** Storefront keys promoted to their own Products columns. */
const SNOONU_KEY = "snoonu:malikas";
const SHOPIFY_KEY = "shopify:malikas";
const RAFEEQ_KEY = "rafeeq:malikas";
const PURE_SEOUL_KEY = "snoonu:pure_seoul";

/** Every value reaches Excel as text; null/undefined become an empty cell. */
function s(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  if (typeof v === "object") {
    try {
      return JSON.stringify(v);
    } catch {
      return "";
    }
  }
  return String(v);
}

/** `gid://shopify/Product/123` → `123`; anything else is returned unchanged. */
export function shopifyNumericId(gid: string | null | undefined): string {
  const t = s(gid);
  const m = /^gid:\/\/shopify\/Product\/(\d+)$/.exec(t);
  return m ? m[1] : t;
}

/** Group rows by a key, preserving input order inside each group. */
function groupBy<T>(rows: readonly T[], key: (row: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const row of rows) {
    const k = key(row);
    const bucket = out.get(k);
    if (bucket) bucket.push(row);
    else out.set(k, [row]);
  }
  return out;
}

/**
 * Pick the listing that represents a product on one storefront: the `active`
 * one when present, otherwise the first. A product may legitimately hold an
 * active listing plus archived history, and the summary columns must describe
 * the LIVE identity — the full picture stays on the Channel Listings sheet,
 * which is never collapsed.
 */
function pickListing(rows: readonly ExportListingRow[] | undefined, storefront: string): ExportListingRow | null {
  if (!rows) return null;
  const onStorefront = rows.filter((r) => s(r.storefront_key) === storefront);
  if (onStorefront.length === 0) return null;
  return onStorefront.find((r) => s(r.mapping_status) === "active") ?? onStorefront[0];
}

export const PRODUCTS_HEADER = [
  "product_id", "sku", "barcode", "name_en", "name_ar", "description_en", "description_ar",
  "brand", "brand_id", "category", "category_id", "subcategory", "subcategory_id",
  "base_price", "discount_price", "cost", "currency",
  "lifecycle_status", "approval_status", "rejection_reason", "stock_status", "stock_quantity",
  "product_type", "color", "size", "keywords_en", "keywords_ar",
  "is_featured", "is_promoted", "has_buy1get1", "notes",
  "created_at", "updated_at",
  "primary_image_url", "primary_image_filename", "product_images_count",
  "has_variants", "variants_count",
  "snoonu_spi", "snoonu_listing_id", "snoonu_listing_active", "snoonu_exported_sku", "snoonu_exported_barcode",
  "snoonu_id_legacy",
  "shopify_product_gid", "shopify_product_numeric_id", "shopify_listing_id", "shopify_active",
  "rafeeq_product_id", "rafeeq_external_id", "rafeeq_listing_id", "rafeeq_active",
  "pure_seoul_external_id", "pure_seoul_listing_id", "pure_seoul_active", "pure_seoul_id_legacy", "pure_seoul_status",
  "platform_status",
] as const;

export const IMAGES_HEADER = [
  "image_id", "product_id", "sku", "product_name_en", "product_name_ar",
  "image_url", "image_filename", "is_primary", "sort_order", "created_at",
  "product_primary_image_url", "matches_product_primary_image_url",
  // Present in the export shape but EMPTY: these columns do not exist in the
  // product_images schema today. The owner's rule is explicit — export what the
  // DB already stores and never download or hash images during an export — so
  // they are reserved here rather than computed.
  "image_source_url", "storage_path", "stored_sha256", "stored_checksum", "width", "height",
] as const;

export const VARIANTS_HEADER = [
  "variant_id", "product_id", "parent_sku", "parent_name_en",
  "variant_sku", "variant_barcode", "variant_name", "variant_name_en",
  "option1_name", "option1_value", "option2_name", "option2_value",
  "price", "stock_quantity", "stock_status", "created_at",
] as const;

export const LISTINGS_HEADER = [
  "listing_id", "product_id", "sku", "product_name_en",
  "channel", "storefront_key", "external_product_id", "external_product_numeric_id", "external_variant_id",
  "identity_type", "external_sku", "external_barcode",
  "variant_id", "variant_sku", "active", "status", "metadata", "created_at", "updated_at",
] as const;

/** Build all four sheets (header row + data rows) from raw table rows. */
export function buildFullCatalogSheets(input: FullCatalogInput): FullCatalogSheets {
  const brandName = new Map(input.brands.map((b) => [b.id, s(b.name)]));
  // products.main_category / sub_category ARE the category names (the FK targets
  // product_categories.name). The numeric-ish id is resolved by name so the
  // sheet can carry both, which is what the requested column list expects.
  const categoryId = new Map(input.categories.map((c) => [s(c.name), c.id]));

  const imagesByProduct = groupBy(input.images, (r) => r.product_id);
  const variantsByProduct = groupBy(input.variants, (r) => r.parent_product_id);
  const listingsByProduct = groupBy(input.listings, (r) => r.product_id);
  const productById = new Map(input.products.map((p) => [p.id, p]));

  const products: string[][] = [PRODUCTS_HEADER.slice()];
  for (const p of input.products) {
    const imgs = imagesByProduct.get(p.id) ?? [];
    const vars = variantsByProduct.get(p.id) ?? [];
    const listings = listingsByProduct.get(p.id);

    const sn = pickListing(listings, SNOONU_KEY);
    const sh = pickListing(listings, SHOPIFY_KEY);
    const rf = pickListing(listings, RAFEEQ_KEY);
    const ps = pickListing(listings, PURE_SEOUL_KEY);

    products.push([
      s(p.id), s(p.sku), s(p.barcode), s(p.name_en), s(p.name_ar), s(p.description_en), s(p.description_ar),
      brandName.get(s(p.brand_id)) ?? "", s(p.brand_id),
      s(p.main_category), s(categoryId.get(s(p.main_category))),
      s(p.sub_category), s(categoryId.get(s(p.sub_category))),
      s(p.price), s(p.discount_price), s(p.cost), "QAR",
      s(p.lifecycle_state), s(p.approval), s(p.rejection_reason), s(p.stock_status), s(p.stock_quantity),
      s(p.product_type), s(p.color), s(p.size), s(p.keywords_en), s(p.keywords_ar),
      s(p.is_featured), s(p.is_promoted), s(p.has_buy1get1), s(p.notes),
      s(p.created_at), s(p.updated_at),
      s(p.image_url), s(p.image_filename), s(imgs.length),
      vars.length > 0 ? "TRUE" : "FALSE", s(vars.length),
      s(sn?.external_product_id), s(sn?.id), s(sn ? s(sn.mapping_status) === "active" : ""),
      s(sn?.exported_sku), s(sn?.exported_barcode), s(p.snoonu_id),
      s(sh?.external_product_id), shopifyNumericId(sh?.external_product_id), s(sh?.id),
      s(sh ? s(sh.mapping_status) === "active" : ""),
      s(p.rafeeq_product_id), s(rf?.external_product_id), s(rf?.id),
      s(rf ? s(rf.mapping_status) === "active" : ""),
      s(ps?.external_product_id), s(ps?.id), s(ps ? s(ps.mapping_status) === "active" : ""),
      s(p.pure_seoul_id), s(p.pure_seoul_status),
      s(p.platform_status),
    ]);
  }

  const images: string[][] = [IMAGES_HEADER.slice()];
  for (const i of input.images) {
    const p = productById.get(i.product_id);
    const productPrimary = s(p?.image_url);
    images.push([
      s(i.id), s(i.product_id), s(p?.sku), s(p?.name_en), s(p?.name_ar),
      s(i.url), s(i.filename), s(i.is_primary), s(i.sort_order), s(i.created_at),
      productPrimary,
      productPrimary === "" && s(i.url) === "" ? "" : s(productPrimary === s(i.url)),
      "", "", "", "", "", "",
    ]);
  }

  const variants: string[][] = [VARIANTS_HEADER.slice()];
  for (const v of input.variants) {
    const p = productById.get(v.parent_product_id);
    // This schema models options as dedicated `color` / `size` columns rather
    // than generic option1/option2 pairs; they are mapped onto the requested
    // option columns so the sheet shape stays stable for downstream tooling.
    variants.push([
      s(v.id), s(v.parent_product_id), s(p?.sku), s(p?.name_en),
      s(v.sku), s(v.barcode), s(v.variant_name), s(v.variant_name_en),
      s(v.color) === "" ? "" : "color", s(v.color),
      s(v.size) === "" ? "" : "size", s(v.size),
      s(v.price), s(v.stock_quantity), s(v.stock_status), s(v.created_at),
    ]);
  }

  const listings: string[][] = [LISTINGS_HEADER.slice()];
  for (const l of input.listings) {
    const p = productById.get(l.product_id);
    listings.push([
      s(l.id), s(l.product_id), s(p?.sku), s(p?.name_en),
      s(l.channel_key), s(l.storefront_key), s(l.external_product_id),
      shopifyNumericId(l.external_product_id), s(l.external_variant_id),
      s(l.identity_type), s(l.exported_sku), s(l.exported_barcode),
      s(l.variant_id), s(l.variant_sku),
      s(s(l.mapping_status) === "active"), s(l.mapping_status),
      s(l.metadata), s(l.created_at), s(l.updated_at),
    ]);
  }

  return { products, images, variants, listings };
}

/** `malikas-full-catalog-YYYY-MM-DD-HHmm.xlsx` in the given date's UTC time. */
export function fullCatalogFilename(now: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp =
    `${now.getUTCFullYear()}-${p(now.getUTCMonth() + 1)}-${p(now.getUTCDate())}` +
    `-${p(now.getUTCHours())}${p(now.getUTCMinutes())}`;
  return `malikas-full-catalog-${stamp}.xlsx`;
}

/** Readable column widths, capped so a long description cannot blow the sheet. */
export function columnWidths(rows: readonly string[][], max = 46): { wch: number }[] {
  const header = rows[0] ?? [];
  return header.map((_, col) => {
    let w = 10;
    for (const row of rows) w = Math.max(w, Math.min((row[col] ?? "").length + 2, max));
    return { wch: w };
  });
}
