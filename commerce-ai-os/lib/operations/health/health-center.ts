// OPS.6 — Platform Health Center composer (PURE).
//
// A cross-cutting, READ-ONLY diagnostics projection: it turns already-gathered,
// BOUNDED signals from the existing read models (OPS.1 dashboard, OPS.3/4 channel
// gap counts + snoonu operational, OPS.5 AI scan, OPS.2 media, ECL head counts,
// bounded inventory/availability/security/runtime signals) into nine per-domain
// health states + a deterministic overall state + actionable findings that
// deep-link to the EXISTING workflows. It invents NO business logic, computes NO
// AI health scores, and fabricates NO history or operational state — a signal it
// cannot cheaply and correctly derive is UNKNOWN, and heavy detail is deep-linked.
//
// PURE: no imports (self-contained states/labels). node:test loads it directly.

// ── states ───────────────────────────────────────────────────────────────────
export type DomainStatus = "HEALTHY" | "WARNING" | "ACTION_REQUIRED" | "OPERATIONALLY_BLOCKED" | "UNKNOWN";

export const DOMAIN_STATUSES: readonly DomainStatus[] = ["HEALTHY", "WARNING", "ACTION_REQUIRED", "OPERATIONALLY_BLOCKED", "UNKNOWN"];

// Deterministic severity rank for the overall roll-up (§3). ACTION_REQUIRED is the
// worst; UNKNOWN outranks HEALTHY (we never claim healthy for what we can't assess).
const STATUS_RANK: Record<DomainStatus, number> = {
  ACTION_REQUIRED: 4,
  OPERATIONALLY_BLOCKED: 3,
  WARNING: 2,
  UNKNOWN: 1,
  HEALTHY: 0,
};

export const DOMAIN_STATUS_LABEL: Record<DomainStatus, string> = {
  HEALTHY: "سليم",
  WARNING: "تحذير",
  ACTION_REQUIRED: "إجراء مطلوب",
  OPERATIONALLY_BLOCKED: "معطّل تشغيليًا",
  UNKNOWN: "غير معروف",
};

export type DomainKey = "catalog" | "inventory" | "availability" | "channels" | "ai" | "media" | "ecl" | "security" | "system";

export const DOMAIN_ORDER: readonly DomainKey[] = ["catalog", "inventory", "availability", "channels", "ai", "media", "ecl", "security", "system"];

export const DOMAIN_LABEL: Record<DomainKey, string> = {
  catalog: "الكتالوج",
  inventory: "المخزون",
  availability: "التوفّر",
  channels: "القنوات",
  ai: "الذكاء / الإثراء",
  media: "الوسائط",
  ecl: "الهوية / ECL",
  security: "الأمان / الإنفاذ",
  system: "النظام / التشغيل",
};

// ── existing workflow routes (deep-link targets — OPS.6 adds NO new screen) ─────
export const ROUTES = {
  operations: "/v2/operations",
  health: "/v2/operations/health",
  catalog: "/v2/catalog",
  media: "/v2/operations/media",
  ai: "/v2/operations/ai",
  channels: "/v2/operations/channels",
  availabilitySync: "/v2/operations/availability-sync",
  barcodeCompletion: "/v2/operations/barcode-completion",
  missingProducts: "/v2/operations/missing-products",
} as const;

// ── domain result shapes ────────────────────────────────────────────────────────
export interface DomainMetric {
  label: string;
  /** null = UNKNOWN / not cheaply derivable (rendered "—", never 0). */
  value: number | null;
}
export interface DomainHealth {
  key: DomainKey;
  label: string;
  status: DomainStatus;
  reasons: string[];
  metrics: DomainMetric[];
  /** an honesty note (e.g. deep detail requires an on-demand scan). */
  note: string | null;
}

export interface HealthFinding {
  domain: DomainKey;
  severity: "warning" | "action";
  reason: string;
  /** null when the authoritative count lives in the linked workflow. */
  count: number | null;
  workflow: string;
  href: string;
}

// ── small helpers ────────────────────────────────────────────────────────────
const m = (label: string, value: number | null): DomainMetric => ({ label, value });
const pos = (v: number | null | undefined): boolean => typeof v === "number" && v > 0;

