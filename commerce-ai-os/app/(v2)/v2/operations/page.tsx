// /v2/operations — Malikas Operations Center (Phase UI.7.2). Read-only Server
// Component. Everything (readiness, tasks, platform status, buckets, health) is
// computed SERVER-SIDE via lib/operations/* engines; only the current page of
// items plus the aggregate summary crosses to the browser — never the whole
// catalog. Data loading is isolated in try/catch: on any failure it shows one
// constant Arabic message, never a raw error/stack/code.

import { createClient } from "@/lib/supabase/server";
import { loadOperationsDashboard } from "@/lib/operations/read-model";
import { loadShopifyPresence } from "@/lib/operations/shopify-presence";
import {
  parseOperationsControls,
  selectOperationsPage,
  type OperationsControls,
  type OperationsListItem,
  type OperationsPage,
} from "@/lib/operations/dashboard-view";
import type { HealthSummary } from "@/lib/operations/shared/models";
import OperationsDashboard from "@/components/v2/operations/OperationsDashboard";

export const dynamic = "force-dynamic";

const LOAD_ERROR = "تعذر تحميل مركز العمليات.";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function OperationsPage({ searchParams }: { searchParams?: SearchParams }) {
  let loaded:
    | {
        controls: OperationsControls;
        health: HealthSummary;
        pageResult: OperationsPage;
        matchCount: number;
        partial: boolean;
        shopifyAvailable: boolean;
      }
    | null = null;

  try {
    const params = searchParams ? await searchParams : {};
    const controls = parseOperationsControls(params);
    const supabase = createClient();
    const result = await loadOperationsDashboard(supabase as never, { shopify: { loadShopifyPresence } });
    if (result.status === "ok") {
      const all: OperationsListItem[] = result.data.items;
      // Reuse the pure pipeline once for the count, once for the page slice.
      const matched = selectOperationsPage(all, { ...controls, page: 1 });
      const pageResult = selectOperationsPage(all, controls);
      loaded = {
        controls,
        health: result.data.health,
        pageResult,
        matchCount: matched.total,
        partial: result.data.partial,
        shopifyAvailable: result.data.shopifyAvailable,
      };
    }
  } catch {
    loaded = null;
  }

  if (loaded === null) {
    return (
      <div className="card border-rose-200 bg-rose-50 text-sm text-rose-700" role="alert">
        {LOAD_ERROR}
      </div>
    );
  }

  return (
    <OperationsDashboard
      health={loaded.health}
      page={loaded.pageResult}
      matchCount={loaded.matchCount}
      controls={loaded.controls}
      partial={loaded.partial}
      shopifyAvailable={loaded.shopifyAvailable}
    />
  );
}
