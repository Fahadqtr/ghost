// CATALOG.GOLIVE.3A — Wave 2 Bulk Review plan (PURE).
//
// The Wave 2 DRAFT intake batch was audited read-only on 2026-08-23 (fresh
// production reads + catalog-precedent evidence). This module holds that audit
// as REVIEW DEFAULTS — seeds for the operator screen, NEVER writes. Every
// mutation the workspace offers delegates to an EXISTING certified boundary
// (see app/(v2)/v2/catalog/launch/wave2/actions.ts); this file only classifies,
// counts and validates against the existing taxonomy (lib/constants CATEGORIES).
//
// PURE: no database, no fetch, no storage, no clock. node:test loads it directly.

import { CATEGORIES, type Category } from "../../constants.ts";

// ── audited category seeds (REVIEW DEFAULTS — not writes) ───────────────────

/** 43 SAFE suggestions from the CATALOG.GOLIVE.3 audit (catalog precedent). */
export const WAVE2_SAFE_DEFAULTS: Readonly<Record<string, Category>> = {
  // Rhode Products Section (precedent: 27 existing Rhode products; live siblings)
  mk2270: "Rhode Products Section", mk2271: "Rhode Products Section",
  mk2280: "Rhode Products Section", mk2281: "Rhode Products Section",
  mk2282: "Rhode Products Section", mk2284: "Rhode Products Section",
  mk2285: "Rhode Products Section", mk2286: "Rhode Products Section",
  mk2287: "Rhode Products Section", mk2288: "Rhode Products Section",
  mk2289: "Rhode Products Section", mk2290: "Rhode Products Section",
  mk2291: "Rhode Products Section", mk2292: "Rhode Products Section",
  // Face Care (serum→65, toner→22, cleansing→23; Medicube/Anua siblings)
  mk2241: "Face Care", mk2242: "Face Care", mk2244: "Face Care",
  mk2250: "Face Care", mk2275: "Face Care", mk2278: "Face Care", mk2293: "Face Care",
  // Lashes & Nails (lash→64, nail→112; sibling mk2257)
  mk2255: "Lashes & Nails", mk2256: "Lashes & Nails", mk2258: "Lashes & Nails",
  mk2274: "Lashes & Nails", mk2247: "Lashes & Nails", mk2267: "Lashes & Nails",
  // Hair Care (comb→10, hair mask→10)
  mk2233: "Hair Care", mk2234: "Hair Care", mk2260: "Hair Care",
  mk2240: "Hair Care", mk2277: "Hair Care",
  // Beauty Accessories (hair clip→2; tumbler→7 / mug→5 house pattern)
  mk2269: "Beauty Accessories", mk2273: "Beauty Accessories",
  mk2235: "Beauty Accessories", mk2249: "Beauty Accessories",
  // Makeup (eyebrow→17; powder/concealer unambiguous)
  mk2246: "Makeup", mk2259: "Makeup", mk2252: "Makeup",
  // Women’s Essentials (eau de parfum→10, watch→13)
  mk2248: "Women’s Essentials", mk2251: "Women’s Essentials",
  // Dental Care (teeth→12, whitening strips→2)
  mk2279: "Dental Care",
  // Summer And Camping Supplies (pool→7)
  mk2261: "Summer And Camping Supplies",
};

/** 13 products whose category evidence is genuinely split — owner must pick. */
export const WAVE2_NEEDS_REVIEW: readonly string[] = [
  "mk2236", "mk2253", "mk2243", "mk2238", "mk2254",
  "mk2263", "mk2265", "mk2266", "mk2264", "mk2268",
  "mk2272", "mk2276", "mk2283",
];

/** No fitting category in the taxonomy at all — pure owner call. */
export const WAVE2_UNKNOWN: readonly string[] = ["mk2262"];

/** The 5 availability-only SKUs (category already set at audit time). */
export const WAVE2_AVAILABILITY_ONLY: readonly string[] = [
  "mk2227", "mk2230", "mk2239", "mk2245", "mk2257",
];

/** The full fixed Wave 2 batch (62 SKUs) — progress is tracked over this set. */
export const WAVE2_BATCH_SKUS: readonly string[] = [
  ...Object.keys(WAVE2_SAFE_DEFAULTS),
  ...WAVE2_NEEDS_REVIEW,
  ...WAVE2_UNKNOWN,
  ...WAVE2_AVAILABILITY_ONLY,
];

export type Wave2Seed =
  | { kind: "safe"; category: Category }
  | { kind: "review" }
  | { kind: "unknown" }
  | { kind: "none" };

export function categorySeed(sku: string): Wave2Seed {
  if (Object.hasOwn(WAVE2_SAFE_DEFAULTS, sku)) return { kind: "safe", category: WAVE2_SAFE_DEFAULTS[sku] };
  if (WAVE2_NEEDS_REVIEW.includes(sku)) return { kind: "review" };
  if (WAVE2_UNKNOWN.includes(sku)) return { kind: "unknown" };
  return { kind: "none" };
}