// ── input signals (all BOUNDED / already-computed; the server gathers them) ─────
export interface CatalogSignals {
  total: number;
  active: number | null;
  archived: number | null;
  missingImages: number;
  missingBarcode: number;
  missingDescription: number;
}
export interface InventorySignals {
  /** negative on-hand rows — strict enforcement keeps this 0; null = not read. */
  negativeInventory: number | null;
  negativeVariant: number | null;
}
export interface AvailabilitySignals {
  total: number;
  /** products with no explicit In/Out availability (null stock_status). */
  unknown: number | null;
  /** trusted drift (Shopify different + Pure Seoul price-different). */
  drift: number;
}
export interface ChannelStorefrontSignal {
  key: string;
  label: string;
  status: DomainStatus;
  missingMappings: number | null;
  needsReview: number | null;
  conflicts: number | null;
  operationalBlocked: boolean;
}
export interface AiSignals {
  missingKeywords: number | null;
  missingDescriptions: number;
  providerConfigured: boolean;
}
export interface MediaSignals {
  missingImages: number;
}
export interface EclSignals {
  totalMappings: number | null;
  active: number | null;
  needsReview: number | null;
}
export interface SecuritySignals {
  ownerConfigured: boolean;
  extraWriterCount: number;
  /** strict DB enforcement is certified at migration/CI level; not runtime-probed
   *  (probing would need a schema object OPS.6 must not add). */
  strictEnforcementCertified: boolean;
}
export interface SystemSignals {
  vercelEnv: string | null;
  providerConfigured: boolean;
  /** recent failed audit rows (bounded window); null = not read. */
  recentFailures: number | null;
  snoonuSessionState: string;
}

export interface HealthSignals {
  catalog: CatalogSignals;
  inventory: InventorySignals;
  availability: AvailabilitySignals;
  channels: ChannelStorefrontSignal[];
  ai: AiSignals;
  media: MediaSignals;
  ecl: EclSignals;
  security: SecuritySignals;
  system: SystemSignals;
}

// ── domain builders (deterministic, §2/§4–§12) ──────────────────────────────────
export function buildCatalogHealth(s: CatalogSignals): DomainHealth {
  const reasons: string[] = [];
  if (pos(s.missingImages)) reasons.push(`صور ناقصة: ${s.missingImages}`);
  if (pos(s.missingBarcode)) reasons.push(`باركود ناقص: ${s.missingBarcode}`);
  if (pos(s.missingDescription)) reasons.push(`وصف ناقص: ${s.missingDescription}`);
  const issues = s.missingImages + s.missingBarcode + s.missingDescription;
  const threshold = Math.ceil(Math.max(s.total, 1) * 0.1);
  const status: DomainStatus = issues === 0 ? "HEALTHY" : issues > threshold ? "ACTION_REQUIRED" : "WARNING";
  return {
    key: "catalog",
    label: DOMAIN_LABEL.catalog,
    status,
    reasons,
    metrics: [m("إجمالي", s.total), m("نشِط", s.active), m("مؤرشف", s.archived), m("صور ناقصة", s.missingImages), m("باركود ناقص", s.missingBarcode), m("وصف ناقص", s.missingDescription)],
    note: "تكرار SKU/الباركود واتساق المنتج/المتغيّر يُفحصان عند الطلب (فحص التسوية).",
  };
}

export function buildInventoryHealth(s: InventorySignals): DomainHealth {
  const reasons: string[] = [];
  const neg = (s.negativeInventory ?? 0) + (s.negativeVariant ?? 0);
  const unread = s.negativeInventory === null && s.negativeVariant === null;
  let status: DomainStatus;
  if (unread) {
    status = "UNKNOWN";
    reasons.push("تعذّرت قراءة إشارات المخزون.");
  } else if (neg > 0) {
    status = "ACTION_REQUIRED";
    reasons.push(`كميات سالبة: ${neg} (يجب أن تكون صفرًا مع الإنفاذ الصارم).`);
  } else {
    status = "HEALTHY";
  }
  return {
    key: "inventory",
    label: DOMAIN_LABEL.inventory,
    status,
    reasons,
    metrics: [m("سالب (مخزون)", s.negativeInventory), m("سالب (متغيّر)", s.negativeVariant)],
    note: "السلامة العميقة (تدرّج الأب/المتغيّر، صفوف يتيمة، سلامة المُباع) تُفحص عند الطلب — فحص التسوية.",
  };
}

