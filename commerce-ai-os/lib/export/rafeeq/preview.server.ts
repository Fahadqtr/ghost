// INT.2D — Rafeeq preview server adapter (SERVER-ONLY, read-only).
//
// Assembles the Rafeeq preview from a single bounded batch of reads (never one
// query per product): products + product_images + the ECL identity evidence
// scoped to storefront_key = "rafeeq:malikas". It writes nothing and NEVER reads
// the legacy per-store id column on products — the Rafeeq Product ID is the ECL
// external_product_id for this storefront only. Delegates all projection +
// validation to the pure buildRafeeqPreview.

import "server-only";

import { createClient } from "@/lib/supabase/server";
import { loadMasterScope } from "@/lib/home/master-scope.server";
import {
  buildRafeeqPreview,
  RAFEEQ_STOREFRONT_KEY,
  type RafeeqPreviewProduct,
  type RafeeqPreviewVariant,
  type RafeeqMappingEvidence,
  type RafeeqPreviewResult,
  rafeeqExportDiscountPrice,
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

export async function loadRafeeqPreview(): Promise<RafeeqPreviewResult | null> {
  try {
    const client = createClient();

    const [allProductRows, imageRows, variantRows, eclRows] = await Promise.all([
      readAll(client, "products",
        "id, sku, barcode, name_en, name_ar, main_category, price, discount_price, description_en, description_ar, image_url, image_filename, lifecycle_state, platform_status",
        "id"),
      readAll(client, "product_images", "product_id, url, filename, is_primary, sort_order", "product_id"),
      readAll(client, "product_variants", "id, parent_product_id, sku, barcode, variant_name, variant_name_en, price", "parent_product_id"),
      readAll(client, "external_channel_listings", "product_id, variant_id, storefront_key, exported_sku, external_product_id, mapping_status", "exported_sku").catch(() => []),
    ]);

    // CURRENT MASTER scope. The Rafeeq FULL catalogue is a replacement of the
    // CURRENT operational catalogue, so its universe is the active
    // snoonu:malikas membership — read through the SAME shared seam as /v2,
    // /v2/catalog, Launch, Export, Inventory and Operations, never a second
    // definition of the master. Products outside it stay in the database
    // untouched; they are simply not part of today's Rafeeq catalogue.
    //
    // Fails CLOSED: an unreadable membership returns null (the caller renders
    // its load error) rather than falling back to every canonical product,
    // which would ship the outside-master products to the marketplace.
    const scope = await loadMasterScope();
    if (!scope.ok) return null;
    const productRows = allProductRows.filter(
      (p) => typeof p.id === "string" && scope.ids.has(p.id),
    );

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

    // Variants grouped under their parent — projected as NATIVE OPTIONS of the
    // one parent product (never separate sellable listings).
    const variantsByProduct = new Map<string, RafeeqPreviewVariant[]>();
    for (const v of variantRows) {
      const pid = typeof v.parent_product_id === "string" ? v.parent_product_id : "";
      if (!pid) continue;
      const list = variantsByProduct.get(pid) ?? [];
      list.push({
        id: s(v.id),
        sku: s(v.sku),
        barcode: s(v.barcode),
        nameEn: s(v.variant_name_en),
        nameAr: s(v.variant_name),
        price: n(v.price),
      });
      variantsByProduct.set(pid, list);
    }

    // ECL evidence for rafeeq:malikas only, keyed by lower(exported_sku) at
    // PRODUCT grain — Rafeeq identity is the parent product (variants are
    // native options). Retired variant-grain rows (non-null variant_id) are
    // ignored here, never collapsed onto the parent identity.
    const mappingBySku: Record<string, RafeeqMappingEvidence> = {};
    for (const e of eclRows) {
      if (s(e.storefront_key) !== RAFEEQ_STOREFRONT_KEY) continue; // hard storefront scope
      if (s(e.variant_id) !== null) continue; // product-grain identity only
      const sku = s(e.exported_sku);
      if (!sku) continue;
      const ms = s(e.mapping_status);
      const status: RafeeqMappingEvidence["status"] =
        ms === "needs_review" ? "needs_review" : ms === "archived" ? "unmapped" : "resolved";
      mappingBySku[sku.toLowerCase()] = { status, externalId: s(e.external_product_id), exportedSku: sku, productId: s(e.product_id) };
    }

    const products: RafeeqPreviewProduct[] = productRows.map((p) => {
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
        price: n(p.price),
        // Snoonu-aligned pricing policy — see rafeeqExportDiscountPrice.
        discountPrice: rafeeqExportDiscountPrice(n(p.discount_price)),
        descriptionEn: s(p.description_en),
        descriptionAr: s(p.description_ar),
        imageUrl: primaryUrl,
        imageFilename: s(p.image_filename),
        galleryImageUrls,
        imageCount,
        lifecycleState: p.lifecycle_state,
        platformStatus: p.platform_status,
        variants: variantsByProduct.get(id) ?? [],
      };
    });

    return buildRafeeqPreview({ products, mappingBySku });
  } catch {
    return null;
  }
}
