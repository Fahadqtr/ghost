import "server-only";
// SHOPIFY.VARIANT.REPAIR — server binder. Binds the REAL ports (catalog read,
// ECL mapping read, the single validated Shopify mutation, targeted re-read,
// certified ECL write-back) to the PURE orchestration core and gates on the
// writer. Deliberately NOT wired to any UI/route yet — the live repair of the
// 62 affected products is a separate, explicitly-approved execution step.
//
// Never writes: inventory quantities, product content/status/media, prices of
// existing variants, or any lifecycle/approval field.

import { createAdminClient } from "@/lib/supabase/admin";
import { requireWriterGate } from "@/lib/auth/requireUser";
import { createClient } from "@/lib/supabase/server";
import { createProductVariantsBulk, fetchShopifyProductVariants } from "@/lib/shopify/admin";
import { writeEclMapping } from "@/lib/missing-products/ecl-repair-write.server";
import { SHOPIFY_STOREFRONT_KEY } from "./preview.ts";
import { storefrontByKey } from "@/lib/channels/storefronts";
import {
  runVariantRepair,
  type RepairInternalProduct,
  type VariantRepairItemResult,
  type VariantRepairPorts,
} from "./variant-repair.ts";

const CHANNEL_KEY = "shopify";
const IDENTITY_TYPE = storefrontByKey(SHOPIFY_STOREFRONT_KEY)?.identityType ?? "shopify_gid";
const MAX_PRODUCTS = 100;

const n = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const s = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);

async function loadInternal(admin: ReturnType<typeof createAdminClient>, productId: string): Promise<RepairInternalProduct | null> {
  const { data: p, error } = await admin
    .from("products")
    .select("id, sku, price, discount_price")
    .eq("id", productId)
    .maybeSingle();
  if (error || !p) return null;
  const { data: vs, error: vErr } = await admin
    .from("product_variants")
    .select("id, variant_name, sku, barcode, price")
    .eq("parent_product_id", productId)
    .order("id", { ascending: true });
  if (vErr) return null;
  return {
    id: String(p.id),
    sku: s(p.sku),
    price: n(p.price),
    discountPrice: n(p.discount_price),
    variants: ((vs ?? []) as Record<string, unknown>[]).map((v) => ({
      id: String(v.id),
      name: s(v.variant_name),
      sku: s(v.sku),
      barcode: s(v.barcode),
      price: n(v.price),
    })),
  };
}

async function loadProductGid(admin: ReturnType<typeof createAdminClient>, productId: string): Promise<{ gid: string | null; ambiguous: boolean }> {
  const { data, error } = await admin
    .from("external_channel_listings")
    .select("external_product_id, mapping_status, identity_type, variant_id")
    .eq("product_id", productId)
    .eq("storefront_key", SHOPIFY_STOREFRONT_KEY)
    .eq("mapping_status", "active");
  if (error) return { gid: null, ambiguous: false };
  const gids = new Set(
    ((data ?? []) as Record<string, unknown>[])
      .filter((r) => r.variant_id === null && r.identity_type === IDENTITY_TYPE)
      .map((r) => String(r.external_product_id ?? ""))
      .filter((g) => g.startsWith("gid://shopify/Product/")),
  );
  if (gids.size > 1) return { gid: null, ambiguous: true };
  return { gid: gids.size === 1 ? [...gids][0]! : null, ambiguous: false };
}

/**
 * Repair the missing real variants for the given internal product ids.
 * Writer-gated; bounded; per-product outcomes — never a silent success.
 */
export async function repairMissingShopifyVariants(
  productIds: readonly string[],
): Promise<{ results: VariantRepairItemResult[]; error?: string }> {
  const unauth = await requireWriterGate();
  if (unauth) return { results: [], error: unauth.error };

  const ids = Array.from(new Set((productIds ?? []).map(String).filter(Boolean))).slice(0, MAX_PRODUCTS);
  if (!ids.length) return { results: [] };

  const admin = createAdminClient();
  const actor = await (async () => {
    try {
      const { data } = await createClient().auth.getUser();
      return data.user?.email ?? "writer";
    } catch {
      return "writer";
    }
  })();

  const ports: VariantRepairPorts = {
    loadInternal: (id) => loadInternal(admin, id),
    loadProductGid: (id) => loadProductGid(admin, id),
    readLive: async (gid) => {
      const r = await fetchShopifyProductVariants(gid);
      return r.variants ? { id: gid, variants: r.variants } : null;
    },
    createVariants: async (gid, creates) => {
      const r = await createProductVariantsBulk(
        gid,
        creates.map((c) => ({ name: c.name, sku: c.sku, barcode: c.barcode, price: c.price })),
      );
      return { ok: r.ok, ...(r.error ? { error: r.error } : {}) };
    },
    rereadLive: async (gid) => {
      const r = await fetchShopifyProductVariants(gid);
      return r.variants ?? null;
    },
    persistEcl: async (productId, productGid, w) => {
      const r = await writeEclMapping(
        admin as never,
        {
          productId,
          variantId: w.internalVariantId,
          channelKey: CHANNEL_KEY,
          storefrontKey: SHOPIFY_STOREFRONT_KEY,
          identityType: IDENTITY_TYPE,
          externalProductId: productGid,
          externalVariantId: w.variantGid,
          exportedSku: w.sku,
          exportedBarcode: w.barcode,
          variantSku: w.sku,
        },
        actor,
      );
      return { ok: r.ok || r.duplicate === true };
    },
  };

  const results: VariantRepairItemResult[] = [];
  for (const id of ids) {
    results.push(await runVariantRepair(ports, id));
  }
  return { results };
}
