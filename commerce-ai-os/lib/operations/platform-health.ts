// Malikas V2 — Commerce Intelligence CI.4: Platform Freshness & Health (PURE).
//
// A platform-LEVEL freshness + health model for /v2/operations, built ONLY from
// data the dashboard already assembles: the four *Overview count structs, the
// per-platform availability/degraded flags, and the total product count. It adds
// NO readers, NO queries, NO snapshot access and NO clock — `now` is injected by
// the caller, exactly like buildProductPlatformMatrix (CI.1).
//
// Honesty invariants (never violated here):
//   • unknown ≠ missing — unknownCount NEVER pushes a platform to needs_attention.
//   • stale never mutates counts — it is a freshness reason, not a missing verdict.
//   • degraded / unavailable never becomes missing — it is its own reason and
//     forces insufficient_data (we cannot assess what we could not read).
//   • no false precision — healthScore stays null in CI.4 v1 (categorical only).
//
// Freshness reuses the EXISTING per-platform stale windows — no new absolute
// threshold: Shopify/PureSoul 24h, Talabat/Rafeeq 7d. `aging` is the first half
// of that same window (an early-warning band, DERIVED, not a new constant).

import type { PlatformType } from "./shared/models.ts";
import { PLATFORM_LABELS } from "./platforms/platform-status.ts";
import type { PlatformOverview } from "./dashboard-summary.ts";
import { PURESOUL_SNAPSHOT_STALE_MS } from "../platforms/puresoul/capture-compute.ts";
import { SHOPIFY_SNAPSHOT_STALE_MS } from "../platforms/shopify/capture-compute.ts";
import { TALABAT_SNAPSHOT_STALE_MS } from "../platforms/talabat/capture-compute.ts";
import { RAFEEQ_SNAPSHOT_STALE_MS } from "../platforms/rafeeq/capture-compute.ts";

export type FreshnessState = "fresh" | "aging" | "stale" | "unknown";

export type HealthLevel = "healthy" | "needs_attention" | "insufficient_data";

export type HealthReason =
  | "degraded_read"
  | "low_coverage"
  | "no_snapshot"
  | "stale_data"
  | "aging_data"
  | "has_missing"
  | "has_review"
  | "has_drift"
  | "has_ready_not_live";

export interface PlatformHealth {
  platform: PlatformType;
  label: string;
  freshnessState: FreshnessState;
  healthLevel: HealthLevel;
  /** null in CI.4 v1 — categorical only, no false precision (see module header). */
  healthScore: number | null;
  lastSnapshotAt: string | null;
  presentCount: number;
  missingCount: number;
  reviewCount: number;
  differentCount: number;
  readyCount: number;
  unknownCount: number;
  knownCount: number;
  reasons: HealthReason[];
}

/** Fraction of the stale window after which a still-fresh snapshot is "aging".
 *  DERIVED from the EXISTING per-platform window — NOT a new absolute threshold. */
export const AGING_FRACTION = 0.5;

/** Normalized per-platform input — the pure builder never sees a platform's own
 *  state enum, only these uniform MatrixState-aligned buckets + freshness
 *  primitives. Normalization lives in buildPlatformHealth (below). */
export interface PlatformHealthInput {
  platform: PlatformType;
  /** a trusted read carried data */
  available: boolean;
  /** the read FAILED (degraded) — forces insufficient_data, never missing */
  degraded: boolean;
  lastSnapshotAt: string | null;
  /** the platform's EXISTING stale window (ms) — drives both stale + aging */
  staleWindowMs: number;
  presentCount: number;
  missingCount: number;
  reviewCount: number;
  differentCount: number;
  readyCount: number;
  unknownCount: number;
}

/** Freshness from the existing window only. `unknown` when the read cannot be
 *  trusted (unavailable/degraded) or nothing was ever captured. Deterministic:
 *  it reads `now` from the argument, never a hidden clock. */
