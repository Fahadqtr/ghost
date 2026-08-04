// Pure view + matching layer for the Malikas V2 Shopify Catalog (Phase UI.3B).
//
// DB-free, network-free, framework-free: no "server-only", no Supabase/Next
// imports, no fetch, no Date.now(), no `any`, no String()/coercion hooks. It
// takes already-read Malikas product / variant rows plus an already-read (and
// already-normalized) list of Shopify products and projects them into a
// PII-safe, catalog-only read model: one matchable row per sellable Malikas
// entity, plus a SEPARATE list of orphan Shopify variants. It never exposes raw
// Shopify JSON, customer/order data, or inventory stock quantities.
//
// Matching is LIVE and identity-based only (no saved relations, no name/title,
// no contains/fuzzy, no auto-pick-first):
//   1. exact normalized SKU     (trim + lowercase; empty → null)
//   2. exact normalized barcode (trim only; empty → null) — ONLY when the SKU
//      produced no Shopify match at all
//   3. otherwise → unmatched (present as "missing" in Shopify)
// A normalized identity shared by more than one Shopify variant is AMBIGUOUS:
// the row is flagged and its Shopify ids are withheld (never guessed).

// ── Shopify input shape (structural; matches lib/shopify/admin.ts output) ─────
//
// Defined locally so this pure module never imports the server-only Shopify
// client. The read layer passes the already-normalized ShopifyProduct[] here;
// it is structurally assignable to these interfaces.

export interface ShopifyVariantInput {
  id: string;
  sku: string; // already trimmed upstream ("" when absent)
  barcode: string; // already trimmed upstream ("" when absent)
  inventoryItemId: string; // "" when absent
}

export interface ShopifyProductInput {
  id: string;
  title: string;
  status: string; // ACTIVE | DRAFT | ARCHIVED (any other → "unknown")
  imageUrl: string; // "" when none
  variants: ShopifyVariantInput[];
}

// ── Output domain (PII-safe; NO raw Shopify JSON / order / customer / stock) ──

export type ShopifyStatus = "active" | "draft" | "archived" | "unknown";
export type PresenceStatus = "present" | "missing" | "unknown";
export type MatchStatus = "matched_sku" | "matched_barcode" | "ambiguous" | "unmatched" | "unknown";
export type OrphanReason = "no_master_match" | "duplicate_identity";

/** One matchable Malikas sellable entity, joined LIVE to Shopify by identity. */
export interface ShopifyCatalogRow {
  masterProductId: string;
  masterVariantId: string | null; // null = a product with no sellable variants
  nameAr: string | null;
  nameEn: string | null;
  sku: string | null;
  barcode: string | null;
  imageUrl: string | null;
  price: number | null;
  shopifyProductId: string | null; // withheld (null) on ambiguity / no match / unknown
  shopifyVariantId: string | null;
  shopifyInventoryItemId: string | null; // identity only — stock quantity is never read
  shopifyStatus: ShopifyStatus;
  presenceStatus: PresenceStatus;
  matchStatus: MatchStatus;
  matchReason: string | null; // fixed reason text — never reflects a raw sku/barcode value
}

/** A Shopify variant that could not be cleanly attributed to a Malikas entity. */
export interface ShopifyOrphanVariant {
  shopifyProductId: string;
  shopifyVariantId: string;
  shopifyInventoryItemId: string | null;
  title: string | null;
  sku: string | null;
  barcode: string | null;
  status: ShopifyStatus;
  reason: OrphanReason;
}

export interface ShopifyCatalogProjection {
  rows: ShopifyCatalogRow[];
  orphanVariants: ShopifyOrphanVariant[];
  /** false when the Shopify read was unavailable (rows become "unknown"). */
  shopifyAvailable: boolean;
}

// ── Safe field readers (typeof guards only — never String()/coercion hooks) ───

function stringOrNull(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}
function numberOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function textOrNull(v: unknown): string | null {
  return typeof v === "string" && v.trim().length > 0 ? v : null;
}

// ── Normalization (the ONLY identity rules) ──────────────────────────────────

/** SKU identity: trim + lowercase; empty → null. */
export function normalizeSku(v: string | null): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim().toLowerCase();
  return t.length > 0 ? t : null;
}
/** Barcode identity: trim only (case-preserving); empty → null. */
export function normalizeBarcode(v: string | null): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

/** Map a raw Shopify status string to a fixed enum (unknown for anything else). */
export function normalizeShopifyStatus(v: string): ShopifyStatus {
  if (typeof v !== "string") return "unknown";
  switch (v.trim().toUpperCase()) {
    case "ACTIVE":
      return "active";
    case "DRAFT":
      return "draft";
    case "ARCHIVED":
      return "archived";
    default:
      return "unknown";
  }
}

