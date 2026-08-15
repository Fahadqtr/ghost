// CH.5 — deterministic backfill projection (PURE).
//
// Projects the CURRENT identity sources into candidate external_channel_listings
// rows and produces a read-only conflict report. Deterministic: anything that
// cannot be resolved unambiguously is marked NEEDS_REVIEW — never guessed. This
// runs against read-only inputs; it writes nothing.
//
// Legacy sources handled (§6):
//   products.snoonu_id        → storefront snoonu:malikas    (snoonu_spi)
//   products.pure_seoul_id    → storefront snoonu:pure_seoul (snoonu_spi, independent)
//   products.rafeeq_product_id→ storefront rafeeq:malikas    (rafeeq_product_id)
//   channel_variant_mappings  → storefront talabat:malikas   (talabat_sku, variant grain)
//
// NOT identity sources (excluded, documented): channel_products (publish/price
// overlay), platform_status (approval/availability overlay). Shopify has NO
// authoritative legacy id (live-match); its rows are captured going forward by
// the adapter, so backfill emits none for Shopify.
//
// PURE: pure sibling imports only. node:test loads it directly.

import { channelKeyFromName } from "./channel-model.ts";
import { storefrontByKey, storefrontsForChannel } from "./storefronts.ts";
import {
  type ExternalListingRecord,
  type MappingStatus,
  externalIdentityKey,
  internalUniquenessKey,
} from "./external-listing-identity.ts";

export interface LegacyProductRow {
  id: string;
  snoonu_id?: string | null;
  pure_seoul_id?: string | null;
  rafeeq_product_id?: string | null;
}

/** A channel_variant_mappings row joined with its channels.name (read-only). */
export interface LegacyVariantMappingRow {
  channel_name: string | null;
  master_product_id: string;
  master_variant_sku: string | null;
  exported_sku: string | null;
  exported_barcode: string | null;
  channel_product_id: string | null;
  mapping_status?: string | null;
}

export interface BackfillReport {
  candidates: number;
  bySource: Record<string, number>;
  /** same (storefront, external id) pointing at >1 product → conflict. */
  duplicateExternalIds: { key: string; productIds: string[] }[];
  /** same (storefront, product, variant) appearing >1 time → conflict. */
  ambiguousInternal: { key: string; count: number }[];
  /** cvm rows whose channel could not be resolved to a storefront. */
  missingStorefront: number;
  /** Talabat rows missing a usable variant grain / exported SKU. */
  talabatGaps: number;
  /** rows marked needs_review (non-deterministic). */
  needsReview: number;
  /** total problematic rows. */
  conflicts: number;
}

export interface BackfillResult {
  records: ExternalListingRecord[];
  report: BackfillReport;
}

const s = (v: string | null | undefined): string => (v ?? "").trim();

const toStatus = (v: string | null | undefined): MappingStatus =>
  v === "needs_review" || v === "archived" ? v : "active";

/** Resolve a channels.name to a storefront key deterministically (null if unsure). */
export function storefrontFromChannelName(name: string | null | undefined): string | null {
  const key = channelKeyFromName(name);
  if (!key) return null;
  const n = (name ?? "").toLowerCase();
  if (key === "snoonu") return n.includes("pure") ? "snoonu:pure_seoul" : "snoonu:malikas";
  if (key === "pure_seoul") return "snoonu:pure_seoul";
  const forChannel = storefrontsForChannel(key);
  return forChannel.length === 1 ? forChannel[0].key : null; // ambiguous multi-store ⇒ null
}

function productColumnRecord(productId: string, storefrontKey: string, externalId: string): ExternalListingRecord {
  const sf = storefrontByKey(storefrontKey)!;
  return {
    productId,
    variantId: null,
    variantSku: null,
    channelKey: sf.channel,
    storefrontKey,
    externalProductId: externalId,
    externalVariantId: null,
    exportedSku: null,
    exportedBarcode: null,
    identityType: sf.identityType,
    mappingStatus: "active",
    metadata: { backfill_source: "products_column" },
  };
}

/**
 * Build candidate rows + a conflict report from the current identity sources.
 * Never throws; unresolved inputs are counted, not invented.
 */
