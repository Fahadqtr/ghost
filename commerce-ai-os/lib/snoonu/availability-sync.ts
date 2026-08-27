// SNOONU AVAILABILITY SYNC (PURE) — membership decides availability.
//
// FINAL BUSINESS RULE (owner decision, supersedes the numeric-stock model):
//
//   FULL workbook  = the complete Snoonu catalog universe.
//   BULK workbook  = the currently selected OUT OF STOCK set.
//   SPI            = the only identity key.
//
//   SPI in FULL and in BULK      ⇒ Out of Stock
//   SPI in FULL and NOT in BULK  ⇒ In Stock
//
// Nothing else is consulted. Snoonu requires arbitrary stock numbers for its
// own operational reasons, so quantities, 0, "unavailable" and the FULL
// availability boolean are ALL non-authoritative here and are deliberately
// never read — membership in the BULK file is the entire signal.
//
// Pure: no I/O, no wall clock, no randomness — same inputs, same fingerprint.

import { createHash } from "node:crypto";
import type { SnoonuCanonicalRecord, SnoonuListingRecord, SnoonuSyncRow } from "./sync.ts";

export const AVAILABLE = "In Stock";
export const UNAVAILABLE = "Out of Stock";
export type SnoonuAvailabilityState = typeof AVAILABLE | typeof UNAVAILABLE;

/** The rule, in the owner's words — rendered verbatim on the page. */
export const SNOONU_AVAILABILITY_RULE_AR = [
  "القاعدة المعتمدة:",
  "المنتج الموجود في ملف Bulk = غير متوفر",
  "المنتج الموجود في ملف الكتالوج وغير موجود في Bulk = متوفر",
  "لا يتم استخدام أرقام المخزون نهائياً.",
].join("\n");

export type SnoonuAvailabilityBlockReason = "BULK_ONLY" | "UNMAPPED" | "DUPLICATE_SPI";

export const SNOONU_AVAILABILITY_BLOCK_AR: Record<SnoonuAvailabilityBlockReason, string> = {
  BULK_ONLY: "SPI موجود في ملف Bulk فقط — غير موجود في ملف الكتالوج (مراجعة يدوية)",
  UNMAPPED: "SPI غير مرتبط بأي منتج في الكتالوج الداخلي (مراجعة يدوية)",
  DUPLICATE_SPI: "SPI مكرر داخل الملف — التطبيق محظور حتى يُصلَح الملف",
};

export interface SnoonuAvailabilityRow {
  spi: string;
  productId: string;
  productSku: string;
  displayName: string;
  /** what membership says this product's availability must become. */
  target: SnoonuAvailabilityState;
  /** the canonical value today ("In Stock" / "Out of Stock" / null). */
  current: string | null;
  /** false when the product is already in the target state. */
  changed: boolean;
}

export interface SnoonuAvailabilityBlocked {
  spi: string;
  reason: SnoonuAvailabilityBlockReason;
  messageAr: string;
}

export interface SnoonuAvailabilityCounts {
  fullRows: number;
  bulkRows: number;
  matchedSpi: number;
  fullOnly: number;
  bulkOnly: number;
  /** the census the rule produces over FULL. */
  outOfStock: number;
  inStock: number;
  /** what an apply would actually change. */
  changingToOut: number;
  changingToIn: number;
  unchanged: number;
  blocked: number;
  conflicts: number;
  /** structurally zero on this page — stated so the owner can see it. */
  removals: 0;
  contentChanges: 0;
  priceChanges: 0;
  skuChanges: 0;
  barcodeChanges: 0;
}

export interface SnoonuAvailabilityPlan {
  rows: SnoonuAvailabilityRow[];
  blocked: SnoonuAvailabilityBlocked[];
  counts: SnoonuAvailabilityCounts;
  duplicateSpis: string[];
  applyBlocked: boolean;
  fingerprint: string;
}

const norm = (s: string): string => s.trim().toLowerCase();

/** SPIs appearing more than once in a workbook — these block the whole apply. */
function duplicatesOf(rows: readonly SnoonuSyncRow[]): string[] {
  const seen = new Set<string>();
  const dup = new Set<string>();
  for (const r of rows) {
    if (!r.spi) continue;
    const k = norm(r.spi);
    if (seen.has(k)) dup.add(k); else seen.add(k);
  }
  return [...dup].sort();
}

/**
 * Build the READ-ONLY availability plan.
 *
 * Only ACTIVE product-grain Snoonu listings participate, so an archived or
 * variant-grain mapping can never be driven from here. A FULL SPI with no
 * such mapping is BLOCKED for manual review rather than guessed at, and a
 * BULK-only SPI is blocked too: it claims a product the catalog universe
 * does not contain, which is a data question, not an availability one.
 */
