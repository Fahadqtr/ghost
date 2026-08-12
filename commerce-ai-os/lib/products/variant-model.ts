// Pure, shared variant-row model + immutable reducers (UX.4E-1).
//
// This is the canonical home for the variant-row operations the V2 editors
// currently inline separately (add / remove / restore / update-field / reorder /
// renumber). It is ADDITIVE: as of UX.4E-1 no editor imports it yet, so nothing
// changes behaviorally — adoption happens from UX.4E-2 onward.
//
// The row shape is the SAME one the V2 edit form already uses
// (`VariantRowState` from ./edit-form-state), re-exported here under the studio
// vocabulary so there is ONE type, never a competing copy. The create wizard's
// id-less rows map onto it with `id: null`.
//
// Purity contract (enforced by the Node test runner): completely pure and
// deterministic — every function returns NEW arrays/objects and never mutates
// its inputs; no React, no server code, no `@/` imports, no Supabase, no
// browser APIs. Callers supply row `key`s, so nothing here reaches for
// randomness or the clock.

import { renumberVariantSkus } from "./sku-generate.ts";
import {
  copyProductPriceToEmpty,
  fillMissingVariantBarcodes,
  fillMissingVariantSkus,
  generateAllMissingIdentity,
} from "./identity-fill.ts";
import {
  EMPTY_VARIANT_FIELDS,
  type VariantFields,
  type VariantRowState,
} from "./edit-form-state.ts";

// Single source of truth for the row shape — re-exported, not redeclared.
export { EMPTY_VARIANT_FIELDS } from "./edit-form-state.ts";
export type { VariantFields, VariantRowState } from "./edit-form-state.ts";

/** The variant-row model the studio operates on (alias of the editor row). */
export type VariantRowModel = VariantRowState;

/** The eight editable variant fields, in stable order. */
export const VARIANT_FIELD_KEYS = [
  "variant_name",
  "variant_name_en",
  "sku",
  "barcode",
  "color",
  "size",
  "price",
  "stock_quantity",
] as const;
export type VariantFieldKey = (typeof VARIANT_FIELD_KEYS)[number];

/**
 * Build one row. `id` defaults to null (a new row — the database mints the uuid
 * on insert); `removed` starts false; unspecified fields start blank. `key` is
 * the caller-owned local list key and is never sent to the database.
 */
export function makeVariantRow(
  key: string,
  init?: { id?: string | null; fields?: Partial<VariantFields> },
): VariantRowModel {
  return {
    key,
    id: init?.id ?? null,
    removed: false,
    fields: { ...EMPTY_VARIANT_FIELDS, ...(init?.fields ?? {}) },
  };
}

/** Append a fresh row (blank unless `init` provides fields/id). */
export function addVariantRow(
  rows: readonly VariantRowModel[],
  key: string,
  init?: { id?: string | null; fields?: Partial<VariantFields> },
): VariantRowModel[] {
  return [...rows, makeVariantRow(key, init)];
}

/**
 * Remove a row by key. A NEW row (id === null) is dropped from the list; an
 * EXISTING row (id set) is marked `removed` so it stays visible with an undo
 * until save — matching the edit form exactly. No-op when the key is absent.
 */
export function removeVariantRow(
  rows: readonly VariantRowModel[],
  key: string,
): VariantRowModel[] {
  const out: VariantRowModel[] = [];
  for (const row of rows) {
    if (row.key !== key) {
      out.push(row);
      continue;
    }
    if (row.id === null) continue; // new row → drop entirely
    out.push({ ...row, removed: true }); // existing row → soft-remove
  }
  return out;
}

/** Undo a soft-remove. No-op unless the matched row is currently removed. */
export function restoreVariantRow(
  rows: readonly VariantRowModel[],
  key: string,
): VariantRowModel[] {
  return rows.map((row) =>
    row.key === key && row.removed ? { ...row, removed: false } : row,
  );
}

/** Immutably set one field on one row. Other rows/fields are untouched. */
export function updateVariantField(
  rows: readonly VariantRowModel[],
  key: string,
  field: VariantFieldKey,
  value: string,
): VariantRowModel[] {
  return rows.map((row) =>
    row.key === key
      ? { ...row, fields: { ...row.fields, [field]: value } }
      : row,
  );
}

/**
 * Move the row at `from` to index `to`, preserving every other row's order.
 * Returns a copy unchanged when either index is out of range or from === to.
 */
export function reorderVariantRows(
  rows: readonly VariantRowModel[],
  from: number,
  to: number,
): VariantRowModel[] {
  const n = rows.length;
  const out = rows.slice();
  if (from < 0 || from >= n || to < 0 || to >= n || from === to) return out;
  const [moved] = out.splice(from, 1);
  out.splice(to, 0, moved);
  return out;
}

