// Cross-platform availability reconciliation — pure, DB-free logic.
//
// The business reality: ONE company, ONE inventory, sold under several
// storefronts that each have their OWN dashboard and no shared stock signal:
//   • Malikas      (Snoonu storefront — the master catalog)
//   • Pure Seoul   (a second Snoonu storefront, same products, disguised brand)
//   • Talabat      (separate system; Excel sheet of active/inactive items)
//   • Rafeeq       (separate system; Excel sheet of active/inactive items)
//   • Shopify      (final consolidation target)
//
// We upload each platform's list, match every row back to the master product,
// and build a per-product availability matrix. The reconciliation rule is
// "OUT ANYWHERE = OUT EVERYWHERE": if a product is sold-out/disabled on ANY
// uploaded platform, it should be out on ALL of them — so we never sell what
// isn't really in stock. Conflicts (out on one, in on another) are surfaced.
//
// No next/headers and no Supabase here, so it is unit-testable directly.

export type Avail = "in" | "out" | "absent";

/** One parsed row from any platform's uploaded sheet (already normalized). */
export interface UploadRow {
  name?: string;
  id?: string;        // platform identifier: snoonu_id / global_id / rafeeq id …
  barcode?: string;
  sku?: string;
  available: boolean | null; // true = listed/active, false = hidden/sold-out, null = no signal
}

export interface PlatformUpload {
  platform: string;   // PlatformKey: malika | pure_seoul | talabat | rafeeq | shopify
  rows: UploadRow[];
}

/** Master catalog row (subset of `products`) used to match uploads against. */
export interface MasterProduct {
  id: string;
  snoonu_id?: string | null;
  rafeeq_product_id?: string | null;
  sku?: string | null;
  barcode?: string | null;
  name_en?: string | null;
  name_ar?: string | null;
}

export interface MatrixRow {
  id: string;
  sku: string | null;
  name_en: string | null;
  perPlatform: Record<string, Avail>;
  reconciled: "in" | "out";
  conflict: boolean; // disagreement: out on ≥1 platform AND in on ≥1 platform
}

export interface PlatformCorrection {
  platform: string;
  // Products that should be HIDDEN on this platform to match the reconciled
  // truth (reconciled = out, but the platform still shows them as listed).
  hide: { id: string; sku: string | null; name_en: string | null }[];
}

export interface ReconcileResult {
  platforms: string[];
  matrix: MatrixRow[];
  conflicts: MatrixRow[];
  corrections: PlatformCorrection[];
  counts: {
    products: number;          // distinct products that appeared in ≥1 upload
    out: number;               // reconciled out
    inStock: number;           // reconciled in
    conflicts: number;
    unmatchedByPlatform: Record<string, number>; // rows that matched no master
  };
  applyOutIds: string[]; // master ids → mark OutOfStock on every platform
  applyInIds: string[];  // master ids → mark InStock on every platform
}

// ---- normalization (kept local; mirrors pure-seoul-actions matching) --------
const S = (v: unknown) => String(v ?? "").trim();
const keyNorm = (v: unknown) => S(v).toLowerCase();
// Alnum-only name key: "Body Cream" == "BodyCream", "(100g)" == "100g".
const norm = (v: unknown) => S(v).toLowerCase().replace(/[^a-z0-9]/g, "");
// Token set that KEEPS numeric tokens (sizes/counts discriminate variants);
// words must be ≥3 chars so generic short words don't cause over-matching.
const tokset = (v: unknown) =>
  new Set(S(v).toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((w) => w.length >= 3 || /^[0-9]+$/.test(w)));
// `a` fully contained in `b` (b just has extra size/qualifier words); needs ≥3
// shared tokens and — since numbers are kept — all of a's sizes exist in b.
const isSubset = (a: Set<string>, b: Set<string>) => {
  if (a.size < 3) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
};

// out beats in beats absent (so a product out on ANY variant row is out).
const rank: Record<Avail, number> = { out: 2, in: 1, absent: 0 };
const combine = (prev: Avail | undefined, next: Avail): Avail =>
  prev === undefined ? next : (rank[next] > rank[prev] ? next : prev);

interface Index {
  byKey: Map<string, MasterProduct>;   // id-like keys (snoonu/rafeeq/sku/barcode)
  byName: Map<string, MasterProduct>;  // alnum name key
  tok: { m: MasterProduct; t: Set<string> }[];
}

function buildIndex(masters: MasterProduct[]): Index {
  const byKey = new Map<string, MasterProduct>();
  const byName = new Map<string, MasterProduct>();
  const tok: { m: MasterProduct; t: Set<string> }[] = [];
  for (const m of masters) {
    for (const k of [m.snoonu_id, m.rafeeq_product_id, m.sku, m.barcode]) {
      const s = keyNorm(k);
      if (s && !byKey.has(s)) byKey.set(s, m);
    }
    const n = norm(m.name_en);
    if (n && !byName.has(n)) byName.set(n, m);
    const t = tokset(m.name_en);
    if (t.size) tok.push({ m, t });
  }
  return { byKey, byName, tok };
}

