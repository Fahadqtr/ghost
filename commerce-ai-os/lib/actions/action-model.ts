// AI.1 — Unified Action Center: the pure Action model (registry, normalization,
// grouping, summary, filtering). Framework-free and side-effect free — no `@/`
// imports, no I/O, no clock, no randomness — so every rule here is directly
// unit-testable and can never itself scan a table or mutate anything.
//
// This is the SINGLE Action model every subsystem contributes to (§2). Detection
// logic is NOT duplicated here: the source adapters (action-sources.ts) translate
// the ALREADY-COMPUTED outputs of the certified OPS/BI readers into this shape.

// ── the action taxonomy (§4 — support at minimum these types) ─────────────────
export const ACTION_TYPES = [
  "IMAGE_REQUIRED",
  "IMAGE_REPLACE",
  "DESCRIPTION_UPDATE",
  "KEYWORDS_UPDATE",
  "BARCODE_REQUIRED",
  "CHANNEL_REPUBLISH",
  "CHANNEL_CONFLICT",
  "PRICE_REVIEW",
  "ARCHIVE_CANDIDATE",
  "DELETE_CANDIDATE",
  "READY_FOR_ACTIVATION",
  "STOP_CANDIDATE",
  "RESTORE_CANDIDATE",
  "LOW_STOCK",
  "OUT_OF_STOCK",
  "HEALTH_ALERT",
  "MAPPING_REVIEW",
  "AI_REVIEW",
  "UNKNOWN",
] as const;

export type ActionType = (typeof ACTION_TYPES)[number];

/** Subsystems that contribute Actions (the certified read models — §3). */
export type ActionSource =
  | "ops_health"
  | "ops_media"
  | "ops_ai"
  | "ops_channels"
  | "missing_products"
  | "availability"
  | "barcode"
  | "ecl"
  | "analytics"
  | "lifecycle";

export type ActionSeverity = "critical" | "warning" | "info";
export type ActionConfidence = "high" | "medium" | "low";

/**
 * The dashboard lanes (§5 top summary). AI.1 is READ-ONLY, so these classify
 * where an item WOULD flow once execution exists — nothing is executed here.
 *   • critical           — urgent, owner must look now
 *   • approval_required  — needs owner review before it could ever run (owner-first, §7)
 *   • auto_eligible      — a future automation could run it safely (high-confidence, low-risk)
 *   • waiting            — blocked on an external state (e.g. no live channel session)
 *   • completed          — placeholder; execution/completion tracking arrives later
 */
export type ActionLane = "critical" | "approval_required" | "auto_eligible" | "waiting" | "completed";

export const ACTION_LANES: readonly ActionLane[] = [
  "critical",
  "approval_required",
  "auto_eligible",
  "waiting",
  "completed",
];

export interface ActionEvidence {
  label: string;
  value: string;
}

/** A single actionable item, contributed by exactly one source. */
export interface Action {
  /** Stable, deterministic id: `${type}:${source}:${entityId}` (no clock/random). */
  id: string;
  type: ActionType;
  source: ActionSource;
  severity: ActionSeverity;
  confidence: ActionConfidence;
  /** Derived lane (see {@link deriveLane}). */
  lane: ActionLane;
  /** Short AR title. */
  title: string;
  /** Why this surfaced (§6 Reason). */
  reason: string;
  /** Supporting facts (§6 Evidence). */
  evidence: ActionEvidence[];
  /** §6 Current State — null when not applicable. */
  currentState: string | null;
  /** §6 Suggested State — null when not applicable. */
  suggestedState: string | null;
  /** Human impact of acting (§8 drawer). Null when not applicable. */
  impact?: string | null;
  /** The product/entity this concerns, or null for catalog-wide actions. */
  entityId: string | null;
  entityLabel: string | null;
  /** §6 Open Original Workflow — an EXISTING route only; never an executor. */
  workflowHref: string | null;
}

/** The shape a source adapter emits; `lane` is derived by {@link normalizeAction}. */
export type ActionInput = Omit<Action, "lane" | "severity"> & {
  /** Optional override; defaults to the registry's severity for the type. */
  severity?: ActionSeverity;
  /** Blocked on an external state → the "waiting" lane. */
  blocked?: boolean;
};

// ── the Action Registry (§2 — one entry per type) ─────────────────────────────
export interface ActionTypeSpec {
  /** AR label shown as the group heading. */
  label: string;
  /** Severity used when a source does not specify one. */
  defaultSeverity: ActionSeverity;
  /** True when a future automation could run this type without owner approval. */
  autoEligible: boolean;
  /** The EXISTING workflow this action delegates to (§6 Open Original Workflow). */
  workflow: string;
}

