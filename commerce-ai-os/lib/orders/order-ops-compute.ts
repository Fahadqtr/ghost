// Unified Order Operations & Reconciliation — PURE compute (Phase 2B.1).
//
// DB-free, network-free, framework-free. No "server-only", no "@/" imports, no
// Supabase/Shopify/Talabat clients, no fetch, no Date.now() — so node:test can
// import it directly. It ONLY normalizes already-persisted, classified order
// fields into a PII-safe unified projection; it never reads or emits raw payloads
// (talabat_orders.raw, deduction_result.products, line items, customer, phone,
// email, address, tokens, headers). Callers pass ONLY the whitelisted columns
// below; any extra keys on the input objects are ignored, never copied out.

// ── Whitelisted inputs (mirror the real, non-sensitive columns only) ─────────

export interface TalabatOrderInput {
  id: string;
  order_code?: string | null;
  event?: string | null;
  processing_status?: string | null; // pending | processed | manual_review | failed
  processed_at?: string | null;
  created_at?: string | null;
  resolution?: unknown; // jsonb — ONLY resolution.reason (a classified string) is read
  /** Optional, caller-supplied CLASSIFIED void state. Never a raw payload. */
  refunded?: boolean | null;
}

export interface ShopifyLedgerInput {
  order_id: string;
  order_name?: string | null;
  channel?: string | null; // "talabat" | "shopify"
  payment_gateway_names?: unknown; // read only to confirm channel; never projected
  deducted?: number | null;
  processing_status?: string | null; // pending | completed
  processed_at?: string | null;
  synced_at?: string | null;
  deduction_result?: unknown; // jsonb — ONLY .status and numeric .deducted are read
  /** Optional, caller-supplied CLASSIFIED void state. Never a raw payload. */
  refunded?: boolean | null;
}

// ── Unified projection ───────────────────────────────────────────────────────

export type OrderOpsSource = "talabat" | "shopify";
export type OrderOpsChannel = "talabat" | "shopify";
export type OrderOpsStatus =
  | "pending"
  | "processed"
  | "baseline"
  | "manual_review"
  | "failed"
  | "blocked"
  | "unknown";

export type SignalKind =
  | "manual_review"
  | "unmatched"
  | "possible_duplicate"
  | "under_deduction"
  | "void_or_refunded"
  | "blocked"
  | "malformed_result";

export type SignalState = "flagged" | "clear" | "unknown";

export interface ReconciliationSignal {
  kind: SignalKind;
  state: SignalState;
}

export interface OrderOpsRow {
  source: OrderOpsSource;
  sourceOrderId: string;
  displayOrderCode: string;
  channel: OrderOpsChannel;
  status: OrderOpsStatus;
  reasonCode: string | null;
  deducted: number;
  createdAt: string | null;
  processedAt: string | null;
  signals: ReconciliationSignal[];
}

// The EXACT set of keys an OrderOpsRow may ever contain (used by the safety test).
export const ORDER_OPS_ROW_KEYS: readonly string[] = [
  "source",
  "sourceOrderId",
  "displayOrderCode",
  "channel",
  "status",
  "reasonCode",
  "deducted",
  "createdAt",
  "processedAt",
  "signals",
];

// Deterministic signal order for stable output.
const SIGNAL_ORDER: SignalKind[] = [
  "manual_review",
  "unmatched",
  "possible_duplicate",
  "under_deduction",
  "void_or_refunded",
  "blocked",
  "malformed_result",
];

// ── Classified reason whitelists (never leak arbitrary text) ─────────────────

// The real classified reasons persisted by the Talabat processor (KNOWN_REASONS).
const TALABAT_REASONS = new Set<string>([
  "auto_deduct_misconfigured",
  "event_not_allowed",
  "talabat_channel_unresolved",
  "context_unavailable",
  "weak_order_identity",
  "empty_order",
  "invalid_quantity",
  "inactive_mapping",
  "ambiguous_match",
  "conflicting_identifiers",
  "title_only_match",
  "unmatched",
  "inventory_inconsistent",
  "invalid_plan",
  "insufficient_stock",
  "duplicate_order",
  "rpc_failed",
  "schedule_failed",
  "processing_failed",
  "manual_review",
]);

// Classified reasons the Shopify path can produce (deduction_result.status +
// fail-closed block reasons the ops layer may be handed explicitly).
const SHOPIFY_REASONS = new Set<string>([
  "baseline_recorded",
  "already_processed",
  "unmatched_order",
  "orders_truncated",
  "line_items_truncated",
  "migration_required",
  "db_error",
  "unknown_response",
]);

