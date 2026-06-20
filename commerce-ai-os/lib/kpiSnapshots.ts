// Daily KPI trends. Records one snapshot per day (service-role upsert) and
// compares today's KPIs against the most recent earlier snapshot. Fully
// defensive: if the `kpi_snapshots` table doesn't exist yet, every call returns
// null and the dashboard simply shows no trend arrows.
import { createAdminClient } from "@/lib/supabase/admin";
import type { CeoKpis } from "@/lib/dashboard";

export interface KpiTrends {
  asOf: string | null;            // date of the snapshot we compared against
  totalProducts: number | null;   // deltas vs that snapshot
  publishedActive: number | null;
  healthGaps: number | null;      // change in total missing fields (down is good)
}

const today = () => new Date().toISOString().slice(0, 10);

export async function recordAndDiffSnapshot(k: CeoKpis): Promise<KpiTrends | null> {
  try {
    const sb = createAdminClient();
    const day = today();

    const { error: upErr } = await sb.from("kpi_snapshots").upsert(
      {
        snapshot_date: day,
        total_products: k.totalProducts,
        published_active: k.publishedActive,
        published_channels: k.publishedChannels,
        missing_price: k.missingPrice,
        missing_image: k.missingImage,
        missing_barcode: k.missingBarcode,
        missing_category: k.missingCategory,
        approved_count: k.approvedCount,
        rejected_count: k.rejectedCount,
        inventory_units: k.inventoryUnits,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "snapshot_date" },
    );
    if (upErr) return null; // table missing / not configured → no trends

    const { data } = await sb
      .from("kpi_snapshots")
      .select("snapshot_date, total_products, published_active, missing_price, missing_image, missing_barcode, missing_category")
      .lt("snapshot_date", day)
      .order("snapshot_date", { ascending: false })
      .limit(1);

    const prev = data?.[0];
    if (!prev) return { asOf: null, totalProducts: null, publishedActive: null, healthGaps: null };

    const prevGaps = prev.missing_price + prev.missing_image + prev.missing_barcode + prev.missing_category;
    const nowGaps = k.missingPrice + k.missingImage + k.missingBarcode + k.missingCategory;

    return {
      asOf: prev.snapshot_date,
      totalProducts: k.totalProducts - prev.total_products,
      publishedActive: k.publishedActive - prev.published_active,
      healthGaps: nowGaps - prevGaps,
    };
  } catch {
    return null; // service role unset, network error, etc. → no trends
  }
}
