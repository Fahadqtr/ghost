// INV.3B / Production-Reconciliation — pure inventory reconciliation math
// (read + derive only, DB-free).
//
// Given a product's raw stock rows, decide whether the stored state is internally
// consistent with the AUTHORITATIVE model:
//   • EXACTLY ONE inventory row per product (0 ⇒ missing, >1 ⇒ duplicate — both
//     inconsistent; never sum multiple rows and hide the problem, never treat
//     sum([]) = 0 as a clean product).
//   • simple  → inventory.stock_quantity IS the source of truth.
//   • variant → each product_variants.stock_quantity is the source; the parent
//               inventory pool MUST equal Σ(variants) (fail-closed). A variant
//               product must NOT carry product-level shelf rows (parent_has_shelf_rows).
//   • shelves → a distribution overlay only: when shelf rows exist, their sum MUST
//               equal the authoritative stock, and inventory.location MUST be the
//               deterministic primary shelf (quantity DESC, location ASC, id ASC).
//               With no shelves, inventory.location MUST be null.
//   • sold    → inventory.sold_quantity, when present, MUST be a non-negative int.
//
// products.stock_quantity is NEVER consulted (retired mirror). Nothing here reads
// or derives availability — a quantity of 0 is NOT "unavailable" here.
//
// PURE: no I/O, no availability, no channel imports.

import { sumVariantStock } from "./compute.ts";

export type ReconcileStatus = "clean" | "drift" | "inconsistent";
export type ProductKind = "simple" | "variant";

export type ReconcileIssueCode =
  | "missing_inventory_row"
  | "duplicate_inventory_rows"
  | "malformed_inventory_quantity"
  | "malformed_sold_quantity"
  | "malformed_variant_quantity"
  | "malformed_shelf_quantity"
  | "malformed_variant_shelf_quantity"
  | "parent_has_shelf_rows"
  | "parent_rollup_drift"
  | "shelf_drift"
  | "variant_shelf_drift"
  | "primary_location_drift"
  | "stale_location_without_shelf";

// Codes that make a product structurally INCONSISTENT (never "clean", and never a
// blind auto-repair). Everything else that is an issue is repairable "drift".
const INCONSISTENT_CODES = new Set<ReconcileIssueCode>([
  "missing_inventory_row",
  "duplicate_inventory_rows",
  "malformed_inventory_quantity",
  "malformed_sold_quantity",
  "malformed_variant_quantity",
  "malformed_shelf_quantity",
  "malformed_variant_shelf_quantity",
  "parent_has_shelf_rows",
]);

export interface ReconcileIssue {
  code: ReconcileIssueCode;
  message: string;
  variantId?: string;
  got?: number | string | null;   // the stored/summed value found
  want?: number | string | null;  // the authoritative value it should equal
}

export interface InventoryRowInput {
  id?: string;
  stock_quantity: number | null | undefined;
  sold_quantity?: number | null | undefined;
  location?: string | null | undefined;
}
export interface VariantRowInput { id: string; stock_quantity: number | null | undefined }
export interface ShelfRowInput { id?: string; location: string | null | undefined; quantity: number | null | undefined }
export interface VariantShelfRowInput { id?: string; variant_id: string; location: string | null | undefined; quantity: number | null | undefined }

export interface ReconcileInput {
  productId: string;
  inventoryRows: InventoryRowInput[];        // MUST be exactly one for a valid product
  variants: VariantRowInput[];               // [] ⇒ simple product
  shelfStock: ShelfRowInput[];               // product-level shelf_stock rows
  variantShelfStock: VariantShelfRowInput[]; // variant-level variant_shelf_stock rows
}

