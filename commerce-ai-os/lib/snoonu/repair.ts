// SNOONU SCOPED REPAIR (PURE) — the five operations that failed during the
// previous FULL apply, and NOTHING else.
//
// This is deliberately NOT part of the sync apply path: it plans and executes
// only `external_channel_listings` changes for an explicit, owner-authorized
// list of operations. It can never write product content, price, stock
// status, SKU, barcode, category or lifecycle, and it can never create a
// product — the executor has no such code path at all.
//
// Authorization is DATA, not behavior: SNOONU_REPAIR_SCOPE is the owner's
// approved list (SKU + expected SPI + expected current listing). Any row not
// in it is unreachable; any row whose live state no longer matches its
// preconditions is BLOCKED, never mutated.

import { createHash } from "node:crypto";
import { spiLike } from "./sync.ts";

export type SnoonuRepairType = "RECONCILE_PLACEHOLDER" | "ARCHIVE_LISTING";

export interface SnoonuRepairScopeItem {
  /** canonical SKU — the owner's authorization key. */
  sku: string;
  type: SnoonuRepairType;
  /** the real Snoonu SPI this product must end up mapped to (RECONCILE), or
   *  the SPI of the listing to archive (ARCHIVE). */
  spi: string;
  /** RECONCILE only: the legacy placeholder external id expected right now. */
  expectedPlaceholder?: string;
  /** ARCHIVE only: the lifecycle the product must still be in. */
  expectedLifecycle?: string;
}

/**
 * THE AUTHORIZED SCOPE (owner decision, 2026-08-27): four placeholder→SPI
 * upgrades plus one listing archive. Values were read from production and the
 * Snoonu catalog workbook — nothing here is inferred.
 */
export const SNOONU_REPAIR_SCOPE: readonly SnoonuRepairScopeItem[] = Object.freeze([
  { sku: "mk2227", type: "RECONCILE_PLACEHOLDER", spi: "6a57c01e6e3fce9a0bd125ee", expectedPlaceholder: "mk2227" },
  { sku: "mk2229", type: "RECONCILE_PLACEHOLDER", spi: "6a5a60ab193c4fa181b7ea99", expectedPlaceholder: "mk2229" },
  { sku: "mk2230", type: "RECONCILE_PLACEHOLDER", spi: "6a5a9d8c2e0de5839aba04d5", expectedPlaceholder: "mk2230" },
  { sku: "mk2231", type: "RECONCILE_PLACEHOLDER", spi: "6a5b65f76e3fce9a0b0f4e8a", expectedPlaceholder: "mk2231" },
  { sku: "mk2025", type: "ARCHIVE_LISTING", spi: "6a15b1339e48caf4ff58425b", expectedLifecycle: "DRAFT" },
]);

export const isAuthorizedRepairSku = (sku: string): boolean =>
  SNOONU_REPAIR_SCOPE.some((s) => s.sku === sku);

// ── live state (read-only input) ─────────────────────────────────────────────

export interface SnoonuRepairLiveListing {
  id: string;
  externalId: string;
  mappingStatus: string;
  variantGrain: boolean;
}

export interface SnoonuRepairLiveProduct {
  sku: string;
  productId: string;
  lifecycleState: string;
  listings: SnoonuRepairLiveListing[];
}

// ── plan ─────────────────────────────────────────────────────────────────────

export type SnoonuRepairStatus = "eligible" | "already_repaired" | "blocked";

export interface SnoonuRepairRow {
  sku: string;
  type: SnoonuRepairType;
  spi: string;
  status: SnoonuRepairStatus;
  reason: string | null;
  productId: string | null;
  lifecycleBefore: string | null;
  /** the listing row this repair would touch (never more than one). */
  listingId: string | null;
  beforeExternalId: string | null;
  beforeMappingStatus: string | null;
  afterExternalId: string | null;
  afterMappingStatus: string | null;
  /** true for every row: repairs never write a products row. */
  productRowChanges: false;
}

export interface SnoonuRepairPlanResult {
  rows: SnoonuRepairRow[];
  eligible: number;
  blocked: number;
  alreadyRepaired: number;
  fingerprint: string;
}

const NO_PRODUCT = "المنتج غير موجود في الكتالوج";
const NO_LISTING = "لا يوجد ربط سنونو نشط لهذا المنتج";
const MULTI = "أكثر من ربط سنونو نشط — يحتاج مراجعة يدوية";
const CONFLICT_SPI = "يوجد ربط SPI حقيقي مختلف — لا إصلاح تلقائي";
const PLACEHOLDER_MISMATCH = "الربط القديم المتوقع لم يعد موجوداً";
const LIFECYCLE_MISMATCH = "حالة دورة الحياة تغيّرت عن المتوقع";

