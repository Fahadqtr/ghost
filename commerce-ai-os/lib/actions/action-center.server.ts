// AI.1 / CAT.1C — Unified Action Center (server assembler).
//
// READ-ONLY orchestration. It calls ONLY the certified OPS/BI server readers +
// the canonical CAT.1B evidence batch, each wrapped in React.cache so a source
// reads once per request; it adds NO scan of its own, mutates nothing, and shapes
// everything through the pure Action model. Every source is best-effort: a
// failing/degraded reader contributes zero actions and is reported as `ok:false`,
// never a fabricated item.
//
//   • loadActionCenter()        — the PRIMARY aggregated read: canonical CAT.1B
//     Evidence (catalog-quality, per-product) + OPS Health (cross-domain platform
//     roll-up) + BI inventory rollups. Backs the top summary + owner strip.
//   • loadActionCenterDetail()  — the LAZY secondary read: OPS Media duplicate
//     images + lifecycle READY_FOR_ACTIVATION, streamed under Suspense (§9).
//
// CAT.1C — Evidence is the canonical source for catalog-quality actions. The
// overlapping legacy projections (per-product media-missing, AI needsGeneration,
// analytics catalog-quality) were retired in action-sources.ts so one active
// evidence identity yields at most one active Action.

import "server-only";

import { cache } from "react";

import { loadHealthCenter } from "@/lib/operations/health/health-center.server";
import { loadAnalytics } from "@/lib/analytics/analytics-read.server";
import { loadMediaCenter } from "@/lib/operations/media/media-center.server";
import { loadLifecycleActionRows } from "./lifecycle-source.server.ts";
import { loadEvidenceActions } from "./evidence-source.server.ts";

import { actionsFromAnalytics, actionsFromHealth, actionsFromMedia, actionsFromLifecycle } from "./action-sources.ts";
import { actionsFromEvidence } from "./evidence-actions.ts";
import { buildActionCenter, type ActionCenterView, type ActionInput, type ActionSourceStatus } from "./action-model.ts";

// Each certified reader, request-cached so a section and the summary that share a
// source trigger only ONE underlying read per request (no repeated scans, §8/§12).
const getHealth = cache(() => loadHealthCenter());
const getAnalytics = cache(() => loadAnalytics());
const getMedia = cache(() => loadMediaCenter());
const getLifecycle = cache(() => loadLifecycleActionRows());
// CAT.1C — the single bounded evidence batch (shared with the CAT.1B overview).
const getEvidence = cache(() => loadEvidenceActions());

function hasError(v: unknown): v is { error: string } {
  return v !== null && typeof v === "object" && "error" in v;
}

/**
 * PRIMARY read — canonical CAT.1B Evidence + OPS Health + BI inventory. Evidence
 * is the canonical catalog-quality source (one bounded batch, cached); Health is
 * the cross-domain platform roll-up; Analytics contributes inventory rollups only.
 * None needs a live merchant session, so the summary + owner strip populate
 * reliably.
 */
export async function loadActionCenter(now: Date = new Date()): Promise<ActionCenterView> {
  const [healthRes, analytics, evidenceRes] = await Promise.all([
    getHealth().catch(() => ({ error: "health_failed" }) as const),
    getAnalytics().catch(() => null),
    getEvidence().catch(() => null),
  ]);

  const inputs: ActionInput[] = [];
  const sources: ActionSourceStatus[] = [];

  // CAT.1C — canonical evidence is the primary, catalog-quality source.
  const evidenceActions = evidenceRes ? actionsFromEvidence(evidenceRes.evidence, { labels: evidenceRes.labels }) : [];
  inputs.push(...evidenceActions);
  sources.push({ source: "evidence", ok: evidenceRes !== null, count: evidenceActions.length });

  const healthModel = hasError(healthRes) ? null : healthRes.model;
  const healthActions = actionsFromHealth(healthModel);
  inputs.push(...healthActions);
  sources.push({ source: "ops_health", ok: !hasError(healthRes), count: healthActions.length });

  const analyticsActions = actionsFromAnalytics(analytics);
  inputs.push(...analyticsActions);
  sources.push({ source: "analytics", ok: analytics !== null && analytics.configured, count: analyticsActions.length });

  return buildActionCenter(inputs, { sources, generatedAt: now.toISOString() });
}

/**
 * LAZY secondary read — OPS Media duplicate images + lifecycle
 * READY_FOR_ACTIVATION. Streamed under Suspense so the primary summary paints
 * first. Best-effort per source.
 */
export async function loadActionCenterDetail(now: Date = new Date()): Promise<ActionCenterView> {
  const [mediaRes, lifecycleRes] = await Promise.all([
    getMedia().catch(() => ({ error: "media_failed" }) as const),
    getLifecycle().catch(() => null),
  ]);

  const inputs: ActionInput[] = [];
  const sources: ActionSourceStatus[] = [];

  const mediaView = hasError(mediaRes) ? null : mediaRes;
  const mediaActions = actionsFromMedia(mediaView);
  inputs.push(...mediaActions);
  sources.push({ source: "ops_media", ok: !hasError(mediaRes), count: mediaActions.length });

  // OPS.8C — lifecycle actions (READY_FOR_ACTIVATION). Best-effort: a null read
  // contributes zero actions and is reported ok:false, never a fabricated item.
  const lifecycleActions = actionsFromLifecycle(lifecycleRes);
  inputs.push(...lifecycleActions);
  sources.push({ source: "lifecycle", ok: lifecycleRes !== null, count: lifecycleActions.length });

  return buildActionCenter(inputs, { sources, generatedAt: now.toISOString() });
}