// Shopify block reasons that map to the "blocked" status when handed in.
const SHOPIFY_BLOCK_REASONS = new Set<string>([
  "unmatched_order",
  "orders_truncated",
  "line_items_truncated",
  "migration_required",
  "db_error",
  "unknown_response",
]);

const UNMATCHED_REASONS = new Set<string>(["unmatched", "unmatched_order"]);
const UNKNOWN_REASON = "unknown_reason";

// ── Small safe helpers ───────────────────────────────────────────────────────

function safeString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}
function safeLower(v: unknown): string {
  return typeof v === "string" ? v.trim().toLowerCase() : "";
}
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function finiteNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Read ONLY the classified reason string from a Talabat resolution object. */
function talabatReason(resolution: unknown): { reasonCode: string | null; shapeInvalid: boolean } {
  if (resolution === null || resolution === undefined) return { reasonCode: null, shapeInvalid: false };
  if (!isPlainObject(resolution)) return { reasonCode: null, shapeInvalid: true }; // array/string/number = malformed
  const r = resolution["reason"];
  if (typeof r !== "string") return { reasonCode: null, shapeInvalid: false };
  return { reasonCode: TALABAT_REASONS.has(r) ? r : UNKNOWN_REASON, shapeInvalid: false };
}

/** Read ONLY status + numeric deducted from a Shopify deduction_result object. */
function shopifyResult(deductionResult: unknown): {
  present: boolean;
  shapeInvalid: boolean;
  status: string | null;
  deducted: number | null;
} {
  const present = deductionResult !== null && deductionResult !== undefined;
  if (!present) return { present: false, shapeInvalid: false, status: null, deducted: null };
  if (!isPlainObject(deductionResult)) return { present: true, shapeInvalid: true, status: null, deducted: null };
  const status = safeString(deductionResult["status"]);
  const deducted = finiteNumber(deductionResult["deducted"]);
  return { present: true, shapeInvalid: false, status, deducted };
}

// ── Status normalization ─────────────────────────────────────────────────────

function normalizeTalabatStatus(processingStatus: unknown): OrderOpsStatus {
  switch (safeLower(processingStatus)) {
    case "processed":
      return "processed";
    case "manual_review":
      return "manual_review";
    case "failed":
      return "failed";
    case "pending":
      return "pending";
    default:
      return "unknown";
  }
}

/**
 * Shopify status. A committed deduction is proven ONLY by a valid
 * deduction_result — processing_status='completed' alone (missing/invalid result)
 * is NEVER treated as processed.
 */
function normalizeShopifyStatus(
  processingStatus: unknown,
  res: ReturnType<typeof shopifyResult>,
): { status: OrderOpsStatus; malformed: boolean } {
  if (res.shapeInvalid) return { status: "unknown", malformed: true };
  if (res.present && res.status) {
    const s = res.status;
    if (s === "processed" || s === "already_processed") return { status: "processed", malformed: false };
    if (s === "baseline_recorded") return { status: "baseline", malformed: false };
    if (s === "error") return { status: "failed", malformed: false };
    if (SHOPIFY_BLOCK_REASONS.has(s)) return { status: "blocked", malformed: false };
    return { status: "unknown", malformed: true }; // unrecognized status value
  }
  // No usable result object.
  const ps = safeLower(processingStatus);
  if (ps === "pending") return { status: "pending", malformed: false };
  if (ps === "completed") return { status: "unknown", malformed: true }; // completed but unproven → NOT processed
  return { status: "unknown", malformed: false };
}

// ── Reason classification ────────────────────────────────────────────────────

function shopifyReason(res: ReturnType<typeof shopifyResult>): string | null {
  if (res.shapeInvalid) return UNKNOWN_REASON;
  if (res.present && res.status) {
    const s = res.status;
    if (s === "baseline_recorded" || s === "already_processed") return s;
    if (SHOPIFY_REASONS.has(s)) return s; // block reasons
    if (s === "processed") return null;
    return UNKNOWN_REASON; // present but unrecognized status
  }
  return null;
}

// ── Reconciliation signals (per row; possible_duplicate resolved in batch) ───

function voidState(refunded: unknown): SignalState {
  if (refunded === true) return "flagged";
  if (refunded === false) return "clear";
  return "unknown"; // only classified when explicitly supplied
}

