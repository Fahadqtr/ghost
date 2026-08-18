// HOME.1 — Executive Home Dashboard composer (PURE).
//
// Builds the 12-section view-model for /v2 from ALREADY-COMPUTED facts produced
// by the certified read models (Action Center, Operations, CAT.1A–E, Export
// Center, AI Center, Rewards, Analytics, audit). This module holds NO business
// rules, NO health/evidence/recommendation/lifecycle/export/AI logic, NO queries
// and NO writes — it only shapes certified numbers into labeled cards and passes
// UNKNOWN through untouched (never fabricated). Every count here originates in a
// certified engine; the composer copies, labels, sums or sorts certified fields
// and does presentation-only tone selection.
//
// PURE: relative imports only, no server-only, no DB/SDK/clock/random.

export const UNKNOWN = "UNKNOWN" as const;
export type Maybe<T> = T | typeof UNKNOWN;

/** A single labeled metric on a card. `value` may be UNKNOWN — rendered as an em dash. */
export interface HomeStat {
  key: string;
  label: string;
  value: Maybe<number>;
  tone: HomeTone;
  href?: string;
}

/** A pre-formatted (string) metric for money/text values the server already rendered. */
export interface HomeTextStat {
  key: string;
  label: string;
  value: string; // already formatted; "—" for unknown
  available: boolean;
}

export type HomeTone = "neutral" | "good" | "warn" | "bad";

// ── Facts contract (what the server assembler extracts from certified loaders) ──

export interface ActionFacts {
  critical: Maybe<number>;
  approvalRequired: Maybe<number>;
  waiting: Maybe<number>;
  completedToday: Maybe<number>;
  total: Maybe<number>;
  /** severity axis (certified Action.severity): warning→"High", info→"Medium". */
  high: Maybe<number>;
  medium: Maybe<number>;
}

export interface LifecycleFacts {
  active: Maybe<number>;
  draft: Maybe<number>;
  stopped: Maybe<number>;
  ready: Maybe<number>;
}

export interface CatalogFacts {
  total: Maybe<number>;
  ready: Maybe<number>;
  blocked: Maybe<number>;
  needsImage: Maybe<number>;
  needsCategory: Maybe<number>;
  needsPrice: Maybe<number>;
  needsBrand: Maybe<number>;
}

export interface HealthFacts {
  averageScore: Maybe<number>;
  total: Maybe<number>;
  byGrade: Readonly<Record<string, number>> | null; // Excellent/Good/Fair/Poor/Critical
}

export interface EvidenceFacts {
  total: Maybe<number>;
  productsWithEvidence: Maybe<number>;
  bySeverity: Readonly<Record<string, number>> | null; // CRITICAL/ERROR/WARNING/INFO
}

export interface RecommendationFacts {
  total: Maybe<number>;
  productsWithRecommendations: Maybe<number>;
  byPriority: Readonly<Record<string, number>> | null; // CRITICAL/HIGH/MEDIUM/LOW
}

export interface ChannelFacts {
  key: string;
  label: string;
  status: string; // certified operational status label
  mapped: Maybe<number>;
  blocked: Maybe<number>;
  needsReview: Maybe<number>;
  lastExport: Maybe<string>;
  href: string;
}

export interface ExportRunFact {
  operation: string;
  status: string; // STARTED/SUCCEEDED/FAILED/PARTIAL
  finishedAt: Maybe<string>;
  createdCount: number;
  updatedCount: number;
  failedCount: number;
}

export interface ExportFacts {
  eligible: Maybe<number>;
  blocked: Maybe<number>;
  historyAvailable: boolean;
  runs: readonly ExportRunFact[] | null;
  pending: Maybe<number>;
  failed: Maybe<number>;
  completed: Maybe<number>;
  lastPublish: Maybe<string>;
}

