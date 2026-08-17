// AI.1 — Unified Action Center (server assembler).
//
// READ-ONLY orchestration. It calls ONLY the certified OPS/BI server readers,
// each wrapped in React.cache so a source read once per request; it adds NO scan
// of its own, mutates nothing, and shapes everything through the pure Action
// model. Every source is best-effort: a failing/degraded reader contributes zero
// actions and is reported as `ok:false`, never a fabricated item.
//
//   • loadActionCenter()        — the PRIMARY aggregated read (OPS Health +
//     Analytics): catalog-wide health findings + catalog-quality/stock actions.
//     Backs the top summary and the grouped view.
//   • loadActionCenterDetail()  — the LAZY secondary read (OPS Media + OPS AI):
//     product-level image + enrichment queues, streamed under Suspense (§9).

import "server-only";

import { cache } from "react";

import { loadHealthCenter } from "@/lib/operations/health/health-center.server";
import { loadAnalytics } from "@/lib/analytics/analytics-read.server";
import { loadMediaCenter } from "@/lib/operations/media/media-center.server";
import { loadAiCenter } from "@/lib/operations/ai/ai-center.server";
import { EMPTY_AI_FILTERS } from "@/lib/operations/ai/ai-center";
import { loadLifecycleActionRows } from "./lifecycle-source.server.ts";

import { actionsFromAi, actionsFromAnalytics, actionsFromHealth, actionsFromMedia, actionsFromLifecycle } from "./action-sources.ts";
import { buildActionCenter, type ActionCenterView, type ActionInput, type ActionSourceStatus } from "./action-model.ts";

// Each certified reader, request-cached so a section and the summary that share a
// source trigger only ONE underlying read per request (no repeated scans, §8).
const getHealth = cache(() => loadHealthCenter());
const getAnalytics = cache(() => loadAnalytics());
const getMedia = cache(() => loadMediaCenter());
const getAi = cache(() => loadAiCenter(EMPTY_AI_FILTERS));
const getLifecycle = cache(() => loadLifecycleActionRows());

function hasError(v: unknown): v is { error: string } {
  return v !== null && typeof v === "object" && "error" in v;
}

/**
 * PRIMARY read — OPS Health + BI Analytics. These two catalog-side aggregate
 * readers need no live merchant session, so they populate the summary reliably.
 */
export async function loadActionCenter(now: Date = new Date()): Promise<ActionCenterView> {
  const [healthRes, analytics] = await Promise.all([
    getHealth().catch(() => ({ error: "health_failed" }) as const),
    getAnalytics().catch(() => null),
  ]);

  const inputs: ActionInput[] = [];
  const sources: ActionSourceStatus[] = [];

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
 * LAZY secondary read — OPS Media + OPS AI product-level queues. Streamed under
 * Suspense so the primary summary paints first. Best-effort per source.
 */
export async function loadActionCenterDetail(now: Date = new Date()): Promise<ActionCenterView> {
  const [mediaRes, aiRes, lifecycleRes] = await Promise.all([
    getMedia().catch(() => ({ error: "media_failed" }) as const),
    getAi().catch(() => ({ error: "ai_failed" }) as const),
    getLifecycle().catch(() => null),
  ]);

  const inputs: ActionInput[] = [];
  const sources: ActionSourceStatus[] = [];

  const mediaView = hasError(mediaRes) ? null : mediaRes;
  const mediaActions = actionsFromMedia(mediaView);
  inputs.push(...mediaActions);
  sources.push({ source: "ops_media", ok: !hasError(mediaRes), count: mediaActions.length });

  const aiModel = hasError(aiRes) ? null : aiRes.model;
  const aiActions = actionsFromAi(aiModel);
  inputs.push(...aiActions);
  sources.push({ source: "ops_ai", ok: !hasError(aiRes), count: aiActions.length });

  // OPS.8C — lifecycle actions (READY_FOR_ACTIVATION). Best-effort: a null read
  // contributes zero actions and is reported ok:false, never a fabricated item.
  const lifecycleActions = actionsFromLifecycle(lifecycleRes);
  inputs.push(...lifecycleActions);
  sources.push({ source: "lifecycle", ok: lifecycleRes !== null, count: lifecycleActions.length });

  return buildActionCenter(inputs, { sources, generatedAt: now.toISOString() });
}
