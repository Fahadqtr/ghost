import "server-only";
// CAT.1A — Catalog Health distribution reader (SERVER-ONLY, READ-ONLY).
//
// Computes the overall grade distribution across the catalog for the Operations
// read-only panel. ONE bounded products read (no N+1) — so the batch evaluates
// the catalog-CONTENT domains (images/desc/keywords/barcode/sku/brand/category/
// price/lifecycle/availability/ai/export). Per-product ECL / channel / inventory
// signals are NOT batch-read here and are passed as null → those domains report
// UNKNOWN and never penalize the batch score (the per-product page shows the full
// picture, including ECL/channel). NEVER writes anything.

import { createClient } from "@/lib/supabase/server";
import { isSignedIn } from "@/lib/auth/requireUser";
import { computeCatalogHealth, computeHealthDistribution, type HealthDistribution } from "./health-engine.ts";
import type { CatalogHealthInput } from "./health-model.ts";

const MAX_ROWS = 5000; // bounded scan
const PAGE = 1000;

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

interface ReadClient {
  from(table: string): { select(cols: string): { order(c: string, o: { ascending: boolean }): { range(a: number, b: number): PromiseLike<{ data: Record<string, unknown>[] | null; error: unknown }> } } };
}

/** Bounded, read-only catalog-content health distribution. Null when unauthenticated. */
export async function loadCatalogHealthDistribution(): Promise<HealthDistribution | null> {
  if (!(await isSignedIn())) return null;
  const sb = createClient() as unknown as ReadClient;

  const rows: Record<string, unknown>[] = [];
  try {
    for (let from = 0; from < MAX_ROWS; from += PAGE) {
      const { data, error } = await sb.from("products")
        .select("id, sku, barcode, name_en, name_ar, description_en, description_ar, keywords_en, keywords_ar, brand_id, main_category, price, discount_price, image_url, image_filename, lifecycle_state, platform_status, approval, stock_status")
        .order("id", { ascending: true }).range(from, from + PAGE - 1);
      if (error || !Array.isArray(data)) break;
      rows.push(...data);
      if (data.length < PAGE) break;
    }
  } catch {
    return null;
  }

  const healths = rows.map((p) => {
    const input: CatalogHealthInput = {
      productId: str(p.id) ?? "",
      sku: str(p.sku), barcode: str(p.barcode),
      nameEn: str(p.name_en), nameAr: str(p.name_ar),
      descriptionEn: str(p.description_en), descriptionAr: str(p.description_ar),
      keywordsEn: str(p.keywords_en), keywordsAr: str(p.keywords_ar),
      brandId: str(p.brand_id), category: str(p.main_category),
      price: num(p.price), discountPrice: num(p.discount_price),
      imageUrl: str(p.image_url) ?? str(p.image_filename),
      imageCount: null,
      lifecycleState: str(p.lifecycle_state), platformStatus: str(p.platform_status), approval: str(p.approval),
      variantCount: 0,
      stockStatus: str(p.stock_status),
      inventoryTracked: null, stockQuantity: null,
      eclActiveCount: null, channelLinkCount: null, // not batch-read → UNKNOWN
    };
    return computeCatalogHealth(input);
  });

  return computeHealthDistribution(healths);
}
