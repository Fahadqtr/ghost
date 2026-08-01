// Unified Order Operations & Reconciliation — PURE compute (Phase 2B.1).
//
// DB-free, network-free, framework-free. No "server-only", no "@/" imports, no
// Supabase/Shopify/Talabat clients, no fetch, no Date.now() — so node:test can
// import it directly. It ONLY normalizes already-persisted, classified order
// fields into a PII-safe unified projection; it never reads or emits raw payloads
// (talabat_orders.raw, deduction_result.products, line items, customer, phone,
// email, address, tokens, headers). Callers pass ONLY the whitelisted columns
// below; any extra keys on the input objects are ignored, never copied out.
//
// Untrusted-input safety: identity values are accepted ONLY when they are already
// strings — non-string ids (object/array/boolean/number/symbol/function/null) are
// never coerced with String(...), so a hostile toString / Symbol.toPrimitive is
// never invoked and can neither throw nor leak.

// ── Whitelisted inputs (mirror the real, non-sensitive columns only) ─────────

/**
 * Explicit, trusted deduction measurement. These are NOT columns in the current
 * production tables — the ledger only stores a row-write COUNT, not units. A later
 * PR may pass these ONLY when computed from a trusted source; without both, the
 * under_deduction signal stays "unknown".
 */
export interface DeductionEvidence {
  expectedUnits: number | null;
  appliedUnits: number | null;
}

export interface TalabatOrderInput {
  id: unknown; // accepted only if a non-empty trimmed string
  order_code?: unknown;
  event?: string | null;
  processing_status?: string | null; // pending | processed | manual_review | failed
  processed_at?: string | null;
  created_at?: string | null;
  resolution?: unknown; // jsonb — ONLY resolution.reason (a classified string) is read
  /** Optional, caller-supplied CLASSIFIED void state. Never a raw payload. */
  refunded?: boolean | null;
  /** Optional, trusted deduction measurement (not a production column). */
  evidence?: DeductionEvidence | null;
}

export interface ShopifyLedgerInput {
  order_id: unknown; // accepted only if a non-empty trimmed string
  order_name?: unknown;
  channel?: string | null; // "talabat" | "shopify"
  payment_gateway_names?: unknown; // read only to confirm channel; never projected
  deducted?: number | null; // COUNT of inventory rows written — NOT units
  processing_status?: string | null; // pending | completed
  processed_at?: string | null;
  synced_at?: string | null;
  deduction_result?: unknown; // jsonb — ONLY .status is read
  /** Optional, caller-supplied CLASSIFIED void state. Never a raw payload. */
  refunded?: boolean | null;
  /** Optional, trusted deduction measurement (not a production column). */
  evidence?: DeductionEvidence | null;
}

// ── Unified projection ───────────────────────────────────────────────────────

export type OrderOpsSource = "talabat" | "shopify";
export type OrderOpsChannel = "talabat" | "shopify" | "unknown";
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
  | "malformed_result"
  | "channel_attribution_mismatch";

export type SignalState = "flagged" | "clear" | "unknown";

export interface ReconciliationSignal {
  kind: SignalKind;
  state: SignalState;
}

export interface OrderOpsRow {
  source: OrderOpsSource;
  sourceOrderId: string; // "" when the persisted id was missing/malformed
  displayOrderCode: string; // display-only; NEVER used as a duplicate key
  channel: OrderOpsChannel;
  status: OrderOpsStatus;
  reasonCode: string | null;
  deductedRows: number | null; // inventory ROW-write count (not units); null = unknown
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
  "deductedRows",
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
  "channel_attribution_mismatch",
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

/** A valid identity is ONLY a non-empty trimmed string. Non-strings are never
 *  coerced (no String(...)), so hostile toString/Symbol.toPrimitive never runs. */
function validId(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}
function safeString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}
function safeLower(v: unknown): string {
  return typeof v === "string" ? v.trim().toLowerCase() : "";
}
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
/** Finite, non-negative number, else null. */
function finiteNonNeg(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
}

