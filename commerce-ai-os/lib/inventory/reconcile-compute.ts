// INV.3B — pure inventory reconciliation math (read + derive only, DB-free).
//
// Given a product's raw stock rows, decide whether the stored quantities are
// internally consistent with the AUTHORITATIVE model:
//   • simple  → inventory.stock_quantity IS the source of truth.
//   • variant → each product_variants.stock_quantity is the source; the parent
//               inventory pool MUST equal Σ(variants) (fail-closed).
//   • shelves → a distribution overlay only: when shelf rows exist, their sum
//               MUST equal the authoritative stock (product- or variant-level).
//
// products.stock_quantity is NEVER consulted (it is a stale mirror). Nothing here
// reads or derives availability — a quantity of 0 is NOT "unavailable" here.
//
// PURE: no I/O, no availability, no channel imports. All summation is fail-closed
// via sumVariantStock from compute.ts — a NULL/negative/fractional/overflowing
// value makes the result `inconsistent`, never a silent 0.

import { sumVariantStock } from "./compute.ts";

export type ReconcileStatus = "clean" | "drift" | "inconsistent";
export type ProductKind = "simple" | "variant";

export type ReconcileIssueCode =
  | "malformed_inventory_quantity"
  | "malformed_variant_quantity"
  | "malformed_shelf_quantity"
  | "malformed_variant_shelf_quantity"
  | "parent_rollup_drift"
  | "shelf_drift"
  | "variant_shelf_drift";

export interface ReconcileIssue {
  code: ReconcileIssueCode;
  message: string;
  variantId?: string;
  got?: number | null;   // the stored/summed value found
  want?: number | null;  // the authoritative value it should equal
}

export interface InventoryRowInput { stock_quantity: number | null | undefined }
export interface VariantRowInput { id: string; stock_quantity: number | null | undefined }
export interface ShelfRowInput { location: string; quantity: number | null | undefined }
export interface VariantShelfRowInput { variant_id: string; location: string; quantity: number | null | undefined }

export interface ReconcileInput {
  productId: string;
  inventoryRows: InventoryRowInput[];        // inventory rows for the product (usually exactly one)
  variants: VariantRowInput[];               // [] ⇒ simple product
  shelfStock: ShelfRowInput[];               // product-level shelf_stock rows
  variantShelfStock: VariantShelfRowInput[]; // variant-level variant_shelf_stock rows
}

export interface ReconcileResult {
  status: ReconcileStatus;
  productId: string;
  kind: ProductKind;
  current: {
    parentStock: number | null;   // Σ inventory rows, as stored (null ⇒ malformed)
    variantSum: number | null;    // Σ variant stock (variant kind only; null ⇒ malformed / n/a)
    shelfSum: number | null;      // Σ product-level shelf_stock (null ⇒ no rows or malformed)
  };
  expected: {
    parentStock: number | null;   // canonical authoritative parent total
  };
  issues: ReconcileIssue[];
}

/** Fail-closed sum over a {quantity} list, reusing compute.ts's rule verbatim. */
function sumQuantities(rows: Array<{ quantity: number | null | undefined }>): number | null {
  return sumVariantStock(rows.map((r) => ({ stock_quantity: r.quantity })));
}

function isCleanQty(v: number | null | undefined): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
}

/**
 * Reconcile one product's stored quantities against the authoritative model.
 * READ + DERIVE only — returns a verdict, never a repair. Status precedence:
 * inconsistent (any malformed value) > drift (any mismatch) > clean.
 */
export function reconcileProduct(input: ReconcileInput): ReconcileResult {
  const productId = input.productId;
  const variants = input.variants ?? [];
  const inventoryRows = input.inventoryRows ?? [];
  const shelfRows = input.shelfStock ?? [];
  const variantShelfRows = input.variantShelfStock ?? [];
  const kind: ProductKind = variants.length > 0 ? "variant" : "simple";
  const issues: ReconcileIssue[] = [];

  // Current parent pool = Σ inventory rows (fail-closed).
  const currentParent = sumQuantities(inventoryRows.map((r) => ({ quantity: r.stock_quantity })));
  if (currentParent === null) {
    issues.push({ code: "malformed_inventory_quantity", message: "inventory.stock_quantity is null / negative / non-integer" });
  }

  // Product-level shelf sum (only meaningful when rows exist).
  const shelfSum = shelfRows.length ? sumQuantities(shelfRows) : null;
  if (shelfRows.length && shelfSum === null) {
    issues.push({ code: "malformed_shelf_quantity", message: "shelf_stock.quantity is null / negative / non-integer" });
  }

  let variantSum: number | null = null;
  let expectedParent: number | null = currentParent;

  if (kind === "variant") {
    // Authoritative parent = Σ variants (fail-closed).
    variantSum = sumVariantStock(variants);
    if (variantSum === null) {
      issues.push({ code: "malformed_variant_quantity", message: "a variant stock_quantity is null / negative / non-integer" });
    }
    expectedParent = variantSum;

    // Parent rollup drift — only comparable when both sides are well-formed.
    if (variantSum !== null && currentParent !== null && currentParent !== variantSum) {
      issues.push({ code: "parent_rollup_drift", message: "inventory.stock_quantity ≠ Σ variants", got: currentParent, want: variantSum });
    }

    // Per-variant shelf reconciliation (variant stock = Σ its variant shelves).
    const byVariant = new Map<string, Array<{ quantity: number | null | undefined }>>();
    for (const r of variantShelfRows) {
      const arr = byVariant.get(r.variant_id) ?? [];
      arr.push({ quantity: r.quantity });
      byVariant.set(r.variant_id, arr);
    }
    for (const v of variants) {
      const rows = byVariant.get(v.id);
      if (!rows || rows.length === 0) continue; // this option has no shelf placement
      const vShelfSum = sumQuantities(rows);
      if (vShelfSum === null) {
        issues.push({ code: "malformed_variant_shelf_quantity", message: "variant_shelf_stock.quantity is null / negative / non-integer", variantId: v.id });
        continue;
      }
      if (isCleanQty(v.stock_quantity) && vShelfSum !== v.stock_quantity) {
        issues.push({ code: "variant_shelf_drift", message: "Σ variant_shelf_stock ≠ variant.stock_quantity", variantId: v.id, got: vShelfSum, want: v.stock_quantity });
      }
    }

    // Product-level shelves on a variant product reconcile to the authoritative
    // parent (Σ variants) — the single shared pool.
    if (shelfSum !== null && expectedParent !== null && shelfSum !== expectedParent) {
      issues.push({ code: "shelf_drift", message: "Σ shelf_stock ≠ authoritative stock (Σ variants)", got: shelfSum, want: expectedParent });
    }
  } else {
    // Simple: authoritative stock IS inventory.stock_quantity; shelves reconcile to it.
    if (shelfSum !== null && currentParent !== null && shelfSum !== currentParent) {
      issues.push({ code: "shelf_drift", message: "Σ shelf_stock ≠ inventory.stock_quantity", got: shelfSum, want: currentParent });
    }
    expectedParent = currentParent;
  }

  const hasMalformed = issues.some((i) => i.code.startsWith("malformed"));
  const hasDrift = issues.some((i) => i.code.endsWith("drift"));
  const status: ReconcileStatus = hasMalformed ? "inconsistent" : hasDrift ? "drift" : "clean";

  return {
    status,
    productId,
    kind,
    current: { parentStock: currentParent, variantSum, shelfSum },
    expected: { parentStock: expectedParent },
    issues,
  };
}
