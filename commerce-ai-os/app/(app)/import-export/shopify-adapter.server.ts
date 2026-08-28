import "server-only";
// CH.4 — concrete Shopify adapter wiring (SERVER). Binds the pure Shopify adapter
// factory to the existing, already-tested Shopify functions and the CH.2 mapping
// reader. This is the reference implementation of the ChannelAdapter contract for
// a live channel.
//
// NOT wired into any runtime path yet — nothing imports `shopifyAdapter()` — so
// this introduces ZERO production behavior change. It exists so the framework has
// a real, compiling binding a later change can adopt without re-plumbing. Every
// side effect delegates to code that already exists; no business logic is copied
// here (the only new code is thin result-shape glue + a match loop for unpublish,
// which had no prior orchestration to reuse).

import { createClient } from "@/lib/supabase/server";
import { createShopifyAdapter, type ShopifyAdapterDeps } from "@/lib/adapters/shopify/shopify-adapter";
import { getExternalIdentityResolver } from "@/lib/channels/identity-resolver.server";
import { type ChannelAdapter } from "@/lib/adapters/types";
import {
  fetchAllShopifyProducts,
  updateShopifyProductContent,
  fetchRecentShopifyOrders,
} from "@/lib/shopify/admin";
import {
  applyShopifyPrices,
  applyShopifyContent,
  syncShopifyInventory,
  listShopifyMissingImages,
  pushShopifyImages,
} from "@/app/(app)/import-export/shopify-actions";
import { indexShopify } from "@/lib/shopify-diff";

/** Build the concrete Shopify adapter, bound to the real integration functions. */
export function shopifyAdapter(): ChannelAdapter {
  // CH.5 Phase D: identity comes from the DEFAULT resolver — durable
  // external_channel_listings (primary) with legacy dual-read fallback.
  const resolver = getExternalIdentityResolver();

  const deps: ShopifyAdapterDeps = {
    resolver,

    listListings: async () => {
      const r = await fetchAllShopifyProducts();
      if (r.error) return { error: r.error };
      return {
        products: (r.products ?? []).map((p) => ({
          externalListingId: p.id,
          title: p.title ?? null,
          sku: p.variants?.[0]?.sku ?? null,
          status: p.status ?? null,
        })),
      };
    },

    // Catalog fields (title + status) — the existing content-push action.
    syncCatalog: (idsArr) => applyShopifyContent(idsArr),

    // Images — reuse the missing-image finder + slice pusher. (The finder is
    // store-wide; the requested-ids list is advisory for Shopify.)
    syncImages: async () => {
      const listed = await listShopifyMissingImages();
      if (!listed.ok) return { ok: false, error: listed.error, updated: 0, failed: [] };
      const res = await pushShopifyImages(listed.pairs ?? []);
      return {
        ok: res.ok,
        error: res.error,
        updated: res.pushed,
        failed: res.failed.map((f) => ({ name: f.title, error: f.error })),
      };
    },

    // Availability = stock push (store-global sync engine).
    syncAvailability: async () => {
      const r = await syncShopifyInventory();
      return { ok: r.ok, error: r.error, matched: r.matched ?? 0, updated: r.updated ?? 0 };
    },

    // Prices — the existing price-push action.
    syncPrices: (idsArr) => applyShopifyPrices(idsArr),

    // Publish = create products in the store. RETIRED (INT.2G): the legacy
    // create path (pushProductsToShopify) bypassed ECL identity / row
    // fingerprinting / export_runs auditing and is no longer wired here. The sole
    // Shopify publish boundary is the certified Export Center flow
    // (/api/export/shopify/publish → lib/export/shopify/publish.server.ts). This
    // dormant adapter refuses to publish so it can never resurrect the duplicate
    // boundary; operator publishing goes through /v2/export/shopify:malikas.
    publish: async () => ({
      ok: false,
      error: "Retired — publish via the Export Center (/v2/export/shopify:malikas).",
      created: 0,
      skipped: 0,
      failed: [],
    }),

    // Unpublish = set the matched Shopify products to DRAFT. No prior orchestration
    // existed; this is a thin SKU-match loop over existing admin calls.
    unpublish: async (idsArr) => {
      if (!idsArr.length) return { ok: true, updated: 0, failed: [] };
      const sb = createClient();
      const { data } = await sb.from("products").select("id, sku, name_en").in("id", idsArr);
      const remote = await fetchAllShopifyProducts();
      if (remote.error) return { ok: false, error: remote.error, updated: 0, failed: [] };
      // OPERATIONAL matching only. The previous hand-rolled map was LAST-wins
      // over every product, archived included — with a duplicate SKU it would
      // resolve to the ARCHIVED shell and flip it ARCHIVED → DRAFT, un-retiring
      // it. `indexShopify` excludes archived products and fails closed on an
      // ambiguous SKU, so an unresolved row is reported, never guessed.
      const { match } = indexShopify(remote.products ?? []);
      let updated = 0;
      const failed: { name: string; error: string }[] = [];
      for (const row of (data ?? []) as { id: string; sku: string | null; name_en: string | null }[]) {
        const sid = match(row.sku, row.name_en)?.p.id;
        const name = row.name_en ?? row.id;
        if (!sid) { failed.push({ name, error: "not found on Shopify" }); continue; }
        const r = await updateShopifyProductContent(sid, { status: "DRAFT" });
        if (r.ok) updated++; else failed.push({ name, error: r.error ?? "failed" });
      }
      return { ok: failed.length === 0, updated, failed };
    },

    // Order ingestion = fetch + count recent orders (READ-ONLY; stock deduction
    // stays owned by the Inventory Engine / order RPCs, untouched here).
    ingestOrders: async (opts) => {
      const hours = opts?.sinceHours ?? 24;
      const sinceIso = new Date(Date.now() - hours * 3600_000).toISOString();
      const r = await fetchRecentShopifyOrders(sinceIso, opts?.limit ?? 50);
      if (r.error) return { ok: false, error: r.error, ingested: 0, skipped: 0 };
      return { ok: true, ingested: (r.orders ?? []).length, skipped: 0 };
    },
  };

  return createShopifyAdapter(deps);
}
