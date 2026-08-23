// INT.2E.2 — Shopify publish plan (PURE).
//
// This is the safety brain of the live publisher. It NEVER computes a Shopify
// diff — it consumes the deterministic classification + op plan already produced
// by buildShopifyPreview (INT.2E) and decides, per row:
//   • eligibility (only NEW / UPDATE_REQUIRED / MATCH may proceed; CONFLICT,
//     BLOCKED, UNKNOWN are hard-stops),
//   • which planned ops this phase is allowed to EXECUTE (a conservative
//     supported set — price / product content / add-missing-media / create),
//   • a deterministic per-row fingerprint over exactly what would be written,
//     so a stale confirmation (internal or live Shopify changed since preview)
//     is rejected before any mutation.
//
// It also aggregates per-item results into a run status. No I/O, no Shopify calls,
// no DB — node:test loads it directly. There is NO second diff engine here.

import type { ShopifyPreviewStatus, ShopifyPlanOp, ShopifyPlanOpType } from "./preview.ts";

// Per-item outcome of an execution attempt (§5).
export type PublishItemResult =
  | "CREATED"
  | "UPDATED"
  | "UNCHANGED"
  | "STALE"
  | "BLOCKED"
  | "CONFLICT"
  | "FAILED"
  | "SKIPPED_UNSUPPORTED"
  | "NEEDS_RECONCILIATION";

// Durable run status (§13).
export type PublishRunStatus = "STARTED" | "SUCCEEDED" | "PARTIAL" | "FAILED" | "CANCELLED";

// The ops this phase is allowed to EXECUTE. Deliberately conservative:
//  • CREATE_PRODUCT — create a new (DRAFT) product; never auto-activates.
//  • UPDATE_PRODUCT — title / description only (never status/publish, §6).
//  • UPDATE_PRICE   — variant price / compare-at at the variant GID.
//  • UPDATE_VARIANT — sku/barcode of a GID-MATCHED variant (catalog is the
//    identity source of truth; the row's classification already proved the
//    match). Added after the mk2237 incident: create() left the barcode
//    blank, the re-read planned a barcode-only UPDATE_VARIANT, and the row
//    became permanently unselectable (SKIPPED_UNSUPPORTED) with no path to
//    convergence. An op without a variantGid still hard-stops in the executor.
//  • UPDATE_MEDIA   — ADD a proven-missing image only (never delete/reorder, §11).
//  • NOOP           — nothing to do → UNCHANGED.
// Any "variants" (add-missing-variant) op is intentionally NOT executed here —
// it is reported SKIPPED_UNSUPPORTED.
export const SUPPORTED_EXECUTION_OPS: readonly ShopifyPlanOpType[] = [
  "CREATE_PRODUCT",
  "UPDATE_PRODUCT",
  "UPDATE_VARIANT",
  "UPDATE_PRICE",
  "UPDATE_MEDIA",
  "NOOP",
];

export function isExecutableOp(t: ShopifyPlanOpType): boolean {
  return SUPPORTED_EXECUTION_OPS.includes(t);
}

// A compact, deterministic projection of exactly what a row would WRITE. The
// fingerprint is computed over this, so any change to the target (internal edit)
// OR to the plan (live Shopify changed) flips it and the confirmation is stale.
export interface PublishTargetVariant {
  variantId: string;
  variantGid: string | null;
  sku: string | null;
  barcode: string | null;
  /** canonical sell price (SHOPIFY.PRICE.1): variant ?? parent discount ?? parent price */
  price: number | null;
  /** canonical compare-at: only a REAL sale (compareAt > sell) survives, else null */
  compareAtPrice: number | null;
}
export interface PublishTarget {
  title: string;
  descriptionText: string; // normalized plain text (matches the preview's diff basis)
  price: number | null; // desired selling price (product-grain / simple)
  compareAtPrice: number | null;
  hasImage: boolean;
  imageUrl: string | null;
  variants: readonly PublishTargetVariant[];
}

