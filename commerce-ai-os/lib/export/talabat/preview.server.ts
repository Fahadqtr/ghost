// INT.2B — Talabat preview server adapter (SERVER-ONLY, read-only).
//
// Assembles the Talabat sellable preview from ONE bounded batch of reads (never
// one query per variant): products + product_variants + product_images +
// talabat approval overlay + talabat:malikas ECL identity evidence. It writes
// nothing. Talabat mapping evidence is read from ECL (authoritative go-forward);
// an absent listing ⇒ unmapped (no fabricated id). Delegates all projection +
// validation to the pure buildTalabatPreview.

import "server-only";

import { createClient } from "@/lib/supabase/server";
import { isApprovedForTalabat } from "@/lib/talabat/export";
import {
  buildTalabatPreview,
  type TalabatPreviewProduct,
  type TalabatPreviewVariant,
  type TalabatMappingEvidence,
  type TalabatPreviewResult,
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

export async function loadTalabatPreview(): Promise<TalabatPreviewResult | null> {
  try {
    const client = createClient();

    const [productRows, variantRows, imageRows, approvalRows, eclRows] = await Promise.all([
      readAll(client, "products",
        "id, sku, barcode, name_en, name_ar, price, discount_price, main_category, description_en, description_ar, image_url, image_filename, lifecycle_state, platform_status",
        "id"),
      readAll(client, "product_variants", "id, parent_product_id, sku, barcode, variant_name, variant_name_en, price", "parent_product_id"),
      readAll(client, "product_images", "product_id, url, filename, is_primary, sort_order", "product_id"),
      // approval overlay (platform_status is a per-platform table; talabat rows only)
      readAll(client, "platform_status", "product_id, platform, approval", "product_id").catch(() => []),
      // Talabat identity evidence (read-only; storefront-scoped)
      readAll(client, "external_channel_listings", "exported_sku, external_product_id, mapping_status, storefront_key", "exported_sku").catch(() => []),
    ]);

    // variants by parent
    const variantsByProduct = new Map<string, TalabatPreviewVariant[]>();
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

    // Gallery images by product — ordered deterministically (is_primary first,
    // then sort_order, then url). Carries the retrievable URL so the package
    // generator can fetch the primary (+ extras for a simple product).
    interface Img { url: string | null; isPrimary: boolean; sortOrder: number }
    const imagesByProduct = new Map<string, Img[]>();
    for (const img of imageRows) {
      const pid = typeof img.product_id === "string" ? img.product_id : "";
      if (!pid) continue;
      const list = imagesByProduct.get(pid) ?? [];
      list.push({
        url: s(img.url),
        isPrimary: img.is_primary === true,
        sortOrder: n(img.sort_order) ?? 0,
      });
      imagesByProduct.set(pid, list);
    }
    const orderImages = (list: Img[]): Img[] =>
      [...list].sort((a, b) =>
        (a.isPrimary === b.isPrimary ? 0 : a.isPrimary ? -1 : 1) ||
        a.sortOrder - b.sortOrder ||
        String(a.url ?? "").localeCompare(String(b.url ?? "")));

    // talabat approval by product
    const approvedByProduct = new Map<string, boolean>();
    for (const a of approvalRows) {
      if (s(a.platform)?.toLowerCase() !== "talabat") continue;
      const pid = typeof a.product_id === "string" ? a.product_id : "";
      if (pid) approvedByProduct.set(pid, isApprovedForTalabat(s(a.approval)));
    }

    // ECL evidence by lower(exported_sku), talabat:malikas only
    const mappingBySku: Record<string, TalabatMappingEvidence> = {};
    for (const e of eclRows) {
      if (s(e.storefront_key) !== "talabat:malikas") continue;
      const sku = s(e.exported_sku);
      if (!sku) continue;
      const ms = s(e.mapping_status);
      const status: TalabatMappingEvidence["status"] =
        ms === "needs_review" ? "needs_review" : ms === "archived" ? "unmapped" : "resolved";
      mappingBySku[sku.toLowerCase()] = { status, externalId: s(e.external_product_id), exportedSku: sku };
    }

    const products: TalabatPreviewProduct[] = productRows.map((p) => {
      const id = typeof p.id === "string" ? p.id : "";
      const ordered = orderImages(imagesByProduct.get(id) ?? []);
      const rowUrls = ordered.map((im) => im.url).filter((u): u is string => u !== null);
      // Primary source URL: the flagged/ordered gallery primary, else products.image_url.
      const primaryUrl = rowUrls[0] ?? s(p.image_url);
      // Additional images = the ordered gallery minus the primary (deterministic).
      const galleryImageUrls = rowUrls.filter((u) => u !== primaryUrl);
      const hasPrimary = primaryUrl !== null || s(p.image_filename) !== null;
      const imageCount = rowUrls.length > 0 ? rowUrls.length : hasPrimary ? 1 : 0;
      return {
        id,
        sku: s(p.sku),
        barcode: s(p.barcode),
        nameEn: s(p.name_en),
        nameAr: s(p.name_ar),
        price: n(p.price),
        discountPrice: n(p.discount_price),
        category: s(p.main_category),
        descriptionEn: s(p.description_en),
        descriptionAr: s(p.description_ar),
        imageUrl: primaryUrl,
        imageFilename: s(p.image_filename),
        galleryImageUrls,
        imageCount,
        approved: approvedByProduct.get(id) ?? false,
        lifecycleState: p.lifecycle_state,
        platformStatus: p.platform_status,
        variants: variantsByProduct.get(id) ?? [],
      };
    });

    return buildTalabatPreview({ products, mappingBySku });
  } catch {
    return null;
  }
}
