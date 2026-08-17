// INT.2A — Export Center dashboard composer (PURE).
//
// Builds one card view-model per canonical destination from ALREADY-COMPUTED
// facts (no scan, no DB here). Honesty rules (§2, §19): a value that cannot be
// produced reliably & cheaply per-destination is "UNKNOWN" — never fabricated.
// Per-destination eligible/blocked are UNKNOWN in the foundation (destination
// rules arrive with the adapters in INT.2B); the global catalog-readiness
// baseline (reused operations readiness) is shown once at the top.

import { EXPORT_DESTINATIONS } from "./destinations.ts";

export const UNKNOWN = "UNKNOWN" as const;
export type Unknownable<T> = T | typeof UNKNOWN;

/** Foundation operational state: the destination is registered and its
 *  validate/preview contracts exist; generation/publish are not implemented. */
export type DestinationOperationalState = "FOUNDATION_READY" | "UNKNOWN";

export interface DestinationCardVM {
  key: string;
  label: string;
  channel: string;
  businessUnit: string;
  listingGrain: string;
  capabilities: readonly string[];
  operationalState: DestinationOperationalState;
  productsEligible: Unknownable<number>;
  productsBlocked: Unknownable<number>;
  lastValidation: Unknownable<string>;
  lastExport: Unknownable<string>;
  lastPublish: Unknownable<string>;
  warnings: Unknownable<number>;
  detailHref: string;
}

export interface ExportCenterModel {
  destinations: DestinationCardVM[];
  /** global catalog-readiness baseline (reused operations readiness), shown once. */
  readinessBaseline: { eligible: Unknownable<number>; blocked: Unknownable<number> };
  historyAvailable: boolean;
  generatedAt: string | null;
}

export interface ExportCenterFacts {
  /** global catalog readiness (reused from loadOperationsDashboard). */
  eligible: Unknownable<number>;
  blocked: Unknownable<number>;
  /** per-destination ECL gap warning counts; a missing key ⇒ UNKNOWN for that card. */
  warningsByDestination: Readonly<Record<string, number>>;
  generatedAt: string | null;
}

export function exportDetailHref(key: string): string {
  return `/v2/export/${encodeURIComponent(key)}`;
}

/** Build the dashboard model. Pure — one card per registered destination. */
export function buildExportCenter(facts: ExportCenterFacts): ExportCenterModel {
  const warnings = facts?.warningsByDestination ?? {};
  const destinations: DestinationCardVM[] = EXPORT_DESTINATIONS.map((d) => ({
    key: d.key,
    label: d.label,
    channel: d.channel,
    businessUnit: d.businessUnit,
    listingGrain: d.listingGrain,
    capabilities: d.capabilities,
    operationalState: "FOUNDATION_READY",
    // Destination-specific eligibility is not computed in the foundation.
    productsEligible: UNKNOWN,
    productsBlocked: UNKNOWN,
    // No durable per-destination timeline exists (see history.ts).
    lastValidation: UNKNOWN,
    lastExport: UNKNOWN,
    lastPublish: UNKNOWN,
    warnings: Object.prototype.hasOwnProperty.call(warnings, d.key) ? warnings[d.key] : UNKNOWN,
    detailHref: exportDetailHref(d.key),
  }));
  return {
    destinations,
    readinessBaseline: {
      eligible: facts?.eligible ?? UNKNOWN,
      blocked: facts?.blocked ?? UNKNOWN,
    },
    historyAvailable: false, // no durable export-history source in INT.2A
    generatedAt: facts?.generatedAt ?? null,
  };
}
