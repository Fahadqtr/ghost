// Pure, DB-free Shopify catalog diff — shared by the server action and tests.
//
// Matching: our products ↔ Shopify products by variant SKU first (exact,
// case-insensitive), then by normalized English title. Our catalog is the
// source of truth: "updated" lists what would change ON SHOPIFY.
//
// OPERATIONAL SAFETY (archived shells)
// ------------------------------------
// De-duplicating on Shopify retires the loser by ARCHIVING it, and an archived
// product keeps both its SKU and its title. Matching therefore runs ONLY over
// the operational candidate set defined in `lib/shopify/operational-eligibility`
// — archived products can never be a match target — and any identity carried by
// two eligible products FAILS CLOSED (no match) instead of silently taking the
// first one. Reporting is unaffected: `onlyShopify` still lists every store
// product, archived included, with its status.

import {
  SHOPIFY_ARCHIVED_STATUS,
  buildOperationalIndex,
  normalizeShopifyStatus,
  type OperationalReason,
} from "./shopify/operational-eligibility.ts";

export interface OurProductRow {
  id: string;
  sku: string | null;
  name_en: string | null;
  name_ar: string | null;
  price: number | string | null;
  discount_price: number | string | null;
  approval: string | null;
}

export interface ShopifyProductLite {
  id: string;
  title: string;
  status: string; // ACTIVE | DRAFT | ARCHIVED
  descriptionHtml?: string;
  imageUrl?: string;
  variants: {
    id: string; sku: string; price: string; compareAtPrice: string | null;
    inventoryItemId?: string; inventoryQuantity?: number | null;
  }[];
}

export interface ShopifyFieldChange { field: string; old: string; new: string }
export interface ShopifyMatch {
  product_id: string;
  shopify_id: string;
  variant_id: string;
  name_en: string;
  changes: ShopifyFieldChange[];
}

export interface ShopifyDuplicate {
  shopify_id: string;
  title: string;      // the store product both rows point at
  names: string[];    // our catalog rows (2+) that matched it
}

export interface ShopifyDiff {
  ok: boolean;
  error?: string;
  counts: { ours: number; shopify: number; matched: number; updated: number; unchanged: number; onlyShopify: number; onlyOurs: number; duplicates: number };
  updated: ShopifyMatch[];                                     // matched, with pending changes
  onlyShopify: { shopify_id: string; title: string; status: string }[]; // in the store, not in our catalog
  onlyOurs: { product_id: string; name_en: string }[];         // in our catalog, missing from the store
  duplicates: ShopifyDuplicate[];                              // 2+ catalog rows on one store product
}

