// Pure, shared variant BULK operations (UX.4E-5).
//
// The single home for the "do it to many rows at once" transforms the V2 Create
// wizard and Edit form both drive from VariantBulkTools. Every function operates
// on VariantRowModel[] and returns a NEW immutable array; it composes the
// existing shared layers and re-implements NOTHING:
//   - variant-model  → add / remove / restore reducers + fill-missing transforms
//   - identity-fill  → the value decisions behind the fill-missing transforms
//   - sku-generate / barcode-ean13 → SKU grammar + EAN math (via the above)
//   - variant-validate → the shared variant-count predicate (batch guard)
//
// Purity contract (enforced by the Node test runner): no React, no Supabase, no
// browser APIs, no server imports, no clock, no randomness of its own (callers
// inject `random`). Persisted identities are protected — see the notes on each op.

import {
  addVariantRow,
  makeVariantRow,
  removeVariantRow,
  restoreVariantRow,
  applyProductPriceToEmptyVariants,
  VARIANT_FIELD_KEYS,
  type VariantRowModel,
} from "./variant-model.ts";
import { exceedsVariantLimit } from "./variant-validate.ts";

// Re-export the fill-missing identity/price transforms as the bulk layer's
// generate operations, so callers have ONE import surface. These already touch
// ONLY blank fields of the active rows — an existing SKU/barcode is never
// overwritten and persisted rows are never renumbered (identity-fill guarantees).
export {
  applyMissingVariantSkus as generateMissingSkus,
  applyMissingVariantBarcodes as generateMissingBarcodes,
  applyAllMissingVariantIdentity as generateMissingIdentity,
} from "./variant-model.ts";

/**
 * Max rows a single "add multiple" action may create at once. This is a UI
 * batch bound (keeps one action sane), NOT a per-product variant cap — no such
 * cap exists and this phase does not invent one. Enforced through the shared
 * exceedsVariantLimit predicate so there is one count rule.
 */
export const MAX_BULK_ADD_BATCH = 20;

/** True when `count` is a valid single add-multiple batch (1..MAX_BULK_ADD_BATCH). */
export function withinAddBatchLimit(count: number): boolean {
  return Number.isInteger(count) && count >= 1 && !exceedsVariantLimit(count, MAX_BULK_ADD_BATCH);
}

// ── price / stock ────────────────────────────────────────────────────────────

/** Fill the product price into ACTIVE rows that have NO price yet (blanks only). */
export function fillMissingPrice(
  rows: readonly VariantRowModel[],
  productPrice: string,
): VariantRowModel[] {
  return applyProductPriceToEmptyVariants(productPrice, rows);
}

/** Fill a stock quantity into ACTIVE rows that have NO stock yet (blanks only). */
export function fillMissingStock(
  rows: readonly VariantRowModel[],
  quantity: string,
): VariantRowModel[] {
  const q = (quantity ?? "").trim();
  return rows.map((row) =>
    !row.removed && row.fields.stock_quantity.trim() === ""
      ? { ...row, fields: { ...row.fields, stock_quantity: q } }
      : row,
  );
}

/** Set the price on the SELECTED rows — explicit overwrite (user requested it). */
export function setSelectedPrice(
  rows: readonly VariantRowModel[],
  selectedKeys: ReadonlySet<string>,
  price: string,
): VariantRowModel[] {
  const p = (price ?? "").trim();
  return rows.map((row) =>
    selectedKeys.has(row.key) ? { ...row, fields: { ...row.fields, price: p } } : row,
  );
}

/** Set the stock on the SELECTED rows — explicit overwrite (user requested it). */
export function setSelectedStock(
  rows: readonly VariantRowModel[],
  selectedKeys: ReadonlySet<string>,
  quantity: string,
): VariantRowModel[] {
  const q = (quantity ?? "").trim();
  return rows.map((row) =>
    selectedKeys.has(row.key) ? { ...row, fields: { ...row.fields, stock_quantity: q } } : row,
  );
}

// ── add / duplicate ──────────────────────────────────────────────────────────

/**
 * Append `count` fresh blank rows, keyed by `keyFactory(i)` (0-based). Deterministic
 * given the same keyFactory. Callers must pre-check withinAddBatchLimit and
 * decline (never partially add) when it fails; this appends exactly `count` when
 * count >= 1, else returns the rows unchanged.
 */
export function addRows(
  rows: readonly VariantRowModel[],
  count: number,
  keyFactory: (i: number) => string,
): VariantRowModel[] {
  if (!Number.isInteger(count) || count < 1) return rows.slice();
  let out: VariantRowModel[] = rows.slice();
  for (let i = 0; i < count; i++) out = addVariantRow(out, keyFactory(i));
  return out;
}

/**
 * Duplicate one row's non-identity fields into a NEW row inserted right after it.
 * SKU + barcode are CLEARED and id is null, so a duplicate can never collide with
 * or shadow a persisted identity. No-op when `key` is absent.
 */
export function duplicateRow(
  rows: readonly VariantRowModel[],
  key: string,
  newKey: string,
): VariantRowModel[] {
  const out: VariantRowModel[] = [];
  for (const row of rows) {
    out.push(row);
    if (row.key === key) {
      out.push(
        makeVariantRow(newKey, {
          fields: { ...row.fields, sku: "", barcode: "" },
        }),
      );
    }
  }
  return out;
}

// ── remove / restore ─────────────────────────────────────────────────────────

/**
 * Remove every SELECTED row with the standard per-row rule (variant-model's
 * removeVariantRow): a NEW row (id null) is dropped; a PERSISTED row (id set) is
 * soft-removed (kept, marked removed, id untouched) so it stays undo-able and
 * the atomic RPC decides the delete. Never auto-deletes anything not selected.
 */
export function markSelectedRemoved(
  rows: readonly VariantRowModel[],
  selectedKeys: ReadonlySet<string>,
): VariantRowModel[] {
  let out: VariantRowModel[] = rows.slice();
  for (const key of selectedKeys) out = removeVariantRow(out, key);
  return out;
}

/** Undo the soft-remove on every SELECTED persisted row. New rows are unaffected. */
export function restoreSelected(
  rows: readonly VariantRowModel[],
  selectedKeys: ReadonlySet<string>,
): VariantRowModel[] {
  let out: VariantRowModel[] = rows.slice();
  for (const key of selectedKeys) out = restoreVariantRow(out, key);
  return out;
}

/**
 * Drop the EMPTY NEW rows — a new row (id null) whose every editable field is
 * blank. Persisted rows are never dropped here (a blank persisted row is soft-
 * removed only through explicit selection), and a new row carrying any data is
 * kept.
 */
export function removeEmptyRows(rows: readonly VariantRowModel[]): VariantRowModel[] {
  return rows.filter((row) => {
    if (row.id !== null) return true; // never drop a persisted row
    return VARIANT_FIELD_KEYS.some((k) => row.fields[k].trim() !== "");
  });
}