// Match a single upload row to a master product. Conservative on purpose:
// exact id/barcode/sku → exact alnum name → high-confidence subset. No fuzzy
// scoring, so we never wrongly mark an unrelated product out of stock.
function matchRow(r: UploadRow, idx: Index): MasterProduct | null {
  for (const k of [r.id, r.barcode, r.sku]) {
    const s = keyNorm(k);
    if (s) { const m = idx.byKey.get(s); if (m) return m; }
  }
  const n = norm(r.name);
  if (n) { const m = idx.byName.get(n); if (m) return m; }
  const rt = tokset(r.name);
  if (rt.size >= 3) {
    for (const { m, t } of idx.tok) if (isSubset(rt, t) || isSubset(t, rt)) return m;
  }
  return null;
}

/**
 * Reconcile uploaded availability across platforms using the
 * "out anywhere = out everywhere" rule. Pure: no DB, no side effects.
 */
export function reconcile(masters: MasterProduct[], uploads: PlatformUpload[]): ReconcileResult {
  const idx = buildIndex(masters);
  const metaById = new Map(masters.map((m) => [m.id, m]));
  const platforms = uploads.map((u) => u.platform);

  const perProduct = new Map<string, Record<string, Avail>>();
  const unmatchedByPlatform: Record<string, number> = {};

  for (const up of uploads) {
    unmatchedByPlatform[up.platform] = 0;
    for (const r of up.rows ?? []) {
      const m = matchRow(r, idx);
      if (!m) { unmatchedByPlatform[up.platform]++; continue; }
      const a: Avail = r.available === true ? "in" : r.available === false ? "out" : "absent";
      if (a === "absent") continue; // no signal in this row → ignore
      const rec = perProduct.get(m.id) ?? {};
      rec[up.platform] = combine(rec[up.platform], a);
      perProduct.set(m.id, rec);
    }
  }

  const matrix: MatrixRow[] = [];
  for (const [id, rec] of perProduct) {
    const perPlatform: Record<string, Avail> = {};
    let anyOut = false, anyIn = false;
    for (const p of platforms) {
      const a = rec[p] ?? "absent";
      perPlatform[p] = a;
      if (a === "out") anyOut = true;
      else if (a === "in") anyIn = true;
    }
    const reconciled: "in" | "out" = anyOut ? "out" : "in";
    const m = metaById.get(id);
    matrix.push({
      id,
      sku: m?.sku ?? null,
      name_en: m?.name_en ?? null,
      perPlatform,
      reconciled,
      conflict: anyOut && anyIn,
    });
  }
  matrix.sort((a, b) => {
    if (a.conflict !== b.conflict) return a.conflict ? -1 : 1; // conflicts first
    return (a.name_en ?? a.sku ?? "").localeCompare(b.name_en ?? b.sku ?? "");
  });

  const corrections: PlatformCorrection[] = platforms.map((p) => ({
    platform: p,
    hide: matrix
      .filter((row) => row.reconciled === "out" && row.perPlatform[p] === "in")
      .map((row) => ({ id: row.id, sku: row.sku, name_en: row.name_en })),
  }));

  const conflicts = matrix.filter((r) => r.conflict);
  const applyOutIds = matrix.filter((r) => r.reconciled === "out").map((r) => r.id);
  const applyInIds = matrix.filter((r) => r.reconciled === "in").map((r) => r.id);

  return {
    platforms,
    matrix,
    conflicts,
    corrections,
    counts: {
      products: matrix.length,
      out: applyOutIds.length,
      inStock: applyInIds.length,
      conflicts: conflicts.length,
      unmatchedByPlatform,
    },
    applyOutIds,
    applyInIds,
  };
}

// ---- generic sheet cell → availability ------------------------------------
// Shared by the client parsers for all platforms. Returns true (listed/active/
// in stock), false (hidden/inactive/sold-out), or null (unrecognized).
const AVAIL_TRUE = new Set(["true", "active", "available", "yes", "y", "1", "in stock", "instock", "visible", "enabled", "listed", "on", "متوفر", "متوفّر", "موجود", "مفعل", "مفعّل", "نشط", "ظاهر"]);
const AVAIL_FALSE = new Set(["false", "inactive", "unavailable", "no", "n", "0", "out of stock", "outofstock", "oos", "hidden", "disabled", "unlisted", "off", "sold out", "soldout", "نافد", "نافذ", "مخلص", "مخلّص", "غير مفعل", "غير مفعّل", "غير متوفر", "مخفي", "موقف", "موقوف"]);

export function cellToAvailable(raw: unknown): boolean | null {
  const v = S(raw).toLowerCase();
  if (v === "") return null;
  if (AVAIL_TRUE.has(v)) return true;
  if (AVAIL_FALSE.has(v)) return false;
  // Pure numeric → treat as a stock quantity: >0 in stock, 0 out.
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v) > 0;
  return null;
}
