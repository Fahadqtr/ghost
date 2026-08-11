// /import-export/export — Exports workspace (UX.3A). Wrapper page: it renders the
// EXISTING export components unchanged (no logic moved into them). The category
// tally + image/new counts that used to run on the Import/Export hub on every open
// were MOVED here verbatim, so those reads (including the category scan) only run
// when this workspace is opened. Auth is the (app) layout login gate, same as before.

import { createClient } from "@/lib/supabase/server";
import { getT } from "@/lib/i18n-server";
import ExportButtons from "@/components/ExportButtons";
import TalabatExport, { type CatCount } from "@/components/TalabatExport";

export const dynamic = "force-dynamic";

export default async function ImportExportExportsPage() {
  const supabase = createClient();
  const { locale } = await getT();

  // How many products have a downloadable image (drives the batch buttons).
  const { count: imageCount } = await supabase
    .from("products")
    .select("*", { count: "exact", head: true })
    .not("image_filename", "is", null);

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
      <TalabatExport categories={categories} newCount={newCount ?? 0} locale={locale} />
      <ExportButtons imageCount={imageCount ?? 0} locale={locale} />
    </div>
  );
}
