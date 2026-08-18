// WAVE.1A — Launch Campaign Workspace composer (PURE).
//
// The operational working screen for the Catalog Completion Campaign. It COMPOSES
// only certified signals: the HOME.2 Launch Readiness view-model (Sections 1/2/6
// aggregates) and the certified Operations readiness reasons (per-product rows).
// It holds NO business logic, NO completion rules and NO health rules — blocker
// classification reuses the certified READINESS_MESSAGES, and wave/priority are a
// deterministic OPERATIONAL ordering of those certified blockers (not a new rule
// defining completeness). No IO, no clock, no random, no writes.
//
// PURE: relative `.ts` imports only; no server-only, no `@/`.

import { READINESS_MESSAGES } from "../../operations/readiness/readiness.ts";
import type { LaunchReadinessVM, Maybe } from "../../home/home-model.ts";
import { UNKNOWN } from "../../home/home-model.ts";

export type WorkWave = 1 | 2 | 3 | 4;
export type WorkPriority = "high" | "medium" | "low";
export type BlockerKey =
  | "image" | "price" | "variants" | "sku" | "barcode"
  | "category" | "review" | "brand" | "other";

/** Minimal per-product input projected from a certified OperationsListItem. */
export interface WorkItemInput {
  id: string;
  sku: string | null;
  name: string | null;
  imageUrl: string | null;
  reasons: readonly string[]; // certified READINESS_MESSAGES strings
  needsImage: boolean;
  needsReview: boolean;
  readinessPercent: number;
  readinessStatus: string; // certified readiness status
  channelMissing: { shopify: boolean; talabat: boolean; snoonu: boolean; rafeeq: boolean };
}

export interface WorkQueueRow {
  id: string;
  sku: string;
  name: string;
  imageUrl: string | null;
  blocker: string; // certified message for the primary blocker
  blockerKey: BlockerKey;
  priority: WorkPriority;
  wave: WorkWave;
  readinessPercent: number;
  href: string; // deep-link to the EXISTING product editor
  channels: { shopify: boolean; talabat: boolean; snoonu: boolean; rafeeq: boolean };
  completed: boolean;
}

export interface WaveProgress {
  wave: WorkWave;
  label: string;
  total: number; // rows whose top blocker is at this wave
}

export interface LaunchWorkspaceModel {
  campaignProgress: {
    readinessPct: Maybe<number>;
    productsRemaining: Maybe<number>;
    completedToday: Maybe<number>; // no certified per-day completion source ⇒ UNKNOWN
    waveProgress: WaveProgress[];
  };
  wave1Queue: {
    missingImages: number;
    missingPrices: number;
    variantProblems: number;
    total: number;
  };
  rows: WorkQueueRow[];
  completionSummary: {
    remaining: Maybe<number>; // certified export-blocked (Launch Readiness)
    completed: Maybe<number>; // certified export-ready (Launch Readiness)
    inQueue: number; // rows currently in the work queue
  };
  generatedAt: string | null;
}

const has = (reasons: readonly string[], code: keyof typeof READINESS_MESSAGES): boolean =>
  reasons.includes(READINESS_MESSAGES[code]);

/** Primary blocker in fixed operational priority order (certified reasons only). */
function primaryBlocker(it: WorkItemInput): { key: BlockerKey; message: string } | null {
  if (it.needsImage || has(it.reasons, "missing_image")) return { key: "image", message: READINESS_MESSAGES.missing_image };
  if (has(it.reasons, "missing_price")) return { key: "price", message: READINESS_MESSAGES.missing_price };
  if (has(it.reasons, "missing_variants")) return { key: "variants", message: READINESS_MESSAGES.missing_variants };
  if (has(it.reasons, "missing_sku") || has(it.reasons, "invalid_sku")) return { key: "sku", message: READINESS_MESSAGES.missing_sku };
  if (has(it.reasons, "missing_barcode") || has(it.reasons, "invalid_barcode")) return { key: "barcode", message: READINESS_MESSAGES.missing_barcode };
  if (has(it.reasons, "missing_category")) return { key: "category", message: READINESS_MESSAGES.missing_category };
  if (it.needsReview || has(it.reasons, "pending_review") || has(it.reasons, "rejected") || has(it.reasons, "not_approved")) return { key: "review", message: READINESS_MESSAGES.pending_review };
  if (has(it.reasons, "missing_brand")) return { key: "brand", message: READINESS_MESSAGES.missing_brand };
  if (it.reasons.length > 0) return { key: "other", message: it.reasons[0]! };
  return null;
}

