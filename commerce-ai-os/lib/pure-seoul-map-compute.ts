// Pure, DB-free matching of Pure Seoul export rows to catalog products BY NAME.
//
// Pure Seoul is a SEPARATE Snoonu merchant, so its SPI(UniqueIdentifier) is a
// different namespace from our products.snoonu_id — the same physical product
// carries a different SPI on each store. The only bridge is the product name.
// This computes confident {product_id → pure_seoul_id} pairs so the Pure Seoul
// SPI can be persisted on the catalog (products.pure_seoul_id); once stored,
// future Pure Seoul syncs/fills match by id directly (exact, no name guessing).
//
// Confidence tiers (mirrors the Pure Seoul reconcile matcher):
//   exact  — normalized names identical
//   subset — one name fully contains the other incl. all numeric tokens
//   strong — token Jaccard ≥ 0.72
// Weaker matches are left out — a wrong id is worse than a missing one. Unit-tested.

export interface PsMapRow { spi?: string | null; nameEn?: string | null; nameAr?: string | null }
export interface CatalogNameRow { id: string; name_en?: string | null; name_ar?: string | null; pure_seoul_id?: string | null }
export interface PsMapPair { product_id: string; pure_seoul_id: string; name: string; matched: "exact" | "subset" | "strong" }
export interface PsMapResult {
  pairs: PsMapPair[];
  mapped: number;       // confident pairs produced
  alreadySet: number;   // catalog product already had this exact pure_seoul_id
  unmatched: number;    // PS rows with no confident catalog match
}

const S = (v: unknown) => String(v ?? "").trim();
const norm = (v: unknown) => S(v).toLowerCase().replace(/[^a-z0-9]/g, "");
// Token set that keeps numeric tokens (sizes/counts) even when short — numbers
// discriminate "6 Color" from "10 Color". Words must be ≥3 chars.
const tokset = (v: unknown) => new Set(
  S(v).toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((w) => w.length >= 3 || /^[0-9]+$/.test(w))
);
const isSubset = (a: Set<string>, b: Set<string>) => {
  if (a.size < 3) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
};
const jaccard = (a: Set<string>, b: Set<string>) => {
  let i = 0; for (const x of a) if (b.has(x)) i++;
  return i / (a.size + b.size - i || 1);
};

const STRONG = 0.72;

/**
 * Compute confident {product_id → pure_seoul_id} pairs. Each catalog product is
 * claimed by at most one Pure Seoul SPI (first confident row wins), and each PS
 * SPI maps to at most one product — so re-running is stable and never fans out.
 */
export function computePureSeoulIdMap(psRows: PsMapRow[], catalog: CatalogNameRow[]): PsMapResult {
  const cats = (catalog ?? []).filter((c) => S(c.id));
  const byName = new Map<string, CatalogNameRow>();
  for (const c of cats) {
    for (const n of [norm(c.name_en), norm(c.name_ar)]) if (n && !byName.has(n)) byName.set(n, c);
  }
  const catTok = cats.map((c) => ({ c, t: tokset(c.name_en) })).filter((x) => x.t.size);

  const claimedProduct = new Set<string>();
  const seenSpi = new Set<string>();
  const pairs: PsMapPair[] = [];
  let alreadySet = 0, unmatched = 0;

  for (const r of psRows ?? []) {
    const spi = S(r.spi);
    if (!spi || seenSpi.has(spi)) continue;
    seenSpi.add(spi);

    const nn = norm(r.nameEn) || norm(r.nameAr);
    let hit: CatalogNameRow | undefined = nn ? byName.get(nn) : undefined;
    let how: PsMapPair["matched"] = "exact";
    if (!hit) {
      const tt = tokset(r.nameEn);
      if (tt.size) {
        let best = 0, bestC: CatalogNameRow | undefined;
        for (const x of catTok) {
          if (isSubset(tt, x.t) || isSubset(x.t, tt)) { bestC = x.c; best = 0.99; how = "subset"; break; }
          const s = jaccard(tt, x.t);
          if (s > best) { best = s; bestC = x.c; }
        }
        if (bestC && best >= 0.99) hit = bestC;
        else if (bestC && best >= STRONG) { hit = bestC; how = "strong"; }
      }
    }
    if (!hit) { unmatched++; continue; }
    if (claimedProduct.has(hit.id)) { unmatched++; continue; } // product already taken by an earlier PS row
    claimedProduct.add(hit.id);

    if (S(hit.pure_seoul_id) === spi) { alreadySet++; continue; } // no write needed
    pairs.push({ product_id: hit.id, pure_seoul_id: spi, name: S(hit.name_en) || S(hit.name_ar), matched: how });
  }

  return { pairs, mapped: pairs.length, alreadySet, unmatched };
}