export interface AiFacts {
  needGeneration: Maybe<number>;
  needReview: Maybe<number>; // live-session only ⇒ typically 0 on server render
  readyApply: Maybe<number>; // live-session only ⇒ typically 0 on server render
  providerState: string; // AVAILABLE/DEGRADED/UNAVAILABLE
  providerConfigured: boolean;
  lastSuccessAt: Maybe<string>;
}

export interface RegistrationFact {
  name: string;
  phone: string;
  createdAt: string;
}

export interface RewardsFacts {
  registeredMembers: Maybe<number>;
  pendingReviews: Maybe<number>;
  heartsApprovedToday: Maybe<number>; // no certified loader ⇒ UNKNOWN
  rewardsReady: Maybe<number>;
  completedCards: Maybe<number>;
  latestRegistrations: readonly RegistrationFact[] | null;
}

export interface AnalyticsFacts {
  configured: boolean;
  revenue: HomeTextStat;
  orders: HomeTextStat;
  averageOrder: HomeTextStat;
  inventoryValue: HomeTextStat;
}

export interface ActivityFact {
  id: string;
  at: string;
  type: string;
  sku: Maybe<string>;
  field: Maybe<string>;
  status: Maybe<string>;
}

export interface ChannelReadyFact {
  key: string;
  label: string;
  ready: Maybe<number>;
  href: string;
}

export interface LaunchReadinessFacts {
  exportReady: Maybe<number>; // certified export-readiness baseline (eligible)
  blocked: Maybe<number>; // certified export-readiness baseline (blocked)
  channels: readonly ChannelReadyFact[]; // per-channel READY = certified active-mapping count
  criticalBlockers: Maybe<number>; // Action Center summary.critical
  missingPrice: Maybe<number>;
  missingImage: Maybe<number>;
  missingCategory: Maybe<number>;
  variantProblems: Maybe<number>; // certified readiness reason "missing_variants"
  needsReview: Maybe<number>; // ECL needs_review across channels
  lifecycleBlocked: Maybe<number>; // OPS.8 lifecycle STOPPED
  availabilityBlocked: Maybe<number>; // Availability Engine OutOfStock
}

export interface HomeFacts {
  now: string; // ISO string
  ownerName: string;
  launchReadiness: LaunchReadinessFacts | null;
  actions: ActionFacts | null;
  lifecycle: LifecycleFacts | null;
  catalog: CatalogFacts | null;
  health: HealthFacts | null;
  evidence: EvidenceFacts | null;
  recommendations: RecommendationFacts | null;
  channels: readonly ChannelFacts[] | null;
  exports: ExportFacts | null;
  ai: AiFacts | null;
  rewards: RewardsFacts | null;
  analytics: AnalyticsFacts | null;
  activity: readonly ActivityFact[] | null;
  generatedAt: string | null;
}

// ── Section view-models ────────────────────────────────────────────────────────

export interface WelcomeVM {
  greeting: string;
  ownerName: string;
  dateLabel: string;
  platformStatus: { label: string; tone: HomeTone };
}

export interface OverviewVM {
  cards: HomeStat[];
}

export interface ActionCenterVM {
  cards: HomeStat[];
  href: string;
  available: boolean;
}

export interface CatalogVM {
  cards: HomeStat[];
  available: boolean;
}

export interface ChannelHealthVM {
  channels: ChannelFacts[];
  available: boolean;
}

export interface ExportOverviewVM {
  cards: HomeStat[];
  runs: ExportRunFact[];
  historyAvailable: boolean;
  available: boolean;
}

export interface AiOverviewVM {
  cards: HomeStat[];
  provider: { label: string; tone: HomeTone; configured: boolean };
  available: boolean;
}

export interface RewardsVM {
  cards: HomeStat[];
  latestRegistrations: RegistrationFact[];
  available: boolean;
}

export interface IntelligenceVM {
  healthDistribution: { grade: string; label: string; count: number }[];
  averageScore: Maybe<number>;
  evidenceBySeverity: { severity: string; label: string; count: number }[];
  recommendationsByPriority: { priority: string; label: string; count: number }[];
  available: boolean;
}

