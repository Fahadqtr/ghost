// Variant-grain Shopify inventory identity — the PURE core.
//
// WHY THIS EXISTS
// ---------------
// A canonical product with variants is listed on Shopify as ONE product with
// several variants, and `external_channel_listings` already records that at
// variant grain: one product-level row (variant_id NULL) plus one row per
// canonical variant carrying `external_variant_id` — a real Shopify
// ProductVariant GID.
//
// The SKU-keyed inventory writers could not see any of that. They resolved the
// canonical product SKU against Shopify's SKU search, which for these products
// matches only a LEGACY duplicate listing whose variants all repeat the bare
// SKU — a product the canonical system does not map at all. The write then
// landed on the wrong product entirely, and on only one of its variants.
//
// THE RULE THIS FILE ENFORCES
// ---------------------------
// When a canonical product has variants, the ECL variant mapping is the ONLY
// identity. SKU is demoted to a consistency check. Nothing about the Shopify
// side — status, publication, handle, search ranking, array order — may
// override or substitute for that mapping. A mapped parent that is DRAFT still
// wins over an ACTIVE, published, unmapped legacy twin.
//
// FAIL CLOSED, WHOLE-PRODUCT
// --------------------------
// A variant product is planned all-or-nothing. If one expected mapping is
// missing, null, duplicated, incoherent or contradicted by SKU, the WHOLE
// product is blocked and nothing is written for it. A partial 4-of-5 write
// would leave the storefront in a state no one chose.

/** Why a canonical product could not be planned at variant grain. Fixed enum. */
export type VariantGrainBlockReason =
  /** No product-level ECL row with an external product id. */
  | "PARENT_MAPPING_MISSING"
  /** The mapped Shopify parent is ARCHIVED — a retired identity. */
  | "PARENT_ARCHIVED"
  /** Canonical variants exist but carry no variant-level ECL rows at all. */
  | "NO_VARIANT_MAPPINGS"
  /** At least one canonical variant has no variant-level ECL row. */
  | "INCOMPLETE_VARIANT_MAPPING"
  /** A mapped variant has a null/empty external_variant_id. */
  | "MISSING_EXTERNAL_VARIANT_ID"
  /** Two ECL rows claim the same canonical variant, or the same Shopify variant. */
  | "DUPLICATE_VARIANT_MAPPING"
  /** A variant ECL row points at a canonical variant this product does not have. */
  | "UNKNOWN_VARIANT_MAPPING"
  /** A variant ECL row hangs off a different Shopify parent than the product row. */
  | "VARIANT_PARENT_MISMATCH"
  /** Canonical variant SKU and the mapping's recorded SKU disagree. */
  | "SKU_MISMATCH"
  /** A canonical variant has no usable stock quantity. */
  | "MISSING_QUANTITY";

export interface CanonicalVariantRow {
  id: string;
  sku?: string | null;
  stockQuantity?: number | null;
}

/** One `external_channel_listings` row for storefront_key = "shopify:malikas". */
export interface ShopifyListingRow {
  /** NULL ⇒ the product-level row; set ⇒ a variant-level row. */
  variantId?: string | null;
  variantSku?: string | null;
  externalProductId?: string | null;
  externalVariantId?: string | null;
}

export interface CanonicalProductInventoryInput {
  productId: string;
  sku?: string | null;
  nameEn?: string | null;
  variants: readonly CanonicalVariantRow[];
  listings: readonly ShopifyListingRow[];
  /** Shopify status of the MAPPED parent when known ("ACTIVE"|"DRAFT"|"ARCHIVED"). */
  parentStatus?: string | null;
}

export interface VariantInventoryTarget {
  canonicalVariantId: string;
  /** gid://shopify/ProductVariant/… — the exact write target. */
  externalVariantId: string;
  /** Canonical variant SKU, carried for validation only — never for lookup. */
  sku: string | null;
  quantity: number;
}

export type InventoryGrainPlan =
  /** No canonical variants — the existing safe SKU resolver still applies. */
  | { grain: "SIMPLE"; productId: string; sku: string | null }
  | { grain: "VARIANT"; productId: string; parentGid: string; targets: VariantInventoryTarget[] }
  | { grain: "BLOCKED"; productId: string; reason: VariantGrainBlockReason };

/**
 * CANONICAL → write each variant's own `product_variants.stock_quantity`.
 * ZERO      → write 0 to every mapped variant (the availability/OOS flow, whose
 *             business scope stays exactly "push zeros", never a full stock sync).
 */
export type QuantityMode = "CANONICAL" | "ZERO";

