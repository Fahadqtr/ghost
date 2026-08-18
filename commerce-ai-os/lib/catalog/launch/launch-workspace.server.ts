import "server-only";
import { cache } from "react";

import { createClient } from "@/lib/supabase/server";
import { buildLaunchWorkspace } from "./launch-workspace.ts";
import type { LaunchWorkspaceModel, WorkItemInput } from "./launch-workspace.ts";

// REUSE — the HOME.2 Launch Readiness pure composer + its facts contract.
import { buildLaunchReadiness, UNKNOWN } from "@/lib/home/home-model";
import type { LaunchReadinessFacts, ChannelReadyFact, Maybe } from "@/lib/home/home-model";

// REUSE — the certified operations + export + catalog + analytics read models.
import { loadOperationsDashboard } from "@/lib/operations/read-model";
import { buildDashboardSummary, annotateTickTick } from "@/lib/operations/dashboard-summary";
import { buildPlatformHealth } from "@/lib/operations/platform-health";
import { buildOperationsCenter } from "@/lib/operations/ops-center";
import { buildLifecycleBreakdown } from "@/lib/operations/lifecycle-signal";
import { loadShopifySnapshotView } from "@/lib/platforms/shopify/snapshot-presence";
import { loadPureSoulSnapshotView } from "@/lib/platforms/puresoul/snapshot-presence";
import { loadTalabatSnapshotView } from "@/lib/platforms/talabat/snapshot-presence";
import { loadRafeeqSnapshotView } from "@/lib/platforms/rafeeq/snapshot-presence";
import type { OperationsListItem } from "@/lib/operations/dashboard-view";
import { getCeoKpis } from "@/lib/dashboard";
import { loadExportCenter } from "@/lib/export/export-center.server";
import { loadActionCenter } from "@/lib/actions/action-center.server";
import { loadAnalytics } from "@/lib/analytics/analytics-read.server";

const numOr = (v: unknown): Maybe<number> => (typeof v === "number" && Number.isFinite(v) ? v : UNKNOWN);

/**
 * ONE operations scan for the whole workspace (snapshot-only readers — no live
 * Shopify/PureSoul API, no capture). React.cache-wrapped so the launch-readiness
 * facts AND the per-row projection share a SINGLE scan on the request.
 */
const loadOps = cache(async () => {
  try {
    const supabase = createClient();
    const result = await loadOperationsDashboard(supabase as never, {
      shopifySnapshot: { loadShopifySnapshotView: (c) => loadShopifySnapshotView(c as never) },
      puresoulSnapshot: { loadPureSoulSnapshotView: (c) => loadPureSoulSnapshotView(c as never) },
      talabatSnapshot: { loadTalabatSnapshotView: (c) => loadTalabatSnapshotView(c as never) },
      rafeeqSnapshot: { loadRafeeqSnapshotView: (c) => loadRafeeqSnapshotView(c as never) },
    });
    if (result.status !== "ok") return null;
    const items = annotateTickTick(result.data.items, new Set<string>());
    const summary = buildDashboardSummary(
      items, result.data.health, result.data.shopifyAvailable,
      { available: result.data.puresoulAvailable, lastCapturedAt: result.data.puresoulLastCapturedAt, stale: result.data.puresoulStale },
      undefined,
      { lastCapturedAt: result.data.shopifyLastCapturedAt, stale: result.data.shopifyStale },
      { available: result.data.talabatAvailable, lastCapturedAt: result.data.talabatLastCapturedAt, stale: result.data.talabatStale },
      { available: result.data.rafeeqAvailable, lastCapturedAt: result.data.rafeeqLastCapturedAt, stale: result.data.rafeeqStale },
    );
    const platformHealth = buildPlatformHealth(
      summary.platformOverview, summary.kpis.totalProducts,
      { puresoul: result.data.puresoulDegraded, talabat: result.data.talabatDegraded, rafeeq: result.data.rafeeqDegraded }, 0,
    );
    const opsCenter = buildOperationsCenter({ kpis: summary.kpis, overview: summary.platformOverview, platformHealth, items });
    const variantProblems = (result.data.readiness ?? []).filter(
      (r) => Array.isArray(r.reasons) && r.reasons.some((x) => x.code === "missing_variants"),
    ).length;
    let archived = 0;
    try {
      const { count } = await supabase.from("product_archive").select("id", { count: "exact", head: true });
      if (typeof count === "number") archived = count;
    } catch { archived = 0; }
    return {
      items: items as OperationsListItem[],
      channels: opsCenter.channels,
      lifecycle: buildLifecycleBreakdown(items, archived),
      variantProblems,
    };
  } catch {
    return null;
  }
});

