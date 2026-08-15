// CH.6B — apply planning + idempotency (PURE). Decides what an apply MAY touch;
// the orchestrator executes the fetch/store. Only confirmed MATCHED rows proceed,
// and stale-preview protection skips any product that gained a valid primary
// image since the preview.
//
// PURE: imports only sibling contracts. node:test loads it directly.

import { type ApplyItemResult, type ImagePreviewRow } from "./merchant-contract.ts";

export type PlannedAction = "import" | "skip" | "needs_review";

export interface PlannedItem {
  productId: string;
  action: PlannedAction;
  reason: string;
  merchantImageUrl: string | null;
  storefrontKey: string;
  spi: string | null;
}

export interface ImportPlanInput {
  /** The preview rows the operator confirmed (by productId). */
  rows: ImagePreviewRow[];
  /** productIds the operator explicitly selected to import. */
  selected: Set<string>;
  /** FRESH image state at apply time: productId → has a valid primary image NOW. */
  hasImageNow: Map<string, boolean>;
}

/**
 * Produce a per-product plan. Rules:
 *  - only selected + MATCHED rows are eligible;
 *  - a product that already has a valid primary image now → skip (idempotent /
 *    stale-preview protection: never overwrite a newly-added internal image);
 *  - non-MATCHED selected rows → needs_review (never imported);
 *  - a MATCHED row without a merchant image url → needs_review.
 */
export function planImageImport(input: ImportPlanInput): PlannedItem[] {
  const out: PlannedItem[] = [];
  for (const r of input.rows) {
    if (!input.selected.has(r.productId)) continue; // not chosen → not in the plan
    const base = { productId: r.productId, merchantImageUrl: r.merchantImageUrl, storefrontKey: r.storefrontKey, spi: r.spi };
    if (r.matchStatus !== "MATCHED") {
      out.push({ ...base, action: "needs_review", reason: "only MATCHED rows may be imported" });
      continue;
    }
    if (input.hasImageNow.get(r.productId) === true) {
      out.push({ ...base, action: "skip", reason: "product already has a valid primary image (stale preview / idempotent)" });
      continue;
    }
    if (!(r.merchantImageUrl ?? "").trim()) {
      out.push({ ...base, action: "needs_review", reason: "no source image to import" });
      continue;
    }
    out.push({ ...base, action: "import", reason: r.reason });
  }
  return out;
}

/** Map a planned non-import action to its terminal apply result. */
export function plannedNonImportResult(item: PlannedItem): ApplyItemResult {
  return { productId: item.productId, status: item.action === "skip" ? "SKIPPED" : "NEEDS_REVIEW", reason: item.reason };
}
