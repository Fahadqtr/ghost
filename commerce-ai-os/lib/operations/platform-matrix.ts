// Malikas V2 — Commerce Intelligence CI.1: Product Platform Matrix (PURE).
//
// A unified, per-product view of "where does this product stand on each platform"
// built ONLY from ALREADY-MERGED state — it adds no readers, no queries, and no
// precedence logic of its own (the snapshot→fallback→unknown precedence is already
// resolved by the four snapshot readers + the operations read model). This layer
// only NORMALIZES each platform's own state enum into one MatrixState and applies
// a per-platform TRUSTED-FIELD allowlist so untrusted fields render as "—".
//
// Honesty invariants (never violated here): absence / stale / degraded ⇒ unknown,
// NEVER missing; a mapping/id-only signal ⇒ ready, NEVER present/published.
//
// Two builders share one contract:
//   • buildPlatformMatrixItem(OperationsListItem) — state-only cells for the
//     all-products/operations surface (zero reads; no raw snapshot fields there).
//   • buildProductPlatformMatrix(..., latest snapshots) — rich cells (state +
//     trusted fields + freshness) for the product page, from the latest snapshot
//     per platform (classified with the existing per-platform classifiers).

import type { PlatformSnapshot } from "../platforms/core/types.ts";
import type { OperationsListItem } from "./dashboard-view.ts";
import type { PlatformStatusValue, PlatformType } from "./shared/models.ts";
import { PLATFORM_TYPES, PLATFORM_LABELS } from "./platforms/platform-status.ts";

import {
  PURESOUL_PLATFORM,
  classifyPureSoulSnapshot,
  isSnapshotStale as isPureSoulStale,
  type PureSoulState,
} from "../platforms/puresoul/capture-compute.ts";
import {
  SHOPIFY_PLATFORM,
  classifyShopifySnapshot,
  isSnapshotStale as isShopifyStale,
  type ShopifyState,
} from "../platforms/shopify/capture-compute.ts";
import {
  TALABAT_PLATFORM,
  classifyTalabatSnapshot,
  isSnapshotStale as isTalabatStale,
  type TalabatState,
} from "../platforms/talabat/capture-compute.ts";
import {
  RAFEEQ_PLATFORM,
  classifyRafeeqSnapshot,
  isSnapshotStale as isRafeeqStale,
  type RafeeqState,
} from "../platforms/rafeeq/capture-compute.ts";

export type MatrixState = "present" | "missing" | "different" | "review" | "ready" | "unknown";

/** Where a cell's state came from (diagnostic; the UI renders it as a hint). */
export type MatrixSource = "snapshot" | "operations" | "unknown";

export interface PlatformMatrixCell {
  platform: PlatformType;
  label: string;
  state: MatrixState;
  source: MatrixSource;
  /** trusted external id, or null → "—" */
  externalId: string | null;
  /** raw platform status when meaningful, or null → "—" */
  status: string | null;
  /** trusted platform price, or null → "—" (only PureSoul today) */
  price: number | null;
  /** trusted platform availability, or null → "—" (only PureSoul today) */
  availability: string | null;
  /** trusted platform title, or null when untrusted/derived (only PureSoul today) */
  title: string | null;
  /** newest snapshot capture time for this platform, or null */
  capturedAt: string | null;
  /** true when the newest snapshot is older than that platform's stale window */
  stale: boolean;
  /** extra non-blocking flags, e.g. "out_of_stock" / "price_different" */
  flags: string[];
}

export interface PlatformMatrixItem {
  productId: string;
  sku: string | null;
  barcode: string | null;
  cells: PlatformMatrixCell[];
  /** number of cells needing attention (missing / different / review) */
  issueCount: number;
  /** issueCount > 0 */
  needsAttention: boolean;
}

/** States that count as an actionable issue. `unknown`/`ready`/`present` do not. */
const ATTENTION_STATES: ReadonlySet<MatrixState> = new Set<MatrixState>(["missing", "different", "review"]);

