// INT.2E — Shopify preview server adapter (SERVER-ONLY, READ-ONLY).
//
// Assembles the Shopify validation + publish preview from:
//   • ONE bounded batch of internal reads (products + product_images +
//     product_variants + the ECL identity evidence scoped to shopify:malikas), and
//   • ONE live Shopify read (fetchAllShopifyProducts — the canonical paginated
//     Admin read boundary; batched 100/page, never one request per variant, §14).
//
// It writes NOTHING (no Shopify mutation, no ECL/catalog/inventory/availability/
// lifecycle write) and NEVER reads a legacy per-store id column — the Shopify GID
// is the ECL external_product_id/external_variant_id for this storefront only.
// When Shopify is unconfigured or the live read fails, `live` is passed as null so
// every row is honestly UNKNOWN (no diff is invented). All projection, validation,
// diffing and plan derivation are delegated to the pure buildShopifyPreview.

import "server-only";

import { createClient } from "@/lib/supabase/server";
import { fetchAllShopifyProducts, shopifyConfigured } from "@/lib/shopify/admin";
import {
  buildShopifyPreview,
  SHOPIFY_STOREFRONT_KEY,
  type ShopifyInternalProduct,
  type ShopifyInternalVariant,
  type ShopifyIdentityEvidence,
  type ShopifyLiveProduct,
  type ShopifyPreviewResult,
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

export async function loadShopifyPreview(): Promise<ShopifyPreviewResult | null> {
  try {
    const client = createClient();

    // ── Internal batch (bounded) + the single live Shopify read, together. ──────
    const internalReads = Promise.all([
      readAll(client, "products",
        "id, sku, barcode, name_en, name_ar, description_en, description_ar, price, discount_price, image_url, image_filename, lifecycle_state, platform_status",
        "id"),
      readAll(client, "product_images", "product_id, url, is_primary, sort_order", "product_id"),
      readAll(client, "product_variants", "id, parent_product_id, variant_name, sku, barcode, price", "parent_product_id"),
      readAll(client, "external_channel_listings",
        "product_id, variant_id, storefront_key, external_product_id, external_variant_id, mapping_status", "product_id").catch(() => []),
    ]);

    const liveRead = (async (): Promise<readonly ShopifyLiveProduct[] | null> => {
      if (!shopifyConfigured()) return null; // unconfigured ⇒ UNKNOWN, never faked
      const { products, error } = await fetchAllShopifyProducts();
      if (error || !Array.isArray(products)) return null; // read failure ⇒ UNKNOWN
      // Structurally identical to ShopifyLiveProduct — pass through read-only.
      return products.map((p) => ({
        id: p.id,
        title: p.title,
        status: p.status,
        descriptionHtml: p.descriptionHtml,
        imageUrl: p.imageUrl,
        variants: p.variants.map((v) => ({
          id: v.id, sku: v.sku, barcode: v.barcode, price: v.price,
          compareAtPrice: v.compareAtPrice, inventoryQuantity: v.inventoryQuantity,
        })),
      }));
    })();

    const [[productRows, imageRows, variantRows, eclRows], live] = await Promise.all([internalReads, liveRead]);

    // ── Images per product (count only — media diff is featured-image based). ────
    interface Img { url: string | null; isPrimary: boolean; sortOrder: number }
    const imagesByProduct = new Map<string, Img[]>();
    for (const img of imageRows) {
      const pid = typeof img.product_id === "string" ? img.product_id : "";
      if (!pid) continue;
      const list = imagesByProduct.get(pid) ?? [];
      list.push({ url: s(img.url), isPrimary: img.is_primary === true, sortOrder: n(img.sort_order) ?? 0 });
      imagesByProduct.set(pid, list);
    }

    // ── Variants per product. ────────────────────────────────────────────────────
    const variantsByProduct = new Map<string, ShopifyInternalVariant[]>();
    for (const v of variantRows) {
      const pid = s(v.parent_product_id);
      const id = s(v.id);
      if (!pid || !id) continue;
      const list = variantsByProduct.get(pid) ?? [];
      list.push({ id, sku: s(v.sku), barcode: s(v.barcode), variantName: s(v.variant_name), price: n(v.price) });
      variantsByProduct.set(pid, list);
    }

    // ── ECL identity evidence for shopify:malikas only, keyed by internal product. ─
    interface Acc { statuses: Set<string>; gids: Set<string>; variantGidByVariantId: Record<string, string> }
    const acc = new Map<string, Acc>();
    for (const e of eclRows) {
      if (s(e.storefront_key) !== SHOPIFY_STOREFRONT_KEY) continue; // hard storefront scope
      const ms = s(e.mapping_status);
      if (ms === "archived") continue; // a retired link is not identity — treat as unmapped
      const pid = s(e.product_id);
      if (!pid) continue;
      const a = acc.get(pid) ?? { statuses: new Set<string>(), gids: new Set<string>(), variantGidByVariantId: {} };
      a.statuses.add(ms ?? "active");
      const gid = s(e.external_product_id);
      if (gid) a.gids.add(gid);
      const vid = s(e.variant_id);
      const vgid = s(e.external_variant_id);
      if (vid && vgid) a.variantGidByVariantId[vid] = vgid;
      acc.set(pid, a);
    }
    const mappingByProductId: Record<string, ShopifyIdentityEvidence> = {};
    for (const [pid, a] of acc) {
      const needsReview = a.statuses.has("needs_review");
      const gidList = [...a.gids];
      mappingByProductId[pid] = {
        status: needsReview ? "needs_review" : "active",
        productGid: gidList[0] ?? null,
        variantGidByVariantId: a.variantGidByVariantId,
        hasConflictingProductGids: gidList.length > 1,
      };
    }

    const products: ShopifyInternalProduct[] = productRows.map((p) => {
      const id = typeof p.id === "string" ? p.id : "";
      const imgs = imagesByProduct.get(id) ?? [];
      const hasRowImage = imgs.some((im) => im.url !== null);
      const imageCount = imgs.filter((im) => im.url !== null).length || (s(p.image_url) || s(p.image_filename) ? 1 : 0);
      return {
        id,
        sku: s(p.sku),
        barcode: s(p.barcode),
        nameEn: s(p.name_en),
        nameAr: s(p.name_ar),
        descriptionEn: s(p.description_en),
        descriptionAr: s(p.description_ar),
        price: n(p.price),
        discountPrice: n(p.discount_price),
        imageUrl: hasRowImage ? imgs.find((im) => im.url !== null)?.url ?? null : s(p.image_url),
        imageFilename: s(p.image_filename),
        imageCount,
        variants: variantsByProduct.get(id) ?? [],
        lifecycleState: p.lifecycle_state,
        platformStatus: p.platform_status,
      };
    });

    return buildShopifyPreview({ products, live, mappingByProductId });
  } catch {
    return null;
  }
}