export interface AnalyticsVM {
  cards: HomeTextStat[];
  configured: boolean;
}

export interface ActivityVM {
  events: ActivityFact[];
  available: boolean;
}

export interface QuickAction {
  key: string;
  label: string;
  href: string;
}

export interface LaunchReadinessVM {
  readinessPct: Maybe<number>;
  headline: HomeStat[];
  blockedSummary: HomeStat[];
  progress: {
    currentPct: Maybe<number>;
    targetPct: number;
    productsRemaining: Maybe<number>;
    estimatedRemainingWork: Maybe<number>; // deterministic sum of open blocker items
  };
  available: boolean;
}

export interface HomeDashboardModel {
  launchReadiness: LaunchReadinessVM;
  welcome: WelcomeVM;
  overview: OverviewVM;
  actionCenter: ActionCenterVM;
  catalog: CatalogVM;
  channelHealth: ChannelHealthVM;
  exportOverview: ExportOverviewVM;
  aiOverview: AiOverviewVM;
  rewards: RewardsVM;
  intelligence: IntelligenceVM;
  analytics: AnalyticsVM;
  activity: ActivityVM;
  quickActions: QuickAction[];
  generatedAt: string | null;
}

// ── helpers (presentation only) ────────────────────────────────────────────────

const isNum = (v: Maybe<number> | null | undefined): v is number =>
  typeof v === "number" && Number.isFinite(v);

/** UNKNOWN passes through untouched; a real number is returned as-is. */
function num(v: Maybe<number> | null | undefined): Maybe<number> {
  return isNum(v) ? v : UNKNOWN;
}

/** "attention" tone: warn/bad when a backlog count is > 0, else good; UNKNOWN⇒neutral. */
function attentionTone(v: Maybe<number>, bad = false): HomeTone {
  if (!isNum(v)) return "neutral";
  if (v <= 0) return "good";
  return bad ? "bad" : "warn";
}

// Malika's Universe operates in Qatar (UTC+3). Deriving the greeting/date from a
// FIXED zone (not the server's) keeps this pure module deterministic given its
// input — no hidden runtime-timezone dependency.
const QATAR_TZ = "Asia/Qatar";

function greetingFor(iso: string): string {
  // Presentation-only: time-of-day greeting from the provided timestamp, read in
  // Qatar time so it is stable regardless of where the server runs.
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "أهلاً";
  const h = (d.getUTCHours() + 3) % 24; // UTC+3 = Qatar
  if (h < 12) return "صباح الخير";
  return "مساء الخير";
}

function dateLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("ar-QA", { timeZone: QATAR_TZ, weekday: "long", year: "numeric", month: "long", day: "numeric" });
}

const GRADE_LABEL: Record<string, string> = {
  Excellent: "ممتاز", Good: "جيد", Fair: "مقبول", Poor: "ضعيف", Critical: "حرج",
};
const GRADE_ORDER = ["Excellent", "Good", "Fair", "Poor", "Critical"] as const;

const SEVERITY_LABEL: Record<string, string> = {
  CRITICAL: "حرج", ERROR: "خطأ", WARNING: "تحذير", INFO: "معلومة",
};
const SEVERITY_ORDER = ["CRITICAL", "ERROR", "WARNING", "INFO"] as const;

const PRIORITY_LABEL: Record<string, string> = {
  CRITICAL: "حرج", HIGH: "عالٍ", MEDIUM: "متوسط", LOW: "منخفض",
};
const PRIORITY_ORDER = ["CRITICAL", "HIGH", "MEDIUM", "LOW"] as const;

