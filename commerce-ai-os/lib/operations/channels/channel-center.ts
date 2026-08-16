// OPS.3 — Channel Command Center composer (PURE).
//
// The Command Center is an ORCHESTRATION layer: it performs NO reads and NO
// writes. It is a pure projection over the SAME aggregates the /v2/operations
// page already computes (DashboardKpis, PlatformOverview, PlatformHealth[], the
// annotated item list) plus the durable Storefront registry (CH.5). From those it
// derives storefront-first health cards, per-storefront detail, a unified alert
// feed, filtered queues, recent-activity, filter options and quick-action links —
// every count comes from data already in memory, so the dashboard needs no extra
// per-card scan (§17). It duplicates NO channel business logic: mapping numbers
// reuse the platform overview, freshness reuses platform health, storefront
// identity/grain reuse the CH.5 registry, and every mutation is delegated to an
// EXISTING workflow by link only (§15/§16).
//
// PURE: the only import is the pure CH.5 storefront registry (a relative import,
// not `@/`). No server-only, no DB, no React, no next — node:test loads it
// directly. A dedicated guard test proves the no-IO / no-write / storefront-
// isolation / links-only invariants.

import { STOREFRONTS, type Storefront } from "../../channels/storefronts.ts";

// ── input shapes (structural SUBSETS of the existing dashboard types, so the
//     page passes its kpis / platformOverview / platformHealth / items directly) ─
export interface CcKpis {
  totalProducts: number;
  needsImage: number;
  needsReview: number;
  ready: number;
  readinessAverage: number;
}
export interface CcShopify {
  available: boolean;
  published: number;
  missing: number;
  different: number;
  reviewRequired: number;
  stale: boolean;
  lastCapturedAt: string | null;
}
export interface CcPuresoul {
  available: boolean;
  published: number;
  missing: number;
  priceDifferent: number;
  reviewRequired: number;
  outOfStock: number;
  stale: boolean;
  lastCapturedAt: string | null;
}
export interface CcTalabat {
  available: boolean;
  present: number;
  missing: number;
  review: number;
  linked: number;
  stale: boolean;
  lastCapturedAt: string | null;
}
export interface CcRafeeq {
  available: boolean;
  present: number;
  missing: number;
  linked: number;
  stale: boolean;
  lastCapturedAt: string | null;
}
export interface CcOverview {
  shopify: CcShopify;
  puresoul: CcPuresoul;
  talabat: CcTalabat;
  rafeeq: CcRafeeq;
}

export type FreshnessLite = "fresh" | "aging" | "stale" | "unknown";
export type HealthLevelLite = "healthy" | "needs_attention" | "insufficient_data";
export interface CcHealthLite {
  platform: string;
  freshnessState: FreshnessLite;
  healthLevel: HealthLevelLite;
  reasons: readonly string[];
}

/** A per-product row (structural subset of OperationsListItem) — carries only what
 *  the Command Center's queues / alerts / search / filters need. */
export interface CcItem {
  id: string;
  sku: string | null;
  barcode: string | null;
  nameAr: string | null;
  nameEn: string | null;
  brandId: string | null;
  category: string | null;
  readinessPercent: number;
  needsImage: boolean;
  needsReview: boolean;
  reasons: readonly string[];
  /** Shopify verdict for this product (from platforms[].shopify.status), or null. */
  shopifyStatus: string | null;
  puresoulState?: string;
  talabatState?: string;
  rafeeqState?: string;
}

/** Per-channel read-degradation flags (a read FAILED — never "missing"). */
export interface CcDegraded {
  puresoul: boolean;
  talabat: boolean;
  rafeeq: boolean;
}

export interface ChannelCenterInput {
  kpis: CcKpis;
  overview: CcOverview;
  platformHealth: readonly CcHealthLite[];
  items: readonly CcItem[];
  degraded: CcDegraded;
  /** Whether a live snoonu:malikas presence/snapshot reader is wired. The
   *  dashboard has NONE (CH.CERT operational note) — snoonu:malikas therefore
   *  stays OPERATIONALLY_BLOCKED here, never reported as "missing". Default false. */
  snoonuMalikasReaderAvailable?: boolean;
  /** Optional, evidence-only Rafeeq conflict (needs_review) count. The dashboard
   *  has no cheap live source for it, so it defaults to undefined — the Rafeeq
   *  conflict review is then a workflow ENTRY-POINT queue (count computed inside
   *  CH.6F), never a fabricated alert. */
  rafeeqConflicts?: number;
}

// ── existing workflow routes (OPS.3 introduces NO parallel screen — every href
//     targets a screen that already exists) ──────────────────────────────────────
export const ROUTES = {
  catalog: "/v2/catalog",
  shopifyCatalog: "/v2/catalog/shopify",
  operations: "/v2/operations",
  channels: "/v2/operations/channels",
  missingProducts: "/v2/operations/missing-products",
  media: "/v2/operations/media",
  aiEnrichment: "/v2/operations/ai-enrichment",
  barcodeCompletion: "/v2/operations/barcode-completion",
  availabilitySync: "/v2/operations/availability-sync",
} as const;

/** A storefront-scoped deep link into the CH.6F missing-products workflow. The
 *  storefront + status params are consumed by that workflow (never resolved here);
 *  OPS.3 only hands off. Status values mirror CH.6F GapStatus (asserted by a test). */
