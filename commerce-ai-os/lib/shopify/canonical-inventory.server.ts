import "server-only";
import type { CanonicalProductInventoryInput } from "./variant-inventory";

// Loads the canonical side of the variant-grain inventory identity — the
// products, their `product_variants`, and their shopify:malikas ECL rows — in a
// shape the pure planner can consume. READ-ONLY: this module issues SELECTs
// only, and never writes to Supabase or Shopify.
//
// `parentStatus` is deliberately left undefined here: the DB does not store the
// live Shopify status, and we do not spend a Shopify round-trip to learn it at
// plan time. An ARCHIVED mapped parent is still refused — the write-time
// resolver (`resolveInventoryItemIdByVariantGid`) rejects it per variant, so
// the product blocks all-or-nothing exactly as it would have at plan time.

const SHOPIFY_STOREFRONT_KEY = "shopify:malikas";

interface ProductRow { id: string; sku: string | null; name_en: string | null }
interface VariantRow { id: string; parent_product_id: string; sku: string | null; stock_quantity: number | null }
interface ListingRow {
  product_id: string;
  variant_id: string | null;
  variant_sku: string | null;
  external_product_id: string | null;
  external_variant_id: string | null;
}

async function pageAll<T>(fetchPage: (from: number, to: number) => any): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await fetchPage(from, from + 999);
    if (error) throw new Error(error.message);
    out.push(...((data ?? []) as T[]));
    if ((data ?? []).length < 1000) break;
  }
  return out;
}

/** Build planner inputs for the given canonical product ids. */
export async function loadCanonicalInventoryInputs(
  sb: any,
  productIds: readonly string[],
): Promise<CanonicalProductInventoryInput[]> {
  const ids = [...new Set((productIds ?? []).filter(Boolean))];
  if (ids.length === 0) return [];

  const { data: prodData, error: prodErr } = await sb
    .from("products").select("id, sku, name_en").in("id", ids);
  if (prodErr) throw new Error(prodErr.message);
  const products = (prodData ?? []) as ProductRow[];
  if (products.length === 0) return [];

  const { data: varData, error: varErr } = await sb
    .from("product_variants").select("id, parent_product_id, sku, stock_quantity").in("parent_product_id", ids);
  if (varErr) throw new Error(varErr.message);

  const { data: eclData, error: eclErr } = await sb
    .from("external_channel_listings")
    .select("product_id, variant_id, variant_sku, external_product_id, external_variant_id")
    .eq("storefront_key", SHOPIFY_STOREFRONT_KEY)
    .in("product_id", ids);
  if (eclErr) throw new Error(eclErr.message);

  return assemble(products, (varData ?? []) as VariantRow[], (eclData ?? []) as ListingRow[]);
}

/**
 * Whole-catalog variant + listing load, for the nightly flow that already scans
 * every product. Avoids an `.in()` list of ~1500 ids.
 */
export async function loadAllCanonicalInventoryInputs(
  sb: any,
  products: readonly { id: string; sku: string | null; name_en: string | null }[],
): Promise<CanonicalProductInventoryInput[]> {
  const variants = await pageAll<VariantRow>((from, to) =>
    sb.from("product_variants").select("id, parent_product_id, sku, stock_quantity").range(from, to));
  const listings = await pageAll<ListingRow>((from, to) =>
    sb.from("external_channel_listings")
      .select("product_id, variant_id, variant_sku, external_product_id, external_variant_id")
      .eq("storefront_key", SHOPIFY_STOREFRONT_KEY).range(from, to));
  return assemble(products as ProductRow[], variants, listings);
}

function assemble(
  products: readonly ProductRow[],
  variants: readonly VariantRow[],
  listings: readonly ListingRow[],
): CanonicalProductInventoryInput[] {
  const varsByProduct = new Map<string, VariantRow[]>();
  for (const v of variants) {
    if (!v?.parent_product_id) continue;
    const b = varsByProduct.get(v.parent_product_id);
    if (b) b.push(v); else varsByProduct.set(v.parent_product_id, [v]);
  }
  const listByProduct = new Map<string, ListingRow[]>();
  for (const l of listings) {
    if (!l?.product_id) continue;
    const b = listByProduct.get(l.product_id);
    if (b) b.push(l); else listByProduct.set(l.product_id, [l]);
  }

  return products.map((p) => ({
    productId: p.id,
    sku: p.sku,
    nameEn: p.name_en,
    variants: (varsByProduct.get(p.id) ?? []).map((v) => ({
      id: v.id, sku: v.sku, stockQuantity: v.stock_quantity,
    })),
    listings: (listByProduct.get(p.id) ?? []).map((l) => ({
      variantId: l.variant_id,
      variantSku: l.variant_sku,
      externalProductId: l.external_product_id,
      externalVariantId: l.external_variant_id,
    })),
  }));
}
