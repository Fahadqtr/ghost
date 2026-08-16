import "server-only";
// CH.6F — Missing Products Discovery & Repair orchestrator (SERVER).
//
// Operations:
//   • scanMissingProducts  — READ-ONLY. Loads the internal Catalog, the CH.5 ECL
//     durable identity, and persisted external evidence for ONE storefront, then
//     classifies every unit deterministically (buildGapItems). NO writes, NO AI.
//   • readOnlyGapReport    — READ-ONLY. Runs the scan across every storefront and
//     returns grain-separated counts for owner review (§25). NO writes.
//   • applyEclRepairs      — WRITER-GATED (CH.3b). Re-scans fresh, re-verifies each
//     selected item is STILL a deterministic MISSING_ECL with no conflicting
//     active mapping (stale/duplicate protection), then INSERTs the ECL row
//     through the narrow repair boundary. Audited per item.
//   • importExternalOnly   — WRITER-GATED. Re-reads the identity snapshot
//     (duplicate protection), creates each import-eligible product ONLY through
//     the approved create core + inventory initializer (seed 0), links a durable
//     ECL row, and audits. Operator supplies the category (no fabrication).
//
// Never writes inventory/availability/barcode/images. Never copies channel
// quantity. Never auto-resolves conflicts. Never touches legacy id columns.

import { requireMalakWriter } from "@/lib/malak/authz";
import { isSignedIn } from "@/lib/auth/requireUser";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { insertAuditRow } from "@/lib/audit";
import { safeError } from "@/lib/security/safe-error";
import { CATEGORIES } from "@/lib/constants";
import { loadIdentitySnapshot } from "@/lib/products/catalog-identity-read";
import {
  type StorefrontKey,
  type GapStatus,
  type ApplyOutcome,
  STOREFRONT_KEYS,
  isStorefrontKey,
  channelOf,
} from "./discovery-model.ts";
import {
  buildGapItems,
  summarize,
  planEclRepairs,
  type GapItem,
  type DiscoverySummary,
} from "./discovery-plan.ts";
import {
  loadInternalUnits,
  loadEclRows,
  loadSnapshotEvidence,
  createEmptyExternalListingSource,
  type ExternalListingSource,
  type ExternalSourceState,
} from "./discovery-source.server.ts";
import { writeEclMapping } from "./ecl-repair-write.server.ts";
import { importOneProduct, type ImportCandidate } from "./catalog-import.server.ts";

const NOT_SIGNED_IN = "غير مسجّل الدخول.";
const SCAN_FAILED = "تعذّر فحص المنتجات الناقصة.";
const APPLY_FAILED = "تعذّر تنفيذ الإصلاح.";
const BAD_STOREFRONT = "متجر غير معروف.";
const MAX_ITEMS = 5000; // hard cap on items returned to the browser

// Optional injection point for a live/export external-listing source. Defaults to
// the empty (session_required) source so discovery is safe until a real feed is
// wired at live-activation time.
let externalSourceFactory: (sf: StorefrontKey) => ExternalListingSource = createEmptyExternalListingSource;
export function __setExternalSourceFactory(f: (sf: StorefrontKey) => ExternalListingSource): void {
  externalSourceFactory = f;
}

// ── scan ─────────────────────────────────────────────────────────────────────
export interface ScanFilters {
  status?: GapStatus;
  brand?: string;
  sku?: string;
  grain?: "product" | "variant";
}
export interface ScanProvenance {
  eclDegraded: boolean;
  internalDegraded: boolean;
  snapshotDegraded: boolean;
  snapshotLastCapturedAt: string | null;
  externalSourceState: ExternalSourceState;
}
export interface ScanResult {
  storefront: StorefrontKey;
  items: GapItem[];
  summary: DiscoverySummary;
  matchCount: number;
  capped: boolean;
  provenance: ScanProvenance;
}