export function computeFreshnessState(input: PlatformHealthInput, now: number): FreshnessState {
  if (!input.available || input.degraded) return "unknown";
  if (input.lastSnapshotAt === null) return "unknown";
  const t = Date.parse(input.lastSnapshotAt);
  if (!Number.isFinite(t)) return "unknown";
  const elapsed = now - t;
  if (elapsed > input.staleWindowMs) return "stale";
  if (elapsed > input.staleWindowMs * AGING_FRACTION) return "aging";
  return "fresh";
}

/** One platform's health from its normalized input + injected clock. PURE. */
export function computePlatformHealth(input: PlatformHealthInput, now: number): PlatformHealth {
  const knownCount =
    input.presentCount +
    input.missingCount +
    input.reviewCount +
    input.differentCount +
    input.readyCount;
  const freshnessState = computeFreshnessState(input, now);

  const base = {
    platform: input.platform,
    label: PLATFORM_LABELS[input.platform],
    freshnessState,
    healthScore: null as number | null, // CI.4 v1 — categorical only
    lastSnapshotAt: input.lastSnapshotAt,
    presentCount: input.presentCount,
    missingCount: input.missingCount,
    reviewCount: input.reviewCount,
    differentCount: input.differentCount,
    readyCount: input.readyCount,
    unknownCount: input.unknownCount,
    knownCount,
  };

  // insufficient_data — we cannot assess health from an untrusted / empty read.
  // Order: an unavailable/degraded read is the strongest signal, then a snapshot
  // source with no capture, then a trusted read that carried no known state.
  if (!input.available || input.degraded) {
    return { ...base, healthLevel: "insufficient_data", reasons: ["degraded_read"] };
  }
  if (input.lastSnapshotAt === null) {
    return { ...base, healthLevel: "insufficient_data", reasons: ["no_snapshot"] };
  }
  if (knownCount === 0) {
    return { ...base, healthLevel: "insufficient_data", reasons: ["low_coverage"] };
  }

  // Trusted data — assess. unknownCount is DELIBERATELY not an attention trigger
  // (unknown ≠ missing), and stale is a freshness reason that never mutates counts.
  const attention: HealthReason[] = [];
  if (input.missingCount > 0) attention.push("has_missing");
  if (input.reviewCount > 0) attention.push("has_review");
  if (input.differentCount > 0) attention.push("has_drift");
  if (input.readyCount > 0) attention.push("has_ready_not_live");
  if (freshnessState === "stale") attention.push("stale_data");

  const reasons: HealthReason[] = [...attention];
  if (freshnessState === "aging") reasons.push("aging_data"); // stays healthy, surfaced

  return {
    ...base,
    healthLevel: attention.length > 0 ? "needs_attention" : "healthy",
    reasons,
  };
}

/** Per-platform degraded flags — Shopify has none (its unavailability is already
 *  expressed as overview.shopify.available=false). */
export interface PlatformDegradedFlags {
  puresoul: boolean;
  talabat: boolean;
  rafeeq: boolean;
}

/** Assemble platform-level health from the ALREADY-computed dashboard overview
 *  (zero new reads). Count normalization lives here (never in the UI):
 *   • Shopify has no `unknown` count → DERIVED as max(0, total − knownSum).
 *   • PureSoul out-of-stock is a listed (present) product, not a problem bucket;
 *     `different` == priceDifferent this phase; it has no ready/linked baseline.
 *   • Talabat/Rafeeq `linked` maps to ready; Rafeeq has no review/different.
 *  Returned in the fixed UI order: PureSoul, Shopify, Talabat, Rafeeq. */
