// Malikas V2 — PureSoul snapshot capture logic (Phase UI.9.3). PURE: no DB, no
// network, no clock, no secrets. This is the DURABLE, testable source of truth
// for what a PureSoul snapshot records per product.
//
// The matching rules MIRROR comparePureSeoul (app/(app)/import-export/
// pure-seoul-actions.ts) — match a PS upload row to a Malika product by
// pure_seoul_id → snoonu_id → name (exact → subset → strong), classify the rest
// as missing/review by name similarity — but here they are ISOLATED and pure so
// the persisted snapshot never depends on a DB read and can be unit-tested.
// comparePureSeoul stays the live import UI; this feeds persistence.
//
// Confidence-only: we NEVER invent missing/different from absent data.
//   present  — the product is on PureSoul (matched a PS row / subset match)
//   missing  — confidently NOT on PureSoul (no match, no close name)
//   review   — a close PS name exists (likely same item / size variant)

import type { SnapshotInput } from "../core/types.ts";
import type { PlatformSnapshot } from "../core/types.ts";

export const PURESOUL_PLATFORM = "pure_seoul";

/** How long a PureSoul snapshot stays "fresh" (adopted threshold, unit-tested). */
export const PURESOUL_SNAPSHOT_STALE_MS = 24 * 60 * 60 * 1000; // 24h

export interface PsCatalogRow {
  id: string;
  snoonu_id?: string | null;
  pure_seoul_id?: string | null;
  sku?: string | null;
  barcode?: string | null;
  name_en?: string | null;
  price?: number | string | null;
}

export interface PsUploadRow {
  id?: string | null;
  global_id?: string | null;
  name_en?: string | null;
  name_ar?: string | null;
  price?: string | number | null;
  approval?: string | null;
  branchStatus?: string | null;
}

export type PureSoulVerdict = "present" | "missing" | "review";

export interface PsVerdict {
  productId: string;
  sku: string | null;
  barcode: string | null;
  psSpi: string | null;
  verdict: PureSoulVerdict;
  availability: "InStock" | "OutOfStock" | null;
  rejected: boolean;
  priceDiff: boolean;
  psPrice: number | null;
  malikaPrice: number | null;
  psName: string | null;
}

/** The dashboard-facing PureSoul state derived from a stored snapshot. */
export type PureSoulState =
  | "published"
  | "missing"
  | "price_different"
  | "review"
  | "out_of_stock"
  | "unknown";

// ---- small matching helpers (mirror comparePureSeoul / pure-seoul-map-compute) ----
const S = (v: unknown) => String(v ?? "").trim();
const norm = (v: unknown) => S(v).toLowerCase().replace(/[^a-z0-9]/g, "");
const tokset = (v: unknown) =>
  new Set(
    S(v)
      .toLowerCase()
      .replace(/[^a-z0-9 ]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length >= 3 || /^[0-9]+$/.test(w)),
  );
const isSubset = (a: Set<string>, b: Set<string>) => {
  if (a.size < 3) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
};
const jaccard = (a: Set<string>, b: Set<string>) => {
  let i = 0;
  for (const x of a) if (b.has(x)) i++;
  return i / (a.size + b.size - i || 1);
};
const numOrNull = (v: unknown): number | null => {
  const t = S(v);
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};
const priceDiffers = (a: unknown, b: unknown) => {
  const x = numOrNull(a);
  const y = numOrNull(b);
  if (x === null || y === null) return S(a) !== S(b);
  return x !== y;
};

/**
 * Compute one verdict per Malika catalog product against a PureSoul upload.
 * Every catalog product yields exactly one verdict; PS rows with no product
 * match (extras) are ignored (we only snapshot Malika products).
 */