/** Read ONLY the classified reason string from a Talabat resolution object. */
function talabatReason(resolution: unknown): { reasonCode: string | null; shapeInvalid: boolean } {
  if (resolution === null || resolution === undefined) return { reasonCode: null, shapeInvalid: false };
  if (!isPlainObject(resolution)) return { reasonCode: null, shapeInvalid: true }; // array/string/number = malformed
  const r = resolution["reason"];
  if (typeof r !== "string") return { reasonCode: null, shapeInvalid: false };
  return { reasonCode: TALABAT_REASONS.has(r) ? r : UNKNOWN_REASON, shapeInvalid: false };
}

/** Read ONLY the status string from a Shopify deduction_result object. */
function shopifyResult(deductionResult: unknown): { present: boolean; shapeInvalid: boolean; status: string | null } {
  const present = deductionResult !== null && deductionResult !== undefined;
  if (!present) return { present: false, shapeInvalid: false, status: null };
  if (!isPlainObject(deductionResult)) return { present: true, shapeInvalid: true, status: null };
  return { present: true, shapeInvalid: false, status: safeString(deductionResult["status"]) };
}

/** True only if the gateway list explicitly contains an exact "talabat" entry. */
function hasTalabatGateway(paymentGatewayNames: unknown): boolean {
  if (!Array.isArray(paymentGatewayNames)) return false;
  for (const g of paymentGatewayNames) {
    if (typeof g === "string" && g.trim().toLowerCase() === "talabat") return true; // no coercion of non-strings
  }
  return false;
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

// ── Channel attribution (fail-closed) ────────────────────────────────────────

/**
 * Resolve the Shopify-source order's channel. Saved channel wins only when it does
 * NOT contradict explicit gateway evidence; a missing/unknown saved channel maps to
 * "unknown" (never silently "shopify") unless the gateway proves Talabat; and a
 * saved-vs-gateway contradiction yields "unknown" + a mismatch flag.
 */
function resolveShopifyChannel(rawChannel: unknown, gateways: unknown): { channel: OrderOpsChannel; mismatch: boolean } {
  const ch = safeLower(rawChannel);
  const gwPresent = Array.isArray(gateways);
  const gwTalabat = hasTalabatGateway(gateways);
  if (ch === "talabat") {
    if (gwPresent && !gwTalabat) return { channel: "unknown", mismatch: true }; // saved talabat, gateway says otherwise
    return { channel: "talabat", mismatch: false };
  }
  if (ch === "shopify") {
    if (gwTalabat) return { channel: "unknown", mismatch: true }; // saved shopify, gateway says talabat
    return { channel: "shopify", mismatch: false };
  }
  // missing / unknown saved channel → only trust explicit gateway evidence
  if (gwTalabat) return { channel: "talabat", mismatch: false };
  return { channel: "unknown", mismatch: false };
}

// ── Reconciliation signals ───────────────────────────────────────────────────

function voidState(refunded: unknown): SignalState {
  if (refunded === true) return "flagged";
  if (refunded === false) return "clear";
  return "unknown"; // only classified when explicitly supplied
}

/**
 * under_deduction needs INDEPENDENT unit evidence (expectedUnits vs appliedUnits).
 * The ledger's row-write count is NOT used. Flagged only when both are present and
 * appliedUnits < expectedUnits; clear on baseline/refund or when both present and
 * appliedUnits >= expectedUnits; unknown when either is missing.
 */
function underDeductionState(status: OrderOpsStatus, refunded: unknown, evidence: DeductionEvidence | null | undefined): SignalState {
  if (refunded === true) return "clear"; // a refund legitimately deducts nothing
  if (status === "baseline") return "clear"; // baseline never deducts by design
  if (status !== "processed") return "clear"; // no success claimed → no silent under-deduction
  const exp = finiteNonNeg(evidence?.expectedUnits);
  const app = finiteNonNeg(evidence?.appliedUnits);
  if (exp === null || app === null) return "unknown"; // no independent numeric evidence → do not invent
  return app < exp ? "flagged" : "clear";
}

function buildSignals(args: {
  status: OrderOpsStatus;
  reasonCode: string | null;
  malformed: boolean;
  refunded: unknown;
  evidence: DeductionEvidence | null | undefined;
  channelMismatch: boolean;
}): ReconciliationSignal[] {
  const { status, reasonCode, malformed, refunded, evidence, channelMismatch } = args;
  const states: Record<SignalKind, SignalState> = {
    manual_review: status === "manual_review" ? "flagged" : status === "unknown" ? "unknown" : "clear",
    unmatched:
      reasonCode !== null && UNMATCHED_REASONS.has(reasonCode)
        ? "flagged"
        : status === "processed" || status === "baseline"
          ? "clear"
          : "unknown",
    possible_duplicate: "clear", // upgraded to flagged in buildOrderOpsRows on exact-key repeats
    under_deduction: underDeductionState(status, refunded, evidence),
    void_or_refunded: voidState(refunded),
    blocked: status === "blocked" ? "flagged" : status === "unknown" ? "unknown" : "clear",
    malformed_result: malformed ? "flagged" : "clear",
    channel_attribution_mismatch: channelMismatch ? "flagged" : "clear",
  };
  return SIGNAL_ORDER.map((kind) => ({ kind, state: states[kind] }));
}

// ── Single-row projectors ────────────────────────────────────────────────────

export function projectTalabatOrder(input: TalabatOrderInput): OrderOpsRow {
  const status = normalizeTalabatStatus(input?.processing_status);
  const { reasonCode, shapeInvalid } = talabatReason(input?.resolution);
  const id = validId(input?.id);
  const code = validId(input?.order_code);
  const signals = buildSignals({
    status,
    reasonCode,
    malformed: shapeInvalid || id === null,
    refunded: input?.refunded,
    evidence: input?.evidence,
    channelMismatch: false, // Talabat-source rows are inherently the Talabat channel
  });
  return {
    source: "talabat",
    sourceOrderId: id ?? "",
    displayOrderCode: code ?? id ?? "",
    channel: "talabat",
    status,
    reasonCode,
    deductedRows: null, // Talabat row-level deduction count is not measured at this layer
    createdAt: safeString(input?.created_at),
    processedAt: safeString(input?.processed_at),
    signals,
  };
}

export function projectShopifyLedger(input: ShopifyLedgerInput): OrderOpsRow {
  const res = shopifyResult(input?.deduction_result);
  const { status, malformed } = normalizeShopifyStatus(input?.processing_status, res);
  const reasonCode = shopifyReason(res);
  const id = validId(input?.order_id);
  const code = validId(input?.order_name);
  const { channel, mismatch } = resolveShopifyChannel(input?.channel, input?.payment_gateway_names);
  const signals = buildSignals({
    status,
    reasonCode,
    malformed: malformed || id === null,
    refunded: input?.refunded,
    evidence: input?.evidence,
    channelMismatch: mismatch,
  });
  return {
    source: "shopify",
    sourceOrderId: id ?? "",
    displayOrderCode: code ?? id ?? "",
    channel,
    status,
    reasonCode,
    deductedRows: finiteNonNeg(input?.deducted), // finite non-negative → number; else null
    createdAt: safeString(input?.synced_at),
    processedAt: safeString(input?.processed_at),
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
 * possible_duplicate for rows sharing an EXACT identity key within the input:
 * validated non-empty sourceOrderId, or validated non-empty EXPLICIT order code
 * (Talabat order_code only). Shopify order_name is display-only and never a key;
 * ID-derived display codes are never keys. Rows with no valid id AND no valid
 * explicit code are excluded from duplicate detection entirely.
 */
export function buildOrderOpsRows(input: OrderOpsInput): OrderOpsRow[] {
  const entries: { row: OrderOpsRow; idKey: string | null; codeKey: string | null }[] = [];

  for (const t of Array.isArray(input?.talabat) ? input.talabat : []) {
    if (!isPlainObject(t)) continue;
    const id = validId((t as TalabatOrderInput).id);
    const code = validId((t as TalabatOrderInput).order_code);
    entries.push({
      row: projectTalabatOrder(t as TalabatOrderInput),
      idKey: id ? `talabat|id|${id}` : null,
      codeKey: code ? `talabat|code|${code}` : null,
    });
  }
  for (const s of Array.isArray(input?.shopify) ? input.shopify : []) {
    if (!isPlainObject(s)) continue;
    const id = validId((s as ShopifyLedgerInput).order_id);
    entries.push({
      row: projectShopifyLedger(s as ShopifyLedgerInput),
      idKey: id ? `shopify|id|${id}` : null,
      codeKey: null, // Shopify order_name is a display name, NOT a duplicate key
    });
  }

  const idCounts = new Map<string, number>();
  const codeCounts = new Map<string, number>();
  for (const e of entries) {
    if (e.idKey) idCounts.set(e.idKey, (idCounts.get(e.idKey) ?? 0) + 1);
    if (e.codeKey) codeCounts.set(e.codeKey, (codeCounts.get(e.codeKey) ?? 0) + 1);
  }
  for (const e of entries) {
    const dup = (e.idKey !== null && (idCounts.get(e.idKey) ?? 0) > 1) || (e.codeKey !== null && (codeCounts.get(e.codeKey) ?? 0) > 1);
    if (dup) setSignal(e.row, "possible_duplicate", "flagged");
  }

  const rows = entries.map((e) => e.row);
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

// Reconciliation signals that constitute an operational "problem" (void is
// informational only).
const PROBLEM_SIGNALS = new Set<SignalKind>([
  "manual_review",
  "unmatched",
  "possible_duplicate",
  "under_deduction",
  "blocked",
  "malformed_result",
  "channel_attribution_mismatch",
]);

export function summarizeOrderOps(rows: OrderOpsRow[]): OrderOpsSummary {
  const summary: OrderOpsSummary = {
    total: 0,
    bySource: { shopify: 0, talabat: 0 },
    byChannel: { shopify: 0, talabat: 0, unknown: 0 },
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
    // A row is flagged once if its status is a problem state OR any problem signal fired.
    const statusFlagged = r.status === "failed" || r.status === "blocked" || r.status === "manual_review";
    const signalFlagged = Array.isArray(r.signals) && r.signals.some((s) => s.state === "flagged" && PROBLEM_SIGNALS.has(s.kind));
    if (statusFlagged || signalFlagged) summary.flagged++;
  }
  return summary;
}

// ── Empty-ledger classification (no invented cause) ──────────────────────────

export interface ShopifyLedgerState {
  state: "empty" | "populated";
  reason: string | null;
}

/**
 * Classify whether the Shopify ledger is empty. Populated ONLY when at least one
 * PLAIN-OBJECT row carries a valid, non-empty order_id — a list of null/malformed
 * rows (or rows missing order_id) is still "empty". It NEVER invents a cause; an
 * empty ledger is "no_synced_orders" unless the caller passes a pre-classified
 * whitelisted reason.
 */
export function classifyShopifyLedgerState(
  rows: ShopifyLedgerInput[] | null | undefined,
  evidence?: { reasonCode?: string | null },
): ShopifyLedgerState {
  const populated =
    Array.isArray(rows) && rows.some((r) => isPlainObject(r) && validId((r as ShopifyLedgerInput).order_id) !== null);
  if (populated) return { state: "populated", reason: null };
  const supplied = evidence?.reasonCode;
  const reason = typeof supplied === "string" && SHOPIFY_REASONS.has(supplied) ? supplied : "no_synced_orders";
  return { state: "empty", reason };
}