// ── Fixed match-reason text (never reflects a raw identity value) ─────────────

const MATCH_REASON = {
  matched_sku: "unique SKU match",
  matched_barcode: "unique barcode match (no SKU match)",
  ambiguous_sku: "multiple Shopify variants share this SKU",
  ambiguous_barcode: "multiple Shopify variants share this barcode",
  unmatched: "no Shopify SKU or barcode match",
} as const;

// ── Master-side projection (raw rows → sellable entities; inputs untouched) ───

interface MasterEntry {
  masterProductId: string;
  masterVariantId: string | null;
  nameAr: string | null;
  nameEn: string | null;
  sku: string | null;
  barcode: string | null;
  imageUrl: string | null;
  price: number | null;
}

/**
 * Build one sellable entity per Malikas row: a product WITHOUT variants yields a
 * single row (masterVariantId null); a product WITH one or more variant rows
 * yields one row per variant and NO extra parent row (the parent is not a
 * sellable SKU once real variants exist). Only whitelisted catalog-safe fields
 * are copied; malformed rows / ids are skipped, never coerced.
 */
function projectMasterEntries(
  productRows: readonly unknown[],
  variantRows: readonly unknown[],
): MasterEntry[] {
  // Group variant rows by their string parent id (others are ignored).
  const byParent = new Map<string, Record<string, unknown>[]>();
  const vRows = Array.isArray(variantRows) ? variantRows : [];
  for (const row of vRows) {
    if (!isPlainObject(row)) continue;
    const parentId = stringOrNull(row.parent_product_id);
    if (parentId === null) continue;
    const list = byParent.get(parentId);
    if (list) list.push(row);
    else byParent.set(parentId, [row]);
  }

  const out: MasterEntry[] = [];
  const pRows = Array.isArray(productRows) ? productRows : [];
  for (const row of pRows) {
    if (!isPlainObject(row)) continue;
    const id = stringOrNull(row.id);
    if (id === null) continue; // malformed identity → skipped
    const nameAr = stringOrNull(row.name_ar);
    const nameEn = stringOrNull(row.name_en);
    const imageUrl = stringOrNull(row.image_url);
    const productPrice = numberOrNull(row.price);
    const variants = byParent.get(id);

    if (!variants || variants.length === 0) {
      out.push({
        masterProductId: id,
        masterVariantId: null,
        nameAr,
        nameEn,
        sku: stringOrNull(row.sku),
        barcode: stringOrNull(row.barcode),
        imageUrl,
        price: productPrice,
      });
      continue;
    }

    for (const v of variants) {
      out.push({
        masterProductId: id,
        masterVariantId: stringOrNull(v.id),
        nameAr,
        nameEn,
        sku: stringOrNull(v.sku),
        barcode: stringOrNull(v.barcode),
        imageUrl,
        // A variant price falls back to the product price when the variant has none.
        price: numberOrNull(v.price) ?? productPrice,
      });
    }
  }
  return out;
}

// ── Shopify-side index (identity → variant refs; duplicates preserved) ────────

interface ShopifyVariantRef {
  shopifyProductId: string;
  shopifyVariantId: string;
  shopifyInventoryItemId: string | null;
  status: ShopifyStatus;
  title: string | null;
  sku: string | null; // raw (empty → null)
  barcode: string | null;
  normSku: string | null;
  normBarcode: string | null;
}

interface ShopifyIndex {
  refs: ShopifyVariantRef[];
  bySku: Map<string, ShopifyVariantRef[]>;
  byBarcode: Map<string, ShopifyVariantRef[]>;
}

function buildShopifyIndex(products: readonly ShopifyProductInput[]): ShopifyIndex {
  const refs: ShopifyVariantRef[] = [];
  const bySku = new Map<string, ShopifyVariantRef[]>();
  const byBarcode = new Map<string, ShopifyVariantRef[]>();

  for (const p of Array.isArray(products) ? products : []) {
    if (!isPlainObject(p)) continue;
    const shopifyProductId = stringOrNull(p.id);
    if (shopifyProductId === null) continue;
    const status = normalizeShopifyStatus(stringOrNull(p.status) ?? "");
    const title = textOrNull(p.title);
    const variants = Array.isArray(p.variants) ? p.variants : [];
    for (const v of variants) {
      if (!isPlainObject(v)) continue;
      const shopifyVariantId = stringOrNull(v.id);
      if (shopifyVariantId === null) continue;
      const rawSku = textOrNull(v.sku);
      const rawBarcode = textOrNull(v.barcode);
      const ref: ShopifyVariantRef = {
        shopifyProductId,
        shopifyVariantId,
        shopifyInventoryItemId: textOrNull(v.inventoryItemId),
        status,
        title,
        sku: rawSku,
        barcode: rawBarcode,
        normSku: normalizeSku(rawSku),
        normBarcode: normalizeBarcode(rawBarcode),
      };
      refs.push(ref);
      if (ref.normSku !== null) {
        const g = bySku.get(ref.normSku);
        if (g) g.push(ref);
        else bySku.set(ref.normSku, [ref]);
      }
      if (ref.normBarcode !== null) {
        const g = byBarcode.get(ref.normBarcode);
        if (g) g.push(ref);
        else byBarcode.set(ref.normBarcode, [ref]);
      }
    }
  }
  return { refs, bySku, byBarcode };
}