/** Per-platform TRUSTED-FIELD allowlist. Anything not listed renders as "—". */
const TRUSTED_FIELDS: Record<PlatformType, { externalId: boolean; price: boolean; availability: boolean; title: boolean }> = {
  // `title` is trusted only where the snapshot records a REAL platform title
  // (PureSoul psName). Shopify's snapshot title is derived from Malika's name, so
  // it is NOT a trustworthy platform value → not comparable.
  puresoul: { externalId: true, price: true, availability: true, title: true },
  shopify: { externalId: true, price: false, availability: false, title: false },
  talabat: { externalId: false, price: false, availability: false, title: false },
  rafeeq: { externalId: true, price: false, availability: false, title: false },
};

const S = (v: unknown): string | null => {
  const t = String(v ?? "").trim();
  return t === "" ? null : t;
};
const numOrNull = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

// ── normalization: each platform's own enum → the one MatrixState ────────────

function normalizePureSoul(state: PureSoulState | undefined): { state: MatrixState; flags: string[] } {
  switch (state) {
    case "published":
      return { state: "present", flags: [] };
    case "price_different":
      return { state: "different", flags: ["price_different"] };
    case "out_of_stock":
      return { state: "present", flags: ["out_of_stock"] };
    case "review":
      return { state: "review", flags: [] };
    case "missing":
      return { state: "missing", flags: [] };
    default:
      return { state: "unknown", flags: [] };
  }
}

function normalizeShopifyState(state: ShopifyState | undefined): MatrixState {
  switch (state) {
    case "published":
      return "present";
    case "ready":
      return "ready";
    case "review":
      return "review";
    case "missing":
      return "missing";
    default:
      return "unknown";
  }
}

/** Shopify from the operations engine's PlatformStatusValue (all-products path). */
function normalizeShopifyStatusValue(v: PlatformStatusValue | undefined): MatrixState {
  switch (v) {
    case "published":
      return "present";
    case "ready":
      return "ready";
    case "different":
      return "different";
    case "review_required":
      return "review";
    case "missing":
      return "missing";
    default:
      return "unknown";
  }
}

function normalizeTalabat(state: TalabatState | undefined): MatrixState {
  switch (state) {
    case "present":
      return "present";
    case "missing":
      return "missing";
    case "review":
      return "review";
    case "linked":
      return "ready";
    default:
      return "unknown";
  }
}

function normalizeRafeeq(state: RafeeqState | undefined): MatrixState {
  switch (state) {
    case "present":
      return "present";
    case "missing":
      return "missing";
    case "linked":
      return "ready";
    default:
      return "unknown";
  }
}

// ── cell helpers ─────────────────────────────────────────────────────────────

function stateOnlyCell(platform: PlatformType, state: MatrixState, source: MatrixSource, flags: string[] = []): PlatformMatrixCell {
  return {
    platform,
    label: PLATFORM_LABELS[platform],
    state,
    source: state === "unknown" ? "unknown" : source,
    externalId: null,
    status: null,
    price: null,
    availability: null,
    title: null,
    capturedAt: null,
    stale: false,
    flags,
  };
}

function finalize(productId: string, sku: string | null, barcode: string | null, cells: PlatformMatrixCell[]): PlatformMatrixItem {
  const issueCount = cells.reduce((n, c) => (ATTENTION_STATES.has(c.state) ? n + 1 : n), 0);
  return { productId, sku, barcode, cells, issueCount, needsAttention: issueCount > 0 };
}

// ── builder 1: all-products / operations (state-only, ZERO reads) ────────────

/**
 * Project an ALREADY-COMPUTED OperationsListItem into a matrix item. State-only:
 * the operations item carries the merged per-platform STATE but not the raw
 * snapshot fields, so externalId/price/availability render as "—" here (the rich
 * fields come from the product-page builder). No reads, no precedence.
 */
export function buildPlatformMatrixItem(item: OperationsListItem): PlatformMatrixItem {
  const shopifyStatus = item.platforms.find((p) => p.platform === "shopify")?.status;
  const ps = normalizePureSoul(item.puresoulState);
  const cells: PlatformMatrixCell[] = PLATFORM_TYPES.map((platform) => {
    switch (platform) {
      case "shopify":
        return stateOnlyCell("shopify", normalizeShopifyStatusValue(shopifyStatus), "operations");
      case "puresoul":
        return stateOnlyCell("puresoul", ps.state, "operations", ps.flags);
      case "talabat":
        return stateOnlyCell("talabat", normalizeTalabat(item.talabatState), "operations");
      case "rafeeq":
        return stateOnlyCell("rafeeq", normalizeRafeeq(item.rafeeqState), "operations");
      default:
        return stateOnlyCell(platform, "unknown", "unknown");
    }
  });
  return finalize(item.id, item.sku, item.barcode, cells);
}