export const ACTION_REGISTRY: Record<ActionType, ActionTypeSpec> = {
  IMAGE_REQUIRED: { label: "صورة مطلوبة", defaultSeverity: "warning", autoEligible: false, workflow: "/v2/operations/media" },
  IMAGE_REPLACE: { label: "استبدال صورة", defaultSeverity: "info", autoEligible: true, workflow: "/v2/operations/media" },
  DESCRIPTION_UPDATE: { label: "تحديث الوصف", defaultSeverity: "info", autoEligible: true, workflow: "/v2/operations/ai" },
  KEYWORDS_UPDATE: { label: "تحديث الكلمات المفتاحية", defaultSeverity: "info", autoEligible: true, workflow: "/v2/operations/ai" },
  BARCODE_REQUIRED: { label: "باركود مطلوب", defaultSeverity: "warning", autoEligible: false, workflow: "/v2/operations/barcode-completion" },
  CHANNEL_REPUBLISH: { label: "إعادة نشر على القناة", defaultSeverity: "warning", autoEligible: false, workflow: "/v2/operations/channels" },
  CHANNEL_CONFLICT: { label: "تعارض في القناة", defaultSeverity: "critical", autoEligible: false, workflow: "/v2/operations/channels" },
  PRICE_REVIEW: { label: "مراجعة السعر", defaultSeverity: "warning", autoEligible: false, workflow: "/v2/analytics" },
  ARCHIVE_CANDIDATE: { label: "مرشّح للأرشفة", defaultSeverity: "warning", autoEligible: false, workflow: "/v2/catalog" },
  DELETE_CANDIDATE: { label: "مرشّح للحذف", defaultSeverity: "critical", autoEligible: false, workflow: "/v2/catalog" },
  READY_FOR_ACTIVATION: { label: "جاهز للتفعيل", defaultSeverity: "info", autoEligible: false, workflow: "/v2/catalog" },
  STOP_CANDIDATE: { label: "مرشّح للإيقاف", defaultSeverity: "warning", autoEligible: false, workflow: "/v2/catalog" },
  RESTORE_CANDIDATE: { label: "مرشّح للاسترجاع", defaultSeverity: "info", autoEligible: false, workflow: "/products/archive" },
  LOW_STOCK: { label: "مخزون منخفض", defaultSeverity: "warning", autoEligible: false, workflow: "/v2/operations/availability-sync" },
  OUT_OF_STOCK: { label: "نفد المخزون", defaultSeverity: "critical", autoEligible: false, workflow: "/v2/operations/availability-sync" },
  HEALTH_ALERT: { label: "تنبيه صحّة المنصة", defaultSeverity: "warning", autoEligible: false, workflow: "/v2/operations/health" },
  MAPPING_REVIEW: { label: "مراجعة الربط", defaultSeverity: "warning", autoEligible: false, workflow: "/v2/operations/channels" },
  AI_REVIEW: { label: "مراجعة الذكاء الاصطناعي", defaultSeverity: "warning", autoEligible: false, workflow: "/v2/operations/ai" },
  UNKNOWN: { label: "غير محدد", defaultSeverity: "info", autoEligible: false, workflow: "/v2/actions" },
};

/** Position of a type in the canonical (§4) order — used to order groups. */
export function actionTypeOrder(type: ActionType): number {
  const i = ACTION_TYPES.indexOf(type);
  return i === -1 ? ACTION_TYPES.length : i;
}

// ── deterministic ranking ─────────────────────────────────────────────────────
export const SEVERITY_RANK: Record<ActionSeverity, number> = { critical: 3, warning: 2, info: 1 };
export const CONFIDENCE_RANK: Record<ActionConfidence, number> = { high: 3, medium: 2, low: 1 };

function isActionType(v: unknown): v is ActionType {
  return typeof v === "string" && (ACTION_TYPES as readonly string[]).includes(v);
}

/**
 * The lane an action belongs to (§5). Critical always wins so nothing urgent is
 * hidden; otherwise a blocked item waits, an auto-eligible high-confidence item
 * is auto-eligible, and everything else needs owner approval (owner-first, §7).
 */
export function deriveLane(a: {
  severity: ActionSeverity;
  confidence: ActionConfidence;
  type: ActionType;
  blocked?: boolean;
}): ActionLane {
  if (a.severity === "critical") return "critical";
  if (a.blocked === true) return "waiting";
  if (ACTION_REGISTRY[a.type]?.autoEligible && a.confidence === "high") return "auto_eligible";
  return "approval_required";
}

/**
 * Normalize a source-emitted ActionInput into a full Action: resolve the type
 * (unrecognized → UNKNOWN), apply the registry's default severity when the source
 * gave none, and derive the lane. Pure and total — never throws.
 */
export function normalizeAction(input: ActionInput): Action {
  const type: ActionType = isActionType(input.type) ? input.type : "UNKNOWN";
  const severity: ActionSeverity = input.severity ?? ACTION_REGISTRY[type].defaultSeverity;
  const confidence: ActionConfidence = input.confidence ?? "medium";
  const lane = deriveLane({ severity, confidence, type, blocked: input.blocked });
  return {
    id: input.id,
    type,
    source: input.source,
    severity,
    confidence,
    lane,
    title: input.title,
    reason: input.reason,
    evidence: Array.isArray(input.evidence) ? input.evidence : [],
    currentState: input.currentState ?? null,
    suggestedState: input.suggestedState ?? null,
    impact: input.impact ?? null,
    entityId: input.entityId ?? null,
    entityLabel: input.entityLabel ?? null,
    workflowHref: input.workflowHref ?? ACTION_REGISTRY[type].workflow,
  };
}

