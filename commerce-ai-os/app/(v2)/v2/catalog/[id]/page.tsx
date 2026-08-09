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
import { loadProductOperations, loadProductTimeline, type ProductOperations } from "@/lib/operations/read-model";
import ProductTasksWidget from "@/components/v2/operations/ProductTasksWidget";
import ProductActivityWidget from "@/components/v2/operations/ProductActivityWidget";
import PlatformHistory from "@/components/v2/catalog/PlatformHistory";
import { loadProductPlatformHistory, type ProductPlatformHistory } from "@/lib/operations/platform-history-read";
import type { TimelineEvent } from "@/lib/operations/shared/models";
import {
  catalogEditHref,
  catalogHref,
  parseCatalogControls,
  parseProductId,
  type CatalogVariant,
  type MasterCatalogProduct,
} from "@/lib/catalog-v2/master-catalog-view";
import ProductDetail from "@/components/v2/catalog/ProductDetail";

export const dynamic = "force-dynamic";

const LOAD_ERROR = "تعذر تحميل كتالوج ماليكاس.";
const NOT_FOUND = "لا يوجد منتج بهذا المعرّف.";

type Params = Promise<{ id: string }>;
type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function ProductDetailPage({
  params,
  searchParams,
}: {
  params: Params;
  searchParams?: SearchParams;
}) {
  // Re-parse the carried catalog state through the validated helper and rebuild
  // the return link via catalogHref — raw searchParams are NEVER copied into an
  // href. On any failure the back link falls back to the clean /v2/catalog.
  let backHref = "/v2/catalog";
  let editHref: string | undefined;
  // Phase UI.4: the editor redirects back here with saved=1 after a successful
  // save. Strict literal comparison — the value itself is never rendered.
  let saved = false;
  // Phase UI.5: the AI creator redirects here with created=1 after a create.
  let created = false;
  // Operations tasks for this product (Phase UI.7.3). Best-effort and isolated:
  // a failure here NEVER breaks the product page — the widget just renders empty.
  let operations: ProductOperations | null = null;
  // Activity timeline for this product (Phase UI.7.4). Best-effort and isolated:
  // a failure here NEVER breaks the product page — the widget just renders empty.
  let activityEvents: TimelineEvent[] | null = null;
  // Platform snapshot history for this product (Phase UI.9.4). Best-effort and
  // isolated: a failure here NEVER breaks the product page — the section is
  // simply omitted. Derived from platform_snapshots (read-only), never stored.
  let platformHistory: ProductPlatformHistory | null = null;
  let state:
    | { kind: "ok"; product: MasterCatalogProduct; variants: CatalogVariant[] }
    | { kind: "notfound" }
    | { kind: "error" } = { kind: "error" };

  try {
    const sp = searchParams ? await searchParams : {};
    const controls = parseCatalogControls(sp);
    backHref = catalogHref(controls, controls.page);
    saved = sp.saved === "1";
    created = sp.created === "1";

    const { id } = await params;
    const validId = parseProductId(id);
    if (validId === null) {
      state = { kind: "notfound" };
    } else {
      editHref = catalogEditHref(validId, controls);
      const supabase = createClient();
      const result = await loadCatalogProduct(supabase, validId);
      if (result.status === "error") {
        state = { kind: "error" };
      } else if (result.product === null) {
        state = { kind: "notfound" };
      } else {
        state = { kind: "ok", product: result.product, variants: result.variants };
        try {
          operations = await loadProductOperations(supabase as never, validId);
        } catch {
          operations = null;
        }
        try {
          const timeline = await loadProductTimeline(supabase as never, validId);
          activityEvents = timeline.status === "ok" ? timeline.timeline.events : null;
        } catch {
          activityEvents = null;
        }
        try {
          platformHistory = await loadProductPlatformHistory(supabase as never, validId);
        } catch {
          platformHistory = null;
        }
      }
    }
  } catch {
    state = { kind: "error" };
  }

  if (state.kind === "error") {
    return (
      <div className="space-y-4">
        <Link href={backHref} className="btn-ghost">
          رجوع للكتالوج
        </Link>
        <div className="card border-rose-200 bg-rose-50 text-sm text-rose-700">{LOAD_ERROR}</div>
      </div>
    );
  }

  if (state.kind === "notfound") {
    return (
      <div className="space-y-4">
        <Link href={backHref} className="btn-ghost">
          رجوع للكتالوج
        </Link>
        <div className="card text-center text-sm text-muted">{NOT_FOUND}</div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {saved ? (
        <div className="card border-emerald-200 bg-emerald-50 text-sm text-emerald-700">
          تم حفظ التغييرات.
        </div>
      ) : null}
      {created ? (
        <div className="card border-emerald-200 bg-emerald-50 text-sm text-emerald-700">
          تم إنشاء المنتج — وهو غير معتمد ولن يُرسل لأي منصة حتى تعتمده.
        </div>
      ) : null}
      <ProductDetail
        product={state.product}
        variants={state.variants}
        backHref={backHref}
        editHref={editHref}
      />
      {operations ? <ProductTasksWidget tasks={operations.tasks} /> : null}
      {activityEvents ? (
        <ProductActivityWidget events={activityEvents} productId={state.product.id} />
      ) : null}
      {platformHistory && platformHistory.status === "ok" &&
      (platformHistory.entries.length > 0 || platformHistory.comparisons.length > 0) ? (
        <PlatformHistory
          entries={platformHistory.entries}
          comparisons={platformHistory.comparisons}
        />
      ) : null}
    </div>
  );
}
