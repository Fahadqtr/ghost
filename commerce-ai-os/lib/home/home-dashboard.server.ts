import "server-only";
import { cache } from "react";

import { createClient } from "@/lib/supabase/server";
import { buildHomeDashboard, UNKNOWN } from "./home-model.ts";
import type {
  HomeDashboardModel,
  HomeFacts,
  Maybe,
  ChannelFacts,
  ExportRunFact,
  HomeTextStat,
} from "./home-model.ts";

// Certified read models (REUSED — no new business logic here).
import { loadActionCenter } from "@/lib/actions/action-center.server";
import { loadOperationsDashboard } from "@/lib/operations/read-model";
import { buildDashboardSummary, annotateTickTick } from "@/lib/operations/dashboard-summary";
import { buildPlatformHealth } from "@/lib/operations/platform-health";
import { buildOperationsCenter } from "@/lib/operations/ops-center";
import { buildLifecycleBreakdown } from "@/lib/operations/lifecycle-signal";
import { loadShopifySnapshotView } from "@/lib/platforms/shopify/snapshot-presence";
import { loadPureSoulSnapshotView } from "@/lib/platforms/puresoul/snapshot-presence";
import { loadTalabatSnapshotView } from "@/lib/platforms/talabat/snapshot-presence";
import { loadRafeeqSnapshotView } from "@/lib/platforms/rafeeq/snapshot-presence";
import { getCeoKpis } from "@/lib/dashboard";
import { loadExportCenter } from "@/lib/export/export-center.server";
import { loadRecentExportRuns } from "@/lib/export/shopify/run-store.server";
import { loadCatalogHealthDistribution } from "@/lib/catalog/health/health-distribution.server";
import { loadEvidenceOverview } from "@/lib/catalog/evidence/evidence-overview.server";
import { loadRecommendationSummary } from "@/lib/catalog/recommendations/recommendation-summary.server";
import { loadAnalytics } from "@/lib/analytics/analytics-read.server";
import { metricCurrency, metricInt, UNKNOWN_TEXT } from "@/lib/analytics/executive-dashboard";
import { loadAiCenter } from "@/lib/operations/ai/ai-center.server";
import { parseAiFilters } from "@/lib/operations/ai/ai-center";
import { listPending, listRewardReady, listCustomers } from "@/lib/loyalty/rewards";
import { loadRecentActivity } from "./recent-activity.server.ts";

const OWNER_NAME = "Fahad";

const numOr = (v: unknown): Maybe<number> => (typeof v === "number" && Number.isFinite(v) ? v : UNKNOWN);
const strOr = (v: unknown): Maybe<string> => (typeof v === "string" && v.length > 0 ? v : UNKNOWN);

/** ONE operations scan → lifecycle breakdown (Section 4) + channel health (Section 5). */
const getOperations = cache(async () => {
  try {
    const supabase = createClient();
    // Snapshot-only readers: real per-channel presence from stored snapshots
    // (cheap DB reads) — NO live Shopify/PureSoul API calls (keeps the home fast)
    // and NO snapshot capture (the home is strictly read-only).
    const result = await loadOperationsDashboard(supabase as never, {
      shopifySnapshot: { loadShopifySnapshotView: (c) => loadShopifySnapshotView(c as never) },
      puresoulSnapshot: { loadPureSoulSnapshotView: (c) => loadPureSoulSnapshotView(c as never) },
      talabatSnapshot: { loadTalabatSnapshotView: (c) => loadTalabatSnapshotView(c as never) },
      rafeeqSnapshot: { loadRafeeqSnapshotView: (c) => loadRafeeqSnapshotView(c as never) },
    });
    if (result.status !== "ok") return null;
    const items = annotateTickTick(result.data.items, new Set<string>());
    const summary = buildDashboardSummary(
      items,
      result.data.health,
      result.data.shopifyAvailable,
      { available: result.data.puresoulAvailable, lastCapturedAt: result.data.puresoulLastCapturedAt, stale: result.data.puresoulStale },
      undefined,
      { lastCapturedAt: result.data.shopifyLastCapturedAt, stale: result.data.shopifyStale },
      { available: result.data.talabatAvailable, lastCapturedAt: result.data.talabatLastCapturedAt, stale: result.data.talabatStale },
      { available: result.data.rafeeqAvailable, lastCapturedAt: result.data.rafeeqLastCapturedAt, stale: result.data.rafeeqStale },
    );
    const platformHealth = buildPlatformHealth(
      summary.platformOverview,
      summary.kpis.totalProducts,
      { puresoul: result.data.puresoulDegraded, talabat: result.data.talabatDegraded, rafeeq: result.data.rafeeqDegraded },
      0,
    );
    // ARCHIVED reuses product_archive (a single head count) — never a 2nd scanner.
    let archived = 0;
    try {
      const { count } = await supabase.from("product_archive").select("id", { count: "exact", head: true });
      if (typeof count === "number") archived = count;
    } catch { archived = 0; }
    const opsCenter = buildOperationsCenter({ kpis: summary.kpis, overview: summary.platformOverview, platformHealth, items });
    return {
      lifecycle: buildLifecycleBreakdown(items, archived),
      channels: opsCenter.channels,
    };
  } catch {
    return null;
  }
});

