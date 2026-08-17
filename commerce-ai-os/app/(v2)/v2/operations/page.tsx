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
import { loadShopifySnapshotView } from "@/lib/platforms/shopify/snapshot-presence";
import { captureShopifySnapshots } from "@/lib/platforms/shopify/snapshot-capture";
import { loadPureSoulPresence } from "@/lib/platforms/puresoul/presence";
import { loadPureSoulSnapshotView } from "@/lib/platforms/puresoul/snapshot-presence";
import { loadTalabatSnapshotView } from "@/lib/platforms/talabat/snapshot-presence";
import { loadRafeeqSnapshotView } from "@/lib/platforms/rafeeq/snapshot-presence";
import { captureRafeeqSnapshots } from "@/lib/platforms/rafeeq/snapshot-capture";
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
import {
  buildOperationsQueues,
  selectQueue,
  paginateIssues,
  parseQueueControl,
  type QueueControl,
  type QueueCounts,
  type IssuePage,
} from "@/lib/operations/operations-queue";
import { buildPlatformHealth, type PlatformHealth } from "@/lib/operations/platform-health";
import { buildOperationsCenter, type OperationsCenterModel } from "@/lib/operations/ops-center";
import Link from "next/link";
import { Suspense } from "react";
import OperationsDashboard from "@/components/v2/operations/OperationsDashboard";
import { buildLifecycleBreakdown, type LifecycleBreakdown } from "@/lib/operations/lifecycle-signal";
import OperationsCenter from "@/components/v2/operations/OperationsCenter";
import OwnerActionsStrip from "@/components/v2/operations/OwnerActionsStrip";
import { loadActionCenter } from "@/lib/actions/action-center.server";

export const dynamic = "force-dynamic";

const LOAD_ERROR = "تعذر تحميل مركز العمليات.";