function missingProductsLink(storefrontKey: string, status?: string): string {
  const q = status
    ? `?storefront=${encodeURIComponent(storefrontKey)}&status=${status}`
    : `?storefront=${encodeURIComponent(storefrontKey)}`;
  return `${ROUTES.missingProducts}${q}`;
}

// ── readiness reason messages (mirror of READINESS_MESSAGES; kept local to stay
//     pure — a unit test asserts they never drift from the source module) ─────────
export const REASON_MISSING_IMAGE = "لا توجد صورة.";
export const REASON_MISSING_BARCODE = "لا يوجد باركود.";

const countReason = (items: readonly CcItem[], msg: string): number =>
  items.reduce((n, it) => (it.reasons.includes(msg) ? n + 1 : n), 0);

// ── storefront status (deterministic health model, §11) ────────────────────────
export type StorefrontStatus =
  | "HEALTHY"
  | "WARNING"
  | "ACTION_REQUIRED"
  | "OPERATIONALLY_BLOCKED"
  | "UNKNOWN";

export const STOREFRONT_STATUSES: readonly StorefrontStatus[] = [
  "HEALTHY",
  "WARNING",
  "ACTION_REQUIRED",
  "OPERATIONALLY_BLOCKED",
  "UNKNOWN",
];

/** Machine reason codes behind a storefront's status (§11 "expose reasons"). */
export type HealthReasonCode =
  | "no_operational_source"
  | "degraded_read"
  | "no_snapshot"
  | "missing_mappings"
  | "conflicts"
  | "sync_errors"
  | "needs_review"
  | "availability_drift"
  | "stale_data";

export const HEALTH_REASON_LABEL: Record<HealthReasonCode, string> = {
  no_operational_source: "لا يوجد مصدر تشغيلي موصول (تتطلب جلسة/قارئ).",
  degraded_read: "تعذّرت القراءة — الحالة غير مؤكدة.",
  no_snapshot: "لا توجد لقطة/بيانات كافية للتقييم.",
  missing_mappings: "توجد منتجات غير مربوطة (بحاجة ربط).",
  conflicts: "توجد تعارضات بحاجة حسم يدوي.",
  sync_errors: "توجد أخطاء مزامنة.",
  needs_review: "عناصر بحاجة مراجعة.",
  availability_drift: "انحراف في التوفّر/السعر.",
  stale_data: "اللقطة قديمة — يُنصح بالتحديث.",
};

/** Normalized per-storefront signals the deterministic classifier consumes. It
 *  NEVER sees a channel's own state enum — only these uniform buckets. */
export interface StorefrontMetrics {
  /** a reader is wired for this storefront at all (snoonu:malikas = false) */
  hasReader: boolean;
  /** the read FAILED (degraded) — forces OPERATIONALLY_BLOCKED, never missing */
  degraded: boolean;
  /** a trusted read carried data */
  available: boolean;
  missingMappings: number;
  needsReview: number;
  conflicts: number;
  availabilityDrift: number;
  syncErrors: number;
  stale: boolean;
}

/**
 * Deterministic storefront health (§11). No AI, no scoring — a fixed precedence
 * over the normalized signals, with the exact reason codes exposed. Precedence:
 *   1. no reader wired            → OPERATIONALLY_BLOCKED
 *   2. read degraded              → OPERATIONALLY_BLOCKED (cannot assess)
 *   3. no trusted data            → UNKNOWN (unknown ≠ missing)
 *   4. missing / conflicts / sync → ACTION_REQUIRED
 *   5. review / drift / stale     → WARNING
 *   6. otherwise                  → HEALTHY
 */
export function computeStorefrontStatus(m: StorefrontMetrics): {
  status: StorefrontStatus;
  reasons: HealthReasonCode[];
} {
  if (!m.hasReader) return { status: "OPERATIONALLY_BLOCKED", reasons: ["no_operational_source"] };
  if (m.degraded) return { status: "OPERATIONALLY_BLOCKED", reasons: ["degraded_read"] };
  if (!m.available) return { status: "UNKNOWN", reasons: ["no_snapshot"] };

  const reasons: HealthReasonCode[] = [];
  if (m.missingMappings > 0) reasons.push("missing_mappings");
  if (m.conflicts > 0) reasons.push("conflicts");
  if (m.syncErrors > 0) reasons.push("sync_errors");
  if (m.needsReview > 0) reasons.push("needs_review");
  if (m.availabilityDrift > 0) reasons.push("availability_drift");
  if (m.stale) reasons.push("stale_data");

  const actionable = m.missingMappings > 0 || m.conflicts > 0 || m.syncErrors > 0;
  const warn = m.needsReview > 0 || m.availabilityDrift > 0 || m.stale;
  if (actionable) return { status: "ACTION_REQUIRED", reasons };
  if (warn) return { status: "WARNING", reasons };
  return { status: "HEALTHY", reasons };
}

// ── storefront cards (§3–§8) ───────────────────────────────────────────────────
export interface StorefrontCard {
  key: string;
  label: string;
  channel: string;
  businessUnit: string;
  listingGrain: Storefront["listingGrain"];
  identityType: Storefront["identityType"];
  status: StorefrontStatus;
  reasons: HealthReasonCode[];
  available: boolean;
  operationalBlocked: boolean;
  /** counts are null when the storefront is blocked/unknown (never fabricated). */
  mapped: number | null;
  missingMappings: number | null;
  needsReview: number | null;
  availabilityDrift: number | null;
  syncErrors: number | null;
  /** catalog-wide advisory listing-data gaps (same across storefronts where they
   *  apply); advisory only — they never drive the storefront status. */
  missingImages: number | null;
  missingBarcodes: number | null;
  stale: boolean;
  lastSyncAt: string | null;
  /** Talabat is variant-grain: a note that parent coverage ≠ variant coverage. */
  grainNote: string | null;
  /** per-storefront quick actions (links only). */
  actions: QuickAction[];
}

