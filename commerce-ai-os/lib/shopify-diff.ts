// Pure, DB-free Shopify catalog diff — shared by the server action and tests.
//
// Matching: our products ↔ Shopify products by variant SKU first (exact,
// case-insensitive), then by normalized English title. Our catalog is the
// source of truth: "updated" lists what would change ON SHOPIFY.

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
  variants: { id: string; sku: string; price: string; compareAtPrice: string | null }[];
}

export interface ShopifyFieldChange { field: string; old: string; new: string }
export interface ShopifyMatch {
  product_id: string;
  shopify_id: string;
  variant_id: string;
  name_en: string;
  changes: ShopifyFieldChange[];
}

export interface ShopifyDiff {
  ok: boolean;
  error?: string;
  counts: { ours: number; shopify: number; matched: number; updated: number; unchanged: number; onlyShopify: number; onlyOurs: number };
  updated: ShopifyMatch[];                                     // matched, with pending changes
  onlyShopify: { shopify_id: string; title: string; status: string }[]; // in the store, not in our catalog
  onlyOurs: { product_id: string; name_en: string }[];         // in our catalog, missing from the store
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

/** Diff our catalog (source of truth) against the live Shopify products. */
export function diffShopify(ours: OurProductRow[], shopify: ShopifyProductLite[]): ShopifyDiff {
  // Index Shopify by variant SKU and by normalized title.
  const bySku = new Map<string, { p: ShopifyProductLite; v: ShopifyProductLite["variants"][number] }>();
  const byTitle = new Map<string, ShopifyProductLite>();
  for (const p of shopify) {
    if (!byTitle.has(normTitle(p.title))) byTitle.set(normTitle(p.title), p);
    for (const v of p.variants) {
      const k = v.sku.toLowerCase();
      if (k && !bySku.has(k)) bySku.set(k, { p, v });
    }
  }

  const matchedShopifyIds = new Set<string>();
  const updated: ShopifyMatch[] = [];
  const onlyOurs: ShopifyDiff["onlyOurs"] = [];
  let matched = 0;

  for (const o of ours) {
    const sku = String(o.sku ?? "").trim().toLowerCase();
    let hit = sku ? bySku.get(sku) : undefined;
    if (!hit) {
      const t = byTitle.get(normTitle(o.name_en));
      if (t) hit = { p: t, v: t.variants[0] };
    }
    if (!hit?.v) {
      onlyOurs.push({ product_id: o.id, name_en: String(o.name_en ?? "") });
      continue;
    }
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
    const isActive = hit.p.status === "ACTIVE";
    if (wantActive !== isActive) {
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

  return {
    ok: true,
    counts: {
      ours: ours.length, shopify: shopify.length, matched,
      updated: updated.length, unchanged: matched - updated.length,
      onlyShopify: onlyShopify.length, onlyOurs: onlyOurs.length,
    },
    updated, onlyShopify, onlyOurs,
  };
}