// ── Matching one master entry to the Shopify index ───────────────────────────

interface MatchOutcome {
  shopifyProductId: string | null;
  shopifyVariantId: string | null;
  shopifyInventoryItemId: string | null;
  shopifyStatus: ShopifyStatus;
  presenceStatus: PresenceStatus;
  matchStatus: MatchStatus;
  matchReason: string | null;
  attributed: string | null; // shopifyVariantId cleanly attributed (else null)
}

const NO_MATCH: MatchOutcome = {
  shopifyProductId: null,
  shopifyVariantId: null,
  shopifyInventoryItemId: null,
  shopifyStatus: "unknown",
  presenceStatus: "missing",
  matchStatus: "unmatched",
  matchReason: MATCH_REASON.unmatched,
  attributed: null,
};

function ambiguous(reason: string): MatchOutcome {
  return {
    shopifyProductId: null, // withheld — never guess among duplicates
    shopifyVariantId: null,
    shopifyInventoryItemId: null,
    shopifyStatus: "unknown",
    presenceStatus: "present", // it clearly exists in Shopify, just not uniquely
    matchStatus: "ambiguous",
    matchReason: reason,
    attributed: null,
  };
}

function matched(ref: ShopifyVariantRef, status: MatchStatus, reason: string): MatchOutcome {
  return {
    shopifyProductId: ref.shopifyProductId,
    shopifyVariantId: ref.shopifyVariantId,
    shopifyInventoryItemId: ref.shopifyInventoryItemId,
    shopifyStatus: ref.status,
    presenceStatus: "present",
    matchStatus: status,
    matchReason: reason,
    attributed: ref.shopifyVariantId,
  };
}

function matchEntry(entry: MasterEntry, index: ShopifyIndex): MatchOutcome {
  const mSku = normalizeSku(entry.sku);
  if (mSku !== null) {
    const grp = index.bySku.get(mSku);
    if (grp && grp.length === 1) return matched(grp[0]!, "matched_sku", MATCH_REASON.matched_sku);
    if (grp && grp.length > 1) return ambiguous(MATCH_REASON.ambiguous_sku);
    // grp empty/undefined → SKU produced no Shopify match; fall through to barcode.
  }

  const mBar = normalizeBarcode(entry.barcode);
  if (mBar !== null) {
    const grp = index.byBarcode.get(mBar);
    if (grp && grp.length === 1) return matched(grp[0]!, "matched_barcode", MATCH_REASON.matched_barcode);
    if (grp && grp.length > 1) return ambiguous(MATCH_REASON.ambiguous_barcode);
  }

  return NO_MATCH;
}

function unknownRow(entry: MasterEntry): ShopifyCatalogRow {
  return {
    masterProductId: entry.masterProductId,
    masterVariantId: entry.masterVariantId,
    nameAr: entry.nameAr,
    nameEn: entry.nameEn,
    sku: entry.sku,
    barcode: entry.barcode,
    imageUrl: entry.imageUrl,
    price: entry.price,
    shopifyProductId: null,
    shopifyVariantId: null,
    shopifyInventoryItemId: null,
    shopifyStatus: "unknown",
    presenceStatus: "unknown",
    matchStatus: "unknown",
    matchReason: null,
  };
}

// ── Top-level projection ─────────────────────────────────────────────────────

/**
 * Project the Malikas catalog joined LIVE to Shopify by identity.
 *
 * - `shopifyProducts === null` means the Shopify read was UNAVAILABLE: every row
 *   is emitted with presence/match "unknown" (never silently "missing"), no
 *   Shopify ids, and no orphan list. `shopifyAvailable` is false.
 * - Otherwise each sellable Malikas entity is matched by unique SKU, then (only
 *   when SKU found nothing) by unique barcode; a shared identity is ambiguous.
 *   Every Shopify variant NOT cleanly attributed to a Malikas entity is returned
 *   SEPARATELY as an orphan (duplicate_identity when it shares an identity with
 *   another Shopify variant, else no_master_match).
 *
 * Neither input array is mutated; no stock quantity, order, or customer data is
 * read or exposed.
 */