// ── builder 2: product page (rich cells from the latest snapshot per platform) ─

const CLASSIFY: Record<PlatformType, (s: PlatformSnapshot) => MatrixState> = {
  puresoul: (s) => normalizePureSoul(classifyPureSoulSnapshot(s)).state,
  shopify: (s) => normalizeShopifyState(classifyShopifySnapshot(s)),
  talabat: (s) => normalizeTalabat(classifyTalabatSnapshot(s)),
  rafeeq: (s) => normalizeRafeeq(classifyRafeeqSnapshot(s)),
};
const FLAGS: Partial<Record<PlatformType, (s: PlatformSnapshot) => string[]>> = {
  puresoul: (s) => normalizePureSoul(classifyPureSoulSnapshot(s)).flags,
};
const STALE: Record<PlatformType, (capturedAt: string | null, now: number) => boolean> = {
  puresoul: isPureSoulStale,
  shopify: isShopifyStale,
  talabat: isTalabatStale,
  rafeeq: isRafeeqStale,
};
/** Snapshot `platform` id → matrix PlatformType (PureSoul stores "pure_seoul"). */
const PLATFORM_ID_TO_TYPE: Record<string, PlatformType> = {
  [PURESOUL_PLATFORM]: "puresoul",
  puresoul: "puresoul",
  [SHOPIFY_PLATFORM]: "shopify",
  [TALABAT_PLATFORM]: "talabat",
  [RAFEEQ_PLATFORM]: "rafeeq",
};

function richCell(platform: PlatformType, snapshot: PlatformSnapshot | undefined, now: number): PlatformMatrixCell {
  if (!snapshot) return stateOnlyCell(platform, "unknown", "unknown");
  const state = CLASSIFY[platform](snapshot);
  const flags = FLAGS[platform]?.(snapshot) ?? [];
  const trust = TRUSTED_FIELDS[platform];
  return {
    platform,
    label: PLATFORM_LABELS[platform],
    state,
    source: state === "unknown" ? "unknown" : "snapshot",
    externalId: trust.externalId ? S(snapshot.externalId) : null,
    status: S(snapshot.status),
    price: trust.price ? numOrNull(snapshot.price) : null,
    availability: trust.availability ? S(snapshot.availability) : null,
    title: trust.title ? S(snapshot.title) : null,
    capturedAt: S(snapshot.capturedAt),
    stale: STALE[platform](S(snapshot.capturedAt), now),
    flags,
  };
}

/**
 * Build a rich matrix for ONE product from its latest snapshot PER PLATFORM.
 * `snapshots` is any set of that product's snapshots (e.g. the bounded, newest-
 * first `listByProduct` result the history reader already uses); the newest per
 * platform is selected here. `now` is supplied by the caller (no clock). Missing
 * platforms → unknown cells (never missing). Deterministic PLATFORM_TYPES order.
 */
export function buildProductPlatformMatrix(
  productId: string,
  sku: string | null,
  barcode: string | null,
  snapshots: readonly PlatformSnapshot[],
  now: number,
): PlatformMatrixItem {
  // newest snapshot per matrix platform type
  const latest = new Map<PlatformType, PlatformSnapshot>();
  for (const s of snapshots ?? []) {
    const type = PLATFORM_ID_TO_TYPE[s.platform];
    if (!type) continue;
    const cur = latest.get(type);
    if (!cur || (S(s.capturedAt) ?? "") > (S(cur.capturedAt) ?? "")) latest.set(type, s);
  }
  const cells = PLATFORM_TYPES.map((platform) => richCell(platform, latest.get(platform), now));
  return finalize(productId, sku, barcode, cells);
}

// ── fixed Arabic labels for the states (UI holds no platform logic) ──────────

export const MATRIX_STATE_LABELS: Record<MatrixState, string> = {
  present: "موجود",
  missing: "غير موجود",
  different: "مختلف",
  review: "يحتاج مراجعة",
  ready: "جاهز/مربوط",
  unknown: "غير معروف",
};

export const MATRIX_FLAG_LABELS: Record<string, string> = {
  out_of_stock: "نافد",
  price_different: "فرق سعر",
};