const text = (v: unknown): string => String(v ?? "").trim();
const skuKey = (v: unknown): string => text(v).toLowerCase();

/**
 * Decide the write grain for ONE canonical product and, for variant products,
 * produce the exact per-variant targets. Pure and order-independent: the result
 * never depends on the order of `variants` or `listings`.
 */
export function planProductInventoryGrain(
  input: CanonicalProductInventoryInput,
  mode: QuantityMode,
): InventoryGrainPlan {
  const productId = String(input?.productId ?? "");
  const variants = (input?.variants ?? []).filter((v) => v && text(v.id) !== "");
  const listings = (input?.listings ?? []).filter(Boolean);
  const blocked = (reason: VariantGrainBlockReason): InventoryGrainPlan => ({ grain: "BLOCKED", productId, reason });

  // A product with no canonical variants is a simple product; the SKU resolver
  // (fail-closed, archived-excluding) remains the right tool for it.
  if (variants.length === 0) return { grain: "SIMPLE", productId, sku: input?.sku ?? null };

  const parentRows = listings.filter((l) => text(l.variantId) === "" && text(l.externalProductId) !== "");
  if (parentRows.length === 0) return blocked("PARENT_MAPPING_MISSING");
  const parentGids = new Set(parentRows.map((l) => text(l.externalProductId)));
  if (parentGids.size > 1) return blocked("VARIANT_PARENT_MISMATCH");
  const parentGid = text(parentRows[0]!.externalProductId);

  // ECL identity is authoritative — but never onto a retired parent.
  if (text(input?.parentStatus).toUpperCase() === "ARCHIVED") return blocked("PARENT_ARCHIVED");

  const variantRows = listings.filter((l) => text(l.variantId) !== "");
  if (variantRows.length === 0) return blocked("NO_VARIANT_MAPPINGS");

  // Duplicates on either side of the 1:1 relation.
  const byCanonical = new Map<string, ShopifyListingRow>();
  const seenExternal = new Set<string>();
  for (const row of variantRows) {
    const cid = text(row.variantId);
    if (byCanonical.has(cid)) return blocked("DUPLICATE_VARIANT_MAPPING");
    byCanonical.set(cid, row);
    const ext = text(row.externalVariantId);
    if (ext !== "") {
      if (seenExternal.has(ext)) return blocked("DUPLICATE_VARIANT_MAPPING");
      seenExternal.add(ext);
    }
  }

  const canonicalIds = new Set(variants.map((v) => text(v.id)));
  for (const cid of byCanonical.keys()) {
    if (!canonicalIds.has(cid)) return blocked("UNKNOWN_VARIANT_MAPPING");
  }

  const targets: VariantInventoryTarget[] = [];
  for (const v of variants) {
    const cid = text(v.id);
    const row = byCanonical.get(cid);
    if (!row) return blocked("INCOMPLETE_VARIANT_MAPPING");

    const ext = text(row.externalVariantId);
    if (ext === "") return blocked("MISSING_EXTERNAL_VARIANT_ID");

    // A variant row must hang off the same Shopify parent as the product row.
    const rowParent = text(row.externalProductId);
    if (rowParent !== "" && rowParent !== parentGid) return blocked("VARIANT_PARENT_MISMATCH");

    // SKU is a CHECK, never the lookup. Disagreement means the mapping and the
    // catalog describe different things — refuse rather than guess which.
    const canonicalSku = skuKey(v.sku);
    const mappedSku = skuKey(row.variantSku);
    if (canonicalSku !== "" && mappedSku !== "" && canonicalSku !== mappedSku) return blocked("SKU_MISMATCH");

    let quantity: number;
    if (mode === "ZERO") {
      quantity = 0;
    } else {
      const raw = v.stockQuantity;
      if (raw === null || raw === undefined || !Number.isFinite(Number(raw))) return blocked("MISSING_QUANTITY");
      quantity = Math.max(0, Math.round(Number(raw)));
    }

    targets.push({ canonicalVariantId: cid, externalVariantId: ext, sku: v.sku ?? null, quantity });
  }

  return { grain: "VARIANT", productId, parentGid, targets };
}

/** Plan a whole batch. Order of the input is preserved in the output. */
export function planInventoryGrainBatch(
  inputs: readonly CanonicalProductInventoryInput[],
  mode: QuantityMode,
): InventoryGrainPlan[] {
  return (inputs ?? []).filter(Boolean).map((i) => planProductInventoryGrain(i, mode));
}

// ── execution core (pure; deps injected) ─────────────────────────────────────