function underDeductionState(status: OrderOpsStatus, rowDeducted: number | null, resultDeducted: number | null): SignalState {
  // Only meaningful for a claimed-successful, non-baseline deduction.
  if (status !== "processed") return "clear"; // no success claimed → no silent under-deduction
  const evidence = rowDeducted !== null ? rowDeducted : resultDeducted;
  if (evidence === null) return "unknown"; // no numeric evidence → do not invent
  return evidence === 0 ? "flagged" : "clear"; // processed but zero rows deducted
}

function buildSignals(args: {
  status: OrderOpsStatus;
  reasonCode: string | null;
  malformed: boolean;
  refunded: unknown;
  rowDeducted: number | null;
  resultDeducted: number | null;
}): ReconciliationSignal[] {
  const { status, reasonCode, malformed, refunded, rowDeducted, resultDeducted } = args;

  const states: Record<SignalKind, SignalState> = {
    manual_review: status === "manual_review" ? "flagged" : status === "unknown" ? "unknown" : "clear",
    unmatched:
      reasonCode !== null && UNMATCHED_REASONS.has(reasonCode)
        ? "flagged"
        : status === "processed" || status === "baseline"
          ? "clear"
          : "unknown",
    possible_duplicate: "clear", // upgraded to flagged in buildOrderOpsRows when a key repeats
    under_deduction: underDeductionState(status, rowDeducted, resultDeducted),
    void_or_refunded: voidState(refunded),
    blocked: status === "blocked" ? "flagged" : status === "unknown" ? "unknown" : "clear",
    malformed_result: malformed ? "flagged" : "clear",
  };

  return SIGNAL_ORDER.map((kind) => ({ kind, state: states[kind] }));
}

// ── Single-row projectors ────────────────────────────────────────────────────

export function projectTalabatOrder(input: TalabatOrderInput): OrderOpsRow {
  const status = normalizeTalabatStatus(input.processing_status);
  const { reasonCode, shapeInvalid } = talabatReason(input.resolution);
  const signals = buildSignals({
    status,
    reasonCode,
    malformed: shapeInvalid,
    refunded: input.refunded,
    rowDeducted: null, // talabat row-level deducted count is not exposed at this layer
    resultDeducted: null,
  });
  return {
    source: "talabat",
    sourceOrderId: String(input.id ?? ""),
    displayOrderCode: safeString(input.order_code) ?? String(input.id ?? ""),
    channel: "talabat",
    status,
    reasonCode,
    deducted: 0,
    createdAt: safeString(input.created_at),
    processedAt: safeString(input.processed_at),
    signals,
  };
}

export function projectShopifyLedger(input: ShopifyLedgerInput): OrderOpsRow {
  const res = shopifyResult(input.deduction_result);
  const { status, malformed } = normalizeShopifyStatus(input.processing_status, res);
  const reasonCode = shopifyReason(res);
  const rowDeducted = finiteNumber(input.deducted);
  const channel: OrderOpsChannel = safeLower(input.channel) === "talabat" ? "talabat" : "shopify"; // unknown → safe default
  const signals = buildSignals({
    status,
    reasonCode,
    malformed,
    refunded: input.refunded,
    rowDeducted,
    resultDeducted: res.deducted,
  });
  return {
    source: "shopify",
    sourceOrderId: String(input.order_id ?? ""),
    displayOrderCode: safeString(input.order_name) ?? String(input.order_id ?? ""),
    channel,
    status,
    reasonCode,
    deducted: rowDeducted ?? 0,
    createdAt: safeString(input.synced_at),
    processedAt: safeString(input.processed_at),
    signals,
  };
}

// ── Batch build (resolves possible_duplicate on EXACT keys only) ─────────────

export interface OrderOpsInput {
  talabat?: TalabatOrderInput[] | null;
  shopify?: ShopifyLedgerInput[] | null;
}

function setSignal(row: OrderOpsRow, kind: SignalKind, state: SignalState): void {
  const sig = row.signals.find((s) => s.kind === kind);
  if (sig) sig.state = state;
}

/**
 * Project both sources into a unified, deterministically-ordered list and flag
 * possible_duplicate for rows that share an EXACT identity key within the input
 * (same source + order id, or same source + non-empty order code). Never uses
 * names, titles, or fuzzy similarity.
 */
