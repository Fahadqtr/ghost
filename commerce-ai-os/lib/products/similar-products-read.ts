// Similar-product card hydration for the AI creator (Phase UI.5, card
// revision). The duplicate report carries product IDS only; this reader loads
// the card/preview fields for JUST those products — the full catalog is never
// sent to the browser. Injected session client, whitelisted columns, no
// writes. server-only.

import "server-only";

import type { DuplicateProductMatch, DuplicateReason } from "./duplicate-detect";

/** Everything the card AND the preview dialog show — and nothing else. */
export interface SimilarProductCard {
  id: string;
  level: "exact" | "similar";
  reasons: DuplicateReason[];
  nameAr: string | null;
  nameEn: string | null;
  sku: string | null;
  barcode: string | null;
  brand: string | null;
  category: string | null;
  size: string | null;
  price: number | null;
  discountPrice: number | null;
  imageUrl: string | null;
  approved: boolean;
  descriptionAr: string | null;
  descriptionEn: string | null;
  variantCount: number;
  /** Built server-side from the REAL product id — never from name or sku. */
  detailHref: string;
}

export interface SimilarCardsResult {
  status: "ok";
  cards: SimilarProductCard[];
  /** Matches found before the hydration cap. */
  total: number;
}

const PRODUCT_CARD_COLUMNS =
  "id, sku, barcode, name_ar, name_en, brand_id, main_category, size, price, discount_price, image_url, approval, description_ar, description_en";

const DEFAULT_CARD_LIMIT = 8;
const VARIANT_COUNT_CAP = 2000;

interface CardReadClient {
  from(table: string): {
    select(columns: string): {
      filter(
        column: string,
        operator: string,
        value: string,
      ): {
        limit(count: number): PromiseLike<{ data: unknown[] | null; error: unknown }>;
      } & PromiseLike<{ data: unknown[] | null; error: unknown }>;
    };
  };
}

/** PostgREST `in` list syntax, same quoting as lib/products/shelf-cleanup. */
function inList(values: readonly string[]): string {
  return `(${values.map((v) => `"${v.replace(/"/g, '""')}"`).join(",")})`;
}

function s(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v : null;
}
function n(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * Pure projection — exported for direct tests. Preserves the match order
 * (already exact-first, strongest-first), drops matches whose product row is
 * missing, and never emits a field outside SimilarProductCard.
 */
export function toSimilarProductCards(
  matches: readonly DuplicateProductMatch[],
  productRows: readonly Record<string, unknown>[],
  variantParentIds: readonly unknown[],
  brandRows: readonly Record<string, unknown>[],
  limit = DEFAULT_CARD_LIMIT,
): SimilarProductCard[] {
  const byId = new Map<string, Record<string, unknown>>();
  for (const row of productRows) {
    if (typeof row.id === "string") byId.set(row.id, row);
  }
  const brandNames = new Map<string, string>();
  for (const b of brandRows) {
    if (typeof b.id === "string" && typeof b.name === "string") brandNames.set(b.id, b.name);
  }
  const variantCounts = new Map<string, number>();
  for (const pid of variantParentIds) {
    if (typeof pid !== "string") continue;
    variantCounts.set(pid, (variantCounts.get(pid) ?? 0) + 1);
  }

  const cards: SimilarProductCard[] = [];
  const seen = new Set<string>();
  for (const m of matches) {
    if (cards.length >= limit) break;
    if (seen.has(m.productId)) continue;
    seen.add(m.productId);
    const row = byId.get(m.productId);
    if (!row) continue;
    const brandId = typeof row.brand_id === "string" ? row.brand_id : null;
    const approval = typeof row.approval === "string" ? row.approval.trim().toLowerCase() : "";
    cards.push({
      id: m.productId,
      level: m.level,
      reasons: [...m.reasons],
      nameAr: s(row.name_ar),
      nameEn: s(row.name_en),
      sku: s(row.sku),
      barcode: s(row.barcode),
      brand: brandId ? (brandNames.get(brandId) ?? null) : null,
      category: s(row.main_category),
      size: s(row.size),
      price: n(row.price),
      discountPrice: n(row.discount_price),
      imageUrl: s(row.image_url),
      approved: approval === "approved",
      descriptionAr: s(row.description_ar),
      descriptionEn: s(row.description_en),
      variantCount: variantCounts.get(m.productId) ?? 0,
      detailHref: `/v2/catalog/${encodeURIComponent(m.productId)}`,
    });
  }
  return cards;
}

/**
 * Hydrate the top matches into cards. A read failure DEGRADES to an empty
 * card list (the level banner still renders) rather than failing the whole
 * prepare step — hydration is presentation, not a safety gate.
 */
export async function loadSimilarProductCards(
  client: CardReadClient,
  matches: readonly DuplicateProductMatch[],
  total: number,
  limit = DEFAULT_CARD_LIMIT,
): Promise<SimilarCardsResult> {
  const wanted = matches.slice(0, limit).map((m) => m.productId);
  if (wanted.length === 0) return { status: "ok", cards: [], total };

  try {
    const { data: productRows, error: pErr } = await client
      .from("products")
      .select(PRODUCT_CARD_COLUMNS)
      .filter("id", "in", inList(wanted));
    if (pErr) return { status: "ok", cards: [], total };

    const { data: variantRows, error: vErr } = await client
      .from("product_variants")
      .select("parent_product_id")
      .filter("parent_product_id", "in", inList(wanted))
      .limit(VARIANT_COUNT_CAP);
    const parentIds = vErr
      ? []
      : (variantRows ?? []).map((r) => (r as { parent_product_id?: unknown }).parent_product_id);

    const brandIds = Array.from(
      new Set(
        (productRows ?? [])
          .map((r) => (r as { brand_id?: unknown }).brand_id)
          .filter((b): b is string => typeof b === "string" && b.length > 0),
      ),
    );
    let brandRows: Record<string, unknown>[] = [];
    if (brandIds.length > 0) {
      const { data: bData, error: bErr } = await client
        .from("brands")
        .select("id, name")
        .filter("id", "in", inList(brandIds));
      if (!bErr) {
        brandRows = (bData ?? []).filter(
          (r): r is Record<string, unknown> => typeof r === "object" && r !== null,
        );
      }
    }

    return {
      status: "ok",
      cards: toSimilarProductCards(
        matches,
        (productRows ?? []).filter(
          (r): r is Record<string, unknown> => typeof r === "object" && r !== null,
        ),
        parentIds,
        brandRows,
        limit,
      ),
      total,
    };
  } catch {
    return { status: "ok", cards: [], total };
  }
}
