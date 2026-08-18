import "server-only";
// CAT.1A — Catalog Health read API (SERVER-ONLY, READ-ONLY).
//
// The single certified entry point: loadCatalogHealth(productId) → CatalogHealth.
// It assembles the pure engine's input from bounded, read-only queries and calls
// computeCatalogHealth. It NEVER writes: no product / inventory / availability /
// lifecycle / ECL / channel mutation, no schema, no migration, no AI. Signed-in
// read (same posture as the other Operations read models). Missing signals are
// passed as null → the engine reports UNKNOWN, never a fabricated verdict.

import { createClient } from "@/lib/supabase/server";
import { isSignedIn } from "@/lib/auth/requireUser";
import { computeCatalogHealth } from "./health-engine.ts";
import type { CatalogHealth, CatalogHealthInput } from "./health-model.ts";

interface ReadClient {
  from(table: string): {
    select(cols: string, opts?: { count?: "exact"; head?: boolean }): {
      eq(c: string, v: string): {
        eq(c: string, v: string): PromiseLike<{ count: number | null; error: unknown }>;
        maybeSingle(): PromiseLike<{ data: Record<string, unknown> | null; error: unknown }>;
      } & PromiseLike<{ count: number | null; error: unknown }>;
    };
  };
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/**
 * Load the certified health for one product. Returns null when unauthenticated
 * or the product does not exist. Read-only.
 */
export async function loadCatalogHealth(productId: string): Promise<CatalogHealth | null> {
  if (!str(productId)) return null;
  if (!(await isSignedIn())) return null;
  const sb = createClient() as unknown as ReadClient;

  const { data: p } = await sb.from("products")
    .select("id, sku, barcode, name_en, name_ar, description_en, description_ar, keywords_en, keywords_ar, brand_id, main_category, price, discount_price, image_url, image_filename, lifecycle_state, platform_status, approval, stock_status")
    .eq("id", productId).maybeSingle();
  if (!p) return null;

  // Bounded, read-only aggregate counts (head:true → no rows returned).
  const variantCount = await countRows(sb, "product_variants", "parent_product_id", productId);
  const eclActiveCount = await countRowsFiltered(sb, "external_channel_listings", "product_id", productId, "mapping_status", "active");
  const channelLinkCount = await countRows(sb, "channel_products", "product_id", productId);

  const input: CatalogHealthInput = {
    productId: str(p.id) ?? productId,
    sku: str(p.sku), barcode: str(p.barcode),
    nameEn: str(p.name_en), nameAr: str(p.name_ar),
    descriptionEn: str(p.description_en), descriptionAr: str(p.description_ar),
    keywordsEn: str(p.keywords_en), keywordsAr: str(p.keywords_ar),
    brandId: str(p.brand_id), category: str(p.main_category),
    price: num(p.price), discountPrice: num(p.discount_price),
    imageUrl: str(p.image_url) ?? str(p.image_filename),
    imageCount: null, // media count not read here → UNKNOWN-safe (rule uses imageUrl)
    lifecycleState: str(p.lifecycle_state), platformStatus: str(p.platform_status), approval: str(p.approval),
    variantCount: variantCount ?? 0,
    stockStatus: str(p.stock_status),
    inventoryTracked: null, stockQuantity: null, // product-level inventory not read → UNKNOWN
    eclActiveCount,
    channelLinkCount,
  };

  return computeCatalogHealth(input);
}

async function countRows(sb: ReadClient, table: string, col: string, val: string): Promise<number | null> {
  try {
    const { count, error } = await sb.from(table).select("id", { count: "exact", head: true }).eq(col, val);
    return error ? null : (count ?? 0);
  } catch { return null; }
}

async function countRowsFiltered(sb: ReadClient, table: string, col: string, val: string, col2: string, val2: string): Promise<number | null> {
  try {
    const { count, error } = await sb.from(table).select("id", { count: "exact", head: true }).eq(col, val).eq(col2, val2);
    return error ? null : (count ?? 0);
  } catch { return null; }
}