export interface PublishEligibility {
  internalProductId: string;
  status: ShopifyPreviewStatus;
  /** true ⇒ the row may proceed to execution (subject to fingerprint match). */
  eligible: boolean;
  /** the ops this phase would actually execute for the row (supported subset). */
  executableOps: ShopifyPlanOp[];
  /** ops present in the plan but NOT executed here (reported, never applied). */
  unsupportedOps: ShopifyPlanOp[];
  /** deterministic fingerprint of exactly what would be written. */
  fingerprint: string;
  /** the terminal result when the row is NOT eligible (else null). */
  ineligibleResult: PublishItemResult | null;
}

/** Rows whose classification is a hard-stop — never executed (§2, §5). */
const HARD_STOP: Record<string, PublishItemResult> = {
  CONFLICT: "CONFLICT",
  BLOCKED: "BLOCKED",
  UNKNOWN: "BLOCKED",
};

// ── Deterministic hashing (FNV-1a over a canonical projection) — self-contained ──
function canonical(value: unknown): string {
  if (value === null || typeof value === "number" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(String(value));
}
export function fnv1a(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/**
 * Per-row fingerprint over the decision-relevant state AND the exact target
 * values that would be written. Recomputed at execution time from the fresh
 * plan; a mismatch with the operator-confirmed value ⇒ STALE (no overwrite).
 */
export function rowFingerprint(
  row: { internalProductId: string; status: ShopifyPreviewStatus; shopifyProductGid: string | null; changedFields: readonly string[]; plannedOps: readonly ShopifyPlanOp[] },
  target: PublishTarget,
): string {
  const projection = {
    id: row.internalProductId,
    status: row.status,
    gid: row.shopifyProductGid,
    changed: [...row.changedFields].sort(),
    ops: row.plannedOps.map((o) => ({ t: o.type, f: [...o.fields].sort(), v: o.variantGid ?? null, vi: o.variantId ?? null })),
    target: {
      title: target.title,
      desc: target.descriptionText,
      price: target.price,
      compareAt: target.compareAtPrice,
      img: target.hasImage ? target.imageUrl : null,
      variants: [...target.variants]
        .map((v) => ({ id: v.variantId, gid: v.variantGid, sku: v.sku, barcode: v.barcode, price: v.price, cmp: v.compareAtPrice }))
        .sort((a, b) => a.id.localeCompare(b.id)),
    },
  };
  return fnv1a(canonical(projection));
}

/** Decide execution eligibility + the executable/unsupported op split for one row. */
export function evaluateRow(
  row: { internalProductId: string; status: ShopifyPreviewStatus; shopifyProductGid: string | null; changedFields: readonly string[]; plannedOps: readonly ShopifyPlanOp[] },
  target: PublishTarget,
): PublishEligibility {
  const fingerprint = rowFingerprint(row, target);
  const base = { internalProductId: row.internalProductId, status: row.status, fingerprint };

  const hardStop = HARD_STOP[row.status];
  if (hardStop) {
    return { ...base, eligible: false, executableOps: [], unsupportedOps: [], ineligibleResult: hardStop };
  }
  if (row.status === "MATCH") {
    // Nothing to change — report UNCHANGED (never touch the store).
    return { ...base, eligible: false, executableOps: [], unsupportedOps: [], ineligibleResult: "UNCHANGED" };
  }

  // NEW or UPDATE_REQUIRED → split the plan into executable vs unsupported.
  const executableOps: ShopifyPlanOp[] = [];
  const unsupportedOps: ShopifyPlanOp[] = [];
  for (const op of row.plannedOps) {
    if (op.type === "NOOP" || op.type === "BLOCKED") continue;
    if (op.type === "UPDATE_PRODUCT" && op.fields.length === 1 && op.fields[0] === "variants") {
      // add-missing-variant is not applied in this phase.
      unsupportedOps.push(op);
    } else if (isExecutableOp(op.type)) {
      executableOps.push(op);
    } else {
      unsupportedOps.push(op); // anything outside the supported execution set
    }
  }

  // If there is nothing we can actually execute but the row is UPDATE_REQUIRED,
  // it is not eligible for a write — surface it as SKIPPED_UNSUPPORTED.
  const eligible = executableOps.length > 0;
  return {
    ...base,
    eligible,
    executableOps,
    unsupportedOps,
    ineligibleResult: eligible ? null : "SKIPPED_UNSUPPORTED",
  };
}

/**
 * The identity fields an UPDATE_VARIANT op would actually send, resolved from
 * the target (PURE — the executor uses exactly this). Only the PLANNED fields,
 * and only when the catalog value is a real non-empty string — Shopify is
 * never blanked out. Returns {} when the op's unit is absent from the target;
 * the mk2237 incident was exactly that miss (simple product, synthetic unit
 * not in target.variants) silently degrading the run to UNCHANGED.
 */
export function variantIdentityFields(
  op: Pick<ShopifyPlanOp, "fields" | "variantId">,
  target: PublishTarget,
): { sku?: string; barcode?: string } {
  const tv = target.variants.find((v) => v.variantId === op.variantId);
  const fields: { sku?: string; barcode?: string } = {};
  if (op.fields.includes("sku") && typeof tv?.sku === "string" && tv.sku !== "") fields.sku = tv.sku;
  if (op.fields.includes("barcode") && typeof tv?.barcode === "string" && tv.barcode !== "") fields.barcode = tv.barcode;
  return fields;
}

/** Confirm an operator-submitted fingerprint against the fresh one (§5). */
export function isStale(freshFingerprint: string, confirmedFingerprint: string | null | undefined): boolean {
  return !confirmedFingerprint || freshFingerprint !== confirmedFingerprint;
}

/**
 * Deduplicate publish selections by internalProductId (§6 — never trust the
 * client to be unique). FIRST occurrence wins, so ordering AND the confirmed
 * fingerprint stay deterministic; entries without a valid id are dropped. A
 * request that repeats the same product therefore executes it AT MOST ONCE,
 * closing the intra-batch duplicate-create vector. Pure — the server orchestrator
 * runs exactly this before execution.
 */
export function dedupeSelections<T extends { internalProductId?: unknown }>(
  selections: readonly T[] | null | undefined,
): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const s of Array.isArray(selections) ? selections : []) {
    const id = s && typeof s.internalProductId === "string" ? s.internalProductId : "";
    if (id === "" || seen.has(id)) continue;
    seen.add(id);
    out.push(s);
  }
  return out;
}

