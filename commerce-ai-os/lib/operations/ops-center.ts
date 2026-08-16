// OPS.1 — Operations Center composer (PURE). No `@/` imports, no server-only, no
// DB — node:test loads it directly.
//
// The Operations Center is an ORCHESTRATION layer: it performs NO reads and NO
// writes. It is a pure projection over aggregates the /v2/operations page ALREADY
// computes (DashboardKpis, PlatformOverview, PlatformHealth[], the annotated
// item list). It derives daily-summary domains, health cards, channel-health
// rows, unified alerts and quick-action links — every count comes from data
// already in memory, so the dashboard needs no extra scans (§11). It duplicates
// NO business logic: product health reuses the readiness percent, channel numbers
// reuse the platform overview, freshness reuses platform health.

// ── input shapes (structural SUBSETS of the existing dashboard types, so the
//     page passes its kpis / platformOverview / platformHealth / items directly) ─
export interface KpiLite {
  totalProducts: number;
  needsImage: number;
  needsReview: number;
  ready: number;
  readinessAverage: number;
}
export interface ShopifyOv { available: boolean; published: number; missing: number; different: number; reviewRequired: number; stale: boolean }
export interface PuresoulOv { available: boolean; published: number; missing: number; priceDifferent: number; reviewRequired: number; stale: boolean }
export interface TalabatOv { available: boolean; present: number; missing: number; review: number; linked: number; stale: boolean }
export interface RafeeqOv { available: boolean; present: number; missing: number; linked: number; stale: boolean }
export interface OverviewLite { shopify: ShopifyOv; puresoul: PuresoulOv; talabat: TalabatOv; rafeeq: RafeeqOv }
export type HealthLevelLite = "healthy" | "needs_attention" | "insufficient_data";
export interface HealthLite { platform: string; healthLevel: HealthLevelLite }
export interface OpsItemLite { readinessPercent: number; reasons: readonly string[]; needsReview: boolean; needsImage: boolean }

export interface OpsCenterInput {
  kpis: KpiLite;
  overview: OverviewLite;
  platformHealth: readonly HealthLite[];
  items: readonly OpsItemLite[];
  /** whether a live Snoonu(Malikas) presence reader is wired (default false —
   *  the dashboard has no snoonu:malikas snapshot reader; it stays OPERATIONALLY
   *  BLOCKED here, matching the CH.CERT operational note). */
  snoonuMalikasReaderAvailable?: boolean;
}

// ── routes (existing workflows only — OPS.1 never introduces a parallel screen) ─
export const ROUTES = {
  catalog: "/v2/catalog",
  operations: "/v2/operations",
  missingProducts: "/v2/operations/missing-products",
  media: "/v2/operations/media",
  aiEnrichment: "/v2/operations/ai-enrichment",
  barcodeCompletion: "/v2/operations/barcode-completion",
  availabilitySync: "/v2/operations/availability-sync",
  rafeeqConflicts: "/v2/operations/missing-products?storefront=rafeeq:malikas&status=NEEDS_REVIEW",
} as const;

// ── readiness reason messages (mirror of READINESS_MESSAGES; kept local to stay
//     pure — a unit test asserts they never drift from the source module) ───────
export const REASON_MISSING_IMAGE = "لا توجد صورة.";
export const REASON_MISSING_BARCODE = "لا يوجد باركود.";
export const REASON_MISSING_DESCRIPTION = "لا يوجد وصف.";

const countReason = (items: readonly OpsItemLite[], msg: string): number =>
  items.reduce((n, it) => (it.reasons.includes(msg) ? n + 1 : n), 0);

// ── product health (REUSE readiness percent — no new scoring) ─────────────────
export type HealthTone = "good" | "warn" | "bad";
export function productHealthTone(percent: number): HealthTone {
  if (percent >= 80) return "good";
  if (percent >= 50) return "warn";
  return "bad";
}

// ── health cards ──────────────────────────────────────────────────────────────
export type CardTone = "neutral" | "good" | "warn" | "bad";
export interface HealthCard {
  key: string;
  label: string;
  /** null ⇒ this card is a workflow entry point; the count is computed on demand
   *  inside its own workflow (avoids a parallel scan here). */
  value: number | null;
  tone: CardTone;
  href: string;
}

const problemTone = (n: number): CardTone => (n > 0 ? "warn" : "good");

