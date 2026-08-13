// Malikas V2 — variant barcode scanner flow (UX.4E-9C). The ONE pure decision
// behind the "scan-to-next" keyboard behavior ported from the retired legacy
// editor (components/ProductForm.tsx): a handheld barcode scanner emits an Enter
// after each code, and instead of that Enter submitting the form we advance focus
// to the NEXT active variant barcode field so the next code scans straight in.
//
// This module owns only the ORDERING decision — given the current rows and the
// row the Enter fired in, which row's barcode field should receive focus next.
// It is deliberately framework-free (no React, no DOM) so both the Create wizard
// and the Edit form share the exact same rule and it can be unit-tested directly.
//
// Rules (matching the legacy behavior):
//   • advance to the next row that is NOT soft-removed (skip removed rows),
//   • identity is the stable row `key`, never the array index,
//   • never create a new row — only move among rows that already exist,
//   • the last active barcode field returns null (the caller keeps focus safe;
//     it must NOT submit or wrap around).

/** Minimal row shape this decision needs — the studio's rows satisfy it. */
export interface ScannerRowRef {
  key: string;
  removed?: boolean;
}

/**
 * The key of the next active (non-removed) row after `currentKey`, or null when
 * `currentKey` is the last active row, is itself removed, or is unknown. Order is
 * the caller's row order; removed rows are skipped on both sides.
 */
export function nextActiveBarcodeKey(
  rows: readonly ScannerRowRef[],
  currentKey: string,
): string | null {
  const active = rows.filter((r) => !r.removed).map((r) => r.key);
  const i = active.indexOf(currentKey);
  if (i < 0 || i + 1 >= active.length) return null;
  return active[i + 1];
}
