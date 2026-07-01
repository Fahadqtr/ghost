// Shrinkage / loss report (server-only, read-only). Built from the movement
// ledger (malak_audit): every stock-OUT whose reason is NOT a sale and NOT a
// neutral transfer is treated as loss (damaged, lost, etc.). Grounded entirely
// in recorded movements — nothing estimated.
import { createAdminClient } from "@/lib/supabase/admin";

// Reasons that are NOT shrinkage. "sale" is revenue; transfers just move stock.
const NON_LOSS = new Set(["sale", "بيع", "تحويل", "transfer"]);

export interface NameUnits { key: string; units: number; count: number }
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

function adminClient(): any | null {
  try { return createAdminClient(); } catch { return null; }
}

export async function getShrinkageReport(days = 30): Promise<ShrinkageReport> {
  const empty: ShrinkageReport = {
    configured: false, days, lossUnits: 0, lossEvents: 0, salesUnits: 0,
    byReason: [], byProduct: [], byEmployee: [],
  };
  const admin = adminClient();
  if (!admin) return empty;

  const since = new Date();
  since.setDate(since.getDate() - days);

  let rows: any[] = [];
  try {
    const { data } = await admin
      .from("malak_audit")
      .select("sku, new_value, old_value, details, created_at")
      .eq("action_type", "stock_out")
      .gte("created_at", since.toISOString())
      .order("created_at", { ascending: false })
      .limit(5000);
    rows = data ?? [];
  } catch {
    return { ...empty, configured: true };
  }

  const qtyOf = (r: any): number => {
    const d = Number(r?.details?.quantity);
    if (Number.isFinite(d) && d > 0) return d;
    // Fall back to the ledger delta when details.quantity is absent.
    const delta = Math.abs(Number(r.new_value) - Number(r.old_value));
    return Number.isFinite(delta) ? delta : 0;
  };

  const reasonMap = new Map<string, NameUnits>();
  const prodMap = new Map<string, NameUnits>();     // keyed by productId or sku
  const empMap = new Map<string, NameUnits>();
  const prodIds = new Set<string>();
  let lossUnits = 0, lossEvents = 0, salesUnits = 0;

  for (const r of rows) {
    const qty = qtyOf(r);
    if (qty <= 0) continue;
    const reason = String(r?.details?.reason ?? "").trim();
    if (reason === "sale") { salesUnits += qty; continue; }
    if (NON_LOSS.has(reason.toLowerCase()) || NON_LOSS.has(reason)) continue;

    lossUnits += qty; lossEvents += 1;

    const rk = reason || (r.sku ? "—" : "—");
    const rEntry = reasonMap.get(rk) ?? { key: rk, units: 0, count: 0 };
    rEntry.units += qty; rEntry.count += 1; reasonMap.set(rk, rEntry);

    const pid = r?.details?.productId ? String(r.details.productId) : null;
    const pkey = pid || (r.sku ? `sku:${r.sku}` : "—");
    if (pid) prodIds.add(pid);
    const pEntry = prodMap.get(pkey) ?? { key: r.sku ? String(r.sku) : pkey, units: 0, count: 0 };
    pEntry.units += qty; pEntry.count += 1; prodMap.set(pkey, pEntry);

    const by = String(r?.details?.by ?? "").replace(/^staff:/, "") || "—";
    const eEntry = empMap.get(by) ?? { key: by, units: 0, count: 0 };
    eEntry.units += qty; eEntry.count += 1; empMap.set(by, eEntry);
  }

  // Resolve product names for the byProduct breakdown.
  if (prodIds.size) {
    try {
      const { data } = await admin.from("products").select("id, name_en, name_ar, sku").in("id", Array.from(prodIds));
      const byId = new Map<string, any>((data ?? []).map((p: any) => [String(p.id), p]));
      for (const [pkey, entry] of prodMap) {
        const p = byId.get(pkey);
        if (p) entry.key = p.name_en || p.name_ar || p.sku || entry.key;
      }
    } catch { /* keep sku/id fallback */ }
  }

  const sortUnits = (m: Map<string, NameUnits>) => Array.from(m.values()).sort((a, b) => b.units - a.units);

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
