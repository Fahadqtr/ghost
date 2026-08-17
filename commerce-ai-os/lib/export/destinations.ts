// INT.2A — Export Center destination registry (PURE).
//
// This does NOT create a second storefront registry. It is a thin CAPABILITY +
// eligibility metadata layer OVER the certified CH.5 storefront registry
// (lib/channels/storefronts.ts) — the five canonical destinations ARE the five
// STOREFRONTS keys, and their listing grain (Talabat = "variant") comes straight
// from there. Framework-free (no @/ , no server-only) so node:test loads it.

import { STOREFRONTS, type Storefront, type ListingGrain } from "../channels/storefronts.ts";

/**
 * What a destination can do. INT.2A defines capability METADATA only — no
 * platform business logic. `validate`/`preview` are read-only foundations;
 * everything else is declared-but-not-implemented until later phases.
 */
export type ExportCapability =
  | "validate"
  | "preview"
  | "generate_package" // future: build the downloadable package (xlsx/zip)
  | "publish" //          future: push to a live API (Shopify)
  | "update" //           future: update already-published listings
  | "images" //           inline image handling (Shopify)
  | "pricing" //          price sync (Shopify)
  | "xlsx" //             future: XLSX sheet output (Talabat/Snoonu/Rafeeq)
  | "image_package" //    future: SKU-named image ZIP
  | "flattened_variants"; // future: one row per sellable variant (Talabat)

/** Per-destination capabilities (§5). Metadata only; nothing here executes. */
export const DESTINATION_CAPABILITIES: Record<string, readonly ExportCapability[]> = {
  "shopify:malikas": ["validate", "preview", "publish", "update", "images", "pricing"],
  "talabat:malikas": ["validate", "preview", "xlsx", "image_package", "flattened_variants"],
  "snoonu:malikas": ["validate", "preview", "xlsx", "image_package"],
  "snoonu:pure_seoul": ["validate", "preview", "xlsx", "image_package"],
  "rafeeq:malikas": ["validate", "preview", "xlsx", "image_package"],
};

/** An export destination = a certified storefront + its export capabilities. */
export interface ExportDestination {
  key: string;
  channel: Storefront["channel"];
  businessUnit: Storefront["businessUnit"];
  label: string;
  /** From the storefront registry — Talabat is "variant" (sellable-listing grain). */
  listingGrain: ListingGrain;
  identityType: Storefront["identityType"];
  capabilities: readonly ExportCapability[];
}

function toDestination(s: Storefront): ExportDestination {
  return {
    key: s.key,
    channel: s.channel,
    businessUnit: s.businessUnit,
    label: s.label,
    listingGrain: s.listingGrain,
    identityType: s.identityType,
    capabilities: DESTINATION_CAPABILITIES[s.key] ?? ["validate", "preview"],
  };
}

/** The canonical export destinations, derived 1:1 from the storefront registry. */
export const EXPORT_DESTINATIONS: readonly ExportDestination[] = STOREFRONTS.map(toDestination);

export const EXPORT_DESTINATION_KEYS: readonly string[] = EXPORT_DESTINATIONS.map((d) => d.key);

const BY_KEY: ReadonlyMap<string, ExportDestination> = new Map(
  EXPORT_DESTINATIONS.map((d) => [d.key, d]),
);

/** Resolve a destination key → destination, or null for an unknown key. */
export function exportDestinationByKey(key: string): ExportDestination | null {
  return BY_KEY.get(key) ?? null;
}

/** Does a destination declare a capability? (metadata check, never execution) */
export function destinationHasCapability(key: string, cap: ExportCapability): boolean {
  return (BY_KEY.get(key)?.capabilities ?? []).includes(cap);
}

/** True when the destination lists at the SELLABLE (per-variant) grain — Talabat. */
export function isSellableListingGrain(key: string): boolean {
  return BY_KEY.get(key)?.listingGrain === "variant";
}