export function buildOrderOpsRows(input: OrderOpsInput): OrderOpsRow[] {
  const rows: OrderOpsRow[] = [];
  for (const t of Array.isArray(input?.talabat) ? input.talabat : []) {
    if (isPlainObject(t)) rows.push(projectTalabatOrder(t as TalabatOrderInput));
  }
  for (const s of Array.isArray(input?.shopify) ? input.shopify : []) {
    if (isPlainObject(s)) rows.push(projectShopifyLedger(s as ShopifyLedgerInput));
  }

  // Exact-key duplicate detection.
  const idCounts = new Map<string, number>();
  const codeCounts = new Map<string, number>();
  for (const r of rows) {
    const idKey = `${r.source} id ${r.sourceOrderId}`;
    idCounts.set(idKey, (idCounts.get(idKey) ?? 0) + 1);
    if (r.displayOrderCode) {
      const codeKey = `${r.source} code ${r.displayOrderCode}`;
      codeCounts.set(codeKey, (codeCounts.get(codeKey) ?? 0) + 1);
    }
  }
  for (const r of rows) {
    const idKey = `${r.source} id ${r.sourceOrderId}`;
    const codeKey = `${r.source} code ${r.displayOrderCode}`;
    const dup = (idCounts.get(idKey) ?? 0) > 1 || (r.displayOrderCode !== "" && (codeCounts.get(codeKey) ?? 0) > 1);
    if (dup) setSignal(r, "possible_duplicate", "flagged");
  }

  // Deterministic ordering: source, then order id, then order code.
  rows.sort(
    (a, b) =>
      a.source.localeCompare(b.source) ||
      a.sourceOrderId.localeCompare(b.sourceOrderId) ||
      a.displayOrderCode.localeCompare(b.displayOrderCode),
  );
  return rows;
}

// ── Batch summary (deterministic key order) ──────────────────────────────────

export interface OrderOpsSummary {
  total: number;
  bySource: Record<OrderOpsSource, number>;
  byChannel: Record<OrderOpsChannel, number>;
  byStatus: Record<OrderOpsStatus, number>;
  flagged: number;
  manualReview: number;
  failed: number;
  blocked: number;
}

// Signals that constitute an operational "problem" (void is informational only).
const PROBLEM_SIGNALS = new Set<SignalKind>([
  "manual_review",
  "unmatched",
  "possible_duplicate",
  "under_deduction",
  "blocked",
  "malformed_result",
]);

export function summarizeOrderOps(rows: OrderOpsRow[]): OrderOpsSummary {
  const summary: OrderOpsSummary = {
    total: 0,
    bySource: { shopify: 0, talabat: 0 },
    byChannel: { shopify: 0, talabat: 0 },
    byStatus: { pending: 0, processed: 0, baseline: 0, manual_review: 0, failed: 0, blocked: 0, unknown: 0 },
    flagged: 0,
    manualReview: 0,
    failed: 0,
    blocked: 0,
  };
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!isPlainObject(r)) continue;
    summary.total++;
    if (r.source in summary.bySource) summary.bySource[r.source]++;
    if (r.channel in summary.byChannel) summary.byChannel[r.channel]++;
    if (r.status in summary.byStatus) summary.byStatus[r.status]++;
    if (r.status === "manual_review") summary.manualReview++;
    if (r.status === "failed") summary.failed++;
    if (r.status === "blocked") summary.blocked++;
    const hasProblem = Array.isArray(r.signals) && r.signals.some((s) => s.state === "flagged" && PROBLEM_SIGNALS.has(s.kind));
    if (hasProblem) summary.flagged++;
  }
  return summary;
}

// ── Empty-ledger classification (no invented cause) ──────────────────────────

export interface ShopifyLedgerState {
  state: "empty" | "populated";
  reason: string | null;
}

/**
 * Classify whether the Shopify ledger is empty. It NEVER invents a cause — an
 * empty ledger is "no_synced_orders" unless the caller passes a pre-classified
 * reason (from the SHOPIFY_REASONS whitelist). It will not claim "OAuth failed",
 * "cron failed", etc. on its own.
 */
export function classifyShopifyLedgerState(
  rows: ShopifyLedgerInput[] | null | undefined,
  evidence?: { reasonCode?: string | null },
): ShopifyLedgerState {
  const count = Array.isArray(rows) ? rows.length : 0;
  if (count > 0) return { state: "populated", reason: null };
  const supplied = evidence?.reasonCode;
  const reason = typeof supplied === "string" && SHOPIFY_REASONS.has(supplied) ? supplied : "no_synced_orders";
  return { state: "empty", reason };
}
