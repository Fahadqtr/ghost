// AI.FIX.1 — enrichment reliability core: token budget, failure taxonomy,
// response classification, and the single-retry policy (PURE).
//
// This module makes the Sonnet-5 enrichment path diagnosable and fail-closed:
//   • it sizes the output token budget so adaptive thinking + the four JSON fields
//     both fit (the DIAG.AI.1 root cause was a 1500 cap the thinking pass alone
//     could exhaust, truncating the JSON);
//   • it classifies every generation outcome into a precise FailureCode instead of
//     one opaque "failed";
//   • it distinguishes TRUNCATED_OUTPUT (stop_reason=max_tokens) from genuinely
//     MALFORMED_JSON, and PROVIDER/TRANSPORT/TIMEOUT errors from each other;
//   • it runs AT MOST one retry, and only for retryable (transport/truncation)
//     cases — malformed/schema-invalid/provider errors fail closed with no retry.
//
// PURE: imports only a pure sibling (enrichment-prompt) — no @/ imports, no
// server-only, no provider SDK. It never sees an API key or auth header; the
// ProviderResponse it consumes carries token counts and stop metadata only.

import { parseEnrichmentResult, type EnrichmentOutput } from "./enrichment-prompt.ts";

/**
 * Output token budget for one enrichment generation. Sonnet 5 runs adaptive
 * thinking by default and thinking tokens are drawn from max_tokens, so this must
 * cover BOTH the reasoning pass AND the visible JSON:
 *   visible JSON ≈ keywords_en/ar (~80 tok each) + description_en/ar
 *     (Arabic ~2× → ~250 tok each) + notes ≈ ~700 tokens
 *   adaptive-thinking headroom ≈ ~3000 tokens
 * 4000 is generous for the four fields without being an arbitrary huge ceiling.
 * (Old value: 1500 — DIAG.AI.1 confirmed the thinking pass alone could consume it,
 * leaving the JSON truncated or absent.)
 */
export const ENRICHMENT_MAX_TOKENS = 4000;

/** Precise, safe failure taxonomy for a single enrichment generation. */
export type FailureCode =
  | "PROVIDER_ERROR"    // provider declined / returned an API error / refusal
  | "TRANSPORT_ERROR"   // network/connection failure reaching the provider
  | "TIMEOUT"           // request exceeded the client timeout
  | "TRUNCATED_OUTPUT"  // stop_reason=max_tokens — output cut off mid-JSON
  | "MALFORMED_JSON"    // no parseable JSON object (empty/prose/broken)
  | "SCHEMA_MISMATCH";  // parseable JSON, but a required key is missing/mistyped

/** Codes for which exactly one retry is safe (transient transport / truncation). */
export const RETRYABLE_FAILURES: ReadonlySet<FailureCode> = new Set<FailureCode>([
  "TRANSPORT_ERROR",
  "TIMEOUT",
  "TRUNCATED_OUTPUT",
]);

export const isRetryableFailure = (code: FailureCode): boolean => RETRYABLE_FAILURES.has(code);

/** Token accounting surfaced for diagnostics — counts only, never content. */
export interface ProviderUsage {
  input_tokens: number;
  output_tokens: number;
  /** internal reasoning tokens (subset of output_tokens), when the API reports it. */
  thinking_tokens: number | null;
}

/**
 * The provider boundary's structured return. Carries the raw text + the metadata
 * needed to diagnose failures. It deliberately has NO field for an API key, auth
 * header, or request payload — only a safe request id.
 */
export interface ProviderResponse {
  text: string;
  /** Anthropic stop_reason (e.g. "end_turn", "max_tokens", "refusal"). */
  stopReason: string | null;
  usage: ProviderUsage | null;
  /** provider request id (safe to log) when available. */
  requestId: string | null;
}

/** The classified outcome of one generation: a validated output, or a failure code. */
export type GenerateOutcome =
  | { ok: true; output: EnrichmentOutput }
  | { ok: false; code: FailureCode };