export function buildPlatformHealth(
  overview: PlatformOverview,
  totalProducts: number,
  degraded: PlatformDegradedFlags,
  now: number,
): PlatformHealth[] {
  const s = overview.shopify;
  const shopifyKnown = s.published + s.missing + s.different + s.reviewRequired + s.ready;
  const shopify = computePlatformHealth(
    {
      platform: "shopify",
      available: s.available,
      degraded: false, // Shopify has no degraded flag — unavailability is available=false
      lastSnapshotAt: s.lastCapturedAt,
      staleWindowMs: SHOPIFY_SNAPSHOT_STALE_MS,
      presentCount: s.published,
      missingCount: s.missing,
      reviewCount: s.reviewRequired,
      differentCount: s.different,
      readyCount: s.ready,
      unknownCount: Math.max(0, totalProducts - shopifyKnown),
    },
    now,
  );

  const p = overview.puresoul;
  const puresoul = computePlatformHealth(
    {
      platform: "puresoul",
      available: p.available,
      degraded: degraded.puresoul,
      lastSnapshotAt: p.lastCapturedAt,
      staleWindowMs: PURESOUL_SNAPSHOT_STALE_MS,
      presentCount: p.published + p.outOfStock, // out-of-stock is listed, not a problem
      missingCount: p.missing,
      reviewCount: p.reviewRequired,
      differentCount: p.different, // == priceDifferent this phase
      readyCount: 0, // PureSoul has no ready/linked baseline
      unknownCount: p.unknown,
    },
    now,
  );

  const t = overview.talabat;
  const talabat = computePlatformHealth(
    {
      platform: "talabat",
      available: t.available,
      degraded: degraded.talabat,
      lastSnapshotAt: t.lastCapturedAt,
      staleWindowMs: TALABAT_SNAPSHOT_STALE_MS,
      presentCount: t.present,
      missingCount: t.missing,
      reviewCount: t.review,
      differentCount: 0,
      readyCount: t.linked, // confirmed mapping only — ready, never present
      unknownCount: t.unknown,
    },
    now,
  );

  const r = overview.rafeeq;
  const rafeeq = computePlatformHealth(
    {
      platform: "rafeeq",
      available: r.available,
      degraded: degraded.rafeeq,
      lastSnapshotAt: r.lastCapturedAt,
      staleWindowMs: RAFEEQ_SNAPSHOT_STALE_MS,
      presentCount: r.present,
      missingCount: r.missing,
      reviewCount: 0,
      differentCount: 0,
      readyCount: r.linked, // draft / id-only — ready, never present
      unknownCount: r.unknown,
    },
    now,
  );

  return [puresoul, shopify, talabat, rafeeq];
}

// ── UI label + tone maps (single source; the UI holds NO platform logic) ───────

export const FRESHNESS_LABELS: Record<FreshnessState, string> = {
  fresh: "محدّثة",
  aging: "تتقادم",
  stale: "قديمة",
  unknown: "غير معروفة",
};

export const HEALTH_LEVEL_LABELS: Record<HealthLevel, string> = {
  healthy: "سليمة",
  needs_attention: "تحتاج انتباه",
  insufficient_data: "بيانات غير كافية",
};

export const HEALTH_REASON_LABELS: Record<HealthReason, string> = {
  degraded_read: "تعذّرت القراءة",
  low_coverage: "تغطية غير كافية",
  no_snapshot: "لا توجد لقطة بعد",
  stale_data: "البيانات قديمة",
  aging_data: "البيانات تتقادم",
  has_missing: "منتجات غير موجودة",
  has_review: "بحاجة مراجعة",
  has_drift: "اختلاف عن ماليكاس",
  has_ready_not_live: "جاهزة غير منشورة",
};

/** Tailwind tone tokens, applied by the UI without any platform branching. */
export const HEALTH_LEVEL_TONE: Record<HealthLevel, string> = {
  healthy: "bg-emerald-50 text-emerald-700",
  needs_attention: "bg-amber-50 text-amber-800",
  insufficient_data: "bg-[#f5ece1] text-muted",
};

export const FRESHNESS_TONE: Record<FreshnessState, string> = {
  fresh: "bg-emerald-50 text-emerald-700",
  aging: "bg-amber-50 text-amber-800",
  stale: "bg-rose-50 text-rose-700",
  unknown: "bg-[#f5ece1] text-muted",
};
