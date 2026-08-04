// /v2/catalog/[id] — Malikas read-only Product Detail (Phase UI.2B). Server
// Component. Validates the id, loads one product + its catalog-safe variants via
// the injected Supabase client (existing user session), and renders it. Data
// loading is isolated in try/catch; JSX is built only afterwards. On failure it
// shows a single constant Arabic message and on a missing/invalid id a single
// constant not-found message — never the requested id, a raw error, stack,
// table/column name, JSON, code, or hint.

import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { loadCatalogProduct } from "@/lib/catalog-v2/master-catalog-read";
import { parseProductId, type CatalogVariant, type MasterCatalogProduct } from "@/lib/catalog-v2/master-catalog-view";
import ProductDetail from "@/components/v2/catalog/ProductDetail";

export const dynamic = "force-dynamic";

const LOAD_ERROR = "تعذر تحميل كتالوج ماليكاس.";
const NOT_FOUND = "لا يوجد منتج بهذا المعرّف.";

type Params = Promise<{ id: string }>;

export default async function ProductDetailPage({ params }: { params: Params }) {
  let state:
    | { kind: "ok"; product: MasterCatalogProduct; variants: CatalogVariant[] }
    | { kind: "notfound" }
    | { kind: "error" } = { kind: "error" };

  try {
    const { id } = await params;
    const validId = parseProductId(id);
    if (validId === null) {
      state = { kind: "notfound" };
    } else {
      const supabase = createClient();
      const result = await loadCatalogProduct(supabase, validId);
      if (result.status === "error") {
        state = { kind: "error" };
      } else if (result.product === null) {
        state = { kind: "notfound" };
      } else {
        state = { kind: "ok", product: result.product, variants: result.variants };
      }
    }
  } catch {
    state = { kind: "error" };
  }

  if (state.kind === "error") {
    return (
      <div className="space-y-4">
        <Link href="/v2/catalog" className="btn-ghost">
          رجوع للكتالوج
        </Link>
        <div className="card border-rose-200 bg-rose-50 text-sm text-rose-700">{LOAD_ERROR}</div>
      </div>
    );
  }

  if (state.kind === "notfound") {
    return (
      <div className="space-y-4">
        <Link href="/v2/catalog" className="btn-ghost">
          رجوع للكتالوج
        </Link>
        <div className="card text-center text-sm text-muted">{NOT_FOUND}</div>
      </div>
    );
  }

  return <ProductDetail product={state.product} variants={state.variants} />;
}
