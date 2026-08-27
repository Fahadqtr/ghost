// SNOONU TWO-SOURCE SYNC (PURE) — the FULL catalog workbook and the BULK
// update workbook, joined STRICTLY by SPI.
//
// The two files answer different questions and neither may answer the
// other's. FULL is the catalog: which products Snoonu carries, and their
// approved names/descriptions. BULK is the operational feed: stock, price,
// SKU, barcode for the rows it happens to contain. A row's ABSENCE therefore
// means completely different things in each file — "Snoonu dropped it" in
// FULL, and nothing at all in BULK — which is why BULK can never reach the
// removal path (see SNOONU_COMBINED_AUTHORITY.removal, and the PARTIAL-mode
// guard in sync.server.ts that fails closed on any non-FULL removal).
//
// When both files are present the two disagree about availability sooner or
// later: FULL carries a boolean per store, BULK carries that store's quantity.
// This module NEVER silently picks a winner. Every disagreement is surfaced
// as SNOONU_STOCK_SOURCE_MISMATCH with BOTH readings side by side; BULK is
// what an apply would operationally use, and the plan says so per row rather
// than leaving it implicit.
//
// Pure: no I/O, no wall clock, no randomness — same inputs, same fingerprint.

import { createHash } from "node:crypto";
import {
  planSnoonuSync,
  type SnoonuCanonicalRecord,
  type SnoonuListingRecord,
  type SnoonuSyncPlan,
  type SnoonuSyncRow,
  type SnoonuUpdateField,
} from "./sync.ts";

export type SnoonuSourceKind = "FULL" | "BULK";

export const SNOONU_SOURCE_LABEL: Record<SnoonuSourceKind, string> = {
  FULL: "ملف الكتالوج الكامل (سنونو)",
  BULK: "ملف التحديث الجزئي (Bulk)",
};

// ── authority ────────────────────────────────────────────────────────────────

export type SnoonuAuthorityKey =
  | "catalog_presence" | "removal"
  | "name_en" | "name_ar" | "description_en" | "description_ar"
  | "stock" | "price" | "sku" | "barcode";

/**
 * WHO decides WHAT when BOTH files are present. Frozen data, not scattered
 * conditionals, so the rule is inspectable and testable in one place.
 * With only FULL uploaded, FULL keeps its existing authority over everything
 * it carries; with only BULK uploaded, BULK updates only what it carries and
 * removal stays unreachable.
 */
export const SNOONU_COMBINED_AUTHORITY: Readonly<Record<SnoonuAuthorityKey, SnoonuSourceKind>> =
  Object.freeze({
    catalog_presence: "FULL",
    removal: "FULL",
    name_en: "FULL",
    name_ar: "FULL",
    description_en: "FULL",
    description_ar: "FULL",
    stock: "BULK",
    price: "BULK",
    sku: "BULK",
    barcode: "BULK",
  });

/** BULK may never drive these, whatever a workbook contains. */
export const SNOONU_BULK_FORBIDDEN: readonly SnoonuAuthorityKey[] =
  Object.freeze(["catalog_presence", "removal"] as const);

export const isBulkAuthoritative = (k: SnoonuAuthorityKey): boolean =>
  SNOONU_COMBINED_AUTHORITY[k] === "BULK";

// ── stock-source mismatch ────────────────────────────────────────────────────

export const SNOONU_STOCK_SOURCE_MISMATCH = "SNOONU_STOCK_SOURCE_MISMATCH";
export const SNOONU_STOCK_SOURCE_MISMATCH_AR = "اختلاف حالة التوفر بين ملف الكتالوج وملف Bulk";

/** Owner-facing note: the mismatch is shown, never auto-resolved silently. */
export const SNOONU_STOCK_SOURCE_NOTE =
  "عند رفع الملفين معاً: المخزون التشغيلي يُؤخذ من ملف Bulk، وحالة التوفر في ملف الكتالوج تُستخدم للمقارنة فقط. أي اختلاف يُعرض بالقيمتين قبل التطبيق.";

export type SnoonuStockReading = "IN" | "OUT";

const readingOf = (available: boolean | null): SnoonuStockReading | null =>
  available === null ? null : available ? "IN" : "OUT";

export const stockReadingLabel = (r: SnoonuStockReading | null): string =>
  r === "IN" ? "متوفر" : r === "OUT" ? "غير متوفر" : "غير محدّد";

export interface SnoonuStockSourceMismatch {
  code: typeof SNOONU_STOCK_SOURCE_MISMATCH;
  messageAr: typeof SNOONU_STOCK_SOURCE_MISMATCH_AR;
  spi: string;
  sku: string | null;
  /** what the FULL catalog workbook's availability column says. */
  full: SnoonuStockReading;
  fullLabel: string;
  /** what the BULK workbook's store stock column says. */
  bulk: SnoonuStockReading;
  bulkLabel: string;
  /** which one an apply would use — always BULK, stated explicitly. */
  operational: SnoonuSourceKind;
  operationalValue: SnoonuStockReading;
  fullRowNum: number;
  bulkRowNum: number;
}

