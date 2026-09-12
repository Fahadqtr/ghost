// STAFF COPY PANEL — server read. SELECT ONLY.
//
// Loads exactly the fields the panel copies, plus the product's variants and
// its brand name. There is no write path in this file and no mutating client
// call anywhere in it: the panel is read-only, and the read is the enforcement.
//
// The column list is the privacy boundary. `cost`, `stock_quantity`, `notes`,
// `keywords_*` and every platform/mapping column are NOT selected, so they
// cannot be projected, copied, or zipped even by mistake later.

import type { CopyPanelProduct, CopyPanelVariant } from "./copy-panel.ts";

/** Marketplace-ready product fields only. No cost/stock/notes/platform columns. */
const PRODUCT_COLUMNS =
  "id, sku, barcode, name_en, name_ar, price, discount_price, main_category, sub_category, size, color, description_en, description_ar, brand_id";

/** Catalog-safe variant fields only. */
const VARIANT_COLUMNS = "id, parent_product_id, variant_name, variant_name_en, sku, barcode, price, color, size, image_url";

const VARIANT_LIMIT = 500;
const MAX_ID_LENGTH = 200;

export interface CopyPanelData {
  product: CopyPanelProduct;
  variants: CopyPanelVariant[];
}

export type CopyPanelReadResult =
  | { status: "ok"; data: CopyPanelData }
  | { status: "notfound" }
  | { status: "error" };

/** The narrow slice of the Supabase client this read needs. */
export interface CopyPanelReadClient {
  from(table: string): {
    select(columns: string): {
      eq(column: string, value: string): {
        limit(n: number): PromiseLike<{ data: unknown; error: unknown }>;
      };
    };
  };
}

function s(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t === "" ? null : v;
}

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function rows(res: { data: unknown; error: unknown }): Record<string, unknown>[] | null {
  if (res.error) return null;
  return Array.isArray(res.data) ? (res.data as Record<string, unknown>[]) : [];
}

/** Pure projection of raw rows — exported so tests can exercise it without a client. */
export function toCopyPanelData(
  productRow: Record<string, unknown>,
  variantRows: readonly Record<string, unknown>[],
  brandName: string | null,
): CopyPanelData {
  const product: CopyPanelProduct = {
    sku: s(productRow.sku),
    barcode: s(productRow.barcode),
    nameEn: s(productRow.name_en),
    nameAr: s(productRow.name_ar),
    price: num(productRow.price),
    discountPrice: num(productRow.discount_price),
    category: s(productRow.main_category),
    subCategory: s(productRow.sub_category),
    brand: brandName,
    size: s(productRow.size),
    color: s(productRow.color),
    descriptionEn: s(productRow.description_en),
    descriptionAr: s(productRow.description_ar),
  };

  const variants: CopyPanelVariant[] = [];
  for (const v of variantRows) {
    if (typeof v !== "object" || v === null) continue;
    variants.push({
      id: s(v.id),
      optionNameAr: s(v.variant_name),
      optionNameEn: s(v.variant_name_en),
      sku: s(v.sku),
      barcode: s(v.barcode),
      price: num(v.price),
      color: s(v.color),
      size: s(v.size),
      imageUrl: s(v.image_url),
    });
  }

  return { product, variants };
}

/**
 * Read one product's copyable data. Isolated: any failure returns a status the
 * caller renders as an absent panel — never a raw error, id, or column name.
 */
export async function loadCopyPanelData(client: CopyPanelReadClient, id: unknown): Promise<CopyPanelReadResult> {
  if (typeof id !== "string" || id.trim() === "" || id.length > MAX_ID_LENGTH) return { status: "notfound" };

  try {
    const productRes = await client.from("products").select(PRODUCT_COLUMNS).eq("id", id).limit(1);
    const productRows = rows(productRes);
    if (productRows === null) return { status: "error" };
    const productRow = productRows[0];
    if (!productRow) return { status: "notfound" };

    const variantRes = await client.from("product_variants").select(VARIANT_COLUMNS).eq("parent_product_id", id).limit(VARIANT_LIMIT);
    const variantRows = rows(variantRes) ?? [];

    // Brand is a lookup, not a product column — a failed/absent lookup simply
    // omits the field rather than failing the panel.
    let brandName: string | null = null;
    const brandId = s(productRow.brand_id);
    if (brandId !== null) {
      const brandRes = await client.from("brands").select("id, name").eq("id", brandId).limit(1);
      const brandRows = rows(brandRes);
      brandName = brandRows && brandRows[0] ? s(brandRows[0].name) : null;
    }

    return { status: "ok", data: toCopyPanelData(productRow, variantRows, brandName) };
  } catch {
    return { status: "error" };
  }
}