export function computePureSoulVerdicts(uploadRows: PsUploadRow[], catalog: PsCatalogRow[]): PsVerdict[] {
  const cats = (catalog ?? []).filter((c) => S(c.id));
  const byPsId = new Map<string, PsCatalogRow>();
  const bySnoonu = new Map<string, PsCatalogRow>();
  const byName = new Map<string, PsCatalogRow>();
  for (const c of cats) {
    if (S(c.pure_seoul_id)) byPsId.set(S(c.pure_seoul_id), c);
    if (S(c.snoonu_id)) bySnoonu.set(S(c.snoonu_id), c);
    const n = norm(c.name_en);
    if (n && !byName.has(n)) byName.set(n, c);
  }

  const verdictByProduct = new Map<string, PsVerdict>();
  const present = (c: PsCatalogRow, over: Partial<PsVerdict>): PsVerdict => ({
    productId: c.id,
    sku: S(c.sku) || null,
    barcode: S(c.barcode) || null,
    psSpi: null,
    verdict: "present",
    availability: null,
    rejected: false,
    priceDiff: false,
    psPrice: null,
    malikaPrice: numOrNull(c.price),
    psName: null,
    ...over,
  });

  // Pass 1: direct row matches (id → name), first row per product wins.
  for (const r of uploadRows ?? []) {
    const spi = S(r.global_id) || S(r.id);
    const m = byPsId.get(spi) || bySnoonu.get(S(r.global_id)) || byName.get(norm(r.name_en));
    if (!m || verdictByProduct.has(m.id)) continue;
    const bs = S(r.branchStatus).toLowerCase();
    verdictByProduct.set(m.id, {
      ...present(m, {}),
      psSpi: spi || null,
      availability: bs === "active" ? "InStock" : bs === "inactive" ? "OutOfStock" : null,
      rejected: S(r.approval) === "Rejected",
      priceDiff: priceDiffers(r.price, m.price),
      psPrice: numOrNull(r.price),
      psName: S(r.name_en) || null,
    });
  }

  // Pass 2: subset auto-match for still-unmatched products (present, but no
  // asserted availability/price — we only know it's on PS).
  const psTok = (uploadRows ?? []).map((r) => ({ t: tokset(r.name_en), n: S(r.name_en) })).filter((x) => x.t.size);
  for (const c of cats) {
    if (verdictByProduct.has(c.id)) continue;
    const ct = tokset(c.name_en);
    if (!ct.size) continue;
    for (const x of psTok) {
      if (isSubset(ct, x.t) || isSubset(x.t, ct)) {
        verdictByProduct.set(c.id, present(c, { psName: x.n || null }));
        break;
      }
    }
  }

  // Pass 3: remaining products → review (close name) or missing (no close name).
  for (const c of cats) {
    if (verdictByProduct.has(c.id)) continue;
    const ct = tokset(c.name_en);
    let best = 0;
    let bn = "";
    if (ct.size) {
      for (const x of psTok) {
        const s = jaccard(ct, x.t);
        if (s > best) {
          best = s;
          bn = x.n;
        }
      }
    }
    const baseline: PsVerdict = {
      productId: c.id,
      sku: S(c.sku) || null,
      barcode: S(c.barcode) || null,
      psSpi: null,
      verdict: "missing",
      availability: null,
      rejected: false,
      priceDiff: false,
      psPrice: null,
      malikaPrice: numOrNull(c.price),
      psName: null,
    };
    if (best >= 0.55) verdictByProduct.set(c.id, { ...baseline, verdict: "review", psName: bn || null });
    else verdictByProduct.set(c.id, baseline);
  }

  return [...verdictByProduct.values()];
}

/** Map verdicts to snapshot inputs. `capturedAt` is supplied by the caller (no
 *  clock here). A snapshot records ONLY what the verdict knows with confidence. */
export function verdictsToSnapshotInputs(verdicts: readonly PsVerdict[], capturedAt: string): SnapshotInput[] {
  return verdicts.map((v) => ({
    platform: PURESOUL_PLATFORM,
    productId: v.productId,
    externalId: v.psSpi,
    sku: v.sku,
    barcode: v.barcode,
    status: v.rejected ? "Rejected" : v.verdict === "present" ? "Approved" : null,
    price: v.verdict === "present" ? v.psPrice : null,
    availability: v.availability,
    title: v.psName,
    capturedAt,
    metadata: { ps: { verdict: v.verdict, priceDiff: v.priceDiff, malikaPrice: v.malikaPrice } },
  }));
}

interface PsMeta {
  verdict?: PureSoulVerdict;
  priceDiff?: boolean;
}

/**
 * Classify a stored PureSoul snapshot into a dashboard state. Reads only the
 * confident verdict recorded at capture time — a snapshot's ABSENCE is handled
 * by the caller as "unknown" (never "missing").
 */
export function classifyPureSoulSnapshot(snapshot: PlatformSnapshot): PureSoulState {
  const ps = ((snapshot.metadata as Record<string, unknown>)?.ps ?? {}) as PsMeta;
  const verdict = ps.verdict;
  if (verdict === "missing") return "missing";
  if (verdict === "review") return "review";
  if (verdict === "present") {
    if (snapshot.status === "Rejected") return "review";
    if (ps.priceDiff === true) return "price_different";
    if (snapshot.availability === "OutOfStock") return "out_of_stock";
    return "published";
  }
  return "unknown";
}

/** True when a snapshot's capture time is older than the adopted stale window. */
export function isSnapshotStale(capturedAt: string | null, now: number): boolean {
  if (!capturedAt) return true;
  const t = Date.parse(capturedAt);
  if (!Number.isFinite(t)) return true;
  return now - t > PURESOUL_SNAPSHOT_STALE_MS;
}
