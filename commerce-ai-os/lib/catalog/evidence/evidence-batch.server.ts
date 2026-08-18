import "server-only";
// CAT.1B/CAT.1C — Catalog evidence batch read (SERVER-ONLY, READ-ONLY).
//
// The SINGLE bounded catalog scan that projects every product's CAT.1A health
// into canonical CAT.1B Evidence. Defined ONCE here so both the Operations
// evidence overview (CAT.1B) and the Action Center evidence projection (CAT.1C)
// share one read — no duplicate scans. ONE bounded products read (no N+1);
// per-product ECL / channel / inventory are UNKNOWN in batch (the per-product
// page shows the full picture). NO writes, no persistence.

import { createClient } from "@/lib/supabase/server";
import { isSignedIn } from "@/lib/auth/requireUser";
import { computeCatalogHealth } from "../health/health-engine.ts";
import type { CatalogHealthInput } from "../health/health-model.ts";
import { buildEvidenceFromHealth, type EvidenceResult } from "./evidence-engine.ts";

const MAX_ROWS = 5000;
const PAGE = 1000;

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

interface ReadClient {
  from(table: string): { select(cols: string): { order(c: string, o: { ascending: boolean }): { range(a: number, b: number): PromiseLike<{ data: Record<string, unknown>[] | null; error: unknown }> } } };
}

export interface EvidenceBatch {
  /** per-product evidence results (ordered, deduped inside each). */
  results: EvidenceResult[];
  /** productId → display label (name/sku) for read-only rendering. */
  labels: Record<string, string>;
  /** number of product rows scanned (bounded). */
  scannedProducts: number;
}

/**
 * Bounded, read-only catalog evidence batch. Null when unauthenticated or on a
 * read failure. At most MAX_ROWS/PAGE = 5 paged reads. Pure compute per row.
 */
export async function loadCatalogEvidenceBatch(): Promise<EvidenceBatch | null> {
  if (!(await isSignedIn())) return null;
  const sb = createClient() as unknown as ReadClient;
  const observedAt = new Date().toISOString();

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

  const labels: Record<string, string> = {};
  const results = rows.map((p) => {
    const productId = str(p.id) ?? "";
    const label = str(p.name_ar) ?? str(p.name_en) ?? str(p.sku) ?? productId;
    if (productId) labels[productId] = label;
    const input: CatalogHealthInput = {
      productId,
      sku: str(p.sku), barcode: str(p.barcode),
      nameEn: str(p.name_en), nameAr: str(p.name_ar),
      descriptionEn: str(p.description_en), descriptionAr: str(p.description_ar),
      keywordsEn: str(p.keywords_en), keywordsAr: str(p.keywords_ar),
      brandId: str(p.brand_id), category: str(p.main_category),
      price: num(p.price), discountPrice: num(p.discount_price),
      imageUrl: str(p.image_url) ?? str(p.image_filename), imageCount: null,
      lifecycleState: str(p.lifecycle_state), platformStatus: str(p.platform_status), approval: str(p.approval),
      variantCount: 0, stockStatus: str(p.stock_status),
      inventoryTracked: null, stockQuantity: null, eclActiveCount: null, channelLinkCount: null,
    };
    return buildEvidenceFromHealth(computeCatalogHealth(input), { observedAt });
  });

  return { results, labels, scannedProducts: rows.length };
}
