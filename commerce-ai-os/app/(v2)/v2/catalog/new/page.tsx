// /v2/catalog/new — Malikas V2 AI Product Creator (Phase UI.5). Server
// Component. Auth comes from the (v2) layout gate; every mutating step
// re-checks the session in its own action. This page only loads the brand
// list (for the brand select) through the injected session client and renders
// the client wizard — no AI call, no storage, no writes happen here.

import { createClient } from "@/lib/supabase/server";
import { CATEGORIES, STOCK_STATUSES } from "@/lib/constants";
import { toEditBrands, type EditBrand } from "@/lib/products/product-edit-read";
import AiProductCreator from "@/components/v2/catalog/AiProductCreator";

export const dynamic = "force-dynamic";

export default async function NewAiProductPage() {
  // Brand list is auxiliary: a failure degrades to an empty select rather
  // than blocking the wizard (same posture as the product editor).
  let brands: EditBrand[] = [];
  try {
    const supabase = createClient();
    const { data, error } = await supabase.from("brands").select("id, name").order("name");
    if (!error) brands = toEditBrands(data ?? []);
  } catch {
    brands = [];
  }

  return (
    <AiProductCreator
      brands={brands}
      categories={[...CATEGORIES]}
      stockStatuses={[...STOCK_STATUSES]}
    />
  );
}