function applyFilters(items: readonly GapItem[], f: ScanFilters | undefined): GapItem[] {
  if (!f) return items.slice();
  const skuNeedle = (f.sku ?? "").trim().toLowerCase();
  return items.filter((it) => {
    if (f.status && it.status !== f.status) return false;
    if (f.grain && it.grain !== f.grain) return false;
    if (f.brand && it.brandId !== f.brand) return false;
    if (skuNeedle) {
      const hay = `${it.sku ?? ""} ${it.externalSku ?? ""}`.toLowerCase();
      if (!hay.includes(skuNeedle)) return false;
    }
    return true;
  });
}

async function scanInternal(storefront: StorefrontKey): Promise<
  | { ok: true; items: GapItem[]; summary: DiscoverySummary; provenance: ScanProvenance }
  | { ok: false; error: string }
> {
  const client = createClient();
  const [internal, eclLoad, snap] = await Promise.all([
    loadInternalUnits(client as never, storefront),
    loadEclRows(client as never, storefront),
    loadSnapshotEvidence(client as never, storefront),
  ]);
  const source = externalSourceFactory(storefront);
  const [externalState, externalListings] = await Promise.all([source.state(), source.listListings()]);
  const external = [...snap.evidence, ...externalListings];
  const items = buildGapItems({ storefront, internals: internal.units, ecl: eclLoad.rows, external });
  const summary = summarize(storefront, items);
  return {
    ok: true,
    items,
    summary,
    provenance: {
      eclDegraded: eclLoad.degraded,
      internalDegraded: internal.degraded,
      snapshotDegraded: snap.degraded,
      snapshotLastCapturedAt: snap.lastCapturedAt,
      externalSourceState: externalState,
    },
  };
}

export async function scanMissingProducts(req: { storefront: string; filters?: ScanFilters }): Promise<ScanResult | { error: string }> {
  if (!(await isSignedIn())) return { error: NOT_SIGNED_IN };
  if (!isStorefrontKey(req.storefront)) return { error: BAD_STOREFRONT };
  const storefront = req.storefront;
  try {
    const scan = await scanInternal(storefront);
    if (!scan.ok) return { error: scan.error };
    const filtered = applyFilters(scan.items, req.filters);
    const capped = filtered.length > MAX_ITEMS;
    return {
      storefront,
      items: filtered.slice(0, MAX_ITEMS),
      summary: scan.summary,
      matchCount: filtered.length,
      capped,
      provenance: scan.provenance,
    };
  } catch (e) {
    return { error: safeError("ch6f_scan", e, SCAN_FAILED) };
  }
}

// ── read-only gap report across all storefronts (§25) ────────────────────────
export interface StorefrontReport {
  storefront: StorefrontKey;
  summary: DiscoverySummary;
  provenance: ScanProvenance;
}
export interface GapReport {
  storefronts: StorefrontReport[];
}

export async function readOnlyGapReport(): Promise<GapReport | { error: string }> {
  if (!(await isSignedIn())) return { error: NOT_SIGNED_IN };
  try {
    const storefronts: StorefrontReport[] = [];
    for (const sf of STOREFRONT_KEYS) {
      const scan = await scanInternal(sf);
      if (scan.ok) storefronts.push({ storefront: sf, summary: scan.summary, provenance: scan.provenance });
    }
    return { storefronts };
  } catch (e) {
    return { error: safeError("ch6f_report", e, SCAN_FAILED) };
  }
}

// ── apply: ECL repairs ───────────────────────────────────────────────────────
export interface ApplyItem {
  key: string;
  productId: string | null;
  outcome: ApplyOutcome;
  reason: string;
}
export interface ApplySummary {
  total: number;
  created: number;
  mapped: number;
  unchanged: number;
  skipped: number;
  stale: number;
  failed: number;
  needsReview: number;
}
export interface ApplyResult {
  results: ApplyItem[];
  summary: ApplySummary;
}

function emptySummary(): ApplySummary {
  return { total: 0, created: 0, mapped: 0, unchanged: 0, skipped: 0, stale: 0, failed: 0, needsReview: 0 };
}
function tally(summary: ApplySummary, outcome: ApplyOutcome): void {
  summary.total += 1;
  const key: Record<ApplyOutcome, keyof ApplySummary> = {
    CREATED: "created",
    MAPPED: "mapped",
    UNCHANGED: "unchanged",
    SKIPPED: "skipped",
    STALE: "stale",
    FAILED: "failed",
    NEEDS_REVIEW: "needsReview",
  };
  (summary[key[outcome]] as number) += 1;
}

