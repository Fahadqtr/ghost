// UX.1A — pure long-text rendering helpers (framework-free).
//
// Suggested/current enrichment values can be long and blow up row height. The UI
// clamps them to a few lines with an expand/collapse toggle. Deciding WHEN a
// toggle is needed is a pure, deterministic heuristic (so it is unit-testable and
// stable across server/client renders) — the visual clamp itself is CSS. No data
// is ever truncated: the full text stays in the DOM (title tooltip + expand).
// node:test loads this directly.

/** Number of lines a clamped cell shows before the ellipsis. */
export const CLAMP_LINES = 3;

/** Character count above which a single-line value is considered long. */
export const EXPAND_CHAR_THRESHOLD = 140;

/**
 * Whether a value needs an expand/collapse toggle: it has more than one line, or
 * it is longer than the character threshold (a proxy for "would wrap past
 * CLAMP_LINES"). Empty/short single-line values need no toggle. Pure + total.
 */
export function isExpandableText(value: string | null | undefined, threshold: number = EXPAND_CHAR_THRESHOLD): boolean {
  if (typeof value !== "string") return false;
  const v = value;
  if (v.trim() === "") return false;
  if (/\r|\n/.test(v)) return true;
  const limit = Number.isFinite(threshold) && threshold > 0 ? threshold : EXPAND_CHAR_THRESHOLD;
  return v.length > limit;
}