export function projectShopifyCatalog(
  productRows: readonly unknown[],
  variantRows: readonly unknown[],
  shopifyProducts: readonly ShopifyProductInput[] | null,
): ShopifyCatalogProjection {
  const entries = projectMasterEntries(productRows, variantRows);

  if (shopifyProducts === null) {
    return {
      rows: entries.map(unknownRow),
      orphanVariants: [],
      shopifyAvailable: false,
    };
  }

  const index = buildShopifyIndex(shopifyProducts);
  const attributed = new Set<string>();
  const rows: ShopifyCatalogRow[] = [];

  for (const entry of entries) {
    const m = matchEntry(entry, index);
    if (m.attributed !== null) attributed.add(m.attributed);
    rows.push({
      masterProductId: entry.masterProductId,
      masterVariantId: entry.masterVariantId,
      nameAr: entry.nameAr,
      nameEn: entry.nameEn,
      sku: entry.sku,
      barcode: entry.barcode,
      imageUrl: entry.imageUrl,
      price: entry.price,
      shopifyProductId: m.shopifyProductId,
      shopifyVariantId: m.shopifyVariantId,
      shopifyInventoryItemId: m.shopifyInventoryItemId,
      shopifyStatus: m.shopifyStatus,
      presenceStatus: m.presenceStatus,
      matchStatus: m.matchStatus,
      matchReason: m.matchReason,
    });
  }

  const orphanVariants: ShopifyOrphanVariant[] = [];
  for (const ref of index.refs) {
    if (attributed.has(ref.shopifyVariantId)) continue; // cleanly matched → not orphan
    const dupSku = ref.normSku !== null && (index.bySku.get(ref.normSku)?.length ?? 0) > 1;
    const dupBarcode = ref.normBarcode !== null && (index.byBarcode.get(ref.normBarcode)?.length ?? 0) > 1;
    orphanVariants.push({
      shopifyProductId: ref.shopifyProductId,
      shopifyVariantId: ref.shopifyVariantId,
      shopifyInventoryItemId: ref.shopifyInventoryItemId,
      title: ref.title,
      sku: ref.sku,
      barcode: ref.barcode,
      status: ref.status,
      reason: dupSku || dupBarcode ? "duplicate_identity" : "no_master_match",
    });
  }

  return { rows, orphanVariants, shopifyAvailable: true };
}

// ── Fixed Arabic labels (never reflect unknown/raw text) ─────────────────────

const MATCH_STATUS_LABELS: Record<MatchStatus, string> = {
  matched_sku: "مطابق (SKU)",
  matched_barcode: "مطابق (باركود)",
  ambiguous: "غير محدد (تكرار)",
  unmatched: "غير مطابق",
  unknown: "غير معروف",
};

const PRESENCE_LABELS: Record<PresenceStatus, string> = {
  present: "موجود في Shopify",
  missing: "غير موجود في Shopify",
  unknown: "غير معروف",
};

const SHOPIFY_STATUS_LABELS: Record<ShopifyStatus, string> = {
  active: "نشط",
  draft: "مسودة",
  archived: "مؤرشف",
  unknown: "غير معروف",
};

const ORPHAN_REASON_LABELS: Record<OrphanReason, string> = {
  no_master_match: "لا يوجد منتج مطابق في ماليكاس",
  duplicate_identity: "هوية مكررة في Shopify",
};

/** Prototype-safe fixed-label lookup (own string key only; else fallback). */
function fixedLabel<T extends object>(labels: T, key: unknown, fallback: string): string {
  if (typeof key !== "string") return fallback;
  if (!Object.hasOwn(labels, key)) return fallback;
  const value = (labels as Record<string, unknown>)[key];
  return typeof value === "string" ? value : fallback;
}

export function getMatchStatusLabel(status: MatchStatus): string {
  return fixedLabel(MATCH_STATUS_LABELS, status, MATCH_STATUS_LABELS.unknown);
}
export function getPresenceStatusLabel(status: PresenceStatus): string {
  return fixedLabel(PRESENCE_LABELS, status, PRESENCE_LABELS.unknown);
}
export function getShopifyStatusLabel(status: ShopifyStatus): string {
  return fixedLabel(SHOPIFY_STATUS_LABELS, status, SHOPIFY_STATUS_LABELS.unknown);
}
export function getOrphanReasonLabel(reason: OrphanReason): string {
  return fixedLabel(ORPHAN_REASON_LABELS, reason, ORPHAN_REASON_LABELS.no_master_match);
}