export function planSnoonuAvailability(input: {
  full: readonly SnoonuSyncRow[];
  bulk: readonly SnoonuSyncRow[];
  canonical: readonly SnoonuCanonicalRecord[];
  listings: readonly SnoonuListingRecord[];
}): SnoonuAvailabilityPlan {
  const canonicalById = new Map(input.canonical.map((c) => [c.id, c]));
  const productBySpi = new Map<string, SnoonuCanonicalRecord>();
  for (const l of input.listings) {
    if (l.mappingStatus !== "active" || l.variantGrain) continue;
    const p = canonicalById.get(l.productId);
    if (p) productBySpi.set(norm(l.externalId), p);
  }

  const fullSpis: string[] = [];
  const fullSeen = new Set<string>();
  for (const r of input.full) {
    if (!r.spi) continue;
    const k = norm(r.spi);
    if (!fullSeen.has(k)) { fullSeen.add(k); fullSpis.push(k); }
  }
  // membership is the ENTIRE availability signal — no cell value is read.
  const bulkSet = new Set(input.bulk.filter((r) => r.spi).map((r) => norm(r.spi)));

  const rows: SnoonuAvailabilityRow[] = [];
  const blocked: SnoonuAvailabilityBlocked[] = [];
  let matchedSpi = 0;

  for (const spi of fullSpis) {
    const inBulk = bulkSet.has(spi);
    if (inBulk) matchedSpi += 1;
    const product = productBySpi.get(spi);
    if (!product) {
      blocked.push({ spi, reason: "UNMAPPED", messageAr: SNOONU_AVAILABILITY_BLOCK_AR.UNMAPPED });
      continue;
    }
    const target: SnoonuAvailabilityState = inBulk ? UNAVAILABLE : AVAILABLE;
    rows.push({
      spi,
      productId: product.id,
      productSku: product.sku,
      displayName: product.nameEn ?? product.nameAr ?? product.sku,
      target,
      current: product.stockStatus,
      changed: product.stockStatus !== target,
    });
  }

  // a BULK SPI absent from FULL is a review item — never an availability write.
  for (const spi of bulkSet) {
    if (!fullSeen.has(spi)) {
      blocked.push({ spi, reason: "BULK_ONLY", messageAr: SNOONU_AVAILABILITY_BLOCK_AR.BULK_ONLY });
    }
  }

  const duplicateSpis = [...new Set([...duplicatesOf(input.full), ...duplicatesOf(input.bulk)])].sort();
  for (const spi of duplicateSpis) {
    blocked.push({ spi, reason: "DUPLICATE_SPI", messageAr: SNOONU_AVAILABILITY_BLOCK_AR.DUPLICATE_SPI });
  }

  const outRows = rows.filter((r) => r.target === UNAVAILABLE);
  const inRows = rows.filter((r) => r.target === AVAILABLE);
  const counts: SnoonuAvailabilityCounts = {
    fullRows: input.full.length,
    bulkRows: input.bulk.length,
    matchedSpi,
    fullOnly: fullSpis.filter((s) => !bulkSet.has(s)).length,
    bulkOnly: [...bulkSet].filter((s) => !fullSeen.has(s)).length,
    outOfStock: outRows.length,
    inStock: inRows.length,
    changingToOut: outRows.filter((r) => r.changed).length,
    changingToIn: inRows.filter((r) => r.changed).length,
    unchanged: rows.filter((r) => !r.changed).length,
    blocked: blocked.length,
    conflicts: blocked.filter((b) => b.reason !== "DUPLICATE_SPI").length,
    removals: 0,
    contentChanges: 0,
    priceChanges: 0,
    skuChanges: 0,
    barcodeChanges: 0,
  };

  const hash = createHash("sha256");
  hash.write(JSON.stringify({
    kind: "SNOONU_AVAILABILITY_SYNC",
    counts,
    rows: rows.filter((r) => r.changed).map((r) => [r.spi, r.productId, r.target]),
    blocked: blocked.map((b) => [b.spi, b.reason]),
    duplicateSpis,
  }));

  return {
    rows,
    blocked,
    counts,
    duplicateSpis,
    applyBlocked: duplicateSpis.length > 0,
    fingerprint: hash.digest("hex"),
  };
}

/** The product ids an apply would move, grouped by target state. */
export function selectAvailabilityWrites(plan: SnoonuAvailabilityPlan): {
  toUnavailable: string[];
  toAvailable: string[];
} {
  return {
    toUnavailable: plan.rows.filter((r) => r.changed && r.target === UNAVAILABLE).map((r) => r.productId),
    toAvailable: plan.rows.filter((r) => r.changed && r.target === AVAILABLE).map((r) => r.productId),
  };
}