/** A category choice is valid ONLY when it is one of the existing taxonomy values. */
export function isValidCategoryChoice(v: unknown): v is Category {
  return typeof v === "string" && (CATEGORIES as readonly string[]).includes(v);
}

// ── row + view model ─────────────────────────────────────────────────────────

/** Availability choices the operator may make. UNKNOWN is a non-action. */
export const WAVE2_AVAILABILITY_CHOICES = ["in_stock", "out_of_stock", "keep_unknown"] as const;
export type Wave2AvailabilityChoice = (typeof WAVE2_AVAILABILITY_CHOICES)[number];

export interface Wave2Row {
  id: string;
  sku: string;
  nameEn: string | null;
  nameAr: string | null;
  imageUrl: string | null;
  /** current stored category (null/"" = unresolved) */
  category: string | null;
  /** current stored availability text (null = UNKNOWN) */
  availability: string | null;
  /** raw approval text ("Approved" | "Rejected" | "SentAI" | "" | null) */
  approval: string | null;
  lifecycle: string | null;
  /** certified readiness status for THIS row (computed by the caller) */
  readinessStatus: string;
  readyToPublish: boolean;
  variantCount: number;
  price: number | null;
}

export interface Wave2RowView extends Wave2Row {
  seed: Wave2Seed;
  categoryResolved: boolean;
  availabilityResolved: boolean;
  approvalResolved: boolean;
  /** approval may only be offered once the category is resolved */
  approveEligible: boolean;
  /** activation may only be offered to READY (OPS.8) rows still in DRAFT */
  activationEligible: boolean;
  activated: boolean;
}

export interface Wave2Progress {
  categories: { done: number; total: number };
  availability: { done: number; total: number };
  approvals: { done: number; total: number };
  activationReady: number;
  activated: number;
  total: number;
}

const hasText = (v: string | null): boolean => typeof v === "string" && v.trim() !== "";

export function decorateWave2Row(row: Wave2Row): Wave2RowView {
  const seed = categorySeed(row.sku);
  const categoryResolved = hasText(row.category);
  const availabilityResolved = hasText(row.availability);
  const approvalResolved = (row.approval ?? "").trim().toLowerCase() === "approved";
  const activated = (row.lifecycle ?? "").trim().toUpperCase() === "ACTIVE";
  return {
    ...row,
    seed,
    categoryResolved,
    availabilityResolved,
    approvalResolved,
    // Never offer approval while the category is unresolved (and never re-approve).
    approveEligible: categoryResolved && !approvalResolved,
    // OPS.8 rule: only READY products still in DRAFT are activation candidates.
    // The lifecycle boundary re-derives readiness authoritatively on write.
    activationEligible: !activated && row.readyToPublish,
    activated,
  };
}

/** Progress over the FIXED batch: a dimension's total is the rows tracked for it. */
export function wave2Progress(rows: readonly Wave2RowView[]): Wave2Progress {
  const categoryTracked = rows.filter((r) => r.seed.kind !== "none");
  return {
    categories: {
      done: categoryTracked.filter((r) => r.categoryResolved).length,
      total: categoryTracked.length,
    },
    availability: {
      done: rows.filter((r) => r.availabilityResolved).length,
      total: rows.length,
    },
    approvals: {
      done: rows.filter((r) => r.approvalResolved).length,
      total: rows.length,
    },
    activationReady: rows.filter((r) => r.activationEligible).length,
    activated: rows.filter((r) => r.activated).length,
    total: rows.length,
  };
}

// ── filters ──────────────────────────────────────────────────────────────────

export const WAVE2_FILTERS = [
  "all",
  "safe_suggestion",
  "needs_review",
  "unknown_category",
  "availability_unresolved",
  "approval_unresolved",
  "ready_for_activation",
] as const;
export type Wave2Filter = (typeof WAVE2_FILTERS)[number];

export function filterWave2Rows(rows: readonly Wave2RowView[], filter: Wave2Filter): Wave2RowView[] {
  switch (filter) {
    case "safe_suggestion":
      return rows.filter((r) => r.seed.kind === "safe" && !r.categoryResolved);
    case "needs_review":
      return rows.filter((r) => r.seed.kind === "review" && !r.categoryResolved);
    case "unknown_category":
      return rows.filter((r) => r.seed.kind === "unknown" && !r.categoryResolved);
    case "availability_unresolved":
      return rows.filter((r) => !r.availabilityResolved);
    case "approval_unresolved":
      return rows.filter((r) => !r.approvalResolved);
    case "ready_for_activation":
      return rows.filter((r) => r.activationEligible);
    default:
      return [...rows];
  }
}