/** Per-SPI resolution of availability across the two sources. */
export interface SnoonuStockResolution {
  spi: string;
  full: SnoonuStockReading | null;
  bulk: SnoonuStockReading | null;
  /** the value an apply would use, and where it came from. */
  effective: SnoonuStockReading | null;
  source: SnoonuSourceKind | null;
  agreed: boolean;
  mismatch: boolean;
}

// ── combined plan ────────────────────────────────────────────────────────────

export interface SnoonuCombinedCounts {
  fullRows: number;
  bulkRows: number;
  matchedInBoth: number;
  fullOnly: number;
  bulkOnly: number;
  stockMatches: number;
  stockMismatches: number;
  bulkOutOfStock: number;
  bulkInStock: number;
  availabilityToOut: number;
  availabilityToIn: number;
  priceChanges: number;
  skuChanges: number;
  barcodeChanges: number;
  contentChanges: number;
  newProducts: number;
  removalCandidates: number;
  zeroPriceReviews: number;
  identityCollisions: number;
  conflicts: number;
  blocked: number;
}

export interface SnoonuCombinedPlan {
  /** the catalog half: presence, content, NEW, and the ONLY removal source. */
  full: SnoonuSyncPlan | null;
  /** the operational half — always PARTIAL, so absence can never remove. */
  bulk: SnoonuSyncPlan | null;
  counts: SnoonuCombinedCounts;
  mismatches: SnoonuStockSourceMismatch[];
  resolutions: SnoonuStockResolution[];
  fullOnlySpis: string[];
  bulkOnlySpis: string[];
  /** true once both workbooks are loaded — drives the authority matrix. */
  bothSources: boolean;
  applyBlocked: boolean;
  fingerprint: string;
}

const norm = (spi: string): string => spi.trim().toLowerCase();

/** count rows whose availability moves the canonical value in one direction. */
function directionCounts(plan: SnoonuSyncPlan | null): { toOut: number; toIn: number } {
  if (!plan) return { toOut: 0, toIn: 0 };
  return { toOut: plan.counts.availabilityTrueToFalse, toIn: plan.counts.availabilityFalseToTrue };
}

/**
 * Build the combined READ-ONLY preview.
 *
 * FULL is planned in FULL mode (removals reachable); BULK is planned in
 * PARTIAL mode, which the server-side guard independently re-asserts, so a
 * BULK row's absence cannot archive or stop anything. Nothing here writes.
 */
