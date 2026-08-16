// BI.2 — Executive Dashboard (server assembler).
//
// Read-only. Composes existing read layers only — it never queries a business
// table directly, never re-derives an analytics metric, and never mutates:
//
//   • loadExecutiveDashboard() makes the SINGLE analytics request (BI.1
//     loadAnalytics) and shapes it via the pure buildExecutiveDashboard. This
//     backs the KPI header, Sales, Inventory, Catalog Quality and Operations
//     Summary — no repeated metric loading.
//   • The heavier operational widgets are lazy: getDashboardHealth (OPS.6
//     loadHealthCenter) and getDashboardChannels (OPS.3 loadChannelCenter) are
//     each React-cached so a section and the header chip that share a source
//     trigger only ONE underlying read per request.

import "server-only";

import { cache } from "react";

import { loadAnalytics } from "./analytics-read.server.ts";
import { buildExecutiveDashboard, type ExecutiveDashboardView } from "./executive-dashboard.ts";
import { loadHealthCenter } from "@/lib/operations/health/health-center.server";
import { loadChannelCenter } from "@/lib/operations/channels/channel-center.server";

/**
 * The single analytics request. Shapes the BI.1 snapshot into the dashboard's
 * primary (analytics-backed) view model.
 */
export async function loadExecutiveDashboard(now: Date = new Date()): Promise<ExecutiveDashboardView> {
  const snapshot = await loadAnalytics(now);
  return buildExecutiveDashboard(snapshot);
}

/**
 * OPS.6 Platform Health, request-cached so the KPI-header health chip and the
 * Health/Alerts section load it once. Returns the certified view or an error.
 */
export const getDashboardHealth = cache(() => loadHealthCenter());

/**
 * OPS.3 Channel Command Center, request-cached. Backs the Channel Overview
 * section (per-storefront cards). Read-only, unfiltered (dashboard summary view).
 */
export const getDashboardChannels = cache(() => loadChannelCenter());