export interface ReconcileResult {
  status: ReconcileStatus;
  productId: string;
  kind: ProductKind;
  current: {
    parentStock: number | null;   // the single inventory row's stock (null ⇒ malformed / missing / duplicate)
    variantSum: number | null;    // Σ variant stock (variant kind only; null ⇒ malformed / n/a)
    shelfSum: number | null;      // Σ product-level shelf_stock (null ⇒ no rows or malformed)
    location: string | null;      // the single inventory row's location (null when n/a)
  };
  expected: {
    parentStock: number | null;   // canonical authoritative parent total
    location: string | null;      // canonical primary location (null ⇒ must be null)
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

const norm = (v: string | null | undefined): string => (v == null ? "" : String(v).trim());

/**
 * The deterministic primary shelf location: the placement with the largest
 * quantity, ties broken by location ASC then id ASC. Mirrors the INV.5 sale
 * primitive's `ORDER BY quantity DESC, location ASC, id ASC`. Returns null when
 * there are no (clean) placements.
 */
export function primaryShelfLocation(rows: ShelfRowInput[]): string | null {
  const clean = rows.filter((r) => isCleanQty(r.quantity) && norm(r.location) !== "");
  if (!clean.length) return null;
  const sorted = [...clean].sort((a, b) => {
    const q = (b.quantity as number) - (a.quantity as number);
    if (q !== 0) return q;
    const la = norm(a.location), lb = norm(b.location);
    if (la !== lb) return la < lb ? -1 : 1;
    return norm(a.id) < norm(b.id) ? -1 : norm(a.id) > norm(b.id) ? 1 : 0;
  });
  return norm(sorted[0].location);
}

/**
 * Reconcile one product's stored state against the authoritative model.
 * READ + DERIVE only — returns a verdict, never a repair. Status precedence:
 * inconsistent > drift > clean.
 */
export function reconcileProduct(input: ReconcileInput): ReconcileResult {
  const productId = input.productId;
  const variants = input.variants ?? [];
  const inventoryRows = input.inventoryRows ?? [];
  const shelfRows = input.shelfStock ?? [];
  const variantShelfRows = input.variantShelfStock ?? [];
  const kind: ProductKind = variants.length > 0 ? "variant" : "simple";
  const issues: ReconcileIssue[] = [];

  // ── EXACTLY ONE inventory row invariant ─────────────────────────────────────
  let invStock: number | null = null;
  let invLocation: string | null = null;
  let hasInvRow = false;
  if (inventoryRows.length === 0) {
    issues.push({ code: "missing_inventory_row", message: "product has no inventory row" });
  } else if (inventoryRows.length > 1) {
    issues.push({ code: "duplicate_inventory_rows", message: "product has more than one inventory row", got: inventoryRows.length });
  } else {
    hasInvRow = true;
    const row = inventoryRows[0];
    invLocation = norm(row.location) === "" ? null : norm(row.location);
    if (!isCleanQty(row.stock_quantity)) {
      issues.push({ code: "malformed_inventory_quantity", message: "inventory.stock_quantity is null / negative / non-integer" });
    } else {
      invStock = row.stock_quantity;
    }
    // sold_quantity: only checked when the caller supplies it (undefined ⇒ skip).
    if (row.sold_quantity !== undefined && !isCleanQty(row.sold_quantity)) {
      issues.push({ code: "malformed_sold_quantity", message: "inventory.sold_quantity is null / negative / non-integer" });
    }
  }

  // Product-level shelf sum (only meaningful when rows exist).
  const shelfSum = shelfRows.length ? sumQuantities(shelfRows) : null;
  if (shelfRows.length && shelfSum === null) {
    issues.push({ code: "malformed_shelf_quantity", message: "shelf_stock.quantity is null / negative / non-integer" });
  }

  let variantSum: number | null = null;
  let expectedParent: number | null = invStock;
  let expectedLocation: string | null = null;

  if (kind === "variant") {
    variantSum = sumVariantStock(variants);
    if (variantSum === null) {
      issues.push({ code: "malformed_variant_quantity", message: "a variant stock_quantity is null / negative / non-integer" });
    }
    expectedParent = variantSum;

    // A variant product must NOT carry product-level shelf rows — inconsistent
    // even if Σ shelves happens to equal Σ variants (no safe auto-repair).
    if (shelfRows.length > 0) {
      issues.push({ code: "parent_has_shelf_rows", message: "a variant product carries product-level shelf_stock rows" });
    }

    // Parent rollup drift — only comparable when both sides are well-formed.
    if (variantSum !== null && invStock !== null && invStock !== variantSum) {
      issues.push({ code: "parent_rollup_drift", message: "inventory.stock_quantity ≠ Σ variants", got: invStock, want: variantSum });
    }

    // Per-variant shelf reconciliation (variant stock = Σ its variant shelves).
    const byVariant = new Map<string, ShelfRowInput[]>();
    for (const r of variantShelfRows) {
      const arr = byVariant.get(r.variant_id) ?? [];
      arr.push({ id: r.id, location: r.location, quantity: r.quantity });
      byVariant.set(r.variant_id, arr);
    }
    for (const v of variants) {
      const rows = byVariant.get(v.id);
      if (!rows || rows.length === 0) continue;
      const vShelfSum = sumQuantities(rows);
      if (vShelfSum === null) {
        issues.push({ code: "malformed_variant_shelf_quantity", message: "variant_shelf_stock.quantity is null / negative / non-integer", variantId: v.id });
        continue;
      }
      if (isCleanQty(v.stock_quantity) && vShelfSum !== v.stock_quantity) {
        issues.push({ code: "variant_shelf_drift", message: "Σ variant_shelf_stock ≠ variant.stock_quantity", variantId: v.id, got: vShelfSum, want: v.stock_quantity });
      }
    }

    // A variant product's parent inventory.location MUST be null (product-level
    // shelves are not allowed). A non-null parent location is stale.
    expectedLocation = null;
    if (hasInvRow && invLocation !== null) {
      issues.push({ code: "stale_location_without_shelf", message: "variant parent inventory.location must be null", got: invLocation, want: null });
    }
  } else {
    // Simple: authoritative stock IS inventory.stock_quantity; shelves reconcile to it.
    if (shelfSum !== null && invStock !== null && shelfSum !== invStock) {
      issues.push({ code: "shelf_drift", message: "Σ shelf_stock ≠ inventory.stock_quantity", got: shelfSum, want: invStock });
    }
    expectedParent = invStock;

    if (shelfRows.length > 0) {
      // With shelves: location MUST be the deterministic primary.
      expectedLocation = primaryShelfLocation(shelfRows);
      if (hasInvRow && expectedLocation !== null && invLocation !== expectedLocation) {
        issues.push({ code: "primary_location_drift", message: "inventory.location ≠ primary shelf", got: invLocation, want: expectedLocation });
      }
    } else {
      // No shelves: location MUST be null.
      expectedLocation = null;
      if (hasInvRow && invLocation !== null) {
        issues.push({ code: "stale_location_without_shelf", message: "inventory.location set with no shelf rows", got: invLocation, want: null });
      }
    }
  }

  const hasInconsistent = issues.some((i) => INCONSISTENT_CODES.has(i.code));
  const hasDrift = issues.length > 0 && !hasInconsistent;
  const status: ReconcileStatus = hasInconsistent ? "inconsistent" : hasDrift ? "drift" : "clean";

  return {
    status,
    productId,
    kind,
    current: { parentStock: invStock, variantSum, shelfSum, location: invLocation },
    expected: { parentStock: expectedParent, location: expectedLocation },
    issues,
  };
}

// ── Repair classification (pure) ──────────────────────────────────────────────

export type RepairClass = "AUTO_SAFE" | "MANUAL_REQUIRED";

export interface RepairItem {
  productId: string;
  code: ReconcileIssueCode;
  repair: RepairClass;
  variantId?: string;
  reason: string;
}

/**
 * Classify each issue of a reconcile result as AUTO_SAFE or MANUAL_REQUIRED. A
 * repair is AUTO_SAFE only when the authoritative value is unambiguous and no
 * quantity has to be invented. The input rows are needed to prove "exactly one
 * shelf row" for the single-shelf-row auto-repairs.
 */
export function classifyRepairs(result: ReconcileResult, input: ReconcileInput): RepairItem[] {
  const out: RepairItem[] = [];
  const pid = result.productId;
  const variantShelfCount = new Map<string, number>();
  for (const r of input.variantShelfStock ?? []) {
    variantShelfCount.set(r.variant_id, (variantShelfCount.get(r.variant_id) ?? 0) + 1);
  }
  const productShelfCount = (input.shelfStock ?? []).length;

  for (const iss of result.issues) {
    switch (iss.code) {
      case "parent_rollup_drift":
        // AUTO_SAFE: exactly one inventory row, all variant quantities valid, no
        // product-level shelves → parent = Σ variants.
        if (result.current.variantSum !== null && (input.inventoryRows?.length ?? 0) === 1 && productShelfCount === 0) {
          out.push({ productId: pid, code: iss.code, repair: "AUTO_SAFE", reason: "parent = Σ variants" });
        } else {
          out.push({ productId: pid, code: iss.code, repair: "MANUAL_REQUIRED", reason: "cannot derive parent safely" });
        }
        break;
      case "shelf_drift":
        // AUTO_SAFE only when inventory quantity valid AND exactly ONE shelf row →
        // that row = authoritative inventory stock. Multiple rows: never guess.
        if (result.kind === "simple" && result.current.parentStock !== null && productShelfCount === 1) {
          out.push({ productId: pid, code: iss.code, repair: "AUTO_SAFE", reason: "single shelf row = inventory stock" });
        } else {
          out.push({ productId: pid, code: iss.code, repair: "MANUAL_REQUIRED", reason: "multiple shelf rows / unknown distribution" });
        }
        break;
      case "variant_shelf_drift": {
        const cnt = iss.variantId ? variantShelfCount.get(iss.variantId) ?? 0 : 0;
        const v = (input.variants ?? []).find((x) => x.id === iss.variantId);
        if (cnt === 1 && v && isCleanQty(v.stock_quantity)) {
          out.push({ productId: pid, code: iss.code, repair: "AUTO_SAFE", variantId: iss.variantId, reason: "single variant shelf row = variant stock" });
        } else {
          out.push({ productId: pid, code: iss.code, repair: "MANUAL_REQUIRED", variantId: iss.variantId, reason: "multiple variant shelf rows / malformed variant" });
        }
        break;
      }
      case "primary_location_drift":
        out.push({ productId: pid, code: iss.code, repair: "AUTO_SAFE", reason: "location = deterministic primary" });
        break;
      case "stale_location_without_shelf":
        out.push({ productId: pid, code: iss.code, repair: "AUTO_SAFE", reason: "location = null" });
        break;
      default:
        // missing/duplicate inventory, malformed_*, parent_has_shelf_rows → manual.
        out.push({ productId: pid, code: iss.code, repair: "MANUAL_REQUIRED", variantId: iss.variantId, reason: "authority unknown / structural" });
    }
  }
  return out;
}