const nullMetrics = (): { mapped: null; missingMappings: null; needsReview: null; availabilityDrift: null; syncErrors: null } => ({
  mapped: null,
  missingMappings: null,
  needsReview: null,
  availabilityDrift: null,
  syncErrors: null,
});

const TALABAT_GRAIN_NOTE =
  "التغطية تُقاس على مستوى المتغيّر (Talabat يفرد المتغيّرات كإدراجات) — تغطية المنتج الأب لا تعني تغطية كل متغيّراته.";

/** Build the per-storefront quick actions (links to EXISTING workflows only). */
function storefrontActions(sf: Storefront): QuickAction[] {
  const base: QuickAction[] = [];
  switch (sf.channel) {
    case "shopify":
      base.push(
        { key: `${sf.key}:diag`, label: "تشخيص Shopify", href: ROUTES.shopifyCatalog },
        { key: `${sf.key}:missing`, label: "المنتجات الناقصة", href: missingProductsLink(sf.key) },
        { key: `${sf.key}:mapping`, label: "مراجعة الربط", href: missingProductsLink(sf.key, "MISSING_ECL") },
      );
      break;
    case "snoonu":
      base.push(
        { key: `${sf.key}:images`, label: "استرجاع الصور", href: ROUTES.media },
        { key: `${sf.key}:availability`, label: "مزامنة التوفّر", href: ROUTES.availabilitySync },
        { key: `${sf.key}:barcode`, label: "إكمال الباركود", href: ROUTES.barcodeCompletion },
        { key: `${sf.key}:missing`, label: "المنتجات الناقصة", href: missingProductsLink(sf.key) },
        { key: `${sf.key}:diag`, label: "التشخيص", href: missingProductsLink(sf.key) },
      );
      break;
    case "talabat":
      base.push(
        { key: `${sf.key}:variants`, label: "إدراجات المتغيّرات الناقصة", href: missingProductsLink(sf.key, "INTERNAL_ONLY") },
        { key: `${sf.key}:review`, label: "قائمة المراجعة اليدوية", href: missingProductsLink(sf.key, "NEEDS_REVIEW") },
        { key: `${sf.key}:missing`, label: "المنتجات الناقصة", href: missingProductsLink(sf.key) },
      );
      break;
    case "rafeeq":
      base.push(
        { key: `${sf.key}:conflicts`, label: "تعارضات رفيق (مراجعة)", href: missingProductsLink(sf.key, "NEEDS_REVIEW") },
        { key: `${sf.key}:missing`, label: "المنتجات الناقصة", href: missingProductsLink(sf.key) },
      );
      break;
    default:
      base.push({ key: `${sf.key}:missing`, label: "المنتجات الناقصة", href: missingProductsLink(sf.key) });
      break;
  }
  return base;
}

/** Per-storefront normalized signals derived from the (already-loaded) overview.
 *  Storefronts are kept STRICTLY ISOLATED: snoonu:malikas and snoonu:pure_seoul
 *  never share SPI/session/state — each reads its own overview slice, and
 *  snoonu:malikas has NO reader so it is blocked, never folded into pure_seoul. */
function metricsFor(sf: Storefront, input: ChannelCenterInput): StorefrontMetrics {
  const o = input.overview;
  switch (sf.key) {
    case "shopify:malikas":
      return {
        hasReader: true,
        degraded: false,
        available: o.shopify.available,
        missingMappings: o.shopify.missing,
        needsReview: o.shopify.reviewRequired,
        conflicts: 0,
        availabilityDrift: o.shopify.different,
        syncErrors: 0,
        stale: o.shopify.stale,
      };
    case "snoonu:pure_seoul":
      return {
        hasReader: true,
        degraded: input.degraded.puresoul,
        available: o.puresoul.available,
        missingMappings: o.puresoul.missing,
        needsReview: o.puresoul.reviewRequired,
        conflicts: 0,
        availabilityDrift: o.puresoul.priceDifferent,
        syncErrors: 0,
        stale: o.puresoul.stale,
      };
    case "snoonu:malikas":
      // No presence/snapshot reader is wired (CH.CERT). It is OPERATIONALLY
      // BLOCKED — never inherits Pure Seoul's numbers (strict store isolation).
      return {
        hasReader: input.snoonuMalikasReaderAvailable === true,
        degraded: false,
        available: false,
        missingMappings: 0,
        needsReview: 0,
        conflicts: 0,
        availabilityDrift: 0,
        syncErrors: 0,
        stale: false,
      };
    case "talabat:malikas":
      return {
        hasReader: true,
        degraded: input.degraded.talabat,
        available: o.talabat.available,
        missingMappings: o.talabat.missing,
        needsReview: o.talabat.review,
        conflicts: 0,
        availabilityDrift: 0,
        syncErrors: 0,
        stale: o.talabat.stale,
      };
    case "rafeeq:malikas":
      return {
        hasReader: true,
        degraded: input.degraded.rafeeq,
        available: o.rafeeq.available,
        missingMappings: o.rafeeq.missing,
        needsReview: input.rafeeqConflicts ?? 0,
        conflicts: input.rafeeqConflicts ?? 0,
        availabilityDrift: 0,
        syncErrors: 0,
        stale: o.rafeeq.stale,
      };
    default:
      return { hasReader: false, degraded: false, available: false, missingMappings: 0, needsReview: 0, conflicts: 0, availabilityDrift: 0, syncErrors: 0, stale: false };
  }
}

