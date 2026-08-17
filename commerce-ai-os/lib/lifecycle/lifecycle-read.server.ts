// OPS.8B — product lifecycle read model (SERVER-ONLY, read-only).
//
// Assembles the DERIVED lifecycle picture for one live product by REUSING the
// certified engines — it invents no readiness rule and writes nothing:
//   • resolveLifecycleState (OPS.8A)            → the stored state
//   • computeProductReadiness (UI.7.1)          → complete/approved ⇒ READY
//   • the pure transition engine (OPS.8B)       → available transitions + display
//
// Injected client (like master-catalog-read) — a targeted single-row read via
// the parameterized `.filter(col,"eq",val)` surface, never string interpolation.

import "server-only";

import { computeProductReadiness, isApproved } from "@/lib/operations/readiness/readiness";
import { mapProductRow } from "@/lib/operations/dashboard-view";
import type { ReadinessStatus } from "@/lib/operations/shared/models";
import { resolveLifecycleState, type LifecycleState } from "./state";
import {
  availableTransitions,
  displayLifecycle,
  type AvailableTransition,
  type LifecycleDisplay,
} from "./transitions";

// Minimal parameterized single-row surface (select → filter → limit). The full
// Supabase session client satisfies this structurally.
interface LifecycleFilterBuilder extends PromiseLike<{ data: unknown[] | null; error: unknown }> {
  filter(column: string, operator: string, value: string): LifecycleFilterBuilder;
  limit(n: number): LifecycleFilterBuilder;
}
interface LifecycleSelectBuilder {
  select(columns: string): LifecycleFilterBuilder;
}
export interface LifecycleReadClient {
  from(table: string): LifecycleSelectBuilder;
}

// lifecycle_state is the ONLY column this phase adds to the read — everything
// else feeds the certified readiness snapshot.
const LIFECYCLE_COLUMNS =
  "id, sku, barcode, name_ar, name_en, description_ar, description_en, brand_id, main_category, price, image_url, approval, platform_status, lifecycle_state";

const VARIANT_CAP = 500;

export interface ProductLifecycleView {
  productId: string;
  sku: string | null;
  /** the STORED lifecycle state (DRAFT | ACTIVE | STOPPED) */
  state: LifecycleState;
  /** the DERIVED display state (adds READY for a complete+approved DRAFT) */
  display: LifecycleDisplay;
  /** derived READY: catalog-complete AND approved (readiness.readyToPublish) */
  ready: boolean;
  approved: boolean;
  readinessPercent: number;
  readinessStatus: ReadinessStatus;
  /** fixed reason strings explaining why the product is not yet READY */
  blockingReasons: string[];
  /** transitions leaving the current state, annotated with allowedNow */
  transitions: AvailableTransition[];
}

/**
 * Load the lifecycle view for ONE live product. Returns null when the product
 * has no live row (archived / not found) — an archived product is shown via
 * /products/archive, never as a fake live lifecycle page. Never throws; a read
 * failure yields null so the page section simply renders nothing.
 */
export async function loadProductLifecycle(
  client: LifecycleReadClient,
  productId: string,
): Promise<ProductLifecycleView | null> {
  if (typeof productId !== "string" || productId === "") return null;
  try {
    const { data, error } = await client
      .from("products")
      .select(LIFECYCLE_COLUMNS)
      .filter("id", "eq", productId)
      .limit(1);
    if (error) return null;
    const raw = Array.isArray(data) ? data[0] : null;
    if (!raw || typeof raw !== "object") return null;
    const row = raw as Record<string, unknown>;

    // variant count (needed by the readiness variants rule)
    let variantCount = 0;
    try {
      const vres = await client
        .from("product_variants")
        .select("id")
        .filter("parent_product_id", "eq", productId)
        .limit(VARIANT_CAP);
      if (!vres.error && Array.isArray(vres.data)) variantCount = vres.data.length;
    } catch {
      variantCount = 0;
    }

    const product = mapProductRow(row, variantCount);
    const readiness = computeProductReadiness(product);
    const state = resolveLifecycleState(row);
    const approved = isApproved(product);
    const ready = readiness.readyToPublish; // requiredOk AND approved

    const ctx = { ready, archived: false };
    return {
      productId: product.id || productId,
      sku: product.sku,
      state,
      display: displayLifecycle(state, ctx),
      ready,
      approved,
      readinessPercent: readiness.percent,
      readinessStatus: readiness.status,
      blockingReasons: ready ? [] : readiness.reasons.map((r) => r.message),
      transitions: availableTransitions(state, ctx),
    };
  } catch {
    return null;
  }
}
