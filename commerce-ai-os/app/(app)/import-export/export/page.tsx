// /import-export/export — Talabat identity/export (legacy, RETAINED).
//
// INT.2F retired the legacy export platform. The bulk per-channel file exports
// (Snoonu masterlist, Rafeeq file, product-image ZIP, and their download
// surface) are gone — the Export Center (/v2/export) is the sole export system.
//
// This page is RETAINED for ONE reason only: TalabatExport is the operator
// trigger for the legacy Talabat CSV export, whose GET side-effect is the sole
// writer of channel_variant_mappings (the authoritative first rung of Talabat
// order-deduction identity). That identity-persistence capability is not yet
// replaced by the certified Talabat package, so it stays until a dedicated
// mapping-sync phase re-homes it.

import { createClient } from "@/lib/supabase/server";
import { getT } from "@/lib/i18n-server";
import TalabatExport, { type CatCount } from "@/components/TalabatExport";

export const dynamic = "force-dynamic";

export default async function ImportExportExportsPage() {
  const supabase = createClient();
  const { locale } = await getT();

  // Category counts for the Talabat category picker.
  const catRows: { main_category: string | null }[] = [];
  for (let from = 0; ; from += 1000) {
    const { data } = await supabase.from("products").select("main_category").range(from, from + 999);
    if (!data || data.length === 0) break;
    catRows.push(...data);
    if (data.length < 1000) break;
  }
  const tally = new Map<string, number>();
  for (const r of catRows) {
    const c = (r.main_category ?? "").trim();
    if (c) tally.set(c, (tally.get(c) ?? 0) + 1);
  }
  const categories: CatCount[] = [...tally.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);

  // Count of products added via Snoonu Sync (notes marker) — for the
  // "export new products only" button.
  const { count: newCount } = await supabase
    .from("products")
    .select("*", { count: "exact", head: true })
    .like("notes", "Imported from Snoonu sync%");

  return (
    <div className="space-y-6">
      <div className="card border-brand/30 bg-brand-light/40 text-xs text-muted">
        صُدِّرت المنصات (شوبي فاي · سنونو · رفيق) الآن عبر <span dir="ltr">مركز التصدير (/v2/export)</span>.
        هذه الصفحة مخصّصة فقط لتصدير طلبات — لتحديث ربط المتغيّرات (channel_variant_mappings).
      </div>
      <TalabatExport categories={categories} newCount={newCount ?? 0} locale={locale} />
    </div>
  );
}
