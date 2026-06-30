import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { getT } from "@/lib/i18n-server";
import ExcelImport from "@/components/ExcelImport";
import ImageUpload from "@/components/ImageUpload";
import ExportButtons from "@/components/ExportButtons";
import TalabatExport, { type CatCount } from "@/components/TalabatExport";

export const dynamic = "force-dynamic";

export default async function ImportExportPage() {
  const supabase = createClient();
  const { locale } = await getT();
  const en = locale === "en";
  const L = (ar: string, e: string) => (en ? e : ar);

  // Product list for the image-attach dropdown only; exports pull live data
  // server-side via /api/export/[channel].
  const { data: productList } = await supabase
    .from("products")
    .select("id, name_en")
    .order("name_en")
    .limit(1000);

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
      <p className="text-sm text-muted">
        {L(
          "استيراد وتصدير لكل منصة. التصدير يسحب قاعدة البيانات الحية؛ لا يتم استدعاء أي واجهة برمجة حقيقية لأي سوق.",
          "Import and per-channel export. Exports pull the live database; no real marketplace API is called."
        )}
      </p>
      <Link href="/import-export/availability" className="card flex items-center justify-between border-brand/30 bg-brand/5 hover:bg-brand/10">
        <div>
          <h3 className="text-sm font-semibold text-ink">🔁 {L("مطابقة التوفّر بين المنصّات", "Match availability across platforms")}</h3>
          <p className="text-xs text-muted">{L("ارفع قوائم مليكاس · Pure Seoul · Talabat · Rafeeq → وحّد النافد على الكل وادفعه لـ Shopify.", "Upload Malika · Pure Seoul · Talabat · Rafeeq lists → unify out-of-stock across all and push to Shopify.")}</p>
        </div>
        <span className="text-brand">→</span>
      </Link>
      <Link href="/import-export/snoonu-sync" className="card flex items-center justify-between hover:bg-slate-50">
        <div>
          <h3 className="text-sm font-semibold text-ink">🔄 Snoonu Sync</h3>
          <p className="text-xs text-muted">{L("ارفع تصدير سنونو وطابقه عبر snoonu_id (راجع الفروق قبل التطبيق).", "Upload a Snoonu export and reconcile by snoonu_id (diff before apply).")}</p>
        </div>
        <span className="text-brand">→</span>
      </Link>
      <Link href="/import-export/pure-seoul" className="card flex items-center justify-between hover:bg-slate-50">
        <div>
          <h3 className="text-sm font-semibold text-ink">🏬 {L("Pure Seoul — مطابقة مليكاس", "Pure Seoul — match Malika")}</h3>
          <p className="text-xs text-muted">{L("ارفع تصدير Pure Seoul → شوف الناقص/الزائد/فروق الأسعار مقابل مليكاس.", "Upload the Pure Seoul export → see what's missing/extra and price differences vs Malika.")}</p>
        </div>
        <span className="text-brand">→</span>
      </Link>
      <ExcelImport locale={locale} />
      <ImageUpload products={(productList ?? []) as { id: string; name_en: string | null }[]} locale={locale} />
      <TalabatExport categories={categories} newCount={newCount ?? 0} locale={locale} />
      <ExportButtons imageCount={imageCount ?? 0} locale={locale} />
    </div>
  );
}