function mappedCountFor(sf: Storefront, input: ChannelCenterInput): number {
  const o = input.overview;
  switch (sf.key) {
    case "shopify:malikas":
      return o.shopify.published;
    case "snoonu:pure_seoul":
      return o.puresoul.published;
    case "talabat:malikas":
      return o.talabat.present + o.talabat.linked;
    case "rafeeq:malikas":
      return o.rafeeq.present + o.rafeeq.linked;
    default:
      return 0;
  }
}

function lastSyncFor(sf: Storefront, input: ChannelCenterInput): string | null {
  const o = input.overview;
  switch (sf.key) {
    case "shopify:malikas":
      return o.shopify.lastCapturedAt;
    case "snoonu:pure_seoul":
      return o.puresoul.lastCapturedAt;
    case "talabat:malikas":
      return o.talabat.lastCapturedAt;
    case "rafeeq:malikas":
      return o.rafeeq.lastCapturedAt;
    default:
      return null;
  }
}

export function buildStorefrontCards(input: ChannelCenterInput): StorefrontCard[] {
  const needsImage = input.kpis.needsImage;
  const missingBarcode = countReason(input.items, REASON_MISSING_BARCODE);
  return STOREFRONTS.map((sf) => {
    const m = metricsFor(sf, input);
    const { status, reasons } = computeStorefrontStatus(m);
    const blocked = status === "OPERATIONALLY_BLOCKED" || status === "UNKNOWN";
    const nulls = nullMetrics();
    // barcode identity matters for Snoonu + Talabat (barcode/SKU identity); it is
    // not part of Shopify/Rafeeq identity, so it is only surfaced there as null.
    const barcodeRelevant = sf.channel === "snoonu" || sf.channel === "talabat";
    return {
      key: sf.key,
      label: sf.label,
      channel: sf.channel,
      businessUnit: sf.businessUnit,
      listingGrain: sf.listingGrain,
      identityType: sf.identityType,
      status,
      reasons,
      available: m.available,
      operationalBlocked: status === "OPERATIONALLY_BLOCKED",
      mapped: blocked ? nulls.mapped : mappedCountFor(sf, input),
      missingMappings: blocked ? nulls.missingMappings : m.missingMappings,
      needsReview: blocked ? nulls.needsReview : m.needsReview,
      availabilityDrift: blocked ? nulls.availabilityDrift : m.availabilityDrift,
      syncErrors: blocked ? nulls.syncErrors : m.syncErrors,
      missingImages: blocked ? null : needsImage,
      missingBarcodes: blocked || !barcodeRelevant ? null : missingBarcode,
      stale: m.stale,
      lastSyncAt: lastSyncFor(sf, input),
      grainNote: sf.listingGrain === "variant" ? TALABAT_GRAIN_NOTE : null,
      actions: storefrontActions(sf),
    };
  });
}

// ── unified alerts (§9) ────────────────────────────────────────────────────────
export type AlertType =
  | "MERCHANT_SESSION_MISSING"
  | "MISSING_ECL"
  | "VARIANT_MAPPING_GAP"
  | "AVAILABILITY_DRIFT"
  | "BARCODE_MISSING"
  | "IMAGE_MISSING"
  | "RAFEEQ_CONFLICT"
  | "SHOPIFY_SYNC_ERROR"
  | "TALABAT_MANUAL_REVIEW"
  | "EXTERNAL_ONLY_LISTING"
  | "INTERNAL_ONLY_PRODUCT";

export type AlertLevel = "info" | "warning" | "action";

export interface ChannelAlert {
  key: string;
  type: AlertType;
  level: AlertLevel;
  /** the storefront this alert belongs to (null ⇒ catalog-wide). */
  storefront: string | null;
  label: string;
  reason: string;
  href: string;
  /** count when known; null when the count is computed inside the linked workflow. */
  count: number | null;
}

const MAX_ALERTS = 40;

/** The unified alert feed. Each alert identifies its storefront, explains the
 *  reason, and links to the EXISTING resolution workflow. Alerts are emitted from
 *  EVIDENCE only (counts already in memory) — there is NO generic "Fix All", and
 *  conflicts are never auto-resolved (they link to manual review). */
