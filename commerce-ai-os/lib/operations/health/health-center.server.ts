import "server-only";
// OPS.6 — Platform Health Center assembler (SERVER-ONLY, READ-ONLY).
//
// One bounded assembly for /v2/operations/health. It performs the SAME single
// aggregated read the operations pages use (loadOperationsDashboard) and feeds it
// to BOTH the catalog signals AND the pure OPS.3 channel composer — no second
// dashboard read. It adds the OPS.4 bounded channel gap counts + snoonu session
// state, and a small set of COUNT-only head queries for the remaining domains. It
// issues NO writes and runs NO heavy scanner inline (reconciliation, ECL dup/
// orphan, media gallery, AI classify are deep-linked). Query cost per load:
//   • 1 aggregated read  — loadOperationsDashboard
//   • ~7 head counts      — loadChannelGapCounts (ECL/channels)
//   • 1 session call      — loadSnoonuMalikasOperational
//   • ~7 head counts      — loadHealthSignals (archived / keywords / availability /
//                           negative-qty / recent-failures)
//   = 1 aggregated + ~15 COUNT-only queries, all parallel, fixed cost.

import { createClient } from "@/lib/supabase/server";
import { isSignedIn } from "@/lib/auth/requireUser";
import { safeError } from "@/lib/security/safe-error";
import { loadOperationsDashboard } from "@/lib/operations/read-model";
import { loadShopifyPresence } from "@/lib/operations/shopify-presence";
import { loadShopifySnapshotView } from "@/lib/platforms/shopify/snapshot-presence";
import { loadPureSoulPresence } from "@/lib/platforms/puresoul/presence";
import { loadPureSoulSnapshotView } from "@/lib/platforms/puresoul/snapshot-presence";
import { loadTalabatSnapshotView } from "@/lib/platforms/talabat/snapshot-presence";
import { loadRafeeqSnapshotView } from "@/lib/platforms/rafeeq/snapshot-presence";
import { buildDashboardSummary } from "@/lib/operations/dashboard-summary";
import { buildPlatformHealth } from "@/lib/operations/platform-health";
import type { OperationsListItem } from "@/lib/operations/dashboard-view";
import { buildChannelCenter, type CcItem, type CcOverview, type ChannelCenterInput } from "@/lib/operations/channels/channel-center";
import { loadChannelGapCounts } from "@/lib/operations/channels/gap-counts.server";
import { loadSnoonuMalikasOperational } from "@/lib/operations/channels/snoonu-malikas-reader.server";
import { READINESS_MESSAGES } from "@/lib/operations/readiness/readiness";

const REASON_MISSING_BARCODE = READINESS_MESSAGES.missing_barcode;
const REASON_MISSING_DESCRIPTION = READINESS_MESSAGES.missing_description;
import {
  buildHealthCenter,
  type HealthCenterModel,
  type HealthSignals,
  type ChannelStorefrontSignal,
  type DomainStatus,
} from "./health-center.ts";

const NOT_SIGNED_IN = "غير مسجّل الدخول.";
const LOAD_FAILED = "تعذّر تحميل مركز الصحة.";

const OWNER_EMAIL = "clanqtr@gmail.com"; // mirror of authz OWNER_EMAIL (always a writer)

interface CountResult { count: number | null; error: unknown | null }
interface CountBuilder extends PromiseLike<CountResult> {
  eq(c: string, v: string): CountBuilder;
  lt(c: string, v: number): CountBuilder;
  is(c: string, v: null): CountBuilder;
  or(f: string): CountBuilder;
}
interface Selectable { select(cols: string, opts: { count: "exact"; head: true }): CountBuilder }
interface HealthCountClient { from(table: string): Selectable }

async function headCount(b: CountBuilder): Promise<number | null> {
  try {
    const { count, error } = await b;
    return error ? null : count ?? 0;
  } catch {
    return null;
  }
}

interface HealthBoundedSignals {
  archived: number | null;
  keywordsMissing: number | null;
  availabilityUnknown: number | null;
  negativeInventory: number | null;
  negativeVariant: number | null;
  recentFailures: number | null;
}

/** The small bounded (COUNT-only) reads for the domains not covered by the
 *  dashboard/gap-count aggregates. Each degrades to null (UNKNOWN) on failure —
 *  never to 0. No heavy scan, no row transfer. */
