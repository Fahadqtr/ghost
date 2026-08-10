// Malikas V2 — Commerce Intelligence CI.3: Cross-Platform Diff (PURE).
//
// Platform vs Malikas (source-of-truth) field comparison for one product, built
// ONLY from the already-loaded PlatformMatrixCell[] (CI.1) + the Malikas product
// record. No readers, no queries, no platform adapters, no snapshot logic. It
// compares ONLY trusted, SoT-backed value fields; a field is `unavailable` when
// the platform value is untrusted (null on the cell) or there is no Malikas
// counterpart, and `unknown` when the platform has no snapshot. A null/unavailable
// value is NEVER a difference. MatrixState stays the headline; this only adds the
// specific (field, sourceValue, platformValue) rows.
//
// Honest scope: only PureSoul carries trustworthy comparable values today (price,
// title) — the cell's trusted-field allowlist already nulls everything else, so
// Shopify/Talabat/Rafeeq naturally yield no field rows (state-only).

import type { MatrixState, PlatformMatrixCell } from "./platform-matrix.ts";
import type { PlatformType } from "./shared/models.ts";
import { PLATFORM_TYPES } from "./platforms/platform-status.ts";

export type DiffStatus = "equal" | "different" | "unavailable" | "unknown";
export type DiffField = "price" | "title";

export interface CrossPlatformFieldDiff {
  field: DiffField;
  sourceValue: string | number | null; // Malikas source-of-truth
  platformValue: string | number | null; // trusted platform snapshot value
  status: DiffStatus;
}

export interface CrossPlatformDiffItem {
  productId: string;
  platform: PlatformType;
  label: string;
  state: MatrixState; // headline — taken straight from the matrix cell
  fields: CrossPlatformFieldDiff[]; // only equal/different rows (both sides trusted)
  issueCount: number; // number of `different` fields
  capturedAt: string | null;
  stale: boolean;
}

/** The Malikas source-of-truth fields this diff reads (subset of the product). */
export interface MalikasSource {
  productId: string;
  price: number | null;
  discountPrice: number | null;
  nameAr: string | null;
  nameEn: string | null;
}

/** Field render order (deterministic). */
const FIELD_ORDER: readonly DiffField[] = ["price", "title"];
/** Platform headline priority: different first, then review, then the rest. */
const STATE_PRIORITY: Partial<Record<MatrixState, number>> = { different: 0, review: 1 };
const PLATFORM_RANK: Record<string, number> = Object.fromEntries(PLATFORM_TYPES.map((p, i) => [p, i]));

const S = (v: unknown): string | null => {
  const t = String(v ?? "").trim();
  return t === "" ? null : t;
};
const numOrNull = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** SoT price: discountPrice when present, else price (reuses the existing rule;
 *  no new pricing logic). */
export function sotPrice(src: MalikasSource): number | null {
  return src.discountPrice !== null && src.discountPrice !== undefined ? numOrNull(src.discountPrice) : numOrNull(src.price);
}
/** SoT title: English name first, then Arabic (matches PureSoul psName source). */
export function sotTitle(src: MalikasSource): string | null {
  return S(src.nameEn) ?? S(src.nameAr);
}

/**
 * Classify one field. `unavailable` when EITHER side is missing (untrusted
 * platform value or no SoT counterpart) — a null is NEVER a difference. Numbers
 * compare numerically; titles compare trimmed + case-insensitively (avoids
 * false diffs from whitespace/case).
 */
export function classifyFieldDiff(
  sourceValue: string | number | null,
  platformValue: string | number | null,
): DiffStatus {
  if (platformValue === null || platformValue === undefined) return "unavailable";
  if (sourceValue === null || sourceValue === undefined) return "unavailable";
  if (typeof sourceValue === "number" || typeof platformValue === "number") {
    const a = numOrNull(sourceValue);
    const b = numOrNull(platformValue);
    if (a === null || b === null) return "unavailable";
    return a === b ? "equal" : "different";
  }
  return S(sourceValue)?.toLowerCase() === S(platformValue)?.toLowerCase() ? "equal" : "different";
}

/**
 * Build the platform-vs-Malikas diff for one product from the already-loaded
 * matrix cells. One item per platform (deterministic, PLATFORM_TYPES order,
 * re-sorted by headline priority). `unknown` platforms emit no field rows; only
 * equal/different rows are emitted (unavailable/unknown are never invented as
 * rows and never counted). Pure — no reads.
 */
export function buildCrossPlatformDiff(
  product: MalikasSource,
  cells: readonly PlatformMatrixCell[],
): CrossPlatformDiffItem[] {
  const price = sotPrice(product);
  const title = sotTitle(product);

  const items: CrossPlatformDiffItem[] = [];
  for (const cell of cells ?? []) {
    const fields: CrossPlatformFieldDiff[] = [];
    if (cell.state !== "unknown") {
      for (const field of FIELD_ORDER) {
        const source = field === "price" ? price : title;
        const platformValue = field === "price" ? cell.price : cell.title;
        const status = classifyFieldDiff(source, platformValue);
        // Only emit rows where both sides are trusted+present (equal/different).
        // unavailable/unknown → never invented as a row.
        if (status === "equal" || status === "different") {
          fields.push({ field, sourceValue: source, platformValue, status });
        }
      }
    }
    items.push({
      productId: product.productId,
      platform: cell.platform,
      label: cell.label,
      state: cell.state,
      fields,
      issueCount: fields.reduce((n, f) => (f.status === "different" ? n + 1 : n), 0),
      capturedAt: cell.capturedAt,
      stale: cell.stale,
    });
  }

  // Sort: different first → review → rest; tiebreak by PLATFORM_TYPES order.
  return items.sort((a, b) => {
    const pa = STATE_PRIORITY[a.state] ?? 2;
    const pb = STATE_PRIORITY[b.state] ?? 2;
    if (pa !== pb) return pa - pb;
    return (PLATFORM_RANK[a.platform] ?? 99) - (PLATFORM_RANK[b.platform] ?? 99);
  });
}

/** Total `different` fields across all platforms for one product (additive; for
 *  future CI.4 use — the Unified Operations Queue stays state-only). */
export function totalDiffIssues(items: readonly CrossPlatformDiffItem[]): number {
  return (items ?? []).reduce((n, i) => n + i.issueCount, 0);
}

// ── fixed Arabic labels (UI holds no comparison logic) ───────────────────────

export const DIFF_FIELD_LABELS: Record<DiffField, string> = {
  price: "السعر",
  title: "الاسم",
};