export function buildAvailabilityHealth(s: AvailabilitySignals): DomainHealth {
  const reasons: string[] = [];
  if (pos(s.drift)) reasons.push(`انحراف توفّر: ${s.drift}`);
  const unknownHigh = s.unknown !== null && s.unknown > Math.ceil(Math.max(s.total, 1) * 0.1);
  if (unknownHigh) reasons.push(`توفّر غير محدّد: ${s.unknown}`);
  let status: DomainStatus;
  if (pos(s.drift)) status = "WARNING";
  else if (unknownHigh) status = "WARNING";
  else if (s.unknown === null) status = "UNKNOWN";
  else status = "HEALTHY";
  return {
    key: "availability",
    label: DOMAIN_LABEL.availability,
    status,
    reasons,
    metrics: [m("إجمالي", s.total), m("غير محدّد", s.unknown), m("انحراف", s.drift)],
    note: "التوفّر صريح ومنفصل عن الكمية — لا يُشتق من الكمية إطلاقًا.",
  };
}

export function buildChannelsHealth(storefronts: readonly ChannelStorefrontSignal[]): DomainHealth {
  const status = worstStatus(storefronts.map((s) => s.status));
  const reasons: string[] = [];
  const blocked = storefronts.filter((s) => s.operationalBlocked).length;
  const review = storefronts.reduce((n, s) => n + (s.needsReview ?? 0), 0);
  const missing = storefronts.reduce((n, s) => n + (s.missingMappings ?? 0), 0);
  if (blocked > 0) reasons.push(`واجهات معطّلة تشغيليًا: ${blocked}`);
  if (review > 0) reasons.push(`بحاجة مراجعة/تعارضات: ${review}`);
  if (missing > 0) reasons.push(`بحاجة ربط: ${missing}`);
  return {
    key: "channels",
    label: DOMAIN_LABEL.channels,
    status,
    reasons,
    metrics: [m("واجهات", storefronts.length), m("معطّلة", blocked), m("بحاجة ربط", missing), m("مراجعة", review)],
    note: "التفصيل لكل واجهة في مركز قيادة القنوات (Talabat على مستوى المتغيّر؛ تعارضات رفيق تبقى مراجعة يدوية).",
  };
}

export function buildAiHealth(s: AiSignals): DomainHealth {
  const reasons: string[] = [];
  if (!s.providerConfigured) reasons.push("مزوّد الذكاء غير مُهيّأ.");
  if (pos(s.missingKeywords)) reasons.push(`كلمات مفتاحية ناقصة: ${s.missingKeywords}`);
  if (pos(s.missingDescriptions)) reasons.push(`أوصاف ناقصة: ${s.missingDescriptions}`);
  let status: DomainStatus;
  if (!s.providerConfigured) status = "OPERATIONALLY_BLOCKED";
  else if (pos(s.missingKeywords) || pos(s.missingDescriptions)) status = "WARNING";
  else status = "HEALTHY";
  return {
    key: "ai",
    label: DOMAIN_LABEL.ai,
    status,
    reasons,
    metrics: [m("كلمات ناقصة", s.missingKeywords), m("أوصاف ناقصة", s.missingDescriptions)],
    note: "جاهز/فشل/قديم للجلسة فقط (التوليد غير مُخزَّن) — التفصيل في مركز الذكاء.",
  };
}

export function buildMediaHealth(s: MediaSignals): DomainHealth {
  const reasons: string[] = [];
  if (pos(s.missingImages)) reasons.push(`صور ناقصة: ${s.missingImages}`);
  return {
    key: "media",
    label: DOMAIN_LABEL.media,
    status: pos(s.missingImages) ? "WARNING" : "HEALTHY",
    reasons,
    metrics: [m("صور ناقصة", s.missingImages)],
    note: "الصور المكسورة/المكررة وتعدّد الصور تُفحص عند الطلب — مركز الوسائط.",
  };
}

