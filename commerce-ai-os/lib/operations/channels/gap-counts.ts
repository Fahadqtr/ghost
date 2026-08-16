// OPS.4 — Live channel gap counts (PURE).
//
// A per-storefront mapping-gap view assembled from BOUNDED, already-gathered
// aggregate counts (never a catalog scan, never the CH.6F classifier). Each field
// is a number OR null (= UNKNOWN/unavailable): when a count cannot be derived
// cheaply AND correctly it is UNKNOWN, never an estimate (§5).
//
// Sourcing per storefront:
//   • shopify:malikas — identity is `live_match` (not in ECL) ⇒ counts come from
//     the presence overview the dashboard already loaded (source "presence").
//   • snoonu:malikas / snoonu:pure_seoul / rafeeq:malikas — product-grain ECL
//     counts (source "ecl"): mapped = active listings; internalOnly = products −
//     mapped; conflicts = needsReview = needs_review listings.
//   • talabat:malikas — VARIANT-grain ECL counts (§6): the denominator is the
//     variant total, so a parent product never hides its missing variant listings.
//   • missingEcl / externalOnly stay UNKNOWN everywhere — distinguishing them
//     requires the external-source scan OPS.4 must not run.
//
// PURE: the only import is the pure CH.5 storefront registry (relative). No
// server-only, no DB — node:test loads it directly.

import { STOREFRONTS, type Storefront } from "../../channels/storefronts.ts";

/** A count that may be UNKNOWN (null) rather than an estimate. */
export type CountValue = number | null;

export interface GapCounts {
  storefront: string;
  grain: Storefront["listingGrain"];
  source: "ecl" | "presence" | "unknown";
  mapped: CountValue;
  missingEcl: CountValue;
  internalOnly: CountValue;
  externalOnly: CountValue;
  conflicts: CountValue;
  needsReview: CountValue;
}

/** Per-ECL-storefront bounded aggregate the server reader gathers via head counts. */
export interface EclStorefrontAggregate {
  activeMapped: number;
  needsReview: number;
}

export interface GapCountsInput {
  /** total catalog products (denominator for product-grain storefronts); null ⇒ UNKNOWN. */
  productsTotal: number | null;
  /** total sellable variants (denominator for Talabat variant grain); null ⇒ UNKNOWN. */
  variantsTotal: number | null;
  /** per-storefront ECL aggregate; a missing/undefined entry ⇒ that storefront is UNKNOWN. */
  ecl: Record<string, EclStorefrontAggregate | undefined>;
  /** Shopify presence overview (already loaded); available:false ⇒ UNKNOWN. */
  shopifyPresence: { available: boolean; mapped: number; missing: number; review: number };
}

const UNKNOWN = (sf: Storefront): GapCounts => ({
  storefront: sf.key,
  grain: sf.listingGrain,
  source: "unknown",
  mapped: null,
  missingEcl: null,
  internalOnly: null,
  externalOnly: null,
  conflicts: null,
  needsReview: null,
});

function eclCounts(sf: Storefront, agg: EclStorefrontAggregate | undefined, denominator: number | null): GapCounts {
  if (!agg) return UNKNOWN(sf);
  const internalOnly = denominator === null ? null : Math.max(0, denominator - agg.activeMapped);
  return {
    storefront: sf.key,
    grain: sf.listingGrain,
    source: "ecl",
    mapped: agg.activeMapped,
    missingEcl: null, //   distinguishing MISSING_ECL from INTERNAL_ONLY needs the external source (UNKNOWN)
    internalOnly,
    externalOnly: null, // discovering external-only listings needs the CH.6F scan (UNKNOWN)
    conflicts: agg.needsReview, // ECL stores conflicts as needs_review; finer subtypes need CH.6F
    needsReview: agg.needsReview,
  };
}

function presenceCounts(sf: Storefront, p: GapCountsInput["shopifyPresence"]): GapCounts {
  if (!p.available) return UNKNOWN(sf);
  return {
    storefront: sf.key,
    grain: sf.listingGrain,
    source: "presence",
    mapped: p.mapped,
    missingEcl: null,
    internalOnly: p.missing,
    externalOnly: null,
    conflicts: p.review,
    needsReview: p.review,
  };
}

/** Build the per-storefront gap counts. Pure — the server does all IO first. */
export function buildGapCounts(input: GapCountsInput): Record<string, GapCounts> {
  const out: Record<string, GapCounts> = {};
  for (const sf of STOREFRONTS) {
    if (sf.key === "shopify:malikas") {
      out[sf.key] = presenceCounts(sf, input.shopifyPresence);
    } else {
      const denominator = sf.listingGrain === "variant" ? input.variantsTotal : input.productsTotal;
      out[sf.key] = eclCounts(sf, input.ecl[sf.key], denominator);
    }
  }
  return out;
}

/** The ECL-identity storefronts the server head-counts (shopify uses presence). */
export const ECL_GAP_STOREFRONTS: readonly string[] = STOREFRONTS.filter((s) => s.key !== "shopify:malikas").map((s) => s.key);
