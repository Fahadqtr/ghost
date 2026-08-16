import "server-only";
// OPS.2 — Media Center reader (SERVER-ONLY, READ-ONLY).
//
// One read-only aggregation for the Media Center dashboard: it pages `products`
// (primary image metadata) and `product_images` (gallery), then hands the rows to
// the PURE media-core composer. It performs NO writes and issues only
// select/eq/order/range (the client surface below cannot mutate). Recovery and
// upload are NOT here — they are delegated to the existing CH.6B recovery
// orchestrator and the media-actions upload boundary by the server actions.

import { createClient } from "@/lib/supabase/server";
import { isSignedIn } from "@/lib/auth/requireUser";
import { safeError } from "@/lib/security/safe-error";
import {
  buildMediaDashboard,
  buildMissingQueue,
  detectDuplicates,
  duplicateProductIds,
  computeMediaHealth,
  type MediaProductRow,
  type GalleryImageRow,
  type MediaDashboard,
  type DuplicateGroup,
  type MissingImageItem,
} from "./media-core.ts";

const NOT_SIGNED_IN = "غير مسجّل الدخول.";
const LOAD_FAILED = "تعذّر تحميل مركز الوسائط.";
const PAGE = 1000;
const PRODUCT_CAP = 30000;
const GALLERY_CAP = 60000;

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v : null);

interface QueryResult { data: unknown[] | null; error: unknown | null }
interface Ordered extends PromiseLike<QueryResult> { range(a: number, b: number): PromiseLike<QueryResult> }
interface Select { select(cols: string): { order(c: string, o: { ascending: boolean }): Ordered } }
interface ReadClient { from(table: string): Select }

async function pageAll(client: ReadClient, table: string, cols: string, cap: number): Promise<{ rows: Record<string, unknown>[]; degraded: boolean }> {
  const rows: Record<string, unknown>[] = [];
  for (let from = 0; from < cap; from += PAGE) {
    const { data, error } = await client.from(table).select(cols).order("id", { ascending: true }).range(from, from + PAGE - 1);
    if (error) return { rows, degraded: true };
    const page = (data ?? []) as Record<string, unknown>[];
    for (const r of page) rows.push(r);
    if (page.length < PAGE) break;
  }
  return { rows, degraded: false };
}

export interface MediaCenterView {
  dashboard: MediaDashboard;
  products: (MediaProductRow & { isDuplicate: boolean; healthScore: number })[];
  missing: MissingImageItem[];
  duplicates: DuplicateGroup[];
  degraded: boolean;
}

export async function loadMediaCenter(): Promise<MediaCenterView | { error: string }> {
  if (!(await isSignedIn())) return { error: NOT_SIGNED_IN };
  try {
    const client = createClient() as unknown as ReadClient;
    const prod = await pageAll(client, "products", "id, sku, name_en, name_ar, brand_id, main_category, image_url, image_filename", PRODUCT_CAP);
    const gal = await pageAll(client, "product_images", "id, product_id, url, filename", GALLERY_CAP);

    const galleryCount = new Map<string, number>();
    const gallery: GalleryImageRow[] = [];
    for (const g of gal.rows) {
      const pid = str(g.product_id);
      if (!pid) continue;
      galleryCount.set(pid, (galleryCount.get(pid) ?? 0) + 1);
      gallery.push({ productId: pid, url: str(g.url), filename: str(g.filename) });
    }

    const rows: MediaProductRow[] = [];
    for (const p of prod.rows) {
      const id = str(p.id);
      if (!id) continue;
      rows.push({
        productId: id,
        sku: str(p.sku),
        nameEn: str(p.name_en),
        nameAr: str(p.name_ar),
        brandId: str(p.brand_id),
        category: str(p.main_category),
        imageUrl: str(p.image_url),
        imageFilename: str(p.image_filename),
        galleryCount: galleryCount.get(id) ?? 0,
      });
    }

    const duplicates = detectDuplicates(rows, gallery);
    const dupIds = duplicateProductIds(duplicates);
    const dashboard = buildMediaDashboard(rows, duplicates);
    const missing = buildMissingQueue(rows);
    const products = rows.map((r) => ({ ...r, isDuplicate: dupIds.has(r.productId), healthScore: computeMediaHealth(r, dupIds.has(r.productId)).score }));

    return { dashboard, products, missing, duplicates, degraded: prod.degraded || gal.degraded };
  } catch (e) {
    return { error: safeError("ops2_media_load", e, LOAD_FAILED) };
  }
}