export function buildEclHealth(s: EclSignals): DomainHealth {
  const reasons: string[] = [];
  const unread = s.totalMappings === null;
  let status: DomainStatus;
  if (unread) {
    status = "UNKNOWN";
    reasons.push("تعذّرت قراءة عدّادات ECL.");
  } else if (pos(s.needsReview)) {
    status = "ACTION_REQUIRED";
    reasons.push(`ربط بحاجة مراجعة: ${s.needsReview}`);
  } else {
    status = "HEALTHY";
  }
  return {
    key: "ecl",
    label: DOMAIN_LABEL.ecl,
    status,
    reasons,
    metrics: [m("إجمالي الربط", s.totalMappings), m("نشِط", s.active), m("بحاجة مراجعة", s.needsReview)],
    note: "الهويات المكررة/اليتيمة وتسريب SPI بين متاجر سنونو والحالة القديمة تُفحص عند الطلب — لا تراجع Phase E هنا.",
  };
}

export function buildSecurityHealth(s: SecuritySignals): DomainHealth {
  const reasons: string[] = [];
  if (!s.ownerConfigured) reasons.push("قائمة صلاحية الكتابة غير مُهيّأة.");
  return {
    key: "security",
    label: DOMAIN_LABEL.security,
    status: s.ownerConfigured ? "HEALTHY" : "ACTION_REQUIRED",
    reasons,
    metrics: [m("كتّاب إضافيون", s.extraWriterCount), m("الإنفاذ الصارم (معتمد)", s.strictEnforcementCertified ? 1 : 0)],
    note: "الإنفاذ الصارم على قاعدة البيانات مُعتمد على مستوى الترحيل/CI (لا يُفحص وقت التشغيل — لا أسرار تُعرض).",
  };
}

export function buildSystemHealth(s: SystemSignals): DomainHealth {
  const reasons: string[] = [];
  if (!s.providerConfigured) reasons.push("مزوّد الذكاء غير مُهيّأ.");
  if (pos(s.recentFailures)) reasons.push(`أخطاء حديثة مسجّلة: ${s.recentFailures}`);
  let status: DomainStatus;
  if (pos(s.recentFailures)) status = "WARNING";
  else if (!s.providerConfigured) status = "WARNING";
  else status = "HEALTHY";
  return {
    key: "system",
    label: DOMAIN_LABEL.system,
    status,
    reasons,
    metrics: [m("أخطاء حديثة", s.recentFailures)],
    note: `البيئة: ${s.vercelEnv ?? "—"} · جلسة سنونو: ${s.snoonuSessionState}`,
  };
}

// ── overall roll-up (§3) ─────────────────────────────────────────────────────
export function worstStatus(statuses: readonly DomainStatus[]): DomainStatus {
  return statuses.reduce<DomainStatus>((acc, st) => (STATUS_RANK[st] > STATUS_RANK[acc] ? st : acc), "HEALTHY");
}

export interface OverallHealth {
  status: DomainStatus;
  reasons: string[];
}

/** Deterministic overall state = the worst domain state, with the driving domains
 *  named as reasons (§3). Testable, explicit — never an AI score. */
export function buildOverall(domains: readonly DomainHealth[]): OverallHealth {
  const status = worstStatus(domains.map((d) => d.status));
  const reasons = domains.filter((d) => d.status === status && status !== "HEALTHY").map((d) => d.label);
  return { status, reasons };
}

