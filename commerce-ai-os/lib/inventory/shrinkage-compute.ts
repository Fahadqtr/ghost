// Shrinkage / loss aggregation — pure, DB-free core.
//
// Given stock-OUT rows from the movement ledger (malak_audit), classify each as
// sale, neutral transfer, or loss, and roll losses up by reason / product /
// employee. Kept free of Supabase and next/headers so it is unit-testable; the
// DB fetches (rows in, product names in) live in shrinkage.ts.

// Reasons that are NOT shrinkage. "sale" is revenue; transfers just move stock.
const NON_LOSS = new Set(["sale", "بيع", "تحويل", "transfer"]);

export interface NameUnits {
  key: string;
  units: number;
  count: number;
}

export interface ShrinkageReport {
  configured: boolean;
  days: number;
  lossUnits: number;      // total units lost to non-sale, non-transfer OUTs
  lossEvents: number;     // number of such movements
  salesUnits: number;     // units sold in the window (context)
  byReason: NameUnits[];  // loss grouped by reason
  byProduct: NameUnits[]; // loss grouped by product (top 10, name/sku)
  byEmployee: NameUnits[];// loss grouped by who logged it (top 10)
}

/** One stock-OUT row from the movement ledger (subset we read). */
export interface ShrinkageRow {
  sku?: string | null;
  new_value?: unknown;
  old_value?: unknown;
  details?: {
    quantity?: unknown;
    reason?: unknown;
    productId?: unknown;
    by?: unknown;
  } | null;
  created_at?: string | null;
}

/** Units moved by a row: prefer details.quantity, else the ledger delta. */
function qtyOf(r: ShrinkageRow): number {
  const d = Number(r?.details?.quantity);
  if (Number.isFinite(d) && d > 0) return d;
  const delta = Math.abs(Number(r.new_value) - Number(r.old_value));
  return Number.isFinite(delta) ? delta : 0;
}

/** Distinct product ids referenced by the rows — used to resolve names. */
export function productIdsIn(rows: ShrinkageRow[]): string[] {
  const ids = new Set<string>();
  for (const r of rows) {
    if (r?.details?.productId) ids.add(String(r.details.productId));
  }
  return Array.from(ids);
}

/**
 * Aggregate loss from ledger rows. `nameByProductId` (optional) resolves the
 * byProduct labels from product id → display name; unresolved products keep
 * their sku/id. Always reports `configured: true` — the not-configured empty
 * case is the wrapper's responsibility.
 */
export function computeShrinkage(
  rows: ShrinkageRow[],
  days: number,
  nameByProductId?: Map<string, string>,
): ShrinkageReport {
  const reasonMap = new Map<string, NameUnits>();
  const prodMap = new Map<string, NameUnits>();     // keyed by productId or sku
  const empMap = new Map<string, NameUnits>();
  let lossUnits = 0, lossEvents = 0, salesUnits = 0;

  for (const r of rows) {
    const qty = qtyOf(r);
    if (qty <= 0) continue;
    const reason = String(r?.details?.reason ?? "").trim();
    if (reason === "sale") { salesUnits += qty; continue; }
    if (NON_LOSS.has(reason.toLowerCase()) || NON_LOSS.has(reason)) continue;

    lossUnits += qty; lossEvents += 1;

    const rk = reason || "—";
    const rEntry = reasonMap.get(rk) ?? { key: rk, units: 0, count: 0 };
    rEntry.units += qty; rEntry.count += 1; reasonMap.set(rk, rEntry);

    const pid = r?.details?.productId ? String(r.details.productId) : null;
    const pkey = pid || (r.sku ? `sku:${r.sku}` : "—");
    const pEntry = prodMap.get(pkey) ?? { key: r.sku ? String(r.sku) : pkey, units: 0, count: 0 };
    pEntry.units += qty; pEntry.count += 1; prodMap.set(pkey, pEntry);

    const by = String(r?.details?.by ?? "").replace(/^staff:/, "") || "—";
    const eEntry = empMap.get(by) ?? { key: by, units: 0, count: 0 };
    eEntry.units += qty; eEntry.count += 1; empMap.set(by, eEntry);
  }

  // Resolve product-id keys to display names where we have them.
  if (nameByProductId?.size) {
    for (const [pkey, entry] of prodMap) {
      const name = nameByProductId.get(pkey);
      if (name) entry.key = name;
    }
  }

  const sortUnits = (m: Map<string, NameUnits>) =>
    Array.from(m.values()).sort((a, b) => b.units - a.units);

  return {
    configured: true,
    days,
    lossUnits,
    lossEvents,
    salesUnits,
    byReason: sortUnits(reasonMap),
    byProduct: sortUnits(prodMap).slice(0, 10),
    byEmployee: sortUnits(empMap).slice(0, 10),
  };
}
