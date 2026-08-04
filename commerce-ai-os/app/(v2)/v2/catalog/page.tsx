// /v2/catalog — Malikas Master Catalog (Phase UI.1). Read-only Server Component.
// Loads the catalog through the injected Supabase client (from the existing user
// session) and renders it. Data loading is isolated in try/catch; JSX is built
// only afterwards, so on any failure it shows a single constant Arabic message —
// never a raw error message/stack/code/details/hint/table/column/JSON.

import { createClient } from "@/lib/supabase/server";
import { loadMasterCatalog } from "@/lib/catalog-v2/master-catalog-read";
import {
  filterCatalogProducts,
  parseCatalogFilters,
  summarizeCatalog,
  type CatalogFilters,
  type CatalogSummary,
  type MasterCatalogProduct,
} from "@/lib/catalog-v2/master-catalog-view";
import MasterCatalog from "@/components/v2/catalog/MasterCatalog";

export const dynamic = "force-dynamic";

const LOAD_ERROR = "تعذر تحميل كتالوج ماليكاس.";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function CatalogPage({ searchParams }: { searchParams?: SearchParams }) {
  let loaded: {
    products: MasterCatalogProduct[];
    allCount: number;
    summary: CatalogSummary;
    filters: CatalogFilters;
    partial: boolean;
  } | null = null;

  try {
    const params = searchParams ? await searchParams : {};
    const filters = parseCatalogFilters(params);
    const supabase = createClient();
    const result = await loadMasterCatalog(supabase);
    if (result.status === "ok") {
      loaded = {
        products: filterCatalogProducts(result.products, filters),
        allCount: result.products.length,
        summary: summarizeCatalog(result.products),
        filters,
        partial: result.partial,
      };
    }
  } catch {
    loaded = null;
  }

  if (loaded === null) {
    return (
      <div className="space-y-4">
        <h1 className="font-serif text-2xl font-semibold text-ink">كتالوج ماليكاس</h1>
        <div className="card border-rose-200 bg-rose-50 text-sm text-rose-700">{LOAD_ERROR}</div>
      </div>
    );
  }

  return (
    <MasterCatalog
      products={loaded.products}
      allCount={loaded.allCount}
      summary={loaded.summary}
      filters={loaded.filters}
      partial={loaded.partial}
    />
  );
}