// ── actionable findings (§13) ────────────────────────────────────────────────
export function buildFindings(s: HealthSignals): HealthFinding[] {
  const out: HealthFinding[] = [];
  const add = (domain: DomainKey, severity: "warning" | "action", reason: string, count: number | null, workflow: string, href: string) =>
    out.push({ domain, severity, reason, count, workflow, href });

  if (pos(s.catalog.missingImages)) add("catalog", "warning", "صور ناقصة", s.catalog.missingImages, "مركز الوسائط", ROUTES.media);
  if (pos(s.catalog.missingBarcode)) add("catalog", "warning", "باركود ناقص", s.catalog.missingBarcode, "إكمال الباركود", ROUTES.barcodeCompletion);
  if (pos(s.catalog.missingDescription)) add("catalog", "warning", "وصف ناقص", s.catalog.missingDescription, "مركز الذكاء", ROUTES.ai);
  if (pos(s.ai.missingKeywords)) add("ai", "warning", "كلمات مفتاحية ناقصة", s.ai.missingKeywords, "مركز الذكاء", ROUTES.ai);
  if (!s.ai.providerConfigured) add("ai", "action", "مزوّد الذكاء غير مُهيّأ", null, "مركز الذكاء", ROUTES.ai);
  if (pos(s.availability.drift)) add("availability", "warning", "انحراف التوفّر", s.availability.drift, "مزامنة التوفّر", ROUTES.availabilitySync);
  if (pos(s.media.missingImages)) add("media", "warning", "صور ناقصة", s.media.missingImages, "مركز الوسائط", ROUTES.media);
  if (pos(s.ecl.needsReview)) add("ecl", "action", "ربط بحاجة مراجعة (تعارضات)", s.ecl.needsReview, "مركز قيادة القنوات", `${ROUTES.missingProducts}?status=NEEDS_REVIEW`);
  const negInv = (s.inventory.negativeInventory ?? 0) + (s.inventory.negativeVariant ?? 0);
  if (negInv > 0) add("inventory", "action", "كميات سالبة", negInv, "العمليات", ROUTES.operations);
  // per-storefront channel findings
  for (const sf of s.channels) {
    if (sf.operationalBlocked) add("channels", "action", `واجهة معطّلة: ${sf.label}`, null, "مركز قيادة القنوات", `${ROUTES.channels}?storefront=${encodeURIComponent(sf.key)}`);
    else if (pos(sf.needsReview)) add("channels", "action", `${sf.label}: بحاجة مراجعة`, sf.needsReview, "مركز قيادة القنوات", `${ROUTES.channels}?storefront=${encodeURIComponent(sf.key)}`);
    else if (pos(sf.missingMappings)) add("channels", "warning", `${sf.label}: بحاجة ربط`, sf.missingMappings, "المنتجات الناقصة", `${ROUTES.missingProducts}?storefront=${encodeURIComponent(sf.key)}`);
  }
  // action severity first, then warnings; stable within
  const rank = { action: 0, warning: 1 } as const;
  return out.sort((a, b) => rank[a.severity] - rank[b.severity]);
}

// ── filters (§15) ────────────────────────────────────────────────────────────
export type Severity = "warning" | "action";
export interface HealthFilters {
  domain: DomainKey | null;
  severity: Severity | null;
  storefront: string | null;
  brand: string | null;
  category: string | null;
  issue: string | null;
}
export const EMPTY_HEALTH_FILTERS: HealthFilters = { domain: null, severity: null, storefront: null, brand: null, category: null, issue: null };

const one = (v: unknown): string | null => {
  const x = Array.isArray(v) ? v[0] : v;
  return typeof x === "string" && x.trim() !== "" ? x.trim() : null;
};

export function parseHealthFilters(params: Record<string, unknown>): HealthFilters {
  const domain = one(params.domain);
  const severity = one(params.severity);
  return {
    domain: domain && (DOMAIN_ORDER as readonly string[]).includes(domain) ? (domain as DomainKey) : null,
    severity: severity === "warning" || severity === "action" ? severity : null,
    storefront: one(params.storefront),
    brand: one(params.brand),
    category: one(params.category),
    issue: one(params.issue),
  };
}

/** Filter the findings list by domain / severity (§15). Pure. */
export function filterFindings(findings: readonly HealthFinding[], f: HealthFilters): HealthFinding[] {
  return findings.filter((x) => {
    if (f.domain && x.domain !== f.domain) return false;
    if (f.severity && x.severity !== f.severity) return false;
    return true;
  });
}

// ── top-level compose ─────────────────────────────────────────────────────────
export interface HealthCenterModel {
  overall: OverallHealth;
  domains: DomainHealth[];
  findings: HealthFinding[];
  counts: { domains: number; findings: number; actionRequired: number; blocked: number };
}

export function buildHealthCenter(s: HealthSignals): HealthCenterModel {
  const domains: DomainHealth[] = [
    buildCatalogHealth(s.catalog),
    buildInventoryHealth(s.inventory),
    buildAvailabilityHealth(s.availability),
    buildChannelsHealth(s.channels),
    buildAiHealth(s.ai),
    buildMediaHealth(s.media),
    buildEclHealth(s.ecl),
    buildSecurityHealth(s.security),
    buildSystemHealth(s.system),
  ];
  const findings = buildFindings(s);
  return {
    overall: buildOverall(domains),
    domains,
    findings,
    counts: {
      domains: domains.length,
      findings: findings.length,
      actionRequired: domains.filter((d) => d.status === "ACTION_REQUIRED").length,
      blocked: domains.filter((d) => d.status === "OPERATIONALLY_BLOCKED").length,
    },
  };
}