/**
 * Classify a completed provider response. Truncation and refusal are detected
 * from stop_reason BEFORE parsing, so a cut-off JSON is never mislabeled as
 * generic malformed output.
 */
export function classifyProviderResponse(resp: ProviderResponse): GenerateOutcome {
  if (resp.stopReason === "max_tokens") return { ok: false, code: "TRUNCATED_OUTPUT" };
  if (resp.stopReason === "refusal") return { ok: false, code: "PROVIDER_ERROR" };
  const parsed = parseEnrichmentResult(resp.text);
  if (!parsed.ok) return { ok: false, code: parsed.code };
  return { ok: true, output: parsed.output };
}

/**
 * AI.FIX.2 — a safe, human-readable sub-classification of a provider failure.
 * This is orthogonal to FailureCode (which stays the stable six-value taxonomy):
 * it surfaces the REAL provider reason for a PROVIDER_ERROR without expanding the
 * taxonomy. Derived only from HTTP status + the API's error.type — never secrets.
 */
export type ProviderCategory =
  | "AUTHENTICATION"
  | "PERMISSION"
  | "MODEL_ACCESS"
  | "RATE_LIMIT"
  | "BILLING"
  | "INVALID_REQUEST"
  | "STRUCTURED_OUTPUT_UNSUPPORTED"
  | "CONTEXT_LIMIT"
  | "SAFETY_REFUSAL"
  | "OVERLOADED"
  | "OTHER";

/** Minimal, SDK-agnostic view of a thrown error (duck-typed by the caller). */
export interface ThrownErrorInfo {
  name?: string;
  status?: number;
  /** the API response body's error.type, e.g. "invalid_request_error". */
  type?: string;
  /** provider request id (safe to log). */
  requestId?: string | null;
  /** sanitized, length-capped provider error message (no secrets). */
  message?: string;
}

/** Redact anything key-shaped and cap length so a message is always safe to keep. */
function sanitizeMessage(raw: unknown): string | undefined {
  if (typeof raw !== "string" || raw.trim() === "") return undefined;
  const redacted = raw.replace(/sk-ant-[A-Za-z0-9_-]+/g, "sk-ant-***").replace(/\s+/g, " ").trim();
  return redacted.length > 300 ? redacted.slice(0, 300) + "…" : redacted;
}

/**
 * Extract a safe view from any thrown value by duck-typing the Anthropic SDK
 * error surface (`.name`, `.status`, `.type`, `.requestID`, `.message`). No API
 * key, header, cookie, or stack is ever read; the message is sanitized + capped.
 */
export function errorInfo(err: unknown): ThrownErrorInfo {
  const e = (err ?? {}) as {
    name?: unknown; status?: unknown; code?: unknown; type?: unknown;
    requestID?: unknown; request_id?: unknown; message?: unknown;
  };
  const name = typeof e.name === "string" ? e.name : typeof e.code === "string" ? e.code : "";
  const status = typeof e.status === "number" ? e.status : undefined;
  const type = typeof e.type === "string" ? e.type : undefined;
  const requestId =
    typeof e.requestID === "string" ? e.requestID :
    typeof e.request_id === "string" ? e.request_id : null;
  return { name, status, type, requestId, message: sanitizeMessage(e.message) };
}

/** Map a thrown transport/provider error to a FailureCode (stable six-value set). */
export function classifyThrownError(info: ThrownErrorInfo): FailureCode {
  const name = info.name ?? "";
  if (/timeout|timedout|etimedout/i.test(name)) return "TIMEOUT";
  if (/connection|econnreset|econnrefused|enotfound|socket|network|fetchfailed/i.test(name)) return "TRANSPORT_ERROR";
  if (typeof info.status === "number" && info.status >= 400) return "PROVIDER_ERROR";
  return "TRANSPORT_ERROR";
}