/** Deterministic OPERATIONAL wave for a blocker (mirrors the campaign waves). */
function waveFor(key: BlockerKey): WorkWave {
  switch (key) {
    case "image": case "price": case "variants": case "sku": case "barcode": return 1;
    case "category": case "review": return 2;
    case "brand": return 3;
    default: return 4;
  }
}

function priorityFor(wave: WorkWave): WorkPriority {
  return wave === 1 ? "high" : wave === 2 ? "medium" : "low";
}

/** Deep-link to the EXISTING product editor (no new editing UI is minted). */
export function productEditorHref(id: string): string {
  return `/v2/catalog/${encodeURIComponent(id)}`;
}

const WAVE_LABEL: Record<WorkWave, string> = {
  1: "الموجة ١ — معوّقات حرجة",
  2: "الموجة ٢ — معوّقات النشر",
  3: "الموجة ٣ — تحسين الجودة",
  4: "الموجة ٤ — تحسين SEO",
};

export interface LaunchWorkspaceFacts {
  launchReadiness: LaunchReadinessVM;
  items: readonly WorkItemInput[];
  generatedAt: string | null;
}

export function buildLaunchWorkspace(facts: LaunchWorkspaceFacts): LaunchWorkspaceModel {
  const lr = facts?.launchReadiness;
  const items = Array.isArray(facts?.items) ? facts.items : [];

  const rows: WorkQueueRow[] = [];
  for (const it of items) {
    const pb = primaryBlocker(it);
    if (!pb) continue; // completed products are not in the work queue
    const wave = waveFor(pb.key);
    rows.push({
      id: it.id,
      sku: it.sku ?? "—",
      name: it.name ?? "—",
      imageUrl: it.imageUrl ?? null,
      blocker: pb.message,
      blockerKey: pb.key,
      priority: priorityFor(wave),
      wave,
      readinessPercent: Number.isFinite(it.readinessPercent) ? it.readinessPercent : 0,
      href: productEditorHref(it.id),
      channels: { ...it.channelMissing },
      completed: false,
    });
  }
  // Stable ordering: wave asc, then lowest readiness first (most work), then SKU.
  rows.sort((a, b) => a.wave - b.wave || a.readinessPercent - b.readinessPercent || a.sku.localeCompare(b.sku));

  const wave1 = rows.filter((r) => r.wave === 1);
  const wave1Queue = {
    missingImages: rows.filter((r) => r.blockerKey === "image").length,
    missingPrices: rows.filter((r) => r.blockerKey === "price").length,
    variantProblems: rows.filter((r) => r.blockerKey === "variants").length,
    total: wave1.length,
  };

  const waveProgress: WaveProgress[] = ([1, 2, 3, 4] as WorkWave[]).map((w) => ({
    wave: w,
    label: WAVE_LABEL[w],
    total: rows.filter((r) => r.wave === w).length,
  }));

  return {
    campaignProgress: {
      readinessPct: lr?.readinessPct ?? UNKNOWN,
      productsRemaining: lr?.progress?.productsRemaining ?? UNKNOWN,
      completedToday: UNKNOWN, // no certified per-day completion source — never fabricated
      waveProgress,
    },
    wave1Queue,
    rows,
    completionSummary: {
      remaining: lr?.progress?.productsRemaining ?? UNKNOWN,
      completed: lr && lr.headline.find((c) => c.key === "export_ready")
        ? (lr.headline.find((c) => c.key === "export_ready")!.value)
        : UNKNOWN,
      inQueue: rows.length,
    },
    generatedAt: facts?.generatedAt ?? null,
  };
}