/** Platform status from the certified catalog-health average score (CAT.1A). */
function platformStatus(score: Maybe<number>): { label: string; tone: HomeTone } {
  if (!isNum(score)) return { label: "غير معروف", tone: "neutral" };
  if (score >= 90) return { label: "ممتاز", tone: "good" };
  if (score >= 75) return { label: "جيد", tone: "good" };
  if (score >= 55) return { label: "مقبول", tone: "warn" };
  if (score >= 30) return { label: "يحتاج انتباه", tone: "warn" };
  return { label: "حرج", tone: "bad" };
}

const PROVIDER_LABEL: Record<string, { label: string; tone: HomeTone }> = {
  AVAILABLE: { label: "متصل", tone: "good" },
  DEGRADED: { label: "متذبذب", tone: "warn" },
  UNAVAILABLE: { label: "غير مهيأ", tone: "bad" },
};

/** Deep-links to EXISTING pages (no new workflows). */
const BLOCKER_HREF = {
  price: "/v2/catalog",
  image: "/v2/operations/media",
  category: "/v2/catalog",
  variants: "/v2/catalog",
  needs_review: "/v2/export/rafeeq:malikas",
  lifecycle: "/v2/operations",
  availability: "/v2/operations/availability-sync",
} as const;

const channelReadyHref = (key: string): string => `/v2/export/${encodeURIComponent(key)}`;

/** Sum only the numeric (non-UNKNOWN) blocker counts — deterministic, no estimation. */
function sumKnown(values: readonly Maybe<number>[]): Maybe<number> {
  const nums = values.filter(isNum);
  if (nums.length === 0) return UNKNOWN;
  return nums.reduce((a, b) => a + b, 0);
}

export function buildLaunchReadiness(lr: LaunchReadinessFacts | null): LaunchReadinessVM {
  if (!lr) {
    return {
      readinessPct: UNKNOWN,
      headline: [],
      blockedSummary: [],
      progress: { currentPct: UNKNOWN, targetPct: 100, productsRemaining: UNKNOWN, estimatedRemainingWork: UNKNOWN },
      available: false,
    };
  }
  const ready = num(lr.exportReady);
  const blocked = num(lr.blocked);
  const total = isNum(ready) && isNum(blocked) ? ready + blocked : null;
  const readinessPct: Maybe<number> = total != null && total > 0 ? Math.round((ready as number) / total * 100) : UNKNOWN;

  const chan = Array.isArray(lr.channels) ? lr.channels : [];
  const byKey = (k: string) => chan.find((c) => c.key === k);
  const channelCard = (key: string, label: string): HomeStat => {
    const c = byKey(key);
    return { key: `ready_${key}`, label, value: c ? num(c.ready) : UNKNOWN, tone: "good", href: c ? c.href : channelReadyHref(key) };
  };

  const headline: HomeStat[] = [
    { key: "readiness_pct", label: "جاهزية الإطلاق ٪", value: readinessPct, tone: readinessPct === UNKNOWN ? "neutral" : (readinessPct >= 90 ? "good" : readinessPct >= 60 ? "warn" : "bad") },
    { key: "export_ready", label: "جاهز للنشر", value: ready, tone: "good", href: "/v2/export" },
    { key: "blocked_products", label: "منتجات محظورة", value: blocked, tone: attentionTone(blocked, true), href: "/v2/export" },
    channelCard("shopify:malikas", "Shopify جاهز"),
    channelCard("talabat:malikas", "Talabat جاهز"),
    channelCard("snoonu:malikas", "Snoonu Malikas جاهز"),
    channelCard("snoonu:pure_seoul", "Snoonu Pure Seoul جاهز"),
    channelCard("rafeeq:malikas", "Rafeeq جاهز"),
    { key: "critical_blockers", label: "معوّقات حرجة", value: num(lr.criticalBlockers), tone: attentionTone(num(lr.criticalBlockers), true), href: "/v2/actions" },
  ];

  const blockedSummary: HomeStat[] = [
    { key: "missing_price", label: "سعر ناقص", value: num(lr.missingPrice), tone: attentionTone(num(lr.missingPrice), true), href: BLOCKER_HREF.price },
    { key: "missing_image", label: "صورة ناقصة", value: num(lr.missingImage), tone: attentionTone(num(lr.missingImage), true), href: BLOCKER_HREF.image },
    { key: "missing_category", label: "تصنيف ناقص", value: num(lr.missingCategory), tone: attentionTone(num(lr.missingCategory)), href: BLOCKER_HREF.category },
    { key: "variant_problems", label: "مشاكل الخيارات", value: num(lr.variantProblems), tone: attentionTone(num(lr.variantProblems)), href: BLOCKER_HREF.variants },
    { key: "needs_review", label: "بحاجة مراجعة", value: num(lr.needsReview), tone: attentionTone(num(lr.needsReview)), href: BLOCKER_HREF.needs_review },
    { key: "lifecycle_blocked", label: "محظور دورة الحياة", value: num(lr.lifecycleBlocked), tone: attentionTone(num(lr.lifecycleBlocked)), href: BLOCKER_HREF.lifecycle },
    { key: "availability_blocked", label: "محظور التوفّر", value: num(lr.availabilityBlocked), tone: attentionTone(num(lr.availabilityBlocked)), href: BLOCKER_HREF.availability },
  ];

  const estimatedRemainingWork = sumKnown([
    lr.missingPrice, lr.missingImage, lr.missingCategory, lr.variantProblems,
    lr.needsReview, lr.lifecycleBlocked, lr.availabilityBlocked,
  ]);

  return {
    readinessPct,
    headline,
    blockedSummary,
    progress: {
      currentPct: readinessPct,
      targetPct: 100,
      productsRemaining: blocked,
      estimatedRemainingWork,
    },
    available: true,
  };
}

