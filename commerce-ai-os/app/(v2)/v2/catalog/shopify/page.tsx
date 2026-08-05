// /v2/catalog/shopify — Shopify Catalog comparison (Phase UI.3C). Read-only
// Server Component. It loads the already-matched read model from UI.3B through
// the injected Supabase client (existing user session), then filters → sorts →
// paginates with the pure view helpers. No matching is re-derived here, no
// Shopify write is possible, and data loading is isolated in try/catch so any
// failure renders a single constant Arabic message — never a raw error
// message/stack/code/hint/JSON, token, or domain.
//
// Auth is enforced by the (v2) route-group layout: an unauthenticated visitor is
// redirected to /login before this page ever runs.

import { createClient } from "@/lib/supabase/server";
import { loadShopifyCatalog } from "@/lib/catalog-v2/shopify-catalog-read";
import {
  filterShopifyCatalogRows,
  paginateShopifyCatalog,
  parseShopifyCatalogControls,
  sortShopifyCatalogRows,
  summarizeShopifyCatalog,
  type ShopifyCatalogControls,
  type ShopifyCatalogPage,
  type ShopifyCatalogSummary,
  type ShopifyOrphanVariant,
} from "@/lib/catalog-v2/shopify-catalog-view";
import ShopifyCatalog from "@/components/v2/catalog/ShopifyCatalog";

export const dynamic = "force-dynamic";

const LOAD_ERROR = "تعذر تحميل كتالوج ماليكاس.";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function ShopifyCatalogPage({ searchParams }: { searchParams?: SearchParams }) {
  let loaded: {
    pageResult: ShopifyCatalogPage;
    allCount: number;
    matchCount: number;
    summary: ShopifyCatalogSummary;
    controls: ShopifyCatalogControls;
    orphanVariants: ShopifyOrphanVariant[];
    partial: boolean;
    shopifyAvailable: boolean;
  } | null = null;

  try {
    const params = searchParams ? await searchParams : {};
    const controls = parseShopifyCatalogControls(params);
    const supabase = createClient();
    // The reader performs the ONLY Shopify read (once) and all paginated
    // database reads; it never mutates either system.
    const result = await loadShopifyCatalog(supabase);
    if (result.status !== "master_error") {
      const filtered = filterShopifyCatalogRows(result.rows, { query: controls.query, filter: controls.filter });
      const sorted = sortShopifyCatalogRows(filtered, controls.sort);
      const pageResult = paginateShopifyCatalog(sorted, controls.page);
      loaded = {
        pageResult,
        allCount: result.rows.length,
        matchCount: sorted.length,
        summary: summarizeShopifyCatalog(result.rows, result.shopifyAvailable),
        controls,
        // Orphans exist only when Shopify actually answered.
        orphanVariants: result.shopifyAvailable ? result.orphanVariants : [],
        partial: result.partial,
        shopifyAvailable: result.shopifyAvailable,
      };
    }
  } catch {
    loaded = null; // never surface the underlying failure
  }

  if (loaded === null) {
    return (
      <div className="space-y-4">
        <h1 className="font-serif text-2xl font-semibold text-ink">كتالوج Shopify</h1>
        <div className="card border-rose-200 bg-rose-50 text-sm text-rose-700">{LOAD_ERROR}</div>
      </div>
    );
  }

  return (
    <ShopifyCatalog
      pageResult={loaded.pageResult}
      allCount={loaded.allCount}
      matchCount={loaded.matchCount}
      summary={loaded.summary}
      controls={loaded.controls}
      orphanVariants={loaded.orphanVariants}
      partial={loaded.partial}
      shopifyAvailable={loaded.shopifyAvailable}
    />
  );
}
