// SKU generation for the AI product creator (Phase UI.5). Pure, no imports.
//
// The house pattern is the EXISTING one: `mk<number>` (lowercase), exactly as
// the legacy nextProductSku action generates and as the storage convention
// stores images (mk1995.jpg — see lib/products/imageStore.ts). Validation is
// case-insensitive and normalization lowercases, so a user typing MK123 gets
// the same catalog form mk123. No brand names, no product names, no other
// pattern.
//
// Variant SKUs are `<main>-<n>` with n starting at 1 and no padding:
// mk123-1, mk123-2, … Never mk123-01, never mk123-A, never mk123-black.

const MK_RE = /^mk(\d+)$/i;

/** True for mk123 / MK123 (any case, digits only after mk). */
export function isValidMkSku(value: unknown): boolean {
  return typeof value === "string" && MK_RE.test(value.trim());
}

/** Canonical catalog form: trimmed + lowercase (MK123 -> mk123). */
export function normalizeMkSku(value: string): string {
  return (value ?? "").trim().toLowerCase();
}

/**
 * Highest mk-number across every SKU seen (products AND variants). Variant
 * skus like mk123-2 also count their base number, so a catalog whose highest
 * entry is a variant still advances past it.
 */
export function maxMkNumber(skus: Iterable<unknown>): number {
  let max = 0;
  for (const raw of skus) {
    if (typeof raw !== "string") continue;
    const s = raw.trim().toLowerCase();
    const m = /^mk(\d+)(?:-\d+)?$/.exec(s);
    if (!m) continue;
    const n = parseInt(m[1], 10);
    if (Number.isSafeInteger(n) && n > max) max = n;
  }
  return max;
}

/** The next free main SKU given every existing sku and any extra taken set. */
export function nextMkSku(skus: Iterable<unknown>, taken?: ReadonlySet<string>): string {
  let n = maxMkNumber(skus) + 1;
  if (taken && taken.size > 0) {
    while (taken.has(`mk${n}`)) n += 1;
  }
  return `mk${n}`;
}

/** Variant SKU: mk123 + index 1 -> mk123-1. Index must be >= 1. */
export function variantMkSku(mainSku: string, index: number): string {
  return `${normalizeMkSku(mainSku)}-${index}`;
}

/**
 * Variant SKUs for n rows, renumbered 1..n. Called on every add/remove before
 * save so a deleted middle row closes the gap (per spec: deleting a variant
 * BEFORE saving renumbers; after a product exists its variant SKUs are never
 * rewritten — that path goes through the editor, not through this module).
 */
export function renumberVariantSkus(mainSku: string, count: number): string[] {
  const out: string[] = [];
  for (let i = 1; i <= count; i++) out.push(variantMkSku(mainSku, i));
  return out;
}

/** True for a well-formed variant sku of the given main (mk123-1 style). */
export function isValidVariantMkSku(value: unknown, mainSku: string): boolean {
  if (typeof value !== "string") return false;
  const main = normalizeMkSku(mainSku).replace(/[.*+?^${}()|[\]\\]/g, "");
  return new RegExp(`^${main}-[1-9]\\d*$`).test(value.trim().toLowerCase());
}
