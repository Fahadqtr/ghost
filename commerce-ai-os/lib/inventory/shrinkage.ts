// Shrinkage / loss report (server-only, read-only). Built from the movement
// ledger (malak_audit): every stock-OUT whose reason is NOT a sale and NOT a
// neutral transfer is treated as loss (damaged, lost, etc.). Grounded entirely
// in recorded movements — nothing estimated. The classification/aggregation is
// pure and unit-tested in shrinkage-compute.ts; this file only does the I/O.
import { createAdminClient } from "@/lib/supabase/admin";
import {
  computeShrinkage,
  productIdsIn,
  type ShrinkageReport,
  type ShrinkageRow,
} from "./shrinkage-compute";

export type { NameUnits, ShrinkageReport } from "./shrinkage-compute";

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

  let rows: ShrinkageRow[] = [];
  try {
    const { data } = await admin
      .from("malak_audit")
      .select("sku, new_value, old_value, details, created_at")
      .eq("action_type", "stock_out")
      .gte("created_at", since.toISOString())
      .order("created_at", { ascending: false })
      .limit(5000);
    rows = (data ?? []) as ShrinkageRow[];
  } catch {
    return { ...empty, configured: true };
  }

  // Resolve product names for the byProduct breakdown.
  const nameByProductId = new Map<string, string>();
  const prodIds = productIdsIn(rows);
  if (prodIds.length) {
    try {
      const { data } = await admin.from("products").select("id, name_en, name_ar, sku").in("id", prodIds);
      for (const p of (data ?? []) as any[]) {
        const name = p.name_en || p.name_ar || p.sku;
        if (name) nameByProductId.set(String(p.id), name);
      }
    } catch { /* keep sku/id fallback */ }
  }

  return computeShrinkage(rows, days, nameByProductId);
}
