// INT.2C — Snoonu preview server adapter (SERVER-ONLY, read-only).
//
// Assembles ONE Snoonu storefront's preview from a single bounded batch of reads
// (never one query per product): products + product_images + the ECL identity
// evidence scoped to THIS storefront_key. It writes nothing and NEVER reads the
// legacy per-store identity columns on products — the Snoonu SPI is the ECL
// external_product_id for this storefront only, so Malikas and Pure Seoul stay
// fully isolated. Delegates all projection + validation to the pure
// buildSnoonuPreview.

import "server-only";

import { createClient } from "@/lib/supabase/server";
import { buildChannelIdentityIndex } from "@/lib/channels/effective-sku";
import {
  buildSnoonuPreview,
  type SnoonuStorefrontKey,
  type SnoonuPreviewProduct,
  type SnoonuMappingEvidence,
  type SnoonuPreviewResult,
} from "./preview.ts";

const PAGE = 1000;
const MAX = 20000;

type Client = ReturnType<typeof createClient>;

async function readAll(client: Client, table: string, columns: string, orderCol: string): Promise<Record<string, unknown>[]> {
  const rows: Record<string, unknown>[] = [];
  for (let from = 0; from < MAX; from += PAGE) {
    const { data, error } = await client.from(table).select(columns).order(orderCol, { ascending: true }).range(from, from + PAGE - 1);
    if (error) throw error;
    if (!Array.isArray(data) || data.length === 0) break;
    rows.push(...(data as unknown as Record<string, unknown>[]));
    if (data.length < PAGE) break;
  }
  return rows;
}

const s = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v : null);
const n = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

export async function loadSnoonuPreview(storefrontKey: SnoonuStorefrontKey): Promise<SnoonuPreviewResult | null> {
  try {
    const client = createClient();

    const [productRows, imageRows, eclRows] = await Promise.all([
      readAll(client, "products",
        "id, sku, barcode, name_en, name_ar, main_category, sub_category, price, discount_price, description_en, description_ar, keywords_en, keywords_ar, image_url, image_filename, lifecycle_state, platform_status",
        "id"),
      readAll(client, "product_images", "product_id, url, filename, is_primary, sort_order", "product_id"),
      // Storefront-scoped ECL identity evidence (read-only). Filtered to THIS
      // storefront_key so Malikas and Pure Seoul SPIs never cross.
      readAll(client, "external_channel_listings", "product_id, variant_id, storefront_key, exported_sku, external_product_id, mapping_status", "product_id").catch(() => []),
    ]);

    // Gallery images by product — deterministic order (is_primary, sort_order, url).
    interface Img { url: string | null; isPrimary: boolean; sortOrder: number }
    const imagesByProduct = new Map<string, Img[]>();
    for (const img of imageRows) {
      const pid = typeof img.product_id === "string" ? img.product_id : "";
      if (!pid) continue;
      const list = imagesByProduct.get(pid) ?? [];
      list.push({ url: s(img.url), isPrimary: img.is_primary === true, sortOrder: n(img.sort_order) ?? 0 });
      imagesByProduct.set(pid, list);
    }
    const orderImages = (list: Img[]): Img[] =>
      [...list].sort((a, b) =>
        (a.isPrimary === b.isPrimary ? 0 : a.isPrimary ? -1 : 1) ||
        a.sortOrder - b.sortOrder ||
        String(a.url ?? "").localeCompare(String(b.url ?? "")));

    // ECL evidence for THIS storefront only, keyed by lower(exported_sku).
    // Shared identity rule — see lib/channels/effective-sku. exported_sku is NULL
    // for every snoonu:malikas and snoonu:pure_seoul row in production, so before
    // this the index was empty and every mapped product looked new.
    const canonicalSkuByProduct = new Map<string, string>();
    for (const p of productRows) {
      const id = s(p.id); const sku = s(p.sku);
      if (id && sku) canonicalSkuByProduct.set(id, sku);
    }
    const snoonuIdentity = buildChannelIdentityIndex<SnoonuMappingEvidence>({
      rows: eclRows,
      storefrontKey,
      canonicalSkuForRow: (e) => canonicalSkuByProduct.get(s(e.product_id) ?? "") ?? null,
      toEvidence: (e, r) => {
        const ms = s(e.mapping_status);
        const status: SnoonuMappingEvidence["status"] = r.contested
          ? "needs_review"
          : ms === "needs_review" ? "needs_review" : ms === "archived" ? "unmapped" : "resolved";
        return { status, externalId: s(e.external_product_id), exportedSku: r.sku, productId: s(e.product_id) };
      },
    });
    const mappingBySku = snoonuIdentity.index;

    const products: SnoonuPreviewProduct[] = productRows.map((p) => {
      const id = typeof p.id === "string" ? p.id : "";
      const ordered = orderImages(imagesByProduct.get(id) ?? []);
      const rowUrls = ordered.map((im) => im.url).filter((u): u is string => u !== null);
      const primaryUrl = rowUrls[0] ?? s(p.image_url);
      const galleryImageUrls = rowUrls.filter((u) => u !== primaryUrl);
      const hasPrimary = primaryUrl !== null || s(p.image_filename) !== null;
      const imageCount = rowUrls.length > 0 ? rowUrls.length : hasPrimary ? 1 : 0;
      return {
        id,
        sku: s(p.sku),
        barcode: s(p.barcode),
        nameEn: s(p.name_en),
        nameAr: s(p.name_ar),
        category: s(p.main_category),
        subCategory: s(p.sub_category),
        price: n(p.price),
        discountPrice: n(p.discount_price),
        descriptionEn: s(p.description_en),
        descriptionAr: s(p.description_ar),
        keywordsEn: s(p.keywords_en),
        keywordsAr: s(p.keywords_ar),
        imageUrl: primaryUrl,
        imageFilename: s(p.image_filename),
        galleryImageUrls,
        imageCount,
        lifecycleState: p.lifecycle_state,
        platformStatus: p.platform_status,
      };
    });

    return buildSnoonuPreview({ storefrontKey, products, mappingBySku });
  } catch {
    return null;
  }
}
