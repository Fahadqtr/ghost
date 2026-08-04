// /v2/catalog — Malikas Catalog Control Center (Phase UI.2A). Read-only Server
// Component. Loads the catalog through the injected Supabase client (existing
// user session), then filters → sorts → paginates with pure helpers. Data
// loading is isolated in try/catch; JSX is built only afterwards, so on any
// failure it shows a single constant Arabic message — never a raw error
// message/stack/code/details/hint/table/column/JSON.

import { createClient } from "@/lib/supabase/server";
import { loadMasterCatalog } from "@/lib/catalog-v2/master-catalog-read";
import {
  filterCatalogProducts,
  paginateCatalog,
  parseCatalogControls,
  sortCatalogProducts,
  summarizeCatalog,
  type CatalogControls,
  type CatalogPage,
  type CatalogSummary,
} from "@/lib/catalog-v2/master-catalog-view";
import MasterCatalog from "@/components/v2/catalog/MasterCatalog";

export const dynamic = "force-dynamic";

const LOAD_ERROR = "تعذر تحميل كتالوج ماليكاس.";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function CatalogPage({ searchParams }: { searchParams?: SearchParams }) {
  let loaded: {
    pageResult: CatalogPage;
    allCount: number;
    matchCount: number;
    summary: CatalogSummary;
    controls: CatalogControls;
    partial: boolean;
  } | null = null;

  try {
    const params = searchParams ? await searchParams : {};
    const controls = parseCatalogControls(params);
    const supabase = createClient();
    const result = await loadMasterCatalog(supabase);
    if (result.status === "ok") {
      const filtered = filterCatalogProducts(result.products, { query: controls.query, filter: controls.filter });
      const sorted = sortCatalogProducts(filtered, controls.sort);
      const pageResult = paginateCatalog(sorted, controls.page);
      loaded = {
        pageResult,
        allCount: result.products.length,
        matchCount: sorted.length,
        summary: summarizeCatalog(result.products),
        controls,
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
      pageResult={loaded.pageResult}
      allCount={loaded.allCount}
      matchCount={loaded.matchCount}
      summary={loaded.summary}
      controls={loaded.controls}
      partial={loaded.partial}
    />
  );
}
