import "server-only";
import { cache } from "react";
import { createClient } from "@/lib/supabase/server";
import { SNOONU_STOREFRONT_KEYS } from "./merchant-contract";
import type { SnoonuStorefrontKey } from "./merchant-contract";
import type { DiscoveryResult, SnoonuDiscoveryProvider } from "./discovery-contract";
import { runSnoonuDiscovery } from "./discovery-engine";
import { createConfiguredSnoonuDiscoveryProvider } from "./live-adapter.server";

// MEDIA.1B — Snoonu Media Discovery orchestrator (SERVER, READ-ONLY).
//
// Reads the internal product's identifying facts from OUR catalog (read-only),
// then runs the pure discovery engine INDEPENDENTLY for each Snoonu storefront
// (Malikas + Pure Seoul). It writes nothing — no imageStore, no product_images,
// no ECL, no product mutation. The default provider is resolved per storefront:
// LIVE (verified name-search reads against the captured portal contract) when
// that storefront's session config is provisioned, otherwise the inert
// SESSION_REQUIRED default. Tests may still inject via `deps.providers`.

export interface DiscoveryQueryContext {
  productId: string | null;
  sku: string | null;
  barcode: string | null;
  name: string | null;
  currentImageUrl: string | null;
}

export interface SnoonuDiscoveryView {
  found: boolean;
  query: DiscoveryQueryContext | null;
  results: DiscoveryResult[];
  generatedAt: string;
}

export interface DiscoveryInput {
  productId?: string | null;
  sku?: string | null;
}

export interface DiscoveryDeps {
  /** Inject a live provider per storefront (future MEDIA.1A-P). Omit → default. */
  providers?: Partial<Record<SnoonuStorefrontKey, SnoonuDiscoveryProvider>>;
}

interface ProductRow {
  id: string;
  sku: string | null;
  barcode: string | null;
  name_en: string | null;
  name_ar: string | null;
  image_url: string | null;
}

async function readProduct(input: DiscoveryInput): Promise<ProductRow | null> {
  const productId = typeof input.productId === "string" ? input.productId.trim() : "";
  const sku = typeof input.sku === "string" ? input.sku.trim() : "";
  if (!productId && !sku) return null;
  try {
    const sb = createClient();
    let q = sb.from("products").select("id, sku, barcode, name_en, name_ar, image_url").limit(1);
    q = productId ? q.eq("id", productId) : q.eq("sku", sku);
    const { data, error } = await q;
    if (error) return null;
    const row = (data ?? [])[0] as ProductRow | undefined;
    return row ?? null;
  } catch {
    return null;
  }
}

export const loadSnoonuDiscovery = cache(async (input: DiscoveryInput, deps?: DiscoveryDeps): Promise<SnoonuDiscoveryView> => {
  const generatedAt = new Date().toISOString();
  const product = await readProduct(input);
  if (!product) return { found: false, query: null, results: [], generatedAt };

  const name = (product.name_en && product.name_en.trim()) || (product.name_ar && product.name_ar.trim()) || null;
  const query: DiscoveryQueryContext = {
    productId: product.id,
    sku: product.sku,
    barcode: product.barcode,
    name,
    currentImageUrl: product.image_url,
  };

  // Independent search per storefront — storefront_key is retained on every result.
  const results = await Promise.all(
    SNOONU_STOREFRONT_KEYS.map((key) => {
      const provider = deps?.providers?.[key] ?? createConfiguredSnoonuDiscoveryProvider(key);
      return runSnoonuDiscovery(provider, {
        storefrontKey: key,
        barcode: product.barcode,
        sku: product.sku,
        name,
      }).catch((): DiscoveryResult => ({
        storefrontKey: key,
        sessionState: "error",
        classification: "ERROR",
        matchReason: "error",
        confidence: "none",
        candidates: [],
        candidateCount: 0,
        error: "discovery failed",
      }));
    }),
  );

  return { found: true, query, results, generatedAt };
});
