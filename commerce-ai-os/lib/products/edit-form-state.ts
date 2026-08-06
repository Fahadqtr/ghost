// Pure row-state helpers for the V2 product editor form (Phase UI.4).
// No imports beyond types, no I/O — node:test loads this directly, and the
// client component uses the exact same functions, so what the tests prove is
// what the browser sends.

import type { VariantInput } from "./product-save";

/** Editable variant field values, always strings (form representation). */
export interface VariantFields {
  variant_name: string;
  variant_name_en: string;
  sku: string;
  barcode: string;
  color: string;
  size: string;
  price: string;
  stock_quantity: string;
}

/**
 * One row in the editor.
 * - `id` is the DATABASE uuid for an existing variant, or null for a new row.
 *   It is never invented client-side: a new row keeps null and the database
 *   generates the uuid on insert.
 * - `key` is the React list key ONLY (`id` when present, otherwise a local
 *   "new-N" marker). It must never leak into the payload.
 * - `removed` marks an existing row the user deleted; it stays visible with an
 *   undo button until save, and is simply omitted from the payload — the
 *   atomic RPC decides whether the delete is allowed.
 */
export interface VariantRowState {
  key: string;
  id: string | null;
  removed: boolean;
  fields: VariantFields;
}

export const EMPTY_VARIANT_FIELDS: VariantFields = {
  variant_name: "",
  variant_name_en: "",
  sku: "",
  barcode: "",
  color: "",
  size: "",
  price: "",
  stock_quantity: "",
};

/** Initial rows from the server-loaded variants (ids kept verbatim). */
export function toVariantRows(
  variants: readonly ({ id: string } & VariantFields)[],
): VariantRowState[] {
  return variants.map((v) => ({
    key: v.id,
    id: v.id,
    removed: false,
    fields: {
      variant_name: v.variant_name,
      variant_name_en: v.variant_name_en,
      sku: v.sku,
      barcode: v.barcode,
      color: v.color,
      size: v.size,
      price: v.price,
      stock_quantity: v.stock_quantity,
    },
  }));
}

/**
 * Build the save payload from the editor rows.
 * - a removed row is omitted entirely (targeted delete happens in the RPC);
 * - an existing row sends its database id VERBATIM;
 * - a new row sends NO id at all — never the local React key, never a
 *   client-generated uuid.
 */
export function buildVariantInputs(rows: readonly VariantRowState[]): VariantInput[] {
  const out: VariantInput[] = [];
  for (const row of rows) {
    if (row.removed) continue;
    const base: VariantInput = {
      variant_name: row.fields.variant_name,
      variant_name_en: row.fields.variant_name_en,
      sku: row.fields.sku,
      barcode: row.fields.barcode,
      color: row.fields.color,
      size: row.fields.size,
      price: row.fields.price,
      stock_quantity: row.fields.stock_quantity,
    };
    if (typeof row.id === "string" && row.id.length > 0) {
      out.push({ id: row.id, ...base });
    } else {
      out.push(base);
    }
  }
  return out;
}

/** True when any scalar or any variant row differs from the initial state. */
export function hasUnsavedChanges(
  initialScalars: Record<string, string>,
  currentScalars: Record<string, string>,
  initialRows: readonly VariantRowState[],
  currentRows: readonly VariantRowState[],
): boolean {
  for (const k of Object.keys(initialScalars)) {
    if (initialScalars[k] !== currentScalars[k]) return true;
  }
  if (initialRows.length !== currentRows.length) return true;
  for (let i = 0; i < currentRows.length; i++) {
    const a = initialRows[i];
    const b = currentRows[i];
    if (a.key !== b.key || a.id !== b.id || a.removed !== b.removed) return true;
    for (const k of Object.keys(a.fields) as (keyof VariantFields)[]) {
      if (a.fields[k] !== b.fields[k]) return true;
    }
  }
  return false;
}