/**
 * Map a rejected provider request to a safe ProviderCategory, from HTTP status +
 * the API error.type + a sanitized message. A 400 whose type/message points at
 * the structured-output request is called STRUCTURED_OUTPUT_UNSUPPORTED so the
 * real reason is not hidden behind a generic INVALID_REQUEST.
 */
export function classifyProviderCategory(info: ThrownErrorInfo): ProviderCategory {
  const status = info.status;
  const type = (info.type ?? "").toLowerCase();
  const msg = (info.message ?? "").toLowerCase();
  const mentionsStructured = /output_config|json_schema|structured|output format/.test(type + " " + msg);
  if (status === 401 || /authentication/.test(type)) return "AUTHENTICATION";
  if (status === 403 || /permission/.test(type)) return /model/.test(msg) ? "MODEL_ACCESS" : "PERMISSION";
  if (status === 404 || /not_found/.test(type)) return "MODEL_ACCESS";
  if (status === 402 || /billing|credit|quota/.test(type + " " + msg)) return "BILLING";
  if (status === 429 || /rate_limit/.test(type)) return "RATE_LIMIT";
  if (status === 413 || /context|too many tokens|prompt is too long/.test(type + " " + msg)) return "CONTEXT_LIMIT";
  if (status === 529 || /overloaded/.test(type)) return "OVERLOADED";
  if (status === 400 || /invalid_request/.test(type)) return mentionsStructured ? "STRUCTURED_OUTPUT_UNSUPPORTED" : "INVALID_REQUEST";
  return "OTHER";
}

/** Safe, structured detail of a thrown provider error (surfaced in diagnostics). */
export interface ProviderErrorDetail {
  status: number | null;
  type: string | null;
  requestId: string | null;
  category: ProviderCategory;
  message: string | null;
}

/** Build a safe ProviderErrorDetail from a thrown value. */
export function providerErrorDetail(err: unknown): ProviderErrorDetail {
  const info = errorInfo(err);
  return {
    status: info.status ?? null,
    type: info.type ?? null,
    requestId: info.requestId ?? null,
    category: classifyProviderCategory(info),
    message: info.message ?? null,
  };
}

/** The result of a (possibly retried) generation attempt. */
export interface GenerationAttempt {
  outcome: GenerateOutcome;
  /** the last provider response (null if every attempt threw). */
  response: ProviderResponse | null;
  /** safe detail of the last thrown provider error (null unless an attempt threw). */
  error: ProviderErrorDetail | null;
  /** the failure code of the final attempt, or null on success. */
  failureCode: FailureCode | null;
  /** how many provider calls were made: 1 (no retry) or 2 (one retry). */
  attempts: number;
}

/**
 * Run a generation with AT MOST one retry. The retry fires only when the first
 * attempt failed with a retryable code (transport/timeout/truncation). Malformed,
 * schema-mismatch, and provider errors fail closed immediately. There is no loop
 * beyond the single retry — `generate` is called at most twice.
 */
export async function generateWithRetry(
  generate: () => Promise<ProviderResponse>,
): Promise<GenerationAttempt> {
  let last: GenerationAttempt = {
    outcome: { ok: false, code: "TRANSPORT_ERROR" },
    response: null,
    error: null,
    failureCode: "TRANSPORT_ERROR",
    attempts: 0,
  };

  for (let attempt = 1; attempt <= 2; attempt++) {
    let outcome: GenerateOutcome;
    let response: ProviderResponse | null = null;
    let error: ProviderErrorDetail | null = null;
    try {
      response = await generate();
      outcome = classifyProviderResponse(response);
    } catch (err) {
      error = providerErrorDetail(err);
      outcome = { ok: false, code: classifyThrownError(errorInfo(err)) };
    }
    const failureCode = outcome.ok ? null : outcome.code;
    last = { outcome, response, error, failureCode, attempts: attempt };
    if (outcome.ok) return last;
    // Exactly one retry, only for retryable failures.
    if (attempt === 1 && failureCode && isRetryableFailure(failureCode)) continue;
    return last;
  }
  return last;
}