// ── Run aggregation (§13) ────────────────────────────────────────────────────────
export interface PublishRunCounts {
  productCount: number;
  created: number;
  updated: number;
  unchanged: number;
  blocked: number;
  conflict: number;
  failed: number;
  stale: number;
  skippedUnsupported: number;
  needsReconciliation: number;
}

export function emptyCounts(): PublishRunCounts {
  return { productCount: 0, created: 0, updated: 0, unchanged: 0, blocked: 0, conflict: 0, failed: 0, stale: 0, skippedUnsupported: 0, needsReconciliation: 0 };
}

export function tallyResult(counts: PublishRunCounts, result: PublishItemResult): PublishRunCounts {
  const c = { ...counts, productCount: counts.productCount + 1 };
  switch (result) {
    case "CREATED": c.created++; break;
    case "UPDATED": c.updated++; break;
    case "UNCHANGED": c.unchanged++; break;
    case "BLOCKED": c.blocked++; break;
    case "CONFLICT": c.conflict++; break;
    case "FAILED": c.failed++; break;
    case "STALE": c.stale++; break;
    case "SKIPPED_UNSUPPORTED": c.skippedUnsupported++; break;
    case "NEEDS_RECONCILIATION": c.needsReconciliation++; break;
  }
  return c;
}

/**
 * Final run status from the aggregated counts (§13). A systemic abort is passed
 * explicitly; otherwise: any hard failure with some success ⇒ PARTIAL; all
 * failures ⇒ FAILED; nothing failed ⇒ SUCCEEDED.
 */
export function runStatusFromCounts(counts: PublishRunCounts, opts?: { systemicAbort?: boolean }): PublishRunStatus {
  if (opts?.systemicAbort) return "FAILED";
  const hardFail = counts.failed + counts.needsReconciliation;
  const succeeded = counts.created + counts.updated;
  const touched = succeeded + hardFail;
  if (touched === 0) return "SUCCEEDED"; // only unchanged / blocked / stale / skipped — nothing broke
  if (hardFail === 0) return "SUCCEEDED";
  if (succeeded === 0) return "FAILED";
  return "PARTIAL";
}