async function audit(
  admin: ReturnType<typeof createAdminClient>,
  actor: string,
  storefront: StorefrontKey,
  item: { productId: string | null; variantId?: string | null; externalId: string | null; exportedSku?: string | null },
  action: string,
  outcome: ApplyOutcome,
  reason: string,
): Promise<void> {
  const at = new Date().toISOString();
  await insertAuditRow(admin as never, {
    agent: "missing_products",
    action: `ch6f_${action}`,
    action_type: `ch6f_${action}`,
    actor,
    product_id: item.productId,
    status: outcome === "FAILED" ? "failed" : "done",
    details: {
      source: "ch6f_missing_products",
      channel: channelOf(storefront),
      storefront,
      external_identity: item.externalId ?? item.exportedSku ?? null,
      internal_product: item.productId,
      internal_variant: item.variantId ?? null,
      action,
      result: outcome,
      reason,
      at,
    },
  }).catch(() => {});
}

/**
 * Create durable ECL mappings for selected deterministic MISSING_ECL items.
 * Re-scans fresh to defeat stale previews; a colliding/active mapping at apply
 * time yields STALE/UNCHANGED, never an overwrite.
 */
export async function applyEclRepairs(req: { storefront: string; keys: string[] }): Promise<ApplyResult | { error: string }> {
  const writer = await requireMalakWriter();
  if (!writer.ok) return { error: writer.error };
  if (!isStorefrontKey(req.storefront)) return { error: BAD_STOREFRONT };
  const storefront = req.storefront;
  const keys = Array.isArray(req.keys) ? req.keys.filter((k) => typeof k === "string" && k) : [];
  if (keys.length === 0) return { error: "لا توجد عناصر محددة." };

  try {
    const scan = await scanInternal(storefront);
    if (!scan.ok) return { error: APPLY_FAILED };
    const repairable = planEclRepairs(scan.items, keys);
    const repairableByKey = new Map(repairable.map((it) => [it.key, it]));

    const admin = createAdminClient();
    const results: ApplyItem[] = [];
    const summary = emptySummary();

    for (const key of keys) {
      const item = repairableByKey.get(key);
      if (!item || !item.productId) {
        // selected but no longer a deterministic MISSING_ECL → the world changed
        results.push({ key, productId: null, outcome: "STALE", reason: "no_longer_deterministic_missing_ecl" });
        tally(summary, "STALE");
        continue;
      }
      const res = await writeEclMapping(
        admin as never,
        {
          productId: item.productId,
          variantId: item.variantId,
          channelKey: channelOf(storefront),
          storefrontKey: storefront,
          identityType: item.repairIdentityType ?? "",
          externalProductId: item.repairExternalId,
          externalVariantId: null,
          exportedSku: item.repairExportedSku,
          exportedBarcode: item.repairExportedBarcode,
          variantSku: item.repairVariantSku,
        },
        writer.email,
      );
      if (res.ok) {
        results.push({ key, productId: item.productId, outcome: "MAPPED", reason: `matched_by_${item.matchedBy}` });
        tally(summary, "MAPPED");
        await audit(admin, writer.email, storefront, { productId: item.productId, variantId: item.variantId, externalId: item.repairExternalId, exportedSku: item.repairExportedSku }, "create_ecl", "MAPPED", `matched_by_${item.matchedBy}`);
      } else if (res.duplicate) {
        results.push({ key, productId: item.productId, outcome: "UNCHANGED", reason: "mapping_already_exists" });
        tally(summary, "UNCHANGED");
      } else {
        results.push({ key, productId: item.productId, outcome: "FAILED", reason: "write_failed" });
        tally(summary, "FAILED");
      }
    }
    return { results, summary };
  } catch (e) {
    return { error: safeError("ch6f_apply_ecl", e, APPLY_FAILED) };
  }
}

// ── apply: controlled product import ─────────────────────────────────────────
export interface ImportSelection {
  key: string;
  title: string | null;
  sku: string | null;
  barcode: string | null;
  externalId: string | null;
  price: string | null;
}
export interface ImportRequest {
  storefront: string;
  category: string;
  subCategory?: string;
  selections: ImportSelection[];
}