export function buildChannelAlerts(input: ChannelCenterInput): ChannelAlert[] {
  const alerts: ChannelAlert[] = [];
  const o = input.overview;
  const push = (a: ChannelAlert) => alerts.push(a);

  // snoonu:malikas — operational source not wired (merchant session required).
  if (input.snoonuMalikasReaderAvailable !== true) {
    push({
      key: "snoonu:malikas:session",
      type: "MERCHANT_SESSION_MISSING",
      level: "action",
      storefront: "snoonu:malikas",
      label: "Snoonu — Malika's Universe",
      reason: "قدرات سنونو (مالكاز) المباشرة غير مُفعّلة — تتطلب جلسة تاجر.",
      href: ROUTES.availabilitySync,
      count: null,
    });
  }

  // Shopify connection error → sync/connection alert (not counted as "missing").
  if (!o.shopify.available) {
    push({ key: "shopify:conn", type: "SHOPIFY_SYNC_ERROR", level: "warning", storefront: "shopify:malikas", label: "Shopify — Malika's Universe", reason: "تعذّر الاتصال/القراءة من Shopify — الحالة غير مؤكدة.", href: ROUTES.shopifyCatalog, count: null });
  }

  // Internal-only (not listed externally) — evidenced by the per-storefront
  // "missing" verdict. Talabat's gap is a VARIANT_MAPPING_GAP (variant grain).
  if (o.shopify.available && o.shopify.missing > 0) {
    push({ key: "shopify:missing", type: "INTERNAL_ONLY_PRODUCT", level: "action", storefront: "shopify:malikas", label: "Shopify — Malika's Universe", reason: `منتجات غير منشورة على Shopify: ${o.shopify.missing}.`, href: missingProductsLink("shopify:malikas", "INTERNAL_ONLY"), count: o.shopify.missing });
  }
  if (o.puresoul.available && o.puresoul.missing > 0) {
    push({ key: "puresoul:missing", type: "INTERNAL_ONLY_PRODUCT", level: "action", storefront: "snoonu:pure_seoul", label: "Snoonu — Pure Seoul", reason: `منتجات غير مربوطة على Pure Seoul: ${o.puresoul.missing}.`, href: missingProductsLink("snoonu:pure_seoul", "MISSING_ECL"), count: o.puresoul.missing });
  }
  if (o.talabat.available && o.talabat.missing > 0) {
    push({ key: "talabat:missing", type: "VARIANT_MAPPING_GAP", level: "action", storefront: "talabat:malikas", label: "Talabat — Malika's Universe", reason: `إدراجات متغيّرات ناقصة على Talabat: ${o.talabat.missing} (تغطية الأب لا تكفي).`, href: missingProductsLink("talabat:malikas", "INTERNAL_ONLY"), count: o.talabat.missing });
  }
  if (o.rafeeq.available && o.rafeeq.missing > 0) {
    push({ key: "rafeeq:missing", type: "INTERNAL_ONLY_PRODUCT", level: "action", storefront: "rafeeq:malikas", label: "Rafeeq — Malika's Universe", reason: `منتجات غير مربوطة على Rafeeq: ${o.rafeeq.missing}.`, href: missingProductsLink("rafeeq:malikas", "MISSING_ECL"), count: o.rafeeq.missing });
  }

  // Availability / price drift (Shopify + Pure Seoul).
  if (o.shopify.available && o.shopify.different > 0) {
    push({ key: "shopify:drift", type: "AVAILABILITY_DRIFT", level: "warning", storefront: "shopify:malikas", label: "Shopify — Malika's Universe", reason: `انحراف في التوفّر/السعر على Shopify: ${o.shopify.different}.`, href: ROUTES.availabilitySync, count: o.shopify.different });
  }
  if (o.puresoul.available && o.puresoul.priceDifferent > 0) {
    push({ key: "puresoul:drift", type: "AVAILABILITY_DRIFT", level: "warning", storefront: "snoonu:pure_seoul", label: "Snoonu — Pure Seoul", reason: `فروقات سعر على Pure Seoul: ${o.puresoul.priceDifferent}.`, href: ROUTES.availabilitySync, count: o.puresoul.priceDifferent });
  }

  // Talabat manual review (evidenced from the trusted upload verdict).
  if (o.talabat.available && o.talabat.review > 0) {
    push({ key: "talabat:review", type: "TALABAT_MANUAL_REVIEW", level: "warning", storefront: "talabat:malikas", label: "Talabat — Malika's Universe", reason: `عناصر Talabat بحاجة مراجعة يدوية: ${o.talabat.review}.`, href: missingProductsLink("talabat:malikas", "NEEDS_REVIEW"), count: o.talabat.review });
  }

  // Rafeeq conflicts — emitted ONLY with evidence; never auto-resolved (links to
  // manual review). Contested rows remain needs_review (§8).
  if (input.rafeeqConflicts !== undefined && input.rafeeqConflicts > 0) {
    push({ key: "rafeeq:conflict", type: "RAFEEQ_CONFLICT", level: "action", storefront: "rafeeq:malikas", label: "Rafeeq — Malika's Universe", reason: `صفوف رفيق متنازع عليها بحاجة حسم يدوي: ${input.rafeeqConflicts}.`, href: missingProductsLink("rafeeq:malikas", "NEEDS_REVIEW"), count: input.rafeeqConflicts });
  }

  // Catalog-wide listing-data gaps (image/barcode) — one alert each.
  if (input.kpis.needsImage > 0) {
    push({ key: "catalog:images", type: "IMAGE_MISSING", level: "warning", storefront: null, label: "الكتالوج", reason: `صور ناقصة: ${input.kpis.needsImage} منتج.`, href: ROUTES.media, count: input.kpis.needsImage });
  }
  const barcodeMissing = countReason(input.items, REASON_MISSING_BARCODE);
  if (barcodeMissing > 0) {
    push({ key: "catalog:barcode", type: "BARCODE_MISSING", level: "warning", storefront: null, label: "الكتالوج", reason: `باركود ناقص: ${barcodeMissing} منتج.`, href: ROUTES.barcodeCompletion, count: barcodeMissing });
  }

  // Stability of ordering: actions first, then warnings, then info; stable within.
  const rank: Record<AlertLevel, number> = { action: 0, warning: 1, info: 2 };
  return alerts.sort((a, b) => rank[a.level] - rank[b.level]).slice(0, MAX_ALERTS);
}

