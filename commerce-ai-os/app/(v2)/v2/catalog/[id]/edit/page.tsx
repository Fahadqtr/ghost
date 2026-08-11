// /v2/catalog/[id]/edit — Malikas V2 Product Editor (Phase UI.4). Server
// Component. Validates the id, loads the product's editable fields + variants
// + the brand list via the injected session Supabase client, and renders the
// edit form. Same failure discipline as the detail page: one fixed Arabic
// message per state — never the requested id, a raw error, stack, table or
// column name, JSON, code, or hint. Auth comes from the (v2) layout gate; the
// save action re-checks the session itself.

import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { CATEGORIES, STOCK_STATUSES } from "@/lib/constants";
import { loadProductForEdit, type EditBrand, type ProductEditInitial } from "@/lib/products/product-edit-read";
import { EDIT_MESSAGES } from "@/lib/products/edit-validation";
import {
  catalogDetailHref,
  parseCatalogControls,
  parseProductId,
  type CatalogControls,
} from "@/lib/catalog-v2/master-catalog-view";
import ProductEditForm from "@/components/v2/catalog/ProductEditForm";
import ProductMedia from "@/components/v2/catalog/ProductMedia";
import { loadProductMedia } from "@/lib/products/product-media-read";
import { EMPTY_PRODUCT_MEDIA, type ProductMediaState } from "@/lib/products/product-media";

export const dynamic = "force-dynamic";

type Params = Promise<{ id: string }>;
type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function ProductEditPage({
  params,
  searchParams,
}: {
  params: Params;
  searchParams?: SearchParams;
}) {
  // Re-parse the carried catalog state through the validated helper and rebuild
  // every link via the href helpers — raw searchParams are NEVER copied into an
  // href. On any failure the cancel link falls back to the clean detail page.
  let cancelHref = "/v2/catalog";
  let state:
    | { kind: "ok"; id: string; initial: ProductEditInitial; brands: EditBrand[]; controls: CatalogControls; media: ProductMediaState }
    | { kind: "notfound" }
    | { kind: "error" } = { kind: "error" };

  try {
    const sp = searchParams ? await searchParams : {};
    const controls = parseCatalogControls(sp);

    const { id } = await params;
    const validId = parseProductId(id);
    if (validId === null) {
      state = { kind: "notfound" };
    } else {
      cancelHref = catalogDetailHref(validId, controls);
      const supabase = createClient();
      const result = await loadProductForEdit(supabase, validId);
      if (result.status === "error") {
        state = { kind: "error" };
      } else if (result.status === "notfound") {
        state = { kind: "notfound" };
      } else {
        // Read-only media (UX.4C-1). Best-effort + isolated: a failure just
        // renders the empty-media block; the editor is never blocked.
        let media: ProductMediaState = EMPTY_PRODUCT_MEDIA;
        try {
          const mediaRead = await loadProductMedia(supabase, validId);
          media = mediaRead.status === "ok" ? mediaRead.state : EMPTY_PRODUCT_MEDIA;
        } catch {
          media = EMPTY_PRODUCT_MEDIA;
        }
        state = { kind: "ok", id: validId, initial: result.initial, brands: result.brands, controls, media };
      }
    }
  } catch {
    state = { kind: "error" };
  }

  if (state.kind === "error") {
    return (
      <div className="space-y-4">
        <Link href={cancelHref} className="btn-ghost">
          رجوع
        </Link>
        <div className="card border-rose-200 bg-rose-50 text-sm text-rose-700">{EDIT_MESSAGES.load_failed}</div>
      </div>
    );
  }

  if (state.kind === "notfound") {
    return (
      <div className="space-y-4">
        <Link href={cancelHref} className="btn-ghost">
          رجوع
        </Link>
        <div className="card text-center text-sm text-muted">{EDIT_MESSAGES.not_found}</div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Read-only product media (UX.4C-1) above the form. This PR does not add
          any upload/edit controls — the primary photo still changes only via the
          existing create/legacy flows. */}
      <ProductMedia state={state.media} />
      <ProductEditForm
        productId={state.id}
        initial={state.initial}
        brands={state.brands}
        categories={[...CATEGORIES]}
        stockStatuses={[...STOCK_STATUSES]}
        controls={state.controls}
        cancelHref={cancelHref}
      />
    </div>
  );
}