async function loadHealthSignals(client: HealthCountClient): Promise<HealthBoundedSignals> {
  const [archived, kwEn, kwAr, availabilityUnknown, negativeInventory, negativeVariant, recentFailures] = await Promise.all([
    headCount(client.from("products").select("id", { count: "exact", head: true }).eq("platform_status", "Archived")),
    headCount(client.from("products").select("id", { count: "exact", head: true }).is("keywords_en", null)),
    headCount(client.from("products").select("id", { count: "exact", head: true }).is("keywords_ar", null)),
    headCount(client.from("products").select("id", { count: "exact", head: true }).is("stock_status", null)),
    headCount(client.from("inventory").select("id", { count: "exact", head: true }).lt("stock_quantity", 0)),
    headCount(client.from("product_variants").select("id", { count: "exact", head: true }).lt("stock_quantity", 0)),
    headCount(client.from("malak_audit").select("id", { count: "exact", head: true }).eq("status", "failed")),
  ]);
  const keywordsMissing = kwEn === null && kwAr === null ? null : (kwEn ?? 0) + (kwAr ?? 0);
  return { archived, keywordsMissing, availabilityUnknown, negativeInventory, negativeVariant, recentFailures };
}

function shopifyStatusOf(i: OperationsListItem): string | null {
  return i.platforms.find((p) => p.platform === "shopify")?.status ?? null;
}
function toCcItem(i: OperationsListItem): CcItem {
  return {
    id: i.id, sku: i.sku, barcode: i.barcode, nameAr: i.nameAr, nameEn: i.nameEn,
    brandId: (i as { brandId?: string | null }).brandId ?? null, category: (i as { category?: string | null }).category ?? null,
    readinessPercent: i.readinessPercent, needsImage: i.needsImage, needsReview: i.needsReview, reasons: i.reasons,
    shopifyStatus: shopifyStatusOf(i), puresoulState: i.puresoulState, talabatState: i.talabatState, rafeeqState: i.rafeeqState,
  };
}
const countReason = (items: readonly OperationsListItem[], msg: string): number => items.reduce((n, it) => (it.reasons.includes(msg) ? n + 1 : n), 0);

export interface HealthCenterView {
  model: HealthCenterModel;
  degraded: boolean;
}