// ── channel queues (§10) ───────────────────────────────────────────────────────
export type QueueKey =
  | "needs_mapping"
  | "needs_review"
  | "availability_drift"
  | "missing_barcode"
  | "missing_image"
  | "external_only"
  | "internal_only"
  | "sync_errors"
  | "operational_blockers";

export interface QueueRow {
  id: string;
  sku: string | null;
  name: string | null;
  storefront: string | null;
}

export interface ChannelQueue {
  key: QueueKey;
  label: string;
  /** total matching rows (across the catalog) — a workflow entry-point queue has
   *  count null (its authoritative count is computed inside the linked workflow). */
  count: number | null;
  /** the top-N compact rows only (never the whole catalog). */
  rows: QueueRow[];
  /** the EXISTING workflow this queue hands off to. */
  href: string;
  /** entry-point queues carry no local rows — they open the workflow that owns them. */
  entryPoint: boolean;
}

export const QUEUE_LABEL: Record<QueueKey, string> = {
  needs_mapping: "بحاجة ربط",
  needs_review: "بحاجة مراجعة",
  availability_drift: "انحراف التوفّر",
  missing_barcode: "باركود ناقص",
  missing_image: "صورة ناقصة",
  external_only: "خارجي فقط",
  internal_only: "داخلي فقط",
  sync_errors: "أخطاء مزامنة",
  operational_blockers: "معوّقات تشغيلية",
};

export const DEFAULT_QUEUE_TOP = 8;

const toRow = (i: CcItem, storefront: string | null): QueueRow => ({ id: i.id, sku: i.sku, name: i.nameAr ?? i.nameEn, storefront });

export function buildChannelQueues(input: ChannelCenterInput, top: number = DEFAULT_QUEUE_TOP): ChannelQueue[] {
  const items = input.items;
  const slice = (rows: QueueRow[]) => rows.slice(0, Math.max(0, top));

  // needs_mapping — any storefront reports this product as internal-only/missing.
  const needsMapping: QueueRow[] = [];
  for (const i of items) {
    if (i.shopifyStatus === "missing") needsMapping.push(toRow(i, "shopify:malikas"));
    else if (i.puresoulState === "missing") needsMapping.push(toRow(i, "snoonu:pure_seoul"));
    else if (i.talabatState === "missing") needsMapping.push(toRow(i, "talabat:malikas"));
    else if (i.rafeeqState === "missing") needsMapping.push(toRow(i, "rafeeq:malikas"));
  }

  const needsReview = items.filter(
    (i) => i.needsReview || i.shopifyStatus === "review_required" || i.puresoulState === "review" || i.talabatState === "review",
  );
  const drift = items.filter((i) => i.shopifyStatus === "different" || i.puresoulState === "price_different");
  const missingBarcode = items.filter((i) => i.reasons.includes(REASON_MISSING_BARCODE));
  const missingImage = items.filter((i) => i.needsImage);

  // internal_only — same evidence as needs_mapping but presented as a gap queue.
  const internalOnly = needsMapping;

  const blockers: QueueRow[] = [];
  if (input.snoonuMalikasReaderAvailable !== true) blockers.push({ id: "snoonu:malikas", sku: null, name: "Snoonu — Malika's Universe", storefront: "snoonu:malikas" });
  if (!input.overview.shopify.available) blockers.push({ id: "shopify:malikas", sku: null, name: "Shopify — Malika's Universe", storefront: "shopify:malikas" });
  if (input.degraded.puresoul) blockers.push({ id: "snoonu:pure_seoul", sku: null, name: "Snoonu — Pure Seoul", storefront: "snoonu:pure_seoul" });
  if (input.degraded.talabat) blockers.push({ id: "talabat:malikas", sku: null, name: "Talabat — Malika's Universe", storefront: "talabat:malikas" });
  if (input.degraded.rafeeq) blockers.push({ id: "rafeeq:malikas", sku: null, name: "Rafeeq — Malika's Universe", storefront: "rafeeq:malikas" });

  return [
    { key: "needs_mapping", label: QUEUE_LABEL.needs_mapping, count: needsMapping.length, rows: slice(needsMapping), href: ROUTES.missingProducts, entryPoint: false },
    { key: "needs_review", label: QUEUE_LABEL.needs_review, count: needsReview.length, rows: slice(needsReview.map((i) => toRow(i, null))), href: missingProductsLink("rafeeq:malikas", "NEEDS_REVIEW"), entryPoint: false },
    { key: "availability_drift", label: QUEUE_LABEL.availability_drift, count: drift.length, rows: slice(drift.map((i) => toRow(i, null))), href: ROUTES.availabilitySync, entryPoint: false },
    { key: "missing_barcode", label: QUEUE_LABEL.missing_barcode, count: missingBarcode.length, rows: slice(missingBarcode.map((i) => toRow(i, null))), href: ROUTES.barcodeCompletion, entryPoint: false },
    { key: "missing_image", label: QUEUE_LABEL.missing_image, count: missingImage.length, rows: slice(missingImage.map((i) => toRow(i, null))), href: ROUTES.media, entryPoint: false },
    // external_only can only be discovered by the CH.6F scan (it iterates external
    // listings) — it is a workflow ENTRY-POINT here (no local rows, count null).
    { key: "external_only", label: QUEUE_LABEL.external_only, count: null, rows: [], href: missingProductsLink("shopify:malikas", "EXTERNAL_ONLY"), entryPoint: true },
    { key: "internal_only", label: QUEUE_LABEL.internal_only, count: internalOnly.length, rows: slice(internalOnly), href: missingProductsLink("shopify:malikas", "INTERNAL_ONLY"), entryPoint: false },
    // no trusted live sync-error count exists — entry-point into diagnostics.
    { key: "sync_errors", label: QUEUE_LABEL.sync_errors, count: null, rows: [], href: ROUTES.shopifyCatalog, entryPoint: true },
    { key: "operational_blockers", label: QUEUE_LABEL.operational_blockers, count: blockers.length, rows: slice(blockers), href: ROUTES.channels, entryPoint: false },
  ];
}