// ── the composer ───────────────────────────────────────────────────────────────

export function buildHomeDashboard(facts: HomeFacts): HomeDashboardModel {
  const f = facts ?? ({} as HomeFacts);
  const now = typeof f.now === "string" && f.now ? f.now : new Date(0).toISOString();

  const welcome: WelcomeVM = {
    greeting: greetingFor(now),
    ownerName: typeof f.ownerName === "string" && f.ownerName ? f.ownerName : "",
    dateLabel: dateLabel(now),
    platformStatus: platformStatus(f.health?.averageScore ?? UNKNOWN),
  };

  // SECTION 0 — Launch Readiness (top KPI). Deterministic; composed from certified
  // facts only (export-readiness baseline, channel mappings, catalog gaps, the
  // certified readiness/lifecycle/availability signals). No new rules, no estimation.
  const launchReadiness = buildLaunchReadiness(f.launchReadiness ?? null);

  // SECTION 2 — Today's Overview
  const overview: OverviewVM = {
    cards: [
      { key: "critical_actions", label: "إجراءات حرجة", value: num(f.actions?.critical), tone: attentionTone(num(f.actions?.critical), true), href: "/v2/actions" },
      { key: "need_approval", label: "بانتظار الاعتماد", value: num(f.actions?.approvalRequired), tone: attentionTone(num(f.actions?.approvalRequired)), href: "/v2/actions" },
      { key: "ready_activation", label: "جاهز للتفعيل", value: num(f.lifecycle?.ready), tone: "good", href: "/v2/operations" },
      { key: "platform_health", label: "صحة المنصة ٪", value: num(f.health?.averageScore), tone: platformStatus(f.health?.averageScore ?? UNKNOWN).tone, href: "/v2/operations/health" },
    ],
  };

  // SECTION 3 — Action Center summary
  const actionCenter: ActionCenterVM = {
    available: f.actions != null,
    href: "/v2/actions",
    cards: [
      { key: "critical", label: "حرج", value: num(f.actions?.critical), tone: attentionTone(num(f.actions?.critical), true) },
      { key: "high", label: "عالٍ", value: num(f.actions?.high), tone: attentionTone(num(f.actions?.high)) },
      { key: "medium", label: "متوسط", value: num(f.actions?.medium), tone: "neutral" },
      { key: "waiting", label: "بالانتظار", value: num(f.actions?.waiting), tone: "neutral" },
      { key: "completed_today", label: "أُنجز اليوم", value: num(f.actions?.completedToday), tone: "good" },
    ],
  };

  // SECTION 4 — Catalog overview
  const catalog: CatalogVM = {
    available: f.catalog != null || f.lifecycle != null,
    cards: [
      { key: "products", label: "المنتجات", value: num(f.catalog?.total), tone: "neutral", href: "/v2/catalog" },
      { key: "active", label: "مُفعّل", value: num(f.lifecycle?.active), tone: "good" },
      { key: "draft", label: "مسودة", value: num(f.lifecycle?.draft), tone: "neutral" },
      { key: "stopped", label: "موقوف", value: num(f.lifecycle?.stopped), tone: "warn" },
      { key: "ready", label: "جاهز للنشر", value: num(f.catalog?.ready), tone: "good" },
      { key: "blocked", label: "محظور", value: num(f.catalog?.blocked), tone: attentionTone(num(f.catalog?.blocked), true) },
      { key: "needs_image", label: "يحتاج صورة", value: num(f.catalog?.needsImage), tone: attentionTone(num(f.catalog?.needsImage)) },
      { key: "needs_category", label: "يحتاج تصنيف", value: num(f.catalog?.needsCategory), tone: attentionTone(num(f.catalog?.needsCategory)) },
      { key: "needs_price", label: "يحتاج سعر", value: num(f.catalog?.needsPrice), tone: attentionTone(num(f.catalog?.needsPrice)) },
      { key: "needs_brand", label: "يحتاج علامة", value: num(f.catalog?.needsBrand), tone: attentionTone(num(f.catalog?.needsBrand)) },
    ],
  };

  // SECTION 5 — Channel health
  const channelHealth: ChannelHealthVM = {
    available: Array.isArray(f.channels) && f.channels.length > 0,
    channels: Array.isArray(f.channels) ? [...f.channels] : [],
  };

  // SECTION 6 — Export overview
  const exportOverview: ExportOverviewVM = {
    available: f.exports != null,
    historyAvailable: Boolean(f.exports?.historyAvailable),
    runs: Array.isArray(f.exports?.runs) ? [...(f.exports?.runs ?? [])] : [],
    cards: [
      { key: "eligible", label: "مؤهّل للنشر", value: num(f.exports?.eligible), tone: "good" },
      { key: "blocked", label: "محظور", value: num(f.exports?.blocked), tone: attentionTone(num(f.exports?.blocked), true) },
      { key: "pending", label: "قيد التنفيذ", value: num(f.exports?.pending), tone: "neutral" },
      { key: "failed", label: "فشل", value: num(f.exports?.failed), tone: attentionTone(num(f.exports?.failed), true) },
      { key: "completed", label: "مكتمل", value: num(f.exports?.completed), tone: "good" },
    ],
  };

  // SECTION 7 — AI overview
  const providerState = typeof f.ai?.providerState === "string" ? f.ai!.providerState : "UNAVAILABLE";
  const provider = PROVIDER_LABEL[providerState] ?? PROVIDER_LABEL.UNAVAILABLE;
  const aiOverview: AiOverviewVM = {
    available: f.ai != null,
    provider: { label: provider.label, tone: provider.tone, configured: Boolean(f.ai?.providerConfigured) },
    cards: [
      { key: "need_generation", label: "يحتاج توليد", value: num(f.ai?.needGeneration), tone: attentionTone(num(f.ai?.needGeneration)), href: "/v2/operations/ai" },
      { key: "need_review", label: "يحتاج مراجعة", value: num(f.ai?.needReview), tone: "neutral", href: "/v2/operations/ai" },
      { key: "ready_apply", label: "جاهز للتطبيق", value: num(f.ai?.readyApply), tone: "good", href: "/v2/operations/ai" },
    ],
  };

  // SECTION 8 — Beauty Rewards
  const rewards: RewardsVM = {
    available: f.rewards != null,
    latestRegistrations: Array.isArray(f.rewards?.latestRegistrations) ? [...(f.rewards?.latestRegistrations ?? [])] : [],
    cards: [
      { key: "members", label: "الأعضاء المسجّلون", value: num(f.rewards?.registeredMembers), tone: "neutral", href: "/v2/loyalty/customers" },
      { key: "pending_reviews", label: "مراجعات معلّقة", value: num(f.rewards?.pendingReviews), tone: attentionTone(num(f.rewards?.pendingReviews)), href: "/v2/loyalty" },
      { key: "hearts_today", label: "قلوب اعتُمدت اليوم", value: num(f.rewards?.heartsApprovedToday), tone: "neutral" },
      { key: "rewards_ready", label: "مكافآت جاهزة", value: num(f.rewards?.rewardsReady), tone: "good", href: "/v2/loyalty" },
      { key: "completed_cards", label: "بطاقات مكتملة", value: num(f.rewards?.completedCards), tone: "good" },
    ],
  };

  // SECTION 9 — Catalog intelligence (CAT.1A–E rollups)
  const byGrade = f.health?.byGrade ?? null;
  const bySeverity = f.evidence?.bySeverity ?? null;
  const byPriority = f.recommendations?.byPriority ?? null;
  const intelligence: IntelligenceVM = {
    available: byGrade != null || bySeverity != null || byPriority != null,
    averageScore: num(f.health?.averageScore),
    healthDistribution: byGrade
      ? GRADE_ORDER.map((g) => ({ grade: g, label: GRADE_LABEL[g] ?? g, count: Number(byGrade[g] ?? 0) }))
      : [],
    evidenceBySeverity: bySeverity
      ? SEVERITY_ORDER.map((s) => ({ severity: s, label: SEVERITY_LABEL[s] ?? s, count: Number(bySeverity[s] ?? 0) }))
      : [],
    recommendationsByPriority: byPriority
      ? PRIORITY_ORDER.map((p) => ({ priority: p, label: PRIORITY_LABEL[p] ?? p, count: Number(byPriority[p] ?? 0) }))
      : [],
  };

  // SECTION 10 — Analytics (honest: UNKNOWN where no source exists)
  const analytics: AnalyticsVM = {
    configured: Boolean(f.analytics?.configured),
    cards: f.analytics
      ? [f.analytics.revenue, f.analytics.orders, f.analytics.averageOrder, f.analytics.inventoryValue]
      : [],
  };

  // SECTION 11 — Recent activity
  const activity: ActivityVM = {
    available: Array.isArray(f.activity),
    events: Array.isArray(f.activity) ? [...f.activity] : [],
  };

  // SECTION 12 — Quick actions
  const quickActions: QuickAction[] = [
    { key: "add_product", label: "إضافة منتج", href: "/v2/catalog/new" },
    { key: "export", label: "مركز التصدير", href: "/v2/export" },
    { key: "catalog", label: "الكتالوج", href: "/v2/catalog" },
    { key: "actions", label: "مركز الإجراءات", href: "/v2/actions" },
    { key: "operations", label: "العمليات", href: "/v2/operations" },
    { key: "rewards", label: "مكافآت الجمال", href: "/v2/loyalty" },
    { key: "analytics", label: "التحليلات", href: "/v2/analytics" },
  ];

  return {
    launchReadiness,
    welcome,
    overview,
    actionCenter,
    catalog,
    channelHealth,
    exportOverview,
    aiOverview,
    rewards,
    intelligence,
    analytics,
    activity,
    quickActions,
    generatedAt: f.generatedAt ?? null,
  };
}