export function planSnoonuCombined(input: {
  full: { rows: readonly SnoonuSyncRow[]; emptySpiRows: readonly number[] } | null;
  bulk: { rows: readonly SnoonuSyncRow[]; emptySpiRows: readonly number[] } | null;
  canonical: readonly SnoonuCanonicalRecord[];
  listings: readonly SnoonuListingRecord[];
}): SnoonuCombinedPlan {
  const fullPlan = input.full
    ? planSnoonuSync({ mode: "FULL", rows: input.full.rows, emptySpiRows: input.full.emptySpiRows,
        canonical: input.canonical, listings: input.listings })
    : null;
  const bulkPlan = input.bulk
    ? planSnoonuSync({ mode: "PARTIAL", rows: input.bulk.rows, emptySpiRows: input.bulk.emptySpiRows,
        canonical: input.canonical, listings: input.listings })
    : null;

  const bothSources = Boolean(input.full && input.bulk);

  // STRICT SPI join — no name, SKU or barcode ever participates in matching.
  const fullBySpi = new Map<string, SnoonuSyncRow>();
  for (const r of input.full?.rows ?? []) if (r.spi) fullBySpi.set(norm(r.spi), r);
  const bulkBySpi = new Map<string, SnoonuSyncRow>();
  for (const r of input.bulk?.rows ?? []) if (r.spi) bulkBySpi.set(norm(r.spi), r);

  const allSpis = [...new Set([...fullBySpi.keys(), ...bulkBySpi.keys()])].sort();
  const resolutions: SnoonuStockResolution[] = [];
  const mismatches: SnoonuStockSourceMismatch[] = [];
  const fullOnlySpis: string[] = [];
  const bulkOnlySpis: string[] = [];
  let matchedInBoth = 0;
  let stockMatches = 0;

  for (const spi of allSpis) {
    const f = fullBySpi.get(spi);
    const b = bulkBySpi.get(spi);
    if (f && !b) fullOnlySpis.push(spi);
    if (b && !f) bulkOnlySpis.push(spi);
    if (f && b) matchedInBoth += 1;

    const fullRead = f ? readingOf(f.availability) : null;
    // BULK's own stock column reading — never its (derived) availability alias.
    const bulkRead = b ? b.stockState : null;
    const effective = bulkRead ?? fullRead;
    const source: SnoonuSourceKind | null = bulkRead !== null ? "BULK" : fullRead !== null ? "FULL" : null;
    const comparable = fullRead !== null && bulkRead !== null;
    const agreed = comparable && fullRead === bulkRead;
    const mismatch = comparable && fullRead !== bulkRead;
    if (agreed) stockMatches += 1;

    resolutions.push({ spi, full: fullRead, bulk: bulkRead, effective, source, agreed, mismatch });

    if (mismatch && f && b) {
      mismatches.push({
        code: SNOONU_STOCK_SOURCE_MISMATCH,
        messageAr: SNOONU_STOCK_SOURCE_MISMATCH_AR,
        spi,
        sku: b.sku ?? f.sku ?? null,
        full: fullRead as SnoonuStockReading,
        fullLabel: stockReadingLabel(fullRead),
        bulk: bulkRead as SnoonuStockReading,
        bulkLabel: stockReadingLabel(bulkRead),
        operational: "BULK",
        operationalValue: bulkRead as SnoonuStockReading,
        fullRowNum: f.rowNum,
        bulkRowNum: b.rowNum,
      });
    }
  }

  // Operational direction counts come from whichever plan owns stock:
  // BULK when it exists, otherwise FULL. Never both (that would double-count).
  const dir = directionCounts(bulkPlan ?? fullPlan);
  const operational = bulkPlan ?? fullPlan;

  const counts: SnoonuCombinedCounts = {
    fullRows: input.full?.rows.length ?? 0,
    bulkRows: input.bulk?.rows.length ?? 0,
    matchedInBoth,
    fullOnly: fullOnlySpis.length,
    bulkOnly: bulkOnlySpis.length,
    stockMatches,
    stockMismatches: mismatches.length,
    bulkOutOfStock: (input.bulk?.rows ?? []).filter((r) => r.stockState === "OUT").length,
    bulkInStock: (input.bulk?.rows ?? []).filter((r) => r.stockState === "IN").length,
    availabilityToOut: dir.toOut,
    availabilityToIn: dir.toIn,
    // operational identifiers/price follow the BULK-authoritative plan.
    priceChanges: operational?.counts.priceChanges ?? 0,
    skuChanges: operational?.counts.skuChanges ?? 0,
    barcodeChanges: operational?.counts.barcodeChanges ?? 0,
    // catalog content is FULL's alone.
    contentChanges: fullPlan?.counts.contentChanges ?? 0,
    newProducts: fullPlan?.counts.newProducts ?? 0,
    // HARD RULE: removal candidates come from FULL and ONLY from FULL.
    removalCandidates: fullPlan?.counts.removedFromSnoonu ?? 0,
    zeroPriceReviews: (fullPlan?.counts.zeroPriceReviews ?? 0) + (bulkPlan?.counts.zeroPriceReviews ?? 0),
    identityCollisions: (fullPlan?.counts.identityCollisions ?? 0) + (bulkPlan?.counts.identityCollisions ?? 0),
    conflicts: (fullPlan?.counts.conflicts ?? 0) + (bulkPlan?.counts.conflicts ?? 0),
    blocked: (fullPlan?.counts.blocked ?? 0) + (bulkPlan?.counts.blocked ?? 0),
  };

  const hash = createHash("sha256");
  hash.write(JSON.stringify({
    bothSources,
    counts,
    full: fullPlan?.fingerprint ?? null,
    bulk: bulkPlan?.fingerprint ?? null,
    mismatches: mismatches.map((m) => [m.spi, m.full, m.bulk]),
  }));

  return {
    full: fullPlan,
    bulk: bulkPlan,
    counts,
    mismatches,
    resolutions,
    fullOnlySpis,
    bulkOnlySpis,
    bothSources,
    applyBlocked: Boolean(fullPlan?.applyBlocked) || Boolean(bulkPlan?.applyBlocked),
    fingerprint: hash.digest("hex"),
  };
}

// ── operational apply (BULK-authoritative) ───────────────────────────────────

/**
 * The ONLY fields the combined apply may write. FULL's catalog content —
 * names, descriptions — is deliberately absent: the combined apply is an
 * OPERATIONAL run, and content stays with the FULL apply path where the owner
 * reviews it separately.
 */
export const SNOONU_OPERATIONAL_FIELDS: readonly SnoonuUpdateField[] =
  Object.freeze(["availability", "price", "sku", "barcode"] as const);

/** Content fields the combined apply must NEVER write, whatever BULK carries. */
export const SNOONU_CONTENT_FIELDS: readonly SnoonuUpdateField[] =
  Object.freeze(["name_en", "name_ar", "description_en", "description_ar"] as const);