export function buildHealthCards(input: OpsCenterInput): HealthCard[] {
  const { kpis, items } = input;
  const descMissing = countReason(items, REASON_MISSING_DESCRIPTION);
  const barcodeMissing = countReason(items, REASON_MISSING_BARCODE);
  return [
    { key: "products", label: "المنتجات", value: kpis.totalProducts, tone: "neutral", href: ROUTES.catalog },
    { key: "ready", label: "جاهزة", value: kpis.ready, tone: "good", href: ROUTES.operations },
    { key: "images_missing", label: "صور ناقصة", value: kpis.needsImage, tone: problemTone(kpis.needsImage), href: ROUTES.media },
    { key: "description_missing", label: "وصف ناقص", value: descMissing, tone: problemTone(descMissing), href: ROUTES.aiEnrichment },
    { key: "barcode_missing", label: "باركود ناقص", value: barcodeMissing, tone: problemTone(barcodeMissing), href: ROUTES.barcodeCompletion },
    { key: "needs_review", label: "بحاجة مراجعة", value: kpis.needsReview, tone: problemTone(kpis.needsReview), href: ROUTES.missingProducts },
    // Entry-point cards — the authoritative count is computed inside the workflow
    // (keywords/AI/ECL need their own scan; OPS.1 does not duplicate it).
    { key: "keywords_missing", label: "كلمات مفتاحية", value: null, tone: "neutral", href: ROUTES.aiEnrichment },
    { key: "needs_ai", label: "إثراء ذكي", value: null, tone: "neutral", href: ROUTES.aiEnrichment },
    { key: "needs_ecl", label: "ربط ECL ناقص", value: null, tone: "neutral", href: ROUTES.missingProducts },
  ];
}

// ── daily summary (domain rollup) ─────────────────────────────────────────────
export type DomainStatus = "PASS" | "WARNING" | "ACTION_REQUIRED";
export interface DomainSummary { domain: string; status: DomainStatus; note: string }

const RANK: Record<DomainStatus, number> = { PASS: 0, WARNING: 1, ACTION_REQUIRED: 2 };
export function worst(statuses: readonly DomainStatus[]): DomainStatus {
  return statuses.reduce<DomainStatus>((acc, s) => (RANK[s] > RANK[acc] ? s : acc), "PASS");
}

function catalogStatus(input: OpsCenterInput): DomainStatus {
  const issues = input.kpis.needsImage + input.kpis.needsReview + countReason(input.items, REASON_MISSING_DESCRIPTION) + countReason(input.items, REASON_MISSING_BARCODE);
  if (issues === 0) return "PASS";
  const threshold = Math.ceil(Math.max(input.kpis.totalProducts, 1) * 0.1);
  return issues <= threshold ? "WARNING" : "ACTION_REQUIRED";
}

function availabilityStatus(input: OpsCenterInput): DomainStatus {
  const drift = input.overview.shopify.different + input.overview.puresoul.priceDifferent;
  return drift > 0 ? "WARNING" : "PASS";
}

function channelsStatus(input: OpsCenterInput): DomainStatus {
  if (input.platformHealth.some((h) => h.healthLevel === "needs_attention")) return "WARNING";
  if (input.platformHealth.some((h) => h.healthLevel === "insufficient_data")) return "WARNING";
  return "PASS";
}

export function buildDailySummary(input: OpsCenterInput): { domains: DomainSummary[]; overall: DomainStatus } {
  const catalog = catalogStatus(input);
  const availability = availabilityStatus(input);
  const channels = channelsStatus(input);
  const domains: DomainSummary[] = [
    { domain: "الكتالوج", status: catalog, note: catalog === "PASS" ? "مكتمل" : "توجد عناصر ناقصة" },
    { domain: "المخزون", status: "PASS", note: "محرك المخزون معتمد" },
    { domain: "التوفّر", status: availability, note: availability === "PASS" ? "متسق" : "توجد فروقات" },
    { domain: "القنوات", status: channels, note: channels === "PASS" ? "سليمة" : "تحتاج انتباه/بيانات" },
    { domain: "الذكاء", status: "PASS", note: "عند الطلب" },
    { domain: "الأمان", status: "PASS", note: "معتمد" },
  ];
  const overall = worst(domains.map((d) => d.status));
  return { domains, overall };
}

// ── channel health (per storefront, from the platform overview) ───────────────
export interface ChannelHealthRow {
  storefront: string;
  label: string;
  mapped: number;
  needsMapping: number;
  needsReview: number;
  syncErrors: number;
  operationalBlocked: boolean;
  /** OPS.7 — storefront-filtered Missing-Products deep-link (the resolver for a
   *  channel's mapping/gap issues). Always a real, validated storefront key. */
  href: string;
}

// OPS.7 — every channel row deep-links to Missing-Products pre-filtered to that
// storefront (routing only; the storefront key is a canonical CH.5 key).
const channelHref = (storefrontKey: string): string =>
  `${ROUTES.missingProducts}?storefront=${encodeURIComponent(storefrontKey)}`;

