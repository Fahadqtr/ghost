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
import PlatformMatrix from "@/components/v2/catalog/PlatformMatrix";
import { loadProductPlatformMatrix } from "@/lib/operations/platform-matrix-read";
import type { PlatformMatrixItem } from "@/lib/operations/platform-matrix";
import { buildCrossPlatformDiff } from "@/lib/operations/cross-platform-diff";
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
import ProductMedia from "@/components/v2/catalog/ProductMedia";
import { loadProductMedia } from "@/lib/products/product-media-read";
import { EMPTY_PRODUCT_MEDIA, type ProductMediaState } from "@/lib/products/product-media";
import InPageNav from "@/components/v2/InPageNav";
import LifecyclePanel from "@/components/v2/catalog/LifecyclePanel";
import { loadProductLifecycle, type ProductLifecycleView } from "@/lib/lifecycle/lifecycle-read.server";
import { loadCatalogHealth } from "@/lib/catalog/health/health.server";
import type { CatalogHealth } from "@/lib/catalog/health/health-model";
import CatalogHealthCard from "@/components/v2/catalog/CatalogHealthCard";
import { loadEvidence } from "@/lib/catalog/evidence/evidence.server";
import type { EvidenceResult } from "@/lib/catalog/evidence/evidence-engine";
import EvidenceSection from "@/components/v2/catalog/EvidenceSection";
import { runLifecycleTransition } from "./actions";

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
  // Unified per-platform matrix (CI.1). Best-effort + isolated: derived read-only
  // from platform_snapshots; a failure never breaks the page (section omitted).
  let platformMatrix: PlatformMatrixItem | null = null;
  // Unified product media (UX.4C-1). Best-effort + isolated read: products.image_url
  // (+ product_images gallery) projected through the shared reducer. A failure
  // simply omits the media block — the rest of the page is unaffected.
  let media: ProductMediaState = EMPTY_PRODUCT_MEDIA;
  // Product lifecycle view (OPS.8B). Best-effort + isolated: derived read-only
  // (stored lifecycle_state + certified readiness). A failure omits the panel.
  let lifecycle: ProductLifecycleView | null = null;
  let health: CatalogHealth | null = null;
  let evidence: EvidenceResult | null = null;
  // OPS.8C — Action Center deep-links here with ?panel=lifecycle. Validated to the
  // exact literal (never the raw value) so the lifecycle panel is highlighted.
  let highlightLifecycle = false;
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
    highlightLifecycle = sp.panel === "lifecycle";

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
        try {
          platformMatrix = await loadProductPlatformMatrix(supabase as never, validId, {
            sku: result.product.sku ?? null,
            barcode: result.product.barcode ?? null,
          });
        } catch {
          platformMatrix = null;
        }
        try {
          const mediaRead = await loadProductMedia(supabase as never, validId);
          media = mediaRead.status === "ok" ? mediaRead.state : EMPTY_PRODUCT_MEDIA;
        } catch {
          media = EMPTY_PRODUCT_MEDIA;
        }
        try {
          lifecycle = await loadProductLifecycle(supabase as never, validId);
        } catch {
          lifecycle = null;
        }
        // CAT.1A — certified read-only Catalog Health (best-effort; a failure
        // simply omits the section — it never blocks the page and never writes).
        try {
          health = await loadCatalogHealth(validId);
        } catch {
          health = null;
        }
        // CAT.1B — unified read-only Evidence (best-effort; projected from the
        // certified health rules; never blocks the page and never writes).
        try {
          evidence = await loadEvidence(validId);
        } catch {
          evidence = null;
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
      {/* In-page section nav (UX.2) — anchors only, no client JS. Links to
          sections that may be conditionally rendered; a missing target simply
          does not scroll (safe). Cross-Platform Diff stays inside «المنصات»;
          the full Timeline stays a drilldown from «النشاط». */}
      <InPageNav
        items={[
          { href: "#details", label: "تفاصيل" },
          { href: "#lifecycle", label: "الحالة" },
          { href: "#health", label: "الصحة" },
          { href: "#platforms", label: "المنصات" },
          { href: "#tasks", label: "المهام" },
          { href: "#activity", label: "النشاط" },
          { href: "#history", label: "السجل" },
        ]}
      />

      <section id="details" className="scroll-mt-28 space-y-4">
        <ProductMedia state={media} />
        <ProductDetail
          product={state.product}
          variants={state.variants}
          backHref={backHref}
          editHref={editHref}
        />
      </section>
      {lifecycle ? (
        <section id="lifecycle" className="scroll-mt-28">
          <LifecyclePanel view={lifecycle} action={runLifecycleTransition} highlight={highlightLifecycle} />
        </section>
      ) : null}
      {health ? (
        <section id="health" className="scroll-mt-28 space-y-4">
          <CatalogHealthCard health={health} />
          {evidence ? <EvidenceSection result={evidence} /> : null}
        </section>
      ) : null}
      {platformMatrix ? (
        <section id="platforms" className="scroll-mt-28">
          <PlatformMatrix
            matrix={platformMatrix}
            diffs={buildCrossPlatformDiff(
              {
                productId: state.product.id,
                price: state.product.price,
                discountPrice: state.product.discountPrice,
                nameAr: state.product.nameAr,
                nameEn: state.product.nameEn,
              },
              platformMatrix.cells,
            )}
          />
        </section>
      ) : null}
      {operations ? (
        <section id="tasks" className="scroll-mt-28">
          <ProductTasksWidget tasks={operations.tasks} />
        </section>
      ) : null}
      {activityEvents ? (
        <section id="activity" className="scroll-mt-28">
          <ProductActivityWidget events={activityEvents} productId={state.product.id} />
        </section>
      ) : null}
      {platformHistory && platformHistory.status === "ok" &&
      (platformHistory.entries.length > 0 || platformHistory.comparisons.length > 0) ? (
        <section id="history" className="scroll-mt-28">
          <PlatformHistory
            entries={platformHistory.entries}
            comparisons={platformHistory.comparisons}
          />
        </section>
      ) : null}
    </div>
  );
}