function planOne(item: SnoonuRepairScopeItem, live: SnoonuRepairLiveProduct | undefined): SnoonuRepairRow {
  const base = {
    sku: item.sku,
    type: item.type,
    spi: item.spi,
    productId: live?.productId ?? null,
    lifecycleBefore: live?.lifecycleState ?? null,
    listingId: null as string | null,
    beforeExternalId: null as string | null,
    beforeMappingStatus: null as string | null,
    afterExternalId: null as string | null,
    afterMappingStatus: null as string | null,
    productRowChanges: false as const,
  };
  if (!live) return { ...base, status: "blocked", reason: NO_PRODUCT };

  const active = live.listings.filter((l) => l.mappingStatus === "active" && !l.variantGrain);

  if (item.type === "RECONCILE_PLACEHOLDER") {
    // already done? the real SPI is live on this product.
    const done = active.find((l) => l.externalId.toLowerCase() === item.spi.toLowerCase());
    if (done) {
      return { ...base, status: "already_repaired", reason: "الربط يحمل SPI الصحيح بالفعل", listingId: done.id,
        beforeExternalId: done.externalId, beforeMappingStatus: done.mappingStatus,
        afterExternalId: done.externalId, afterMappingStatus: done.mappingStatus };
    }
    if (active.length === 0) return { ...base, status: "blocked", reason: NO_LISTING };
    if (active.length > 1) return { ...base, status: "blocked", reason: MULTI };
    const only = active[0];
    if (spiLike(only.externalId)) return { ...base, status: "blocked", reason: CONFLICT_SPI, listingId: only.id, beforeExternalId: only.externalId, beforeMappingStatus: only.mappingStatus };
    if (only.externalId !== item.expectedPlaceholder) {
      return { ...base, status: "blocked", reason: PLACEHOLDER_MISMATCH, listingId: only.id, beforeExternalId: only.externalId, beforeMappingStatus: only.mappingStatus };
    }
    return {
      ...base, status: "eligible", reason: null, listingId: only.id,
      beforeExternalId: only.externalId, beforeMappingStatus: only.mappingStatus,
      afterExternalId: item.spi, afterMappingStatus: "active",
    };
  }

  // ARCHIVE_LISTING — the listing goes away; the product keeps its lifecycle.
  if (item.expectedLifecycle && live.lifecycleState !== item.expectedLifecycle) {
    return { ...base, status: "blocked", reason: LIFECYCLE_MISMATCH };
  }
  const target = active.find((l) => l.externalId.toLowerCase() === item.spi.toLowerCase());
  if (!target) {
    const archived = live.listings.find((l) => l.externalId.toLowerCase() === item.spi.toLowerCase());
    if (archived) {
      return { ...base, status: "already_repaired", reason: "الربط مؤرشف بالفعل", listingId: archived.id,
        beforeExternalId: archived.externalId, beforeMappingStatus: archived.mappingStatus,
        afterExternalId: archived.externalId, afterMappingStatus: archived.mappingStatus };
    }
    return { ...base, status: "blocked", reason: NO_LISTING };
  }
  return {
    ...base, status: "eligible", reason: null, listingId: target.id,
    beforeExternalId: target.externalId, beforeMappingStatus: target.mappingStatus,
    afterExternalId: target.externalId, afterMappingStatus: "archived",
  };
}

/** Plan the authorized repairs against live state. Pure — no I/O, no writes. */
export function planSnoonuRepair(live: readonly SnoonuRepairLiveProduct[]): SnoonuRepairPlanResult {
  const bySku = new Map(live.map((p) => [p.sku, p]));
  const rows = SNOONU_REPAIR_SCOPE.map((item) => planOne(item, bySku.get(item.sku)));
  const hash = createHash("sha256");
  hash.write(JSON.stringify(rows.map((r) => [r.sku, r.status, r.listingId, r.beforeExternalId, r.beforeMappingStatus, r.afterExternalId, r.afterMappingStatus, r.lifecycleBefore])));
  return {
    rows,
    eligible: rows.filter((r) => r.status === "eligible").length,
    blocked: rows.filter((r) => r.status === "blocked").length,
    alreadyRepaired: rows.filter((r) => r.status === "already_repaired").length,
    fingerprint: hash.digest("hex"),
  };
}
