import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import ExcelImport from "@/components/ExcelImport";
import ImageUpload from "@/components/ImageUpload";
import ExportButtons from "@/components/ExportButtons";

export const dynamic = "force-dynamic";

export default async function ImportExportPage() {
  const supabase = createClient();

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

  return (
    <div className="space-y-6">
      <p className="text-sm text-muted">
        Import and per-channel export. Exports pull the live database; no real marketplace API is called.
      </p>
      <Link href="/import-export/snoonu-sync" className="card flex items-center justify-between hover:bg-slate-50">
        <div>
          <h3 className="text-sm font-semibold text-ink">🔄 Snoonu Sync</h3>
          <p className="text-xs text-muted">Upload a Snoonu export and reconcile by snoonu_id (diff before apply).</p>
        </div>
        <span className="text-brand">→</span>
      </Link>
      <ExcelImport />
      <ImageUpload products={(productList ?? []) as { id: string; name_en: string | null }[]} />
      <ExportButtons imageCount={imageCount ?? 0} />
    </div>
  );
}