// OPS.7 — Owner Actions summary. Streamed under Suspense so the AI.1 read (which
// runs its own aggregate) never blocks or slows the main dashboard's single scan.
// Reuses loadActionCenter; renders four lane counts only — not the action list.
async function OwnerActionsSlot() {
  const view = await loadActionCenter();
  return <OwnerActionsStrip summary={view.summary} />;
}

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function OperationsPage({ searchParams }: { searchParams?: SearchParams }) {
  let loaded:
    | {
        controls: OperationsControls;
        kpis: DashboardKpis;
        queues: Queue[];
        platformOverview: PlatformOverview;
        platformHealth: PlatformHealth[];
        opsCenter: OperationsCenterModel;
        pageResult: OperationsPage;
        matchCount: number;
        partial: boolean;
        shopifyAvailable: boolean;
        shopifyLastCapturedAt: string | null;
        shopifyStale: boolean;
        shopifySnapshotAvailable: boolean;
        puresoulAvailable: boolean;
        puresoulDegraded: boolean;
        puresoulLastCapturedAt: string | null;
        puresoulStale: boolean;
        talabatAvailable: boolean;
        talabatDegraded: boolean;
        talabatLastCapturedAt: string | null;
        talabatStale: boolean;
        rafeeqAvailable: boolean;
        rafeeqDegraded: boolean;
        rafeeqLastCapturedAt: string | null;
        rafeeqStale: boolean;
        ticktickAvailable: boolean;
        queueControl: QueueControl;
        issuePage: IssuePage;
        queueCounts: QueueCounts;
        queueCapped: boolean;
        lifecycle: LifecycleBreakdown;
      }
    | null = null;

  try {
    const params = searchParams ? await searchParams : {};
    const controls = parseOperationsControls(params);
    const supabase = createClient();
    const result = await loadOperationsDashboard(supabase as never, {
      shopify: { loadShopifyPresence },
      // Persisted Shopify snapshots (UI.9.5) take precedence per product; the
      // live UI.3 reader above is the fallback. Same session client.
      shopifySnapshot: { loadShopifySnapshotView: (c) => loadShopifySnapshotView(c as never) },
      // PureSoul reads platform_status via .eq(); bridge the client type (same
      // session client passed to the dashboard, cast as elsewhere on this page).
      puresoul: { loadPureSoulPresence: (c) => loadPureSoulPresence(c as never) },
      // Persisted snapshots (UI.9.3) take precedence; same session client.
      puresoulSnapshot: { loadPureSoulSnapshotView: (c) => loadPureSoulSnapshotView(c as never) },
      // Talabat snapshots (UI.9.6): upload-derived state + mapping-linked
      // baseline. Read-only; same session client. No auto-capture (no API).
      talabatSnapshot: { loadTalabatSnapshotView: (c) => loadTalabatSnapshotView(c as never) },
      // Rafeeq snapshots (UI.9.7): channel_products/rafeeq_product_id overlays.
      // Read-only; same session client.
      rafeeqSnapshot: { loadRafeeqSnapshotView: (c) => loadRafeeqSnapshotView(c as never) },
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
        {
          available: result.data.puresoulAvailable,
          lastCapturedAt: result.data.puresoulLastCapturedAt,
          stale: result.data.puresoulStale,
        },
        undefined,
        { lastCapturedAt: result.data.shopifyLastCapturedAt, stale: result.data.shopifyStale },
        {
          available: result.data.talabatAvailable,
          lastCapturedAt: result.data.talabatLastCapturedAt,
          stale: result.data.talabatStale,
        },
        {
          available: result.data.rafeeqAvailable,
          lastCapturedAt: result.data.rafeeqLastCapturedAt,
          stale: result.data.rafeeqStale,
        },
      );

      // Best-effort auto-capture (UI.9.7): when there is no fresh Rafeeq snapshot,
      // refresh it from the DB overlays. Fire-and-forget — never awaited (no
      // dashboard latency), gated on staleness (bounded writes), reads only the DB
      // (no API/cron/webhook), and any failure is swallowed so it can never break
      // the page. Idempotent by payload-hash, so an early teardown just retries.
      if (!result.data.rafeeqAvailable || result.data.rafeeqStale) {
        void captureRafeeqSnapshots(supabase as never, new Date().toISOString()).catch(() => {});
      }

      // Best-effort auto-capture (UI.9.5): when there is no fresh Shopify
      // snapshot, refresh it from the trusted read model. Fire-and-forget — it is
      // NEVER awaited (adds no dashboard latency), it is gated on staleness (no
      // uncontrolled writes: at most one refresh per stale window), it reuses the
      // existing read model (no new Shopify client/cron/webhook), and any failure
      // is swallowed so it can never break the page. Idempotent by payload-hash,
      // so if the fire-and-forget is torn down early the next view simply retries.
      if (!result.data.shopifySnapshotAvailable || result.data.shopifyStale) {
        void captureShopifySnapshots(supabase as never, new Date().toISOString()).catch(() => {});
      }

      // Reuse the pure pipeline once for the match count, once for the page slice.
      const matched = selectOperationsPage(items, { ...controls, page: 1 });
      const pageResult = selectOperationsPage(items, controls);

      // Unified operations queue (CI.2): pure aggregation over the SAME items via
      // buildPlatformMatrixItem — zero new reads. Only the current queue page +
      // counts cross to the browser.
      const queueControl = parseQueueControl(params);
      const queues = buildOperationsQueues(items);
      const issuePage = paginateIssues(selectQueue(queues, queueControl.queue), queueControl.page);

      // Platform-level freshness + health (CI.4): pure, from the SAME already-loaded
      // overview + availability/degraded flags + total count — zero new reads. `now`
      // is injected (no hidden clock in the pure builder).
      const platformHealth = buildPlatformHealth(
        summary.platformOverview,
        summary.kpis.totalProducts,
        {
          puresoul: result.data.puresoulDegraded,
          talabat: result.data.talabatDegraded,
          rafeeq: result.data.rafeeqDegraded,
        },
        new Date().getTime(),
      );

      loaded = {
        controls,
        kpis: summary.kpis,
        queues: summary.queues,
        platformOverview: summary.platformOverview,
        platformHealth,
        // OPS.1 — pure composition over the aggregates already computed above
        // (no extra reads/scans, no writes). Orchestration only.
        opsCenter: buildOperationsCenter({
          kpis: summary.kpis,
          overview: summary.platformOverview,
          platformHealth,
          items,
        }),
        pageResult,
        matchCount: matched.total,
        partial: result.data.partial,
        shopifyAvailable: result.data.shopifyAvailable,
        shopifyLastCapturedAt: result.data.shopifyLastCapturedAt,
        shopifyStale: result.data.shopifyStale,
        shopifySnapshotAvailable: result.data.shopifySnapshotAvailable,
        puresoulAvailable: result.data.puresoulAvailable,
        puresoulDegraded: result.data.puresoulDegraded,
        puresoulLastCapturedAt: result.data.puresoulLastCapturedAt,
        puresoulStale: result.data.puresoulStale,
        talabatAvailable: result.data.talabatAvailable,
        talabatDegraded: result.data.talabatDegraded,
        talabatLastCapturedAt: result.data.talabatLastCapturedAt,
        talabatStale: result.data.talabatStale,
        rafeeqAvailable: result.data.rafeeqAvailable,
        rafeeqDegraded: result.data.rafeeqDegraded,
        rafeeqLastCapturedAt: result.data.rafeeqLastCapturedAt,
        rafeeqStale: result.data.rafeeqStale,
        ticktickAvailable: ticktick.available,
        queueControl,
        issuePage,
        queueCounts: queues.counts,
        queueCapped: queues.capped,
        // OPS.8B — read-only lifecycle breakdown over the SAME items (no scan).
        lifecycle: buildLifecycleBreakdown(items),
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
    <>
      <div className="mb-4">
        <Suspense fallback={<div className="mb-4 h-24 animate-pulse rounded-xl bg-slate-100" aria-hidden="true" />}>
          <OwnerActionsSlot />
        </Suspense>
      </div>
      <div className="mb-4">
        <OperationsCenter model={loaded.opsCenter} />
      </div>
      <div className="mb-3 flex flex-wrap justify-end gap-2">
        <Link
          href="/v2/operations/channels"
          className="rounded-lg border border-sky-200 bg-sky-50 px-3 py-1.5 text-xs font-semibold text-sky-700 hover:bg-sky-100"
        >
          مركز قيادة القنوات ↗
        </Link>
        <Link
          href="/v2/operations/ai"
          className="rounded-lg border border-indigo-200 bg-indigo-50 px-3 py-1.5 text-xs font-semibold text-indigo-700 hover:bg-indigo-100"
        >
          مركز الذكاء ↗
        </Link>
        <Link
          href="/v2/operations/health"
          className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-xs font-semibold text-emerald-700 hover:bg-emerald-100"
        >
          مركز صحة المنصّة ↗
        </Link>
        <Link
          href="/v2/operations/missing-products"
          className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-50"
        >
          المنتجات الناقصة ↗
        </Link>
        <Link
          href="/v2/operations/ai-enrichment"
          className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-50"
        >
          الإثراء الذكي ↗
        </Link>
        <Link
          href="/v2/operations/barcode-completion"
          className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-50"
        >
          إكمال باركود سنونو ↗
        </Link>
        <Link
          href="/v2/operations/availability-sync"
          className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-50"
        >
          مزامنة توفّر سنونو ↗
        </Link>
      </div>
      <OperationsDashboard
      kpis={loaded.kpis}
      queues={loaded.queues}
      platformOverview={loaded.platformOverview}
      platformHealth={loaded.platformHealth}
      page={loaded.pageResult}
      matchCount={loaded.matchCount}
      controls={loaded.controls}
      partial={loaded.partial}
      shopifyAvailable={loaded.shopifyAvailable}
      shopifyLastCapturedAt={loaded.shopifyLastCapturedAt}
      shopifyStale={loaded.shopifyStale}
      shopifySnapshotAvailable={loaded.shopifySnapshotAvailable}
      puresoulAvailable={loaded.puresoulAvailable}
      puresoulDegraded={loaded.puresoulDegraded}
      puresoulLastCapturedAt={loaded.puresoulLastCapturedAt}
      puresoulStale={loaded.puresoulStale}
      talabatAvailable={loaded.talabatAvailable}
      talabatDegraded={loaded.talabatDegraded}
      talabatLastCapturedAt={loaded.talabatLastCapturedAt}
      talabatStale={loaded.talabatStale}
      rafeeqAvailable={loaded.rafeeqAvailable}
      rafeeqDegraded={loaded.rafeeqDegraded}
      rafeeqLastCapturedAt={loaded.rafeeqLastCapturedAt}
      rafeeqStale={loaded.rafeeqStale}
      ticktickAvailable={loaded.ticktickAvailable}
      queueControl={loaded.queueControl}
      issuePage={loaded.issuePage}
      queueCounts={loaded.queueCounts}
      queueCapped={loaded.queueCapped}
      lifecycle={loaded.lifecycle}
    />
    </>
  );
}