export const isOperationalField = (f: SnoonuUpdateField): boolean =>
  (SNOONU_OPERATIONAL_FIELDS as readonly string[]).includes(f);

export interface SnoonuOperationalRow {
  spi: string;
  productId: string;
  productSku: string;
  displayName: string;
  /** the canonical availability this row moves to, or null when unchanged. */
  stockTo: "In Stock" | "Out of Stock" | null;
  price: number | null;
  sku: string | null;
  barcode: string | null;
}

export interface SnoonuOperationalCounts {
  stockToOut: number;
  stockToIn: number;
  priceChanges: number;
  skuChanges: number;
  barcodeChanges: number;
  blockedZeroPrice: number;
  blockedIdentityCollisions: number;
  /** structurally always 0 — BULK is PARTIAL and absence means nothing. */
  removals: number;
  rows: number;
}

export interface SnoonuOperationalPlan {
  rows: SnoonuOperationalRow[];
  counts: SnoonuOperationalCounts;
  /** held back for an explicit per-row owner decision — never auto-applied. */
  blockedZeroPrice: SnoonuSyncPlan["zeroPriceReviews"];
  /** never resolved automatically: no identifier is written for these. */
  blockedIdentityCollisions: SnoonuSyncPlan["identityCollisions"];
  applyBlocked: boolean;
  /** the fingerprint the owner confirms; apply refuses anything else. */
  fingerprint: string;
}

const EMPTY_OPERATIONAL: SnoonuOperationalPlan = {
  rows: [],
  counts: { stockToOut: 0, stockToIn: 0, priceChanges: 0, skuChanges: 0, barcodeChanges: 0,
    blockedZeroPrice: 0, blockedIdentityCollisions: 0, removals: 0, rows: 0 },
  blockedZeroPrice: [],
  blockedIdentityCollisions: [],
  applyBlocked: false,
  fingerprint: "",
};

/**
 * Derive the operational apply from a combined preview.
 *
 * Source of truth is the BULK plan and nothing else — no FULL row reaches
 * this. Within BULK, only the four operational fields survive; content
 * changes are dropped even when the BULK workbook carries name columns (it
 * does). NEW products are ignored entirely: the combined apply never creates.
 * Removals cannot appear — BULK is planned PARTIAL — and the count is
 * asserted here as well as in the server guard.
 */
export function selectSnoonuOperationalApply(combined: SnoonuCombinedPlan): SnoonuOperationalPlan {
  const bulk = combined.bulk;
  if (!bulk) return EMPTY_OPERATIONAL;

  const rows: SnoonuOperationalRow[] = [];
  let stockToOut = 0, stockToIn = 0, priceChanges = 0, skuChanges = 0, barcodeChanges = 0;

  for (const m of bulk.matched) {
    // content is dropped HERE, not merely unused downstream.
    const ops = m.changes.filter((c) => isOperationalField(c.field));
    if (ops.length === 0) continue;
    const row: SnoonuOperationalRow = {
      spi: m.spi, productId: m.productId, productSku: m.productSku, displayName: m.displayName,
      stockTo: null, price: null, sku: null, barcode: null,
    };
    for (const c of ops) {
      if (c.field === "availability") {
        row.stockTo = c.to === "In Stock" ? "In Stock" : "Out of Stock";
        if (row.stockTo === "In Stock") stockToIn += 1; else stockToOut += 1;
      } else if (c.field === "price") {
        row.price = Number(c.to);
        priceChanges += 1;
      } else if (c.field === "sku") {
        row.sku = c.to;
        skuChanges += 1;
      } else if (c.field === "barcode") {
        row.barcode = c.to;
        barcodeChanges += 1;
      }
    }
    rows.push(row);
  }

  const counts: SnoonuOperationalCounts = {
    stockToOut, stockToIn, priceChanges, skuChanges, barcodeChanges,
    blockedZeroPrice: bulk.zeroPriceReviews.length,
    blockedIdentityCollisions: bulk.identityCollisions.length,
    removals: bulk.removals.length, // PARTIAL ⇒ structurally 0
    rows: rows.length,
  };

  const hash = createHash("sha256");
  hash.write(JSON.stringify({
    kind: "SNOONU_OPERATIONAL_APPLY",
    bulk: bulk.fingerprint,
    counts,
    rows: rows.map((r) => [r.spi, r.productId, r.stockTo, r.price, r.sku, r.barcode]),
  }));

  return {
    rows,
    counts,
    blockedZeroPrice: bulk.zeroPriceReviews,
    blockedIdentityCollisions: bulk.identityCollisions,
    applyBlocked: bulk.applyBlocked,
    fingerprint: hash.digest("hex"),
  };
}
