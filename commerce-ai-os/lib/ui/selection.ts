// UX.1A — pure selection model helpers (framework-free).
//
// A selection is a Set<string> of stable row keys. These helpers implement the
// three-level select controls (page / all-filtered / clear) and the counter,
// WITHOUT rendering: selecting "all filtered" only grows the key set, so the
// table can still render just the current page's checkboxes (no quadratic
// rendering). Every function returns a FRESH set — never mutates its input.
// node:test loads this directly (no @/ imports, no React).

/** Toggle one key in the selection (add if absent, remove if present). */
export function toggleKey(current: ReadonlySet<string>, key: string): Set<string> {
  const next = new Set(current);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}

/** Add every key to the selection (used by "select current page" / "select all filtered"). */
export function selectKeys(current: ReadonlySet<string>, keys: readonly string[]): Set<string> {
  const next = new Set(current);
  for (const k of keys) next.add(k);
  return next;
}

/** Remove every key from the selection (used by "deselect current page"). */
export function deselectKeys(current: ReadonlySet<string>, keys: readonly string[]): Set<string> {
  const next = new Set(current);
  for (const k of keys) next.delete(k);
  return next;
}

/** An empty selection ("clear selection"). */
export function clearSelection(): Set<string> {
  return new Set();
}

/** True when EVERY key is selected (and there is at least one key). */
export function allSelected(current: ReadonlySet<string>, keys: readonly string[]): boolean {
  if (keys.length === 0) return false;
  for (const k of keys) if (!current.has(k)) return false;
  return true;
}

/** True when at least one — but not all — of the keys is selected (indeterminate). */
export function someSelected(current: ReadonlySet<string>, keys: readonly string[]): boolean {
  let hit = 0;
  for (const k of keys) if (current.has(k)) hit++;
  return hit > 0 && hit < keys.length;
}

/** How many of `keys` are currently selected (the counter's X, scoped to the filtered set). */
export function countSelectedWithin(current: ReadonlySet<string>, keys: readonly string[]): number {
  let n = 0;
  for (const k of keys) if (current.has(k)) n++;
  return n;
}

/** Format the always-visible selection counter value: "X of Y". */
export function formatSelectionCount(selected: number, total: number): string {
  return `${Math.max(0, selected)} of ${Math.max(0, total)}`;
}