// ── recent activity (§12) ──────────────────────────────────────────────────────
// No cross-channel event ledger exists (and OPS.3 must NOT create one). The only
// reliable shared activity source is the per-storefront snapshot capture time —
// surfaced here; the richer per-event stream is documented as an OPS.4 gap.
export interface ActivityEntry {
  storefront: string;
  label: string;
  kind: "snapshot";
  at: string | null;
}

export function buildActivity(input: ChannelCenterInput): ActivityEntry[] {
  const out: ActivityEntry[] = [];
  const o = input.overview;
  out.push({ storefront: "shopify:malikas", label: "Shopify — Malika's Universe", kind: "snapshot", at: o.shopify.lastCapturedAt });
  out.push({ storefront: "snoonu:pure_seoul", label: "Snoonu — Pure Seoul", kind: "snapshot", at: o.puresoul.lastCapturedAt });
  out.push({ storefront: "talabat:malikas", label: "Talabat — Malika's Universe", kind: "snapshot", at: o.talabat.lastCapturedAt });
  out.push({ storefront: "rafeeq:malikas", label: "Rafeeq — Malika's Universe", kind: "snapshot", at: o.rafeeq.lastCapturedAt });
  // sort by timestamp desc; nulls (no snapshot) last. Pure string compare on ISO.
  return out.sort((a, b) => (b.at ?? "").localeCompare(a.at ?? ""));
}

// ── global search (§13) — LOCAL identity match over the loaded items ────────────
// SKU / barcode / product name are matched here (pure, exact/substring, NEVER
// fuzzy). External identity (SPI / GID / Rafeeq id / Talabat SKU) is resolved by
// the server via the ECL resolver and merged in — never fuzzily guessed here.
export type SearchField = "sku" | "barcode" | "name" | "external";
export interface SearchMatch {
  id: string;
  sku: string | null;
  name: string | null;
  matchedOn: SearchField;
  /** for external-identity matches: the storefront the identity resolved on. */
  storefront?: string;
  /** for external-identity matches: the raw external identifier that resolved. */
  externalId?: string;
}

/** The combined search result: local (SKU/barcode/name, pure) + external
 *  (SPI/GID/Rafeeq id/Talabat SKU, resolved by the server via the ECL resolver). */
export interface SearchResult {
  query: string;
  local: SearchMatch[];
  external: SearchMatch[];
}

export function searchLocal(items: readonly CcItem[], rawQuery: string, limit = 25): SearchMatch[] {
  const q = rawQuery.trim().toLowerCase();
  if (q === "") return [];
  const out: SearchMatch[] = [];
  for (const i of items) {
    let matchedOn: SearchField | null = null;
    if (i.sku && i.sku.toLowerCase() === q) matchedOn = "sku";
    else if (i.barcode && i.barcode.toLowerCase() === q) matchedOn = "barcode";
    else if ((i.nameAr ?? "").toLowerCase().includes(q) || (i.nameEn ?? "").toLowerCase().includes(q)) matchedOn = "name";
    if (matchedOn) out.push({ id: i.id, sku: i.sku, name: i.nameAr ?? i.nameEn, matchedOn });
    if (out.length >= limit) break;
  }
  return out;
}

// ── filters (§14) ──────────────────────────────────────────────────────────────
export interface FilterOptions {
  channels: string[];
  storefronts: { key: string; label: string }[];
  statuses: StorefrontStatus[];
  brands: string[];
  categories: string[];
  issueTypes: QueueKey[];
}

export function buildFilterOptions(input: ChannelCenterInput): FilterOptions {
  const brands = new Set<string>();
  const categories = new Set<string>();
  for (const i of input.items) {
    if (i.brandId) brands.add(i.brandId);
    if (i.category) categories.add(i.category);
  }
  const channels = [...new Set(STOREFRONTS.map((s) => s.channel))];
  return {
    channels,
    storefronts: STOREFRONTS.map((s) => ({ key: s.key, label: s.label })),
    statuses: [...STOREFRONT_STATUSES],
    brands: [...brands].sort(),
    categories: [...categories].sort(),
    issueTypes: Object.keys(QUEUE_LABEL) as QueueKey[],
  };
}

// ── filter application (§14, PURE) ──────────────────────────────────────────────
export interface ChannelFilters {
  channel: string | null;
  storefront: string | null;
  status: StorefrontStatus | null;
  issueType: QueueKey | null;
  brand: string | null;
  category: string | null;
}

