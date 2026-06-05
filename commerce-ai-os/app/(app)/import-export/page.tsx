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

  return (
    <div className="space-y-6">
      <p className="text-sm text-muted">
        Import and per-channel export. Exports pull the live database; no real marketplace API is called.
      </p>
      <ExcelImport />
      <ImageUpload products={(productList ?? []) as { id: string; name_en: string | null }[]} />
      <ExportButtons />
    </div>
  );
}