export function buildChannelHealth(input: OpsCenterInput): ChannelHealthRow[] {
  const { overview } = input;
  return [
    {
      storefront: "shopify:malikas",
      label: "Shopify — Malikas",
      mapped: overview.shopify.published,
      needsMapping: overview.shopify.missing,
      needsReview: overview.shopify.reviewRequired,
      syncErrors: 0,
      operationalBlocked: !overview.shopify.available,
      href: channelHref("shopify:malikas"),
    },
    {
      // No snoonu:malikas presence reader is wired into the dashboard (CH.CERT
      // operational note) — surfaced as OPERATIONALLY_BLOCKED, never as "missing".
      storefront: "snoonu:malikas",
      label: "Snoonu — Malikas",
      mapped: 0,
      needsMapping: 0,
      needsReview: 0,
      syncErrors: 0,
      operationalBlocked: input.snoonuMalikasReaderAvailable !== true,
      href: channelHref("snoonu:malikas"),
    },
    {
      storefront: "snoonu:pure_seoul",
      label: "Snoonu — Pure Seoul",
      mapped: overview.puresoul.published,
      needsMapping: overview.puresoul.missing,
      needsReview: overview.puresoul.reviewRequired,
      syncErrors: 0,
      operationalBlocked: !overview.puresoul.available,
      href: channelHref("snoonu:pure_seoul"),
    },
    {
      storefront: "talabat:malikas",
      label: "Talabat — Malikas",
      mapped: overview.talabat.present + overview.talabat.linked,
      needsMapping: overview.talabat.missing,
      needsReview: overview.talabat.review,
      syncErrors: 0,
      operationalBlocked: !overview.talabat.available,
      href: channelHref("talabat:malikas"),
    },
    {
      storefront: "rafeeq:malikas",
      label: "Rafeeq — Malikas",
      mapped: overview.rafeeq.present + overview.rafeeq.linked,
      needsMapping: overview.rafeeq.missing,
      needsReview: 0,
      syncErrors: 0,
      operationalBlocked: !overview.rafeeq.available,
      href: channelHref("rafeeq:malikas"),
    },
  ];
}

// ── unified alerts ────────────────────────────────────────────────────────────
export type AlertLevel = "info" | "warning" | "action";
export interface Alert { key: string; level: AlertLevel; message: string; href: string }

const MAX_ALERTS = 12;

export function buildAlerts(input: OpsCenterInput): Alert[] {
  const alerts: Alert[] = [];
  const { kpis, overview } = input;

  if (input.snoonuMalikasReaderAvailable !== true) {
    alerts.push({ key: "snoonu_session", level: "info", message: "قدرات سنونو (مالكاز) المباشرة غير مُفعّلة — تتطلب جلسة تاجر.", href: ROUTES.availabilitySync });
  }
  if (kpis.needsImage > 0) {
    alerts.push({ key: "images", level: "warning", message: `صور ناقصة: ${kpis.needsImage} منتج.`, href: ROUTES.media });
  }
  if (kpis.needsReview > 0) {
    alerts.push({ key: "review", level: "warning", message: `عناصر بحاجة مراجعة: ${kpis.needsReview}.`, href: ROUTES.missingProducts });
  }
  const chan: { label: string; missing: number; stale: boolean }[] = [
    { label: "Shopify", missing: overview.shopify.missing, stale: overview.shopify.stale },
    { label: "Pure Seoul", missing: overview.puresoul.missing, stale: overview.puresoul.stale },
    { label: "Talabat", missing: overview.talabat.missing, stale: overview.talabat.stale },
    { label: "Rafeeq", missing: overview.rafeeq.missing, stale: overview.rafeeq.stale },
  ];
  for (const c of chan) {
    if (c.missing > 0) alerts.push({ key: `missing_${c.label}`, level: "warning", message: `${c.label}: ${c.missing} إدراج ناقص.`, href: ROUTES.missingProducts });
  }
  for (const c of chan) {
    if (c.stale) alerts.push({ key: `stale_${c.label}`, level: "info", message: `${c.label}: لقطة قديمة — يُنصح بالتحديث.`, href: ROUTES.operations });
  }
  return alerts.slice(0, MAX_ALERTS);
}

// ── quick actions (buttons → existing workflows only) ─────────────────────────
export interface QuickAction { key: string; label: string; href: string }
export function buildQuickActions(): QuickAction[] {
  return [
    { key: "media", label: "مركز الوسائط", href: ROUTES.media },
    { key: "images", label: "استرجاع الصور", href: ROUTES.media },
    { key: "ai", label: "توليد ذكي", href: ROUTES.aiEnrichment },
    { key: "barcode", label: "إكمال الباركود", href: ROUTES.barcodeCompletion },
    { key: "availability", label: "مزامنة التوفّر", href: ROUTES.availabilitySync },
    { key: "missing", label: "المنتجات الناقصة", href: ROUTES.missingProducts },
    { key: "rafeeq", label: "تعارضات رفيق", href: ROUTES.rafeeqConflicts },
    { key: "refresh", label: "تحديث اللوحة", href: ROUTES.operations },
  ];
}

// ── top-level compose ─────────────────────────────────────────────────────────
export interface OperationsCenterModel {
  cards: HealthCard[];
  daily: DomainSummary[];
  overall: DomainStatus;
  channels: ChannelHealthRow[];
  alerts: Alert[];
  quickActions: QuickAction[];
  readinessAverage: number;
}

export function buildOperationsCenter(input: OpsCenterInput): OperationsCenterModel {
  const { domains, overall } = buildDailySummary(input);
  return {
    cards: buildHealthCards(input),
    daily: domains,
    overall,
    channels: buildChannelHealth(input),
    alerts: buildAlerts(input),
    quickActions: buildQuickActions(),
    readinessAverage: input.kpis.readinessAverage,
  };
}

export const DOMAIN_STATUS_LABEL: Record<DomainStatus, string> = {
  PASS: "سليم",
  WARNING: "تحذير",
  ACTION_REQUIRED: "إجراء مطلوب",
};