export async function importExternalOnly(req: ImportRequest): Promise<ApplyResult | { error: string }> {
  const writer = await requireMalakWriter();
  if (!writer.ok) return { error: writer.error };
  if (!isStorefrontKey(req.storefront)) return { error: BAD_STOREFRONT };
  const storefront = req.storefront;
  const category = typeof req.category === "string" ? req.category : "";
  if (!(CATEGORIES as readonly string[]).includes(category)) return { error: "اختر تصنيفًا صحيحًا للمنتجات المستوردة." };
  const selections = Array.isArray(req.selections) ? req.selections.filter((s) => s && typeof s.key === "string") : [];
  if (selections.length === 0) return { error: "لا توجد منتجات محددة للاستيراد." };

  try {
    const session = createClient();
    const admin = createAdminClient();
    // duplicate protection — fresh identity snapshot re-read before any create
    const snapshot = await loadIdentitySnapshot(session as never);
    if (snapshot.status !== "ok") return { error: APPLY_FAILED };
    const existingSkus = snapshot.snapshot.skus.slice();
    const existingBarcodes = new Set(snapshot.snapshot.barcodes);

    const results: ApplyItem[] = [];
    const summary = emptySummary();

    for (const sel of selections) {
      const candidate: ImportCandidate = { title: sel.title, sku: sel.sku, barcode: sel.barcode, externalId: sel.externalId, price: sel.price };
      // stale/duplicate: SKU or barcode already present since preview
      const extSku = (sel.sku ?? "").trim().toLowerCase();
      if (extSku && existingSkus.some((s) => s.toLowerCase() === extSku)) {
        results.push({ key: sel.key, productId: null, outcome: "STALE", reason: "sku_now_exists" });
        tally(summary, "STALE");
        continue;
      }
      const one = await importOneProduct(session as never, admin as never, candidate, {
        category,
        subCategory: req.subCategory ?? "",
        existingSkus,
        existingBarcodes,
      });
      if (!one.ok) {
        if (one.duplicate) {
          results.push({ key: sel.key, productId: null, outcome: "STALE", reason: "duplicate_identity" });
          tally(summary, "STALE");
        } else {
          results.push({ key: sel.key, productId: null, outcome: "FAILED", reason: one.error });
          tally(summary, "FAILED");
        }
        continue;
      }
      // keep the local dedup sets fresh so a batch cannot self-collide
      existingSkus.push(one.sku);
      existingBarcodes.add(one.barcode);

      // link a durable ECL mapping to the external identity (best-effort; the
      // product is created either way and re-scan will show MISSING_ECL if this fails)
      const outcome: ApplyOutcome = "CREATED";
      let reason = "imported";
      if (candidate.externalId) {
        const mapping = await writeEclMapping(
          admin as never,
          {
            productId: one.productId,
            variantId: null,
            channelKey: channelOf(storefront),
            storefrontKey: storefront,
            identityType: identityTypeFor(storefront),
            externalProductId: candidate.externalId,
            externalVariantId: null,
            exportedSku: sel.sku,
            exportedBarcode: sel.barcode,
            variantSku: null,
          },
          writer.email,
        );
        if (mapping.ok) reason = "imported_and_mapped";
      }
      results.push({ key: sel.key, productId: one.productId, outcome, reason });
      tally(summary, outcome);
      await audit(admin, writer.email, storefront, { productId: one.productId, externalId: candidate.externalId, exportedSku: sel.sku }, "import_product", outcome, reason);
    }
    return { results, summary };
  } catch (e) {
    return { error: safeError("ch6f_import", e, APPLY_FAILED) };
  }
}

function identityTypeFor(sf: StorefrontKey): string {
  return {
    "shopify:malikas": "shopify_gid",
    "snoonu:malikas": "snoonu_spi",
    "snoonu:pure_seoul": "snoonu_spi",
    "talabat:malikas": "talabat_sku",
    "rafeeq:malikas": "rafeeq_product_id",
  }[sf];
}