const channelMissing = (it: OperationsListItem) => {
  const shopify = it.platforms?.some((p) => p.platform === "shopify" && (p.status === "missing" || p.status === "different")) ?? false;
  return {
    shopify,
    talabat: it.talabatState === "missing",
    snoonu: it.puresoulState === "missing",
    rafeeq: it.rafeeqState === "missing",
  };
};

/** Single shared read model for /v2/catalog/launch. */
export const loadLaunchWorkspace = cache(async (now: Date = new Date()): Promise<LaunchWorkspaceModel> => {
  const [ops, exportCenter, ceo, action, analytics] = await Promise.all([
    loadOps(),
    loadExportCenter(now).then((r) => ("model" in r ? r.model : null)).catch(() => null),
    getCeoKpis().catch(() => null),
    loadActionCenter(now).catch(() => null),
    loadAnalytics(now).catch(() => null),
  ]);

  const eligible: Maybe<number> = exportCenter && typeof exportCenter.readinessBaseline.eligible === "number" ? exportCenter.readinessBaseline.eligible : UNKNOWN;
  const blocked: Maybe<number> = exportCenter && typeof exportCenter.readinessBaseline.blocked === "number" ? exportCenter.readinessBaseline.blocked : UNKNOWN;
  const availabilityBlocked: Maybe<number> =
    analytics && analytics.inventory?.outOfStock?.status === "available" && analytics.inventory.outOfStock.value != null
      ? analytics.inventory.outOfStock.value
      : UNKNOWN;
  const readyChannels: ChannelReadyFact[] = ops
    ? ops.channels.map((c) => ({ key: c.storefront, label: c.label, ready: numOr(c.mapped), href: `/v2/export/${encodeURIComponent(c.storefront)}` }))
    : [];

  // REUSE the HOME.2 Launch Readiness composer (same certified facts as HOME.2).
  const launchReadiness = buildLaunchReadiness(
    ops || exportCenter
      ? ({
          exportReady: eligible,
          blocked,
          channels: readyChannels,
          criticalBlockers: numOr(action?.summary.critical),
          missingPrice: numOr(ceo?.missingPrice),
          missingImage: numOr(ceo?.missingImage),
          missingCategory: numOr(ceo?.missingCategory),
          variantProblems: ops ? numOr(ops.variantProblems) : UNKNOWN,
          needsReview: ops ? ops.channels.reduce((n, c) => n + (Number(c.needsReview) || 0), 0) : UNKNOWN,
          lifecycleBlocked: ops ? numOr(ops.lifecycle.stopped) : UNKNOWN,
          availabilityBlocked,
        } satisfies LaunchReadinessFacts)
      : null,
  );

  const workItems: WorkItemInput[] = ops
    ? ops.items.map((it) => ({
        id: it.id,
        sku: it.sku,
        name: it.nameEn ?? it.nameAr,
        imageUrl: it.imageUrl,
        reasons: it.reasons,
        needsImage: it.needsImage,
        needsReview: it.needsReview,
        readinessPercent: it.readinessPercent,
        readinessStatus: String(it.readinessStatus),
        channelMissing: channelMissing(it),
      }))
    : [];

  return buildLaunchWorkspace({ launchReadiness, items: workItems, generatedAt: now.toISOString() });
});
