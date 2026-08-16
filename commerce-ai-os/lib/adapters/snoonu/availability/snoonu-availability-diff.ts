// CH.6C — Snoonu availability diff engine (PURE).
//
// Compares Snoonu availability against the internal Availability Engine authority
// (products.stock_status) and classifies the action. Applies the safety skips
// (§7): archived / draft / unknown mapping / unknown availability never change
// internal state automatically. NEVER touches quantity.
//
// PURE: imports only pure siblings. node:test loads it.

import { type AvailabilityState } from "../../../availability/read.ts";
import { type SnoonuAvailability, toEngineState } from "./snoonu-availability-normalize.ts";
import { type SnoonuStorefrontKey } from "../merchant/merchant-contract.ts";

export type DiffAction =
  | "UNCHANGED"
  | "CHANGE_TO_IN"
  | "CHANGE_TO_OUT"
  | "UNKNOWN" //        Snoonu availability unknown → skip
  | "NEEDS_REVIEW" //   no active ECL mapping → skip
  | "SKIPPED"; //       draft / archived lifecycle → skip

export type ProductLifecycle = "Active" | "Draft" | "Archived" | null;

export interface AvailabilityDiffInput {
  productId: string;
  sku: string | null;
  storefront: SnoonuStorefrontKey;
  spi: string | null;
  /** Snoonu availability for this storefront (tri-state). */
  snoonu: SnoonuAvailability;
  /** Current internal availability (products.stock_status), or null when unset. */
  currentInternal: AvailabilityState | null;
  /** Product lifecycle (products.platform_status column). */
  lifecycle: ProductLifecycle;
  /** Whether an active ECL mapping exists for this (product, storefront). */
  mappingActive: boolean;
}

export interface AvailabilityDiffRow {
  productId: string;
  sku: string | null;
  storefront: SnoonuStorefrontKey;
  spi: string | null;
  current: AvailabilityState | null;
  incoming: SnoonuAvailability;
  targetState: AvailabilityState | null; //  what we would write (null ⇒ never)
  action: DiffAction;
  reason: string;
  /** true only for a real change the operator may apply. */
  actionable: boolean;
}

export function diffAvailabilityRow(input: AvailabilityDiffInput): AvailabilityDiffRow {
  const base = {
    productId: input.productId, sku: input.sku, storefront: input.storefront, spi: input.spi,
    current: input.currentInternal, incoming: input.snoonu,
  };
  // Safety skips (§7) — order matters: mapping, then lifecycle, then unknown.
  if (!input.mappingActive) return { ...base, targetState: null, action: "NEEDS_REVIEW", reason: "no active ECL mapping for this storefront", actionable: false };
  if (input.lifecycle === "Draft" || input.lifecycle === "Archived")
    return { ...base, targetState: null, action: "SKIPPED", reason: `product is ${input.lifecycle}`, actionable: false };
  if (input.snoonu === "UNKNOWN")
    return { ...base, targetState: null, action: "UNKNOWN", reason: "Snoonu availability unknown", actionable: false };

  const target = toEngineState(input.snoonu)!; // IN/OUT (not UNKNOWN here)
  if (input.currentInternal === target)
    return { ...base, targetState: target, action: "UNCHANGED", reason: "already matches Snoonu", actionable: false };
  return {
    ...base,
    targetState: target,
    action: target === "In Stock" ? "CHANGE_TO_IN" : "CHANGE_TO_OUT",
    reason: `internal ${input.currentInternal ?? "unset"} → Snoonu ${target}`,
    actionable: true,
  };
}

/** A product resolved from an ACTIVE ECL mapping (SPI → internal product). */
export interface ResolvedProduct {
  productId: string;
  sku: string | null;
  currentInternal: AvailabilityState | null;
  lifecycle: ProductLifecycle;
}

export interface BuildDiffInput {
  storefront: SnoonuStorefrontKey;
  /** SPI → normalized Snoonu availability, as observed on the storefront. */
  sourceBySpi: Map<string, SnoonuAvailability>;
  /** SPI → resolved internal product, ACTIVE ECL mappings for THIS storefront only. */
  productBySpi: Map<string, ResolvedProduct>;
}

/**
 * Pure resolver+diff: for every SPI the Snoonu source reports, resolve it through
 * the ACTIVE ECL mapping and classify. An SPI with no active mapping surfaces as
 * NEEDS_REVIEW (never silently applied). Cross-store isolation is the caller's
 * contract: pass only THIS storefront's source rows and mappings. Deterministic
 * and DB-free — the orchestrator supplies the two maps; node:test loads this.
 */
export function buildAvailabilityDiff(input: BuildDiffInput): AvailabilityDiffRow[] {
  const rows: AvailabilityDiffRow[] = [];
  for (const [spi, snoonu] of input.sourceBySpi) {
    const p = input.productBySpi.get(spi);
    rows.push(
      diffAvailabilityRow({
        productId: p?.productId ?? "",
        sku: p?.sku ?? null,
        storefront: input.storefront,
        spi,
        snoonu,
        currentInternal: p?.currentInternal ?? null,
        lifecycle: p?.lifecycle ?? null,
        mappingActive: p !== undefined,
      }),
    );
  }
  return rows;
}

export interface AvailabilityDiffSummary {
  total: number;
  unchanged: number;
  changeToIn: number;
  changeToOut: number;
  unknown: number;
  needsReview: number;
  skipped: number;
}

export function summarizeDiff(rows: AvailabilityDiffRow[]): AvailabilityDiffSummary {
  return {
    total: rows.length,
    unchanged: rows.filter((r) => r.action === "UNCHANGED").length,
    changeToIn: rows.filter((r) => r.action === "CHANGE_TO_IN").length,
    changeToOut: rows.filter((r) => r.action === "CHANGE_TO_OUT").length,
    unknown: rows.filter((r) => r.action === "UNKNOWN").length,
    needsReview: rows.filter((r) => r.action === "NEEDS_REVIEW").length,
    skipped: rows.filter((r) => r.action === "SKIPPED").length,
  };
}
