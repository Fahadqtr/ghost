// /import-export/images — Images & quality workspace (UX.3A). Wrapper page: it
// renders the EXISTING image components unchanged; nothing here is new logic. The
// product-list read that used to run on the Import/Export hub was MOVED here so it
// only loads when this workspace is opened (hub is now a light landing page).
// Auth is the (app) layout login gate, same as before.

import { createClient } from "@/lib/supabase/server";
import { getT } from "@/lib/i18n-server";
import ImageHealth from "@/components/ImageHealth";
import ImageUpload from "@/components/ImageUpload";
import CatalogImageBySku from "@/components/CatalogImageBySku";

export const dynamic = "force-dynamic";

export default async function ImportExportImagesPage() {
  const supabase = createClient();
  const { locale } = await getT();

  // Product list for the image-attach dropdown only (moved verbatim from the hub).
  const { data: productList } = await supabase
    .from("products")
    .select("id, name_en")
    .order("name_en")
    .limit(1000);

  return (
    <div className="space-y-6">
      <ImageHealth />
      <ImageUpload products={(productList ?? []) as { id: string; name_en: string | null }[]} locale={locale} />
      <CatalogImageBySku locale={locale} />
    </div>
  );
}