export const EMPTY_FILTERS: ChannelFilters = {
  channel: null,
  storefront: null,
  status: null,
  issueType: null,
  brand: null,
  category: null,
};

const oneStr = (v: unknown): string | null => {
  const s = Array.isArray(v) ? v[0] : v;
  return typeof s === "string" && s.trim() !== "" ? s.trim() : null;
};

/** Parse the read-only filter controls from a Next searchParams object. Unknown /
 *  malformed values fall back to null (never throw). Pure. */
export function parseChannelFilters(params: Record<string, unknown>): ChannelFilters {
  const status = oneStr(params.status);
  const issue = oneStr(params.issue);
  return {
    channel: oneStr(params.channel),
    storefront: oneStr(params.storefront),
    status: status && (STOREFRONT_STATUSES as readonly string[]).includes(status) ? (status as StorefrontStatus) : null,
    issueType: issue && issue in QUEUE_LABEL ? (issue as QueueKey) : null,
    brand: oneStr(params.brand),
    category: oneStr(params.category),
  };
}

/** Filter the storefront cards by channel / storefront / health status. Pure. */
export function filterStorefrontCards(cards: readonly StorefrontCard[], f: ChannelFilters): StorefrontCard[] {
  return cards.filter((c) => {
    if (f.channel && c.channel !== f.channel) return false;
    if (f.storefront && c.key !== f.storefront) return false;
    if (f.status && c.status !== f.status) return false;
    return true;
  });
}

/** Filter the alert feed by storefront / channel. Pure. */
export function filterAlerts(alerts: readonly ChannelAlert[], f: ChannelFilters): ChannelAlert[] {
  return alerts.filter((a) => {
    if (f.storefront && a.storefront !== f.storefront) return false;
    if (f.channel && a.storefront !== null && !a.storefront.startsWith(`${f.channel}:`)) return false;
    return true;
  });
}

/** Select one queue by issue type (null ⇒ all). Pure. */
export function selectQueue(queues: readonly ChannelQueue[], issueType: QueueKey | null): ChannelQueue[] {
  return issueType ? queues.filter((q) => q.key === issueType) : [...queues];
}

/** Filter product rows by brand / category (applied to item-level views). Pure. */
export function filterItems(items: readonly CcItem[], f: ChannelFilters): CcItem[] {
  return items.filter((i) => {
    if (f.brand && i.brandId !== f.brand) return false;
    if (f.category && i.category !== f.category) return false;
    return true;
  });
}

// ── quick actions (§15) — buttons → EXISTING workflows only ─────────────────────
export interface QuickAction {
  key: string;
  label: string;
  href: string;
}

export function buildQuickActions(): QuickAction[] {
  return [
    { key: "operations", label: "مركز العمليات", href: ROUTES.operations },
    { key: "media", label: "مركز الوسائط", href: ROUTES.media },
    { key: "ai", label: "الإثراء الذكي", href: ROUTES.aiEnrichment },
    { key: "availability", label: "مزامنة التوفّر", href: ROUTES.availabilitySync },
    { key: "barcode", label: "إكمال الباركود", href: ROUTES.barcodeCompletion },
    { key: "missing", label: "المنتجات الناقصة", href: ROUTES.missingProducts },
    { key: "shopify", label: "تشخيص Shopify", href: ROUTES.shopifyCatalog },
  ];
}

// ── overall status roll-up ─────────────────────────────────────────────────────
const STATUS_RANK: Record<StorefrontStatus, number> = {
  HEALTHY: 0,
  UNKNOWN: 1,
  WARNING: 2,
  OPERATIONALLY_BLOCKED: 3,
  ACTION_REQUIRED: 4,
};

export function worstStatus(cards: readonly StorefrontCard[]): StorefrontStatus {
  return cards.reduce<StorefrontStatus>((acc, c) => (STATUS_RANK[c.status] > STATUS_RANK[acc] ? c.status : acc), "HEALTHY");
}

export const STOREFRONT_STATUS_LABEL: Record<StorefrontStatus, string> = {
  HEALTHY: "سليم",
  WARNING: "تحذير",
  ACTION_REQUIRED: "إجراء مطلوب",
  OPERATIONALLY_BLOCKED: "معطّل تشغيليًا",
  UNKNOWN: "غير معروف",
};

// ── top-level compose ──────────────────────────────────────────────────────────
export interface ChannelCenterModel {
  storefronts: StorefrontCard[];
  overallStatus: StorefrontStatus;
  alerts: ChannelAlert[];
  queues: ChannelQueue[];
  activity: ActivityEntry[];
  filters: FilterOptions;
  quickActions: QuickAction[];
  readinessAverage: number;
  counts: { storefronts: number; alerts: number; blocked: number };
}

export function buildChannelCenter(input: ChannelCenterInput): ChannelCenterModel {
  const storefronts = buildStorefrontCards(input);
  const alerts = buildChannelAlerts(input);
  const blocked = storefronts.filter((c) => c.status === "OPERATIONALLY_BLOCKED").length;
  return {
    storefronts,
    overallStatus: worstStatus(storefronts),
    alerts,
    queues: buildChannelQueues(input),
    activity: buildActivity(input),
    filters: buildFilterOptions(input),
    quickActions: buildQuickActions(),
    readinessAverage: input.kpis.readinessAverage,
    counts: { storefronts: storefronts.length, alerts: alerts.length, blocked },
  };
}