function channelStatusLabel(row: { operationalBlocked: boolean; needsReview: number; needsMapping: number }): string {
  if (row.operationalBlocked) return "غير مفعّل";
  if (row.needsReview > 0) return "يحتاج مراجعة";
  if (row.needsMapping > 0) return "نواقص إدراج";
  return "سليم";
}

const metricStat = (key: string, label: string, m: { status: string; value: number | null } | null | undefined, money: boolean): HomeTextStat => {
  if (!m) return { key, label, value: UNKNOWN_TEXT, available: false };
  const value = money ? metricCurrency(m as never) : metricInt(m as never);
  return { key, label, value, available: m.status === "available" && m.value != null };
};

/** Assemble every certified read model in PARALLEL (best-effort) into HomeFacts. */
export const loadHomeDashboard = cache(async (now: Date = new Date()): Promise<HomeDashboardModel> => {
  const nowIso = now.toISOString();

  const [
    action,
    ops,
    ceo,
    exportCenter,
    shopifyRuns,
    healthDist,
    evidence,
    recommendations,
    analytics,
    ai,
    pending,
    ready,
    customers,
    activity,
  ] = await Promise.all([
    loadActionCenter(now).catch(() => null),
    getOperations(),
    getCeoKpis().catch(() => null),
    loadExportCenter(now).then((r) => ("model" in r ? r.model : null)).catch(() => null),
    loadRecentExportRuns(createClient() as never, "shopify:malikas", 20).catch(() => null),
    loadCatalogHealthDistribution().catch(() => null),
    loadEvidenceOverview().catch(() => null),
    loadRecommendationSummary().catch(() => null),
    loadAnalytics(now).catch(() => null),
    loadAiCenter(parseAiFilters({})).then((r) => ("model" in r ? r : null)).catch(() => null),
    listPending().catch(() => null),
    listRewardReady().catch(() => null),
    listCustomers().catch(() => null),
    loadRecentActivity(20).catch(() => null),
  ]);

  // SECTION 2/3 — Action Center (lanes + severity axis)
  const actionsFacts = action
    ? {
        critical: numOr(action.summary.critical),
        approvalRequired: numOr(action.summary.approvalRequired),
        waiting: numOr(action.summary.waiting),
        completedToday: numOr(action.summary.completedToday),
        total: numOr(action.summary.total),
        high: numOr(action.actions.filter((a) => a.severity === "warning").length),
        medium: numOr(action.actions.filter((a) => a.severity === "info").length),
      }
    : null;

  // SECTION 4 — lifecycle (from the single ops scan)
  const lifecycleFacts = ops
    ? { active: numOr(ops.lifecycle.active), draft: numOr(ops.lifecycle.draft), stopped: numOr(ops.lifecycle.stopped), ready: numOr(ops.lifecycle.ready) }
    : null;

  // SECTION 4 — catalog field gaps (getCeoKpis) + ready/blocked (Export Center readiness baseline)
  const eligible = exportCenter ? (typeof exportCenter.readinessBaseline.eligible === "number" ? exportCenter.readinessBaseline.eligible : UNKNOWN) : UNKNOWN;
  const blocked = exportCenter ? (typeof exportCenter.readinessBaseline.blocked === "number" ? exportCenter.readinessBaseline.blocked : UNKNOWN) : UNKNOWN;
  const catalogFacts = ceo || exportCenter
    ? {
        total: numOr(ceo?.totalProducts),
        ready: eligible,
        blocked,
        needsImage: numOr(ceo?.missingImage),
        needsCategory: numOr(ceo?.missingCategory),
        needsPrice: numOr(ceo?.missingPrice),
        needsBrand: ceo ? numOr(ceo.totalProducts - ceo.productsWithBrand) : UNKNOWN,
      }
    : null;

  // SECTION 9 — CAT.1A health distribution + CAT.1B evidence + CAT.1D recommendations
  const healthFacts = healthDist
    ? { averageScore: numOr(healthDist.averageScore), total: numOr(healthDist.total), byGrade: healthDist.byGrade }
    : null;
  const evidenceFacts = evidence
    ? { total: numOr(evidence.total), productsWithEvidence: numOr(evidence.productsWithEvidence), bySeverity: evidence.bySeverity }
    : null;
  const recommendationFacts = recommendations
    ? { total: numOr(recommendations.total), productsWithRecommendations: numOr(recommendations.productsWithRecommendations), byPriority: recommendations.byPriority }
    : null;

  // SECTION 6 — Export overview (runs → pending/failed/completed/last publish)
  const runsAvail = shopifyRuns?.availability === "AVAILABLE";
  const runList = runsAvail ? shopifyRuns!.runs : [];
  const runFacts: ExportRunFact[] = runList.slice(0, 10).map((r) => ({
    operation: r.operation,
    status: r.status,
    finishedAt: strOr(r.finishedAt),
    createdCount: r.createdCount,
    updatedCount: r.updatedCount,
    failedCount: r.failedCount,
  }));
  const countStatus = (s: string) => runList.filter((r) => r.status === s).length;
  const exportsFacts = exportCenter || runsAvail
    ? {
        eligible,
        blocked,
        historyAvailable: runsAvail,
        runs: runsAvail ? runFacts : null,
        pending: runsAvail ? numOr(countStatus("STARTED")) : UNKNOWN,
        failed: runsAvail ? numOr(countStatus("FAILED")) : UNKNOWN,
        completed: runsAvail ? numOr(countStatus("SUCCEEDED")) : UNKNOWN,
        lastPublish: runsAvail ? strOr(runList[0]?.finishedAt) : UNKNOWN,
      }
    : null;

  // SECTION 5 — Channel health (from the single ops scan). Shopify last export
  // reuses the export_runs reader; other channels have no durable export timeline.
  const shopifyLastExport = runsAvail ? strOr(runList[0]?.finishedAt) : UNKNOWN;
  const channelFacts: ChannelFacts[] | null = ops
    ? ops.channels.map((c) => ({
        key: c.storefront,
        label: c.label,
        status: channelStatusLabel(c),
        mapped: numOr(c.mapped),
        blocked: numOr(c.needsMapping),
        needsReview: numOr(c.needsReview),
        lastExport: c.storefront === "shopify:malikas" ? shopifyLastExport : UNKNOWN,
        href: c.href,
      }))
    : null;

  // SECTION 7 — AI (Need Review / Ready Apply are live-session only ⇒ 0 on server render)
  const aiFacts = ai
    ? {
        needGeneration: numOr(ai.model.dashboard.productsNeedingAi),
        needReview: numOr(ai.model.dashboard.needsReview),
        readyApply: numOr(ai.model.dashboard.readySuggestions),
        providerState: ai.model.diagnostics.state,
        providerConfigured: ai.providerConfigured,
        lastSuccessAt: strOr(ai.model.diagnostics.lastSuccessAt),
      }
    : null;

  // SECTION 8 — Beauty Rewards (compose certified list loaders; Hearts Approved
  // Today has no certified loader ⇒ UNKNOWN, never fabricated).
  const rewardsFacts = pending || ready || customers
    ? {
        registeredMembers: customers ? numOr(customers.length) : UNKNOWN,
        pendingReviews: pending ? numOr(pending.length) : UNKNOWN,
        heartsApprovedToday: UNKNOWN as Maybe<number>,
        rewardsReady: ready ? numOr(ready.length) : UNKNOWN,
        completedCards: customers ? numOr(customers.reduce((n, c) => n + (Number(c.cyclesCompleted) || 0), 0)) : UNKNOWN,
        latestRegistrations: customers
          ? [...customers]
              .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
              .slice(0, 5)
              .map((c) => ({ name: c.name, phone: c.phone, createdAt: c.createdAt }))
          : null,
      }
    : null;

  // SECTION 10 — Analytics (honest: orders / average order are UNKNOWN; revenue is
  // lifetime-cumulative and inventory value is real).
  const analyticsFacts = analytics
    ? {
        configured: analytics.configured,
        revenue: metricStat("revenue", "الإيراد (تراكمي)", analytics.sales?.lifetime?.revenue, true),
        orders: metricStat("orders", "الطلبات", analytics.kpi?.orders, false),
        averageOrder: { key: "aov", label: "متوسط الطلب", value: UNKNOWN_TEXT, available: false } as HomeTextStat,
        inventoryValue: metricStat("inventory_value", "قيمة المخزون", analytics.inventory?.value?.atPrice, true),
      }
    : null;

  const facts: HomeFacts = {
    now: nowIso,
    ownerName: OWNER_NAME,
    actions: actionsFacts,
    lifecycle: lifecycleFacts,
    catalog: catalogFacts,
    health: healthFacts,
    evidence: evidenceFacts,
    recommendations: recommendationFacts,
    channels: channelFacts,
    exports: exportsFacts,
    ai: aiFacts,
    rewards: rewardsFacts,
    analytics: analyticsFacts,
    activity: activity,
    generatedAt: nowIso,
  };

  return buildHomeDashboard(facts);
});
