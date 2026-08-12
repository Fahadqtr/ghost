// Server-only read layer for the V2 product editor (Phase UI.4).
//
// Loads ONE product with every column the shared save path (product-save.ts)
// writes, plus its variants and the brand list for the brand <select>. The
// client is INJECTED (the page passes the session-scoped Supabase client), so
// this module creates no client, uses no service role, and node:test can load
// it directly with a fake. Whitelisted columns only — never `select("*")`.
//
// Failure contract mirrors lib/catalog-v2/master-catalog-read.ts: a
// discriminated union, never a thrown raw error and never raw database text.

import "server-only";

import type { ProductInput, VariantInput } from "./product-save";

// Every scalar column of ProductInput, by name. The edit form must round-trip
// ALL of them (visible or not): the save path writes the full row, so a field
// missing from the payload would be nulled out in the database.
const PRODUCT_EDIT_COLUMNS =
  "id, sku, barcode, name_en, name_ar, brand_id, main_category, sub_category, product_type, color, size, price, discount_price, cost, stock_quantity, stock_status, platform_status, approval, rejection_reason, image_filename, image_url, description_en, description_ar, keywords_en, keywords_ar, notes";

const VARIANT_EDIT_COLUMNS =
  "id, parent_product_id, variant_name, variant_name_en, sku, barcode, color, size, price, stock_quantity";

// Same guard as the detail read: a product with a pathological variant count
// still renders/edits its first rows instead of hanging the page.
const VARIANT_EDIT_CAP = 500;

interface EditReadClient {
  from(table: string): {
    select(columns: string): {
      filter(
        column: string,
        operator: string,
        value: string,
      ): {
        limit(count: number): {
          order(
            column: string,
            opts: { ascending: boolean },
          ): PromiseLike<{ data: unknown[] | null; error: unknown }>;
        };
        maybeSingle(): PromiseLike<{ data: Record<string, unknown> | null; error: unknown }>;
      };
      order(
        column: string,
        opts: { ascending: boolean },
      ): PromiseLike<{ data: unknown[] | null; error: unknown }>;
    };
  };
}

/** A variant row as the edit form needs it: string fields + the durable id. */
export interface EditableVariant extends VariantInput {
  id: string;
}

export interface ProductEditInitial
  extends Omit<ProductInput, "variants" | "original_sku" | "original_barcode"> {
  variants: EditableVariant[];
}

export interface EditBrand {
  id: string;
  name: string;
}

export type ProductEditReadResult =
  | { status: "ok"; initial: ProductEditInitial; brands: EditBrand[] }
  | { status: "notfound" }
  | { status: "error" };

/** Nullable DB value -> the string-based form shape ("" for null/undefined). */
function s(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return "";
}

/**
 * Pure projection of raw rows into the form's initial state. Exported for
 * direct unit tests. Variant ids are kept VERBATIM — they are the durable
 * identity the whole phase exists to preserve. A variant row without a string
 * id is dropped (it cannot be safely round-tripped through the diff).
 */
export function toEditInitial(
  productRow: Record<string, unknown>,
  variantRows: readonly Record<string, unknown>[],
): ProductEditInitial {
  const variants: EditableVariant[] = [];
  for (const v of variantRows) {
    const id = v.id;
    if (typeof id !== "string" || id.length === 0) continue;
    variants.push({
      id,
      variant_name: s(v.variant_name),
      variant_name_en: s(v.variant_name_en),
      sku: s(v.sku),
      barcode: s(v.barcode),
      color: s(v.color),
      size: s(v.size),
      price: s(v.price),
      stock_quantity: s(v.stock_quantity),
    });
  }
  return {
    sku: s(productRow.sku),
    barcode: s(productRow.barcode),
    name_en: s(productRow.name_en),
    name_ar: s(productRow.name_ar),
    brand_id: s(productRow.brand_id),
    main_category: s(productRow.main_category),
    sub_category: s(productRow.sub_category),
    product_type: s(productRow.product_type),
    color: s(productRow.color),
    size: s(productRow.size),
    price: s(productRow.price),
    discount_price: s(productRow.discount_price),
    cost: s(productRow.cost),
    stock_quantity: s(productRow.stock_quantity),
    stock_status: s(productRow.stock_status),
    platform_status: s(productRow.platform_status),
    approval: s(productRow.approval),
    rejection_reason: s(productRow.rejection_reason),
    image_filename: s(productRow.image_filename),
    image_url: s(productRow.image_url),
    description_en: s(productRow.description_en),
    description_ar: s(productRow.description_ar),
    keywords_en: s(productRow.keywords_en),
    keywords_ar: s(productRow.keywords_ar),
    notes: s(productRow.notes),
    variants,
  };
}

/** Brand rows -> the select options; malformed rows are dropped, never thrown. */
export function toEditBrands(rows: readonly unknown[]): EditBrand[] {
  const out: EditBrand[] = [];
  for (const r of rows) {
    if (typeof r !== "object" || r === null) continue;
    const { id, name } = r as { id?: unknown; name?: unknown };
    if (typeof id !== "string" || id.length === 0) continue;
    if (typeof name !== "string" || name.length === 0) continue;
    out.push({ id, name });
  }
  return out;
}

/**
 * Load one product for editing. `status: "error"` on any read failure —
 * the page renders one fixed Arabic message and never the raw error.
 */
export async function loadProductForEdit(
  client: EditReadClient,
  productId: string,
): Promise<ProductEditReadResult> {
  try {
    const { data: productRow, error: productErr } = await client
      .from("products")
      .select(PRODUCT_EDIT_COLUMNS)
      .filter("id", "eq", productId)
      .maybeSingle();
    if (productErr) return { status: "error" };
    if (!productRow) return { status: "notfound" };

    const { data: variantRows, error: variantErr } = await client
      .from("product_variants")
      .select(VARIANT_EDIT_COLUMNS)
      .filter("parent_product_id", "eq", productId)
      .limit(VARIANT_EDIT_CAP)
      .order("id", { ascending: true });
    if (variantErr) return { status: "error" };

    // Brand list is auxiliary: a failure degrades to an empty select rather
    // than blocking the whole edit page.
    let brands: EditBrand[] = [];
    try {
      const { data: brandRows, error: brandErr } = await client
        .from("brands")
        .select("id, name")
        .order("name", { ascending: true });
      if (!brandErr) brands = toEditBrands(brandRows ?? []);
    } catch {
      brands = [];
    }

    return {
      status: "ok",
      initial: toEditInitial(
        productRow,
        (variantRows ?? []).filter(
          (r): r is Record<string, unknown> => typeof r === "object" && r !== null,
        ),
      ),
      brands,
    };
  } catch {
    return { status: "error" };
  }
}