/** The rows that will actually be saved (not soft-removed). */
export function activeVariantRows(
  rows: readonly VariantRowModel[],
): VariantRowModel[] {
  return rows.filter((row) => !row.removed);
}

/** How many rows will be saved. */
export function activeVariantCount(rows: readonly VariantRowModel[]): number {
  let count = 0;
  for (const row of rows) if (!row.removed) count += 1;
  return count;
}

/**
 * A row carries real data when it has a name (either language) or a SKU — the
 * same "retained" rule the atomic sync uses. Blank/whitespace-only rows are
 * treated as empty.
 */
export function isMeaningfulVariant(fields: VariantFields): boolean {
  return (
    fields.variant_name.trim() !== "" ||
    fields.variant_name_en.trim() !== "" ||
    fields.sku.trim() !== ""
  );
}

/**
 * Renumber the ACTIVE rows' SKUs to `mk<main>-1..n` in order, leaving
 * soft-removed rows untouched. This reproduces both current behaviors: the
 * create wizard (no removed rows → every row renumbered) and the edit form's
 * "copy SKU prefix" (active rows only, skipping removed). Delegates the SKU
 * strings to the single generator in ./sku-generate.
 */
export function renumberVariantRowSkus(
  mainSku: string,
  rows: readonly VariantRowModel[],
): VariantRowModel[] {
  const skus = renumberVariantSkus(mainSku, activeVariantCount(rows));
  let i = 0;
  return rows.map((row) => {
    if (row.removed) return row;
    const sku = skus[i++];
    return row.fields.sku === sku
      ? row
      : { ...row, fields: { ...row.fields, sku } };
  });
}

// ── "generate/fill missing" row transforms ───────────────────────────────────
// These fill only the ACTIVE rows (removed rows pass through untouched), in
// order, delegating every value decision to identity-fill (which itself composes
// sku-generate + barcode-ean13). They exist so the create/edit editors and the
// shared identity hook share ONE implementation instead of three inline copies.

/** Fill empty variant SKUs of the active rows with `mk<main>-<n>` (positional). */
export function applyMissingVariantSkus(
  mainSku: string,
  rows: readonly VariantRowModel[],
): VariantRowModel[] {
  const skus = fillMissingVariantSkus(
    mainSku,
    activeVariantRows(rows).map((r) => ({ sku: r.fields.sku })),
  );
  let k = -1;
  return rows.map((row) =>
    row.removed ? row : (++k, { ...row, fields: { ...row.fields, sku: skus[k] } }),
  );
}

/** Fill empty variant barcodes of the active rows with fresh unique EAN-13s. */
export function applyMissingVariantBarcodes(
  rows: readonly VariantRowModel[],
  existing: ReadonlySet<string>,
  random: () => number,
  extraTaken: readonly string[] = [],
): VariantRowModel[] {
  const barcodes = fillMissingVariantBarcodes(
    activeVariantRows(rows).map((r) => ({ barcode: r.fields.barcode })),
    existing,
    random,
    extraTaken,
  );
  let k = -1;
  return rows.map((row) =>
    row.removed
      ? row
      : (++k, { ...row, fields: { ...row.fields, barcode: barcodes[k] } }),
  );
}

/** Fill both empty SKUs and empty barcodes across the active rows at once. */
export function applyAllMissingVariantIdentity(
  mainSku: string,
  rows: readonly VariantRowModel[],
  existing: ReadonlySet<string>,
  random: () => number,
  extraTaken: readonly string[] = [],
): VariantRowModel[] {
  const out = generateAllMissingIdentity(
    mainSku,
    activeVariantRows(rows).map((r) => ({ sku: r.fields.sku, barcode: r.fields.barcode })),
    existing,
    random,
    extraTaken,
  );
  let k = -1;
  return rows.map((row) =>
    row.removed
      ? row
      : (++k, {
          ...row,
          fields: { ...row.fields, sku: out.skus[k], barcode: out.barcodes[k] },
        }),
  );
}

/** Copy the product price into the active rows that have no price yet. */
export function applyProductPriceToEmptyVariants(
  productPrice: string,
  rows: readonly VariantRowModel[],
): VariantRowModel[] {
  const prices = copyProductPriceToEmpty(
    productPrice,
    activeVariantRows(rows).map((r) => ({ price: r.fields.price })),
  );
  let k = -1;
  return rows.map((row) =>
    row.removed ? row : (++k, { ...row, fields: { ...row.fields, price: prices[k] } }),
  );
}
