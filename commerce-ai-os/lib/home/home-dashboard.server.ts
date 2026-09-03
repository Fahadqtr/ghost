import "server-only";
import { cache } from "react";

import { createClient } from "@/lib/supabase/server";
import { buildHomeDashboard, UNKNOWN } from "./home-model.ts";
import type {
  HomeDashboardModel,
  HomeFacts,
  Maybe,
  ChannelFacts,
  ChannelReadyFact,
  LaunchReadinessFacts,
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
import { loadMasterScope } from "./master-scope.server.ts";
import { scopeRows, type MasterScope } from "./master-scope.ts";
import { scopeActionCenterView } from "@/lib/actions/action-scope";
import { computeMasterReadiness, countMasterGap } from "@/lib/readiness/master-readiness";

const OWNER_NAME = "Fahad";

/**
 * CURRENT OPERATIONAL SCOPE.
 *
 * Every product-derived metric below is measured over the ACTIVE snoonu:malikas
 * master — the same membership /v2/catalog uses — so the two pages can never
 * disagree. The master size is derived per request; no count is hardcoded.
 * Historical and system data (audit history, export runs, AI diagnostics,
 * analytics, rewards) stays deliberately GLOBAL.
 *
 * Products outside the master remain untouched in the database; they are only
 * excluded from current operational counts.
 */

const numOr = (v: unknown): Maybe<number> => (typeof v === "number" && Number.isFinite(v) ? v : UNKNOWN);
const strOr = (v: unknown): Maybe<string> => (typeof v === "string" && v.length > 0 ? v : UNKNOWN);

/**
 * ONE operations scan → lifecycle (Section 4), channel health (Section 5),
 * catalog field gaps and the export-readiness baseline — all measured over the
 * master only. Scoping the scanned items ONCE makes every downstream engine
 * (summary → platform overview → platform health → channel cards) master-scoped
 * without a second query or a second rule.
 */
const getOperations = cache(async (scope: MasterScope) => {
  if (!scope.ok) return null; // fail closed — never fall back to the whole catalog
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
    // ── MASTER SCOPE: filter the scanned universe down to the master ──────────
    const scopedItems = scopeRows(result.data.items, (i) => i.id, scope);
    const scopedReadiness = scopeRows(result.data.readiness ?? [], (r) => r.productId, scope);
    const items = annotateTickTick(scopedItems, new Set<string>());
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
    // Snoonu — Malikas presence, MEASURED (never hardcoded): of the master's
    // members, how many resolve to a live scanned product row. A listing whose
    // product row is gone shows up as "missing" rather than silently inflating.
    const snoonuPresent = scopedItems.length;
    const snoonuMalikasPresence = {
      mapped: snoonuPresent,
      needsMapping: Math.max(0, scope.total - snoonuPresent),
      needsReview: 0,
    };
    const opsCenter = buildOperationsCenter({
      kpis: summary.kpis,
      overview: summary.platformOverview,
      platformHealth,
      items,
      snoonuMalikasPresence,
    });
    // Certified variant blocker: the readiness engine's "missing_variants" reason
    // (a product that expects variants but has none). Counted over the SAME scan —
    // no new scan, no new rule.
    const variantProblems = scopedReadiness.filter(
      (r) => Array.isArray(r.reasons) && r.reasons.some((x) => x.code === "missing_variants"),
    ).length;
    // Catalog field gaps come from the SAME scoped readiness checks rather than
    // from catalog-wide head counts, so Home and /v2/catalog can never disagree
    // (this is what made Home report "needs image 2" while the catalog said 0 —
    // both of those products are outside the master).
    const gaps = {
      total: scopedItems.length,
      needsImage: countMasterGap(scopedReadiness, scope, "image"),
      needsPrice: countMasterGap(scopedReadiness, scope, "price"),
      needsCategory: countMasterGap(scopedReadiness, scope, "category"),
      needsBrand: countMasterGap(scopedReadiness, scope, "brand"),
      needsSku: countMasterGap(scopedReadiness, scope, "sku"),
      needsBarcode: countMasterGap(scopedReadiness, scope, "barcode"),
    };
    // Readiness baseline over the master — the SAME shared counter Launch and
    // Export use, so the three surfaces cannot diverge.
    const baseline = computeMasterReadiness(scopedReadiness, scope);
    return {
      lifecycle: buildLifecycleBreakdown(items, archived),
      channels: opsCenter.channels,
      variantProblems,
      gaps,
      eligible: baseline.ready,
      blocked: baseline.blocked,
      masterTotal: scope.total,
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

  // Membership first — every operational metric below is measured against it.
  const scope = await loadMasterScope();
  const memberIds = scope.ok ? scope.ids : null;

  const [
    action,
    ops,
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
    getOperations(scope),
    loadExportCenter(now).then((r) => ("model" in r ? r.model : null)).catch(() => null),
    loadRecentExportRuns(createClient() as never, "shopify:malikas", 20).catch(() => null),
    loadCatalogHealthDistribution(memberIds).catch(() => null),
    // Both reuse the SAME bounded evidence batch inside the certified loaders;
    // the membership filter is applied there, not re-implemented here.
    loadEvidenceOverview(memberIds).catch(() => null),
    loadRecommendationSummary(memberIds).catch(() => null),
    loadAnalytics(now).catch(() => null),
    loadAiCenter(parseAiFilters({})).then((r) => ("model" in r ? r : null)).catch(() => null),
    listPending().catch(() => null),
    listRewardReady().catch(() => null),
    listCustomers().catch(() => null),
    loadRecentActivity(20).catch(() => null),
  ]);

  // SECTION 2/3 — Action Center (lanes + severity axis), scoped to the master.
  // Product-bound actions outside the master are dropped; catalog-wide actions
  // (entityId null) are kept. The summary is recomputed with the SAME certified
  // pure summarizer over the filtered list — no new counting rule.
  // Uses the SAME shared helper as /v2/actions, so the two surfaces cannot drift
  // onto different membership rules. Semantics are unchanged from #700: keep
  // entity-less (catalog-wide) actions, drop product-bound non-members, and
  // recount with the certified pure summarizer.
  const scopedView = action ? scopeActionCenterView(action, (id) => scope.ids.has(id), scope.ok) : null;
  const scopedActions = scopedView ? scopedView.actions : [];
  const scopedSummary = scopedView ? scopedView.summary : null;
  const actionsFacts = action && scopedSummary
    ? {
        critical: numOr(scopedSummary.critical),
        approvalRequired: numOr(scopedSummary.approvalRequired),
        waiting: numOr(scopedSummary.waiting),
        completedToday: numOr(scopedSummary.completedToday),
        total: numOr(scopedSummary.total),
        high: numOr(scopedActions.filter((a) => a.severity === "warning").length),
        medium: numOr(scopedActions.filter((a) => a.severity === "info").length),
      }
    : null;

  // SECTION 4 — lifecycle (from the single ops scan)
  const lifecycleFacts = ops
    ? { active: numOr(ops.lifecycle.active), draft: numOr(ops.lifecycle.draft), stopped: numOr(ops.lifecycle.stopped), ready: numOr(ops.lifecycle.ready) }
    : null;

  // SECTION 4 — catalog field gaps + ready/blocked, BOTH derived from the one
  // master-scoped operations scan. `getCeoKpis` is deliberately no longer used
  // here: its head counts are catalog-wide and cannot be filtered to membership.
  const eligible: Maybe<number> = ops ? numOr(ops.eligible) : UNKNOWN;
  const blocked: Maybe<number> = ops ? numOr(ops.blocked) : UNKNOWN;
  const catalogFacts = ops
    ? {
        total: numOr(ops.gaps.total),
        ready: eligible,
        blocked,
        needsImage: numOr(ops.gaps.needsImage),
        needsCategory: numOr(ops.gaps.needsCategory),
        needsPrice: numOr(ops.gaps.needsPrice),
        needsBrand: numOr(ops.gaps.needsBrand),
      }
    : null;

  // SECTION 9 — CAT.1A health distribution + CAT.1B evidence + CAT.1D
  // recommendations, all restricted to the master. Evidence and recommendations
  // are derived from ONE shared batch, filtered by membership, then handed to the
  // same certified pure engines.
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
  // Pure Seoul is a SEPARATE storefront, not a Malikas-master channel — it is
  // never expressed against the Malikas denominator.
  const isMasterChannel = (key: string) => key !== "snoonu:pure_seoul";
  const channelFacts: ChannelFacts[] | null = ops
    ? ops.channels.map((c) => ({
        key: c.storefront,
        label: c.label,
        status: channelStatusLabel(c),
        mapped: numOr(c.mapped),
        blocked: numOr(c.needsMapping),
        needsReview: numOr(c.needsReview),
        masterTotal: isMasterChannel(c.storefront) ? numOr(ops.masterTotal) : UNKNOWN,
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

  // SECTION 0 — Launch Readiness facts. Composed ENTIRELY from data already
  // fetched above (export-readiness baseline, ops channels + readiness + lifecycle,
  // getCeoKpis, action center, availability from the analytics snapshot). No new
  // loader, no new scan, no new rule.
  const availabilityBlocked: Maybe<number> =
    analytics && analytics.inventory?.outOfStock?.status === "available" && analytics.inventory.outOfStock.value != null
      ? analytics.inventory.outOfStock.value
      : UNKNOWN;
  const needsReviewTotal: Maybe<number> = ops
    ? ops.channels.reduce((n, c) => n + (Number(c.needsReview) || 0), 0)
    : UNKNOWN;
  const readyChannels: ChannelReadyFact[] = ops
    ? ops.channels.map((c) => ({
        key: c.storefront,
        label: c.label,
        ready: numOr(c.mapped),
        masterTotal: isMasterChannel(c.storefront) ? numOr(ops.masterTotal) : UNKNOWN,
        href: `/v2/export/${encodeURIComponent(c.storefront)}`,
      }))
    : [];
  const launchReadinessFacts: LaunchReadinessFacts | null = ops
    ? {
        exportReady: eligible,
        blocked,
        masterTotal: numOr(ops.masterTotal),
        channels: readyChannels,
        criticalBlockers: numOr(scopedSummary?.critical),
        missingPrice: numOr(ops.gaps.needsPrice),
        missingImage: numOr(ops.gaps.needsImage),
        missingCategory: numOr(ops.gaps.needsCategory),
        variantProblems: ops ? numOr(ops.variantProblems) : UNKNOWN,
        needsReview: needsReviewTotal,
        lifecycleBlocked: ops ? numOr(ops.lifecycle.stopped) : UNKNOWN,
        availabilityBlocked,
      }
    : null;

  const facts: HomeFacts = {
    now: nowIso,
    ownerName: OWNER_NAME,
    launchReadiness: launchReadinessFacts,
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