export function projectBackfill(
  products: LegacyProductRow[],
  variantMappings: LegacyVariantMappingRow[] = [],
): BackfillResult {
  const records: ExternalListingRecord[] = [];
  const bySource: Record<string, number> = {
    snoonu_malikas: 0, snoonu_pure_seoul: 0, rafeeq_malikas: 0, talabat_malikas: 0,
  };
  let missingStorefront = 0;
  let talabatGaps = 0;

  // 1) product external-id columns → product-grain listings
  for (const p of products) {
    const pid = s(p.id);
    if (!pid) continue;
    if (s(p.snoonu_id)) { records.push(productColumnRecord(pid, "snoonu:malikas", s(p.snoonu_id))); bySource.snoonu_malikas++; }
    if (s(p.pure_seoul_id)) { records.push(productColumnRecord(pid, "snoonu:pure_seoul", s(p.pure_seoul_id))); bySource.snoonu_pure_seoul++; }
    if (s(p.rafeeq_product_id)) { records.push(productColumnRecord(pid, "rafeeq:malikas", s(p.rafeeq_product_id))); bySource.rafeeq_malikas++; }
  }

  // 2) channel_variant_mappings → Talabat flattened variant listings
  for (const m of variantMappings) {
    const storefrontKey = storefrontFromChannelName(m.channel_name);
    if (!storefrontKey) { missingStorefront++; continue; }
    const sf = storefrontByKey(storefrontKey)!;
    const exportedSku = s(m.exported_sku) || null;
    const variantSku = s(m.master_variant_sku) || null;
    // Talabat is variant grain: a row with no variant SKU AND no exported SKU has
    // no usable flattened identity → gap, needs review (never collapsed to product).
    const isGap = sf.listingGrain === "variant" && !variantSku && !exportedSku;
    const status: MappingStatus = isGap ? "needs_review" : toStatus(m.mapping_status);
    if (isGap) talabatGaps++;
    records.push({
      productId: s(m.master_product_id),
      variantId: null,
      variantSku,
      channelKey: sf.channel,
      storefrontKey,
      externalProductId: s(m.channel_product_id) || null,
      externalVariantId: null,
      exportedSku,
      exportedBarcode: s(m.exported_barcode) || null,
      identityType: sf.identityType,
      mappingStatus: status,
      metadata: { backfill_source: "channel_variant_mappings" },
    });
    if (storefrontKey === "talabat:malikas") bySource.talabat_malikas++;
  }

  // 3) conflict detection — duplicate external ids (one handle → many products)
  const extGroups = new Map<string, Set<string>>();
  for (const r of records) {
    const k = externalIdentityKey(r);
    if (!k) continue;
    (extGroups.get(k) ?? extGroups.set(k, new Set()).get(k)!).add(r.productId);
  }
  const duplicateExternalIds = [...extGroups.entries()]
    .filter(([, pids]) => pids.size > 1)
    .map(([key, pids]) => ({ key, productIds: [...pids] }));
  const dupKeys = new Set(duplicateExternalIds.map((d) => d.key));

  // 4) conflict detection — same internal target duplicated in a storefront
  const intGroups = new Map<string, number>();
  for (const r of records) {
    const k = internalUniquenessKey(r);
    intGroups.set(k, (intGroups.get(k) ?? 0) + 1);
  }
  const ambiguousInternal = [...intGroups.entries()]
    .filter(([, c]) => c > 1)
    .map(([key, count]) => ({ key, count }));

  // 5) mark conflicting rows needs_review (deterministic degrade — never guess)
  for (const r of records) {
    const ek = externalIdentityKey(r);
    if (ek && dupKeys.has(ek)) r.mappingStatus = "needs_review";
  }

  const needsReview = records.filter((r) => r.mappingStatus === "needs_review").length;
  const conflicts = duplicateExternalIds.length + ambiguousInternal.length + missingStorefront + talabatGaps;

  return {
    records,
    report: {
      candidates: records.length,
      bySource,
      duplicateExternalIds,
      ambiguousInternal,
      missingStorefront,
      talabatGaps,
      needsReview,
      conflicts,
    },
  };
}