export async function loadHealthCenter(): Promise<HealthCenterView | { error: string }> {
  if (!(await isSignedIn())) return { error: NOT_SIGNED_IN };
  try {
    const supabase = createClient();
    const result = await loadOperationsDashboard(supabase as never, {
      shopify: { loadShopifyPresence },
      shopifySnapshot: { loadShopifySnapshotView: (c) => loadShopifySnapshotView(c as never) },
      puresoul: { loadPureSoulPresence: (c) => loadPureSoulPresence(c as never) },
      puresoulSnapshot: { loadPureSoulSnapshotView: (c) => loadPureSoulSnapshotView(c as never) },
      talabatSnapshot: { loadTalabatSnapshotView: (c) => loadTalabatSnapshotView(c as never) },
      rafeeqSnapshot: { loadRafeeqSnapshotView: (c) => loadRafeeqSnapshotView(c as never) },
    });
    if (result.status !== "ok") return { error: LOAD_FAILED };

    const items = result.data.items;
    const summary = buildDashboardSummary(
      items, result.data.health, result.data.shopifyAvailable,
      { available: result.data.puresoulAvailable, lastCapturedAt: result.data.puresoulLastCapturedAt, stale: result.data.puresoulStale },
      undefined,
      { lastCapturedAt: result.data.shopifyLastCapturedAt, stale: result.data.shopifyStale },
      { available: result.data.talabatAvailable, lastCapturedAt: result.data.talabatLastCapturedAt, stale: result.data.talabatStale },
      { available: result.data.rafeeqAvailable, lastCapturedAt: result.data.rafeeqLastCapturedAt, stale: result.data.rafeeqStale },
    );
    const platformHealth = buildPlatformHealth(summary.platformOverview, summary.kpis.totalProducts, { puresoul: result.data.puresoulDegraded, talabat: result.data.talabatDegraded, rafeeq: result.data.rafeeqDegraded }, new Date().getTime());
    const ov = summary.platformOverview;
    const overview: CcOverview = {
      shopify: { available: ov.shopify.available, published: ov.shopify.published, missing: ov.shopify.missing, different: ov.shopify.different, reviewRequired: ov.shopify.reviewRequired, stale: ov.shopify.stale, lastCapturedAt: ov.shopify.lastCapturedAt },
      puresoul: { available: ov.puresoul.available, published: ov.puresoul.published, missing: ov.puresoul.missing, priceDifferent: ov.puresoul.priceDifferent, reviewRequired: ov.puresoul.reviewRequired, outOfStock: ov.puresoul.outOfStock, stale: ov.puresoul.stale, lastCapturedAt: ov.puresoul.lastCapturedAt },
      talabat: { available: ov.talabat.available, present: ov.talabat.present, missing: ov.talabat.missing, review: ov.talabat.review, linked: ov.talabat.linked, stale: ov.talabat.stale, lastCapturedAt: ov.talabat.lastCapturedAt },
      rafeeq: { available: ov.rafeeq.available, present: ov.rafeeq.present, missing: ov.rafeeq.missing, linked: ov.rafeeq.linked, stale: ov.rafeeq.stale, lastCapturedAt: ov.rafeeq.lastCapturedAt },
    };

    // Parallel bounded reads (OPS.4 channel gaps + snoonu session + OPS.6 head counts).
    const shopifyPresence = { available: ov.shopify.available, mapped: ov.shopify.published, missing: ov.shopify.missing, review: ov.shopify.reviewRequired };
    const [gapCounts, snoonuMalikas, bounded] = await Promise.all([
      loadChannelGapCounts(supabase as never, shopifyPresence),
      loadSnoonuMalikasOperational(),
      loadHealthSignals(supabase as unknown as HealthCountClient),
    ]);

    // Reuse the OPS.3 pure channel composer (no extra read) for storefront states.
    const ccItems: CcItem[] = items.map(toCcItem);
    const channelInput: ChannelCenterInput = {
      kpis: { totalProducts: summary.kpis.totalProducts, needsImage: summary.kpis.needsImage, needsReview: summary.kpis.needsReview, ready: summary.kpis.ready, readinessAverage: summary.kpis.readinessAverage },
      overview,
      platformHealth: platformHealth.map((h) => ({ platform: h.platform, freshnessState: h.freshnessState, healthLevel: h.healthLevel, reasons: h.reasons })),
      items: ccItems,
      degraded: { puresoul: result.data.puresoulDegraded, talabat: result.data.talabatDegraded, rafeeq: result.data.rafeeqDegraded },
      snoonuMalikas,
      gapCounts,
    };
    const channelModel = buildChannelCenter(channelInput);
    const channels: ChannelStorefrontSignal[] = channelModel.storefronts.map((c) => ({
      key: c.key, label: c.label, status: c.status as DomainStatus,
      missingMappings: c.missingMappings, needsReview: c.needsReview, conflicts: c.conflicts, operationalBlocked: c.operationalBlocked,
    }));

    // ECL totals from the bounded gap counts (active + needs_review per storefront).
    let eclActive = 0, eclReview = 0, eclSeen = false;
    for (const g of Object.values(gapCounts)) {
      if (g.source === "ecl") {
        eclSeen = true;
        eclActive += g.mapped ?? 0;
        eclReview += g.needsReview ?? 0;
      }
    }

    const totalProducts = summary.kpis.totalProducts;
    const providerConfigured = !!process.env.ANTHROPIC_API_KEY;
    const extraWriterCount = (process.env.MALAK_WRITER_EMAILS || "").split(",").map((t) => t.trim()).filter(Boolean).length;

    const signals: HealthSignals = {
      catalog: {
        total: totalProducts,
        active: bounded.archived === null ? null : Math.max(0, totalProducts - bounded.archived),
        archived: bounded.archived,
        missingImages: summary.kpis.needsImage,
        missingBarcode: countReason(items, REASON_MISSING_BARCODE),
        missingDescription: countReason(items, REASON_MISSING_DESCRIPTION),
      },
      inventory: { negativeInventory: bounded.negativeInventory, negativeVariant: bounded.negativeVariant },
      availability: { total: totalProducts, unknown: bounded.availabilityUnknown, drift: ov.shopify.different + ov.puresoul.priceDifferent },
      channels,
      ai: { missingKeywords: bounded.keywordsMissing, missingDescriptions: countReason(items, REASON_MISSING_DESCRIPTION), providerConfigured },
      media: { missingImages: summary.kpis.needsImage },
      ecl: { totalMappings: eclSeen ? eclActive + eclReview : null, active: eclSeen ? eclActive : null, needsReview: eclSeen ? eclReview : null },
      security: { ownerConfigured: OWNER_EMAIL.length > 0, extraWriterCount, strictEnforcementCertified: true },
      system: { vercelEnv: process.env.VERCEL_ENV ?? null, providerConfigured, recentFailures: bounded.recentFailures, snoonuSessionState: snoonuMalikas.state },
    };

    return { model: buildHealthCenter(signals), degraded: result.data.partial };
  } catch (e) {
    return { error: safeError("ops6_health_load", e, LOAD_FAILED) };
  }
}