export const normTitle = (v: unknown): string =>
  String(v ?? "").toLowerCase().normalize("NFKC").replace(/[’']/g, "").replace(/["،,.\-–—]/g, " ").replace(/\s+/g, " ").trim();

const money = (v: unknown): string => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n.toFixed(2) : "";
};

/**
 * Our price model → Shopify's: with a discount, Shopify price = discount and
 * compareAtPrice = original; otherwise price = price, compareAt cleared.
 */
export function targetShopifyPrice(p: OurProductRow): { price: string; compareAtPrice: string | null } {
  const base = money(p.price);
  const disc = money(p.discount_price);
  if (disc && base && Number(disc) < Number(base)) return { price: disc, compareAtPrice: base };
  return { price: disc || base, compareAtPrice: null };
}

type ShopifyHit = { p: ShopifyProductLite; v: ShopifyProductLite["variants"][number] };

const skuKey = (v: unknown): string => String(v ?? "").trim().toLowerCase();

/**
 * Index Shopify by variant SKU and by normalized title (shared matcher).
 *
 * OPERATIONAL, not historical: archived products are excluded from both
 * indexes, and an identity claimed by two eligible products is recorded in
 * `blockedSkus` / `blockedTitles` instead of being resolved. `match()` returns
 * `undefined` for a blocked identity — the caller sees "no match", never the
 * wrong product.
 */
export function indexShopify(shopify: ShopifyProductLite[]): {
  bySku: Map<string, ShopifyHit>;
  byTitle: Map<string, ShopifyProductLite>;
  blockedSkus: Map<string, Exclude<OperationalReason, "OK">>;
  blockedTitles: Map<string, Exclude<OperationalReason, "OK">>;
  match: (sku: string | null, nameEn: string | null) => ShopifyHit | undefined;
} {
  const list = (Array.isArray(shopify) ? shopify : []).filter(Boolean);
  const identity = (p: ShopifyProductLite) => String(p.id ?? "");

  // One key per DISTINCT sku a product carries (a 5-shade product repeating the
  // same SKU is one claimant, not five).
  const skuIdx = buildOperationalIndex(
    list,
    (p) => [...new Set((p.variants ?? []).map((v) => skuKey(v.sku)).filter((k) => k !== ""))],
    identity,
  );
  const titleIdx = buildOperationalIndex(list, (p) => [normTitle(p.title)], identity);

  const bySku = new Map<string, ShopifyHit>();
  for (const [k, p] of skuIdx.resolved) {
    const v = (p.variants ?? []).find((x) => skuKey(x.sku) === k);
    if (v) bySku.set(k, { p, v });
  }
  const byTitle = titleIdx.resolved;

  const match = (sku: string | null, nameEn: string | null): ShopifyHit | undefined => {
    const k = skuKey(sku);
    if (k !== "") {
      // Ambiguous or archived-only SKU ⇒ stop. Never fall through to the title
      // fallback: that is exactly how a write lands on the wrong twin.
      if (skuIdx.blocked.has(k)) return undefined;
      const hit = bySku.get(k);
      if (hit) return hit;
    }
    const t = normTitle(nameEn);
    if (t === "" || titleIdx.blocked.has(t)) return undefined;
    const p = byTitle.get(t);
    return p ? { p, v: p.variants[0] } : undefined;
  };

  return { bySku, byTitle, blockedSkus: skuIdx.blocked, blockedTitles: titleIdx.blocked, match };
}

/** Diff our catalog (source of truth) against the live Shopify products. */
export function diffShopify(ours: OurProductRow[], shopify: ShopifyProductLite[]): ShopifyDiff {
  const { match } = indexShopify(shopify);

  const matchedShopifyIds = new Set<string>();
  const updated: ShopifyMatch[] = [];
  const onlyOurs: ShopifyDiff["onlyOurs"] = [];
  // Which of OUR rows landed on each store product — a second landing is a
  // duplicate catalog row. It gets reported, not diffed: two rows syncing the
  // same product would fight each other (ACTIVE<->DRAFT flip-flop) forever.
  const landed = new Map<string, ShopifyDuplicate>();
  let matched = 0;

  for (const o of ours) {
    const hit = match(o.sku, o.name_en);
    if (!hit?.v) {
      onlyOurs.push({ product_id: o.id, name_en: String(o.name_en ?? "") });
      continue;
    }
    const prior = landed.get(hit.p.id);
    if (prior) {
      prior.names.push(String(o.name_en ?? ""));
      continue;
    }
    landed.set(hit.p.id, { shopify_id: hit.p.id, title: hit.p.title, names: [String(o.name_en ?? "")] });
    matched++;
    matchedShopifyIds.add(hit.p.id);

    const changes: ShopifyFieldChange[] = [];
    const want = targetShopifyPrice(o);
    if (want.price && money(hit.v.price) !== want.price) {
      changes.push({ field: "price", old: money(hit.v.price), new: want.price });
    }
    const haveCompare = money(hit.v.compareAtPrice);
    if ((want.compareAtPrice ?? "") !== haveCompare) {
      changes.push({ field: "compare_at", old: haveCompare, new: want.compareAtPrice ?? "" });
    }
    if (normTitle(o.name_en) && normTitle(o.name_en) !== normTitle(hit.p.title)) {
      changes.push({ field: "title", old: hit.p.title, new: String(o.name_en ?? "") });
    }
    const wantActive = String(o.approval ?? "") === "Approved";
    const liveStatus = normalizeShopifyStatus(hit.p.status);
    const isActive = liveStatus === "ACTIVE";
    // ARCHIVED is a RETIRED identity, never an activation candidate: a retired
    // shell must not be planned back to ACTIVE just because our row is
    // Approved. Restoring one is an explicit, owner-authorized action. (The
    // operational index already excludes archived products; this is the
    // defence-in-depth so no future matcher change can resurrect the path.)
    if (liveStatus !== SHOPIFY_ARCHIVED_STATUS && wantActive !== isActive) {
      changes.push({ field: "status", old: hit.p.status, new: wantActive ? "ACTIVE" : "DRAFT" });
    }
    if (changes.length) {
      updated.push({
        product_id: o.id, shopify_id: hit.p.id, variant_id: hit.v.id,
        name_en: String(o.name_en ?? ""), changes,
      });
    }
  }

  const onlyShopify = shopify
    .filter((p) => !matchedShopifyIds.has(p.id))
    .map((p) => ({ shopify_id: p.id, title: p.title, status: p.status }));

  const duplicates = [...landed.values()].filter((d) => d.names.length > 1);
  const extraRows = duplicates.reduce((n, d) => n + d.names.length - 1, 0);

  return {
    ok: true,
    counts: {
      ours: ours.length, shopify: shopify.length, matched,
      updated: updated.length, unchanged: matched - updated.length,
      onlyShopify: onlyShopify.length, onlyOurs: onlyOurs.length,
      duplicates: extraRows,
    },
    updated, onlyShopify, onlyOurs, duplicates,
  };
}

export interface InventoryPlanItem {
  product_id: string;
  name_en: string;
  inventoryItemId: string;
  from: number | null; // Shopify's current available qty
  quantity: number;    // ours — what gets written
}

/**
 * Which matched products need their Shopify "available" quantity corrected to
 * OUR stock (the inventory table is the source of truth). Products without a
 * Shopify match or without an inventory item are skipped, not errors.
 */
export function planInventorySync(
  ours: { id: string; sku: string | null; name_en: string | null; stock: number }[],
  shopify: ShopifyProductLite[],
): { changes: InventoryPlanItem[]; matched: number; unmatched: number } {
  const { match } = indexShopify(shopify);
  const changes: InventoryPlanItem[] = [];
  let matched = 0, unmatched = 0;
  for (const o of ours) {
    const hit = match(o.sku, o.name_en);
    if (!hit?.v?.inventoryItemId) { unmatched++; continue; }
    matched++;
    const want = Math.max(0, Math.round(Number(o.stock) || 0));
    const have = hit.v.inventoryQuantity;
    if (typeof have === "number" && have === want) continue; // already in sync
    changes.push({
      product_id: o.id, name_en: String(o.name_en ?? ""),
      inventoryItemId: hit.v.inventoryItemId, from: typeof have === "number" ? have : null, quantity: want,
    });
  }
  return { changes, matched, unmatched };
}

/** Plain catalog text → simple safe HTML for Shopify's descriptionHtml. */
export function htmlFromPlain(text: unknown): string {
  return String(text ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/\r?\n/g, "<br>")
    .trim();
}

/** Shopify descriptionHtml → clean plain text for our description columns. */
export function textFromHtml(html: unknown): string {
  return String(html ?? "")
    .replace(/<(br|\/p|\/div|\/li)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&quot;/gi, '"').replace(/&#39;/gi, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Inverse of targetShopifyPrice: Shopify price(+compareAt) → our columns. */
export function shopifyToCatalogPrices(price: unknown, compareAtPrice: unknown): { price: number | null; discount_price: number | null } {
  const p = Number(price);
  const c = Number(compareAtPrice);
  const hasP = Number.isFinite(p) && p > 0;
  const hasC = Number.isFinite(c) && c > 0;
  if (hasP && hasC && c > p) return { price: c, discount_price: p };
  return { price: hasP ? p : null, discount_price: null };
}

export interface CatalogImportRow {
  name_en: string;
  description_en: string | null;
  price: number | null;
  discount_price: number | null;
  sku: string | null;
  image_url: string | null;
  approval: string;
}

/** One Shopify product → the catalog row the import inserts. */
export function mapShopifyToCatalogRow(p: ShopifyProductLite): CatalogImportRow {
  const v = p.variants[0];
  const prices = shopifyToCatalogPrices(v?.price, v?.compareAtPrice);
  const desc = textFromHtml(p.descriptionHtml);
  return {
    name_en: p.title.trim(),
    description_en: desc || null,
    price: prices.price,
    discount_price: prices.discount_price,
    sku: v?.sku?.trim() || null,
    image_url: p.imageUrl?.trim() || null,
    approval: p.status === "ACTIVE" ? "Approved" : "Rejected",
  };
}
