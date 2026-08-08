// /v2/operations — Malikas Operations Center (Phase UI.8 upgrade). Read-only
// Server Component. Everything (readiness, tasks, platform status, health,
// KPIs, queues, platform overview) is computed SERVER-SIDE via lib/operations/*
// engines + the pure summary layer; only the KPIs, per-queue top items, counts
// and the CURRENT page of products cross to the browser — never the whole
// catalog. TickTick linkage is a best-effort read that can never break the page.
// Data loading is isolated in try/catch: on any failure it shows one constant
// Arabic message, never a raw error/stack/code.

import { createClient } from "@/lib/supabase/server";
import { loadOperationsDashboard } from "@/lib/operations/read-model";
import { loadShopifyPresence } from "@/lib/operations/shopify-presence";
import { loadPureSoulPresence } from "@/lib/platforms/puresoul/presence";
import { loadTickTickSyncedIds } from "@/lib/integrations/ticktick/synced-ids";
import {
  parseOperationsControls,
  selectOperationsPage,
  type OperationsControls,
  type OperationsListItem,
  type OperationsPage,
} from "@/lib/operations/dashboard-view";
import {
  annotateTickTick,
  buildDashboardSummary,
  type DashboardKpis,
  type PlatformOverview,
  type Queue,
} from "@/lib/operations/dashboard-summary";
import OperationsDashboard from "@/components/v2/operations/OperationsDashboard";

export const dynamic = "force-dynamic";

const LOAD_ERROR = "تعذر تحميل مركز العمليات.";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function OperationsPage({ searchParams }: { searchParams?: SearchParams }) {
  let loaded:
    | {
        controls: OperationsControls;
        kpis: DashboardKpis;
        queues: Queue[];
        platformOverview: PlatformOverview;
        pageResult: OperationsPage;
        matchCount: number;
        partial: boolean;
        shopifyAvailable: boolean;
        puresoulAvailable: boolean;
        puresoulDegraded: boolean;
        ticktickAvailable: boolean;
      }
    | null = null;

  try {
    const params = searchParams ? await searchParams : {};
    const controls = parseOperationsControls(params);
    const supabase = createClient();
    const result = await loadOperationsDashboard(supabase as never, {
      shopify: { loadShopifyPresence },
      // PureSoul reads platform_status via .eq(); bridge the client type (same
      // session client passed to the dashboard, cast as elsewhere on this page).
      puresoul: { loadPureSoulPresence: (c) => loadPureSoulPresence(c as never) },
    });
    if (result.status === "ok") {
      // TickTick is a best-effort annotation only — it must NEVER break the
      // dashboard. loadTickTickSyncedIds already degrades internally; the extra
      // catch is belt-and-suspenders.
      const ticktick = await loadTickTickSyncedIds().catch(() => ({ available: false, ids: new Set<string>() }));

      // Annotate once (server-side) so KPIs, queues AND the ticktick_synced
      // filter all read the same enriched items — the whole set stays here; only
      // the summary + current page are sent to the browser.
      const items: OperationsListItem[] = annotateTickTick(result.data.items, ticktick.ids);
      const summary = buildDashboardSummary(
        items,
        result.data.health,
        result.data.shopifyAvailable,
        result.data.puresoulAvailable,
      );

      // Reuse the pure pipeline once for the match count, once for the page slice.
      const matched = selectOperationsPage(items, { ...controls, page: 1 });
      const pageResult = selectOperationsPage(items, controls);

      loaded = {
        controls,
        kpis: summary.kpis,
        queues: summary.queues,
        platformOverview: summary.platformOverview,
        pageResult,
        matchCount: matched.total,
        partial: result.data.partial,
        shopifyAvailable: result.data.shopifyAvailable,
        puresoulAvailable: result.data.puresoulAvailable,
        puresoulDegraded: result.data.puresoulDegraded,
        ticktickAvailable: ticktick.available,
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
      kpis={loaded.kpis}
      queues={loaded.queues}
      platformOverview={loaded.platformOverview}
      page={loaded.pageResult}
      matchCount={loaded.matchCount}
      controls={loaded.controls}
      partial={loaded.partial}
      shopifyAvailable={loaded.shopifyAvailable}
      puresoulAvailable={loaded.puresoulAvailable}
      puresoulDegraded={loaded.puresoulDegraded}
      ticktickAvailable={loaded.ticktickAvailable}
    />
  );
}