/** Why one variant target could not be resolved to an inventory item. */
export type VariantResolveReason =
  | "not_found"        // no Shopify variant with that GID
  | "archived_parent"  // the variant's parent product is ARCHIVED
  | "sku_mismatch"     // live variant SKU contradicts the canonical variant SKU
  | "no_inventory_item";

export interface VariantInventoryDeps {
  configured: () => boolean;
  resolveLocationId: () => Promise<{ locationId?: string; error?: string }>;
  /**
   * Resolve ONE exact Shopify ProductVariant GID to its inventory item id.
   * MUST reject an ARCHIVED parent and MUST fail closed when the variant is
   * absent or its identity is incoherent. No SKU search is permitted here.
   */
  resolveInventoryItemIdByVariantGid: (
    variantGid: string,
    expectedSku?: string | null,
  ) => Promise<{ inventoryItemId?: string; error?: string; reason?: VariantResolveReason }>;
  setQuantities: (
    locationId: string,
    items: { inventoryItemId: string; quantity: number }[],
  ) => Promise<{ ok: boolean; error?: string }>;
}

export type VariantProductOutcome =
  | { productId: string; result: "synced"; variants: number }
  | { productId: string; result: "blocked"; reason: VariantGrainBlockReason | VariantResolveReason | "shopify_error" };

export interface VariantInventorySummary {
  configured: boolean;
  attempted: number;   // products planned at variant grain
  synced: number;      // products whose full variant set was written
  blocked: number;     // products written for NOT AT ALL
  variantsWritten: number;
  reason?: "not_configured" | "missing_location";
  perProduct: VariantProductOutcome[];
}

/**
 * Write variant-grain inventory. Per product this is ALL-OR-NOTHING: every
 * target is resolved to an inventory item FIRST, and only if every one resolves
 * is a single quantity set issued for that product. A product that cannot be
 * fully resolved is written for not at all.
 */
export async function syncVariantInventory(
  plans: readonly InventoryGrainPlan[],
  deps: VariantInventoryDeps,
): Promise<VariantInventorySummary> {
  const variantPlans = (plans ?? []).filter(
    (p): p is Extract<InventoryGrainPlan, { grain: "VARIANT" }> => p?.grain === "VARIANT",
  );
  const blockedPlans = (plans ?? []).filter(
    (p): p is Extract<InventoryGrainPlan, { grain: "BLOCKED" }> => p?.grain === "BLOCKED",
  );
  const perProduct: VariantProductOutcome[] = blockedPlans.map((p) => ({
    productId: p.productId, result: "blocked" as const, reason: p.reason,
  }));

  if (!deps.configured()) {
    return { configured: false, attempted: 0, synced: 0, blocked: perProduct.length, variantsWritten: 0, reason: "not_configured", perProduct };
  }
  if (variantPlans.length === 0) {
    return { configured: true, attempted: 0, synced: 0, blocked: perProduct.length, variantsWritten: 0, perProduct };
  }

  const loc = await deps.resolveLocationId();
  if (loc.error || !loc.locationId) {
    return { configured: true, attempted: 0, synced: 0, blocked: perProduct.length, variantsWritten: 0, reason: "missing_location", perProduct };
  }
  const locationId = loc.locationId;

  let synced = 0, variantsWritten = 0;
  for (const plan of variantPlans) {
    const items: { inventoryItemId: string; quantity: number }[] = [];
    let failure: VariantResolveReason | "shopify_error" | null = null;

    for (const t of plan.targets) {
      const r = await deps.resolveInventoryItemIdByVariantGid(t.externalVariantId, t.sku);
      if (r.error) { failure = "shopify_error"; break; }
      if (!r.inventoryItemId) { failure = r.reason ?? "not_found"; break; }
      items.push({ inventoryItemId: r.inventoryItemId, quantity: t.quantity });
    }

    if (failure) { perProduct.push({ productId: plan.productId, result: "blocked", reason: failure }); continue; }

    const res = await deps.setQuantities(locationId, items);
    if (!res.ok) { perProduct.push({ productId: plan.productId, result: "blocked", reason: "shopify_error" }); continue; }
    synced++;
    variantsWritten += items.length;
    perProduct.push({ productId: plan.productId, result: "synced", variants: items.length });
  }

  return {
    configured: true,
    attempted: variantPlans.length,
    synced,
    blocked: perProduct.filter((p) => p.result === "blocked").length,
    variantsWritten,
    perProduct,
  };
}

/** True when this canonical product must NOT be resolved by bare SKU. */
export function isVariantGrainProduct(input: { variants?: readonly unknown[] }): boolean {
  return Array.isArray(input?.variants) && input.variants.length > 0;
}