/** Sort by severity desc, then confidence desc, then §4 type order, then id. */
export function sortActions(actions: readonly Action[]): Action[] {
  return [...actions].sort((a, b) => {
    const sev = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
    if (sev !== 0) return sev;
    const conf = CONFIDENCE_RANK[b.confidence] - CONFIDENCE_RANK[a.confidence];
    if (conf !== 0) return conf;
    const ord = actionTypeOrder(a.type) - actionTypeOrder(b.type);
    if (ord !== 0) return ord;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

// ── grouping (§5 grouped by Action Type) ──────────────────────────────────────
export interface ActionGroup {
  type: ActionType;
  label: string;
  /** The highest severity among the group's actions. */
  severity: ActionSeverity;
  count: number;
  actions: Action[];
}

export function groupActionsByType(actions: readonly Action[]): ActionGroup[] {
  const byType = new Map<ActionType, Action[]>();
  for (const a of actions) {
    const list = byType.get(a.type);
    if (list) list.push(a);
    else byType.set(a.type, [a]);
  }
  const groups: ActionGroup[] = [];
  for (const [type, list] of byType) {
    const severity = list.reduce<ActionSeverity>(
      (worst, a) => (SEVERITY_RANK[a.severity] > SEVERITY_RANK[worst] ? a.severity : worst),
      "info",
    );
    groups.push({ type, label: ACTION_REGISTRY[type].label, severity, count: list.length, actions: sortActions(list) });
  }
  return groups.sort((a, b) => actionTypeOrder(a.type) - actionTypeOrder(b.type));
}

// ── summary (§5 top summary) ──────────────────────────────────────────────────
export interface ActionSummary {
  critical: number;
  approvalRequired: number;
  autoEligible: number;
  waiting: number;
  /** Placeholder — execution/completion tracking is not part of AI.1. Always 0. */
  completedToday: number;
  total: number;
}

export function summarizeActions(actions: readonly Action[]): ActionSummary {
  const summary: ActionSummary = {
    critical: 0,
    approvalRequired: 0,
    autoEligible: 0,
    waiting: 0,
    completedToday: 0,
    total: actions.length,
  };
  for (const a of actions) {
    if (a.lane === "critical") summary.critical += 1;
    else if (a.lane === "approval_required") summary.approvalRequired += 1;
    else if (a.lane === "auto_eligible") summary.autoEligible += 1;
    else if (a.lane === "waiting") summary.waiting += 1;
  }
  return summary;
}

// ── filtering (§11 Filters) ───────────────────────────────────────────────────
export interface ActionFilter {
  lane?: ActionLane | null;
  type?: ActionType | null;
  severity?: ActionSeverity | null;
  source?: ActionSource | null;
  confidence?: ActionConfidence | null;
  /** Case-insensitive substring over title / reason / entityLabel. */
  query?: string | null;
}

export function filterActions(actions: readonly Action[], filter: ActionFilter = {}): Action[] {
  const q = typeof filter.query === "string" ? filter.query.trim().toLowerCase() : "";
  return actions.filter((a) => {
    if (filter.lane && a.lane !== filter.lane) return false;
    if (filter.type && a.type !== filter.type) return false;
    if (filter.severity && a.severity !== filter.severity) return false;
    if (filter.source && a.source !== filter.source) return false;
    if (filter.confidence && a.confidence !== filter.confidence) return false;
    if (q !== "") {
      const hay = `${a.title} ${a.reason} ${a.entityLabel ?? ""}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

// ── the aggregated read model (§8 one aggregated view) ────────────────────────
export interface ActionSourceStatus {
  source: ActionSource;
  ok: boolean;
  count: number;
}

export interface ActionCenterView {
  summary: ActionSummary;
  groups: ActionGroup[];
  actions: Action[];
  /** Per-source health so degraded sources are visible, never silently empty. */
  sources: ActionSourceStatus[];
  generatedAt: string | null;
}

/**
 * Build the whole Action Center view from source-emitted inputs. Normalizes each
 * input, de-duplicates by id (a stable id means the same finding from two reads
 * collapses to one), sorts, groups by type and summarizes. `generatedAt` is
 * passed in — the pure layer owns no clock.
 */
export function buildActionCenter(
  inputs: readonly ActionInput[],
  opts: { sources?: readonly ActionSourceStatus[]; generatedAt?: string | null } = {},
): ActionCenterView {
  const seen = new Set<string>();
  const actions: Action[] = [];
  for (const input of Array.isArray(inputs) ? inputs : []) {
    if (input === null || typeof input !== "object") continue;
    const action = normalizeAction(input);
    if (seen.has(action.id)) continue;
    seen.add(action.id);
    actions.push(action);
  }
  const sorted = sortActions(actions);
  return {
    summary: summarizeActions(sorted),
    groups: groupActionsByType(sorted),
    actions: sorted,
    sources: opts.sources ? [...opts.sources] : [],
    generatedAt: opts.generatedAt ?? null,
  };
}
