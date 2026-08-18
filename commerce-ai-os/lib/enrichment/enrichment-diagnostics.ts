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

/** Minimal, SDK-agnostic view of a thrown error (duck-typed by the caller). */
export interface ThrownErrorInfo {
  name?: string;
  status?: number;
}

/** Extract a safe {name,status} view from any thrown value (no message/stack kept). */
export function errorInfo(err: unknown): ThrownErrorInfo {
  const e = (err ?? {}) as { name?: unknown; status?: unknown; code?: unknown };
  const name = typeof e.name === "string" ? e.name : typeof e.code === "string" ? e.code : "";
  const status = typeof e.status === "number" ? e.status : undefined;
  return { name, status };
}

/** Map a thrown transport/provider error to a FailureCode. */
export function classifyThrownError(info: ThrownErrorInfo): FailureCode {
  const name = info.name ?? "";
  if (/timeout|timedout|etimedout/i.test(name)) return "TIMEOUT";
  if (/connection|econnreset|econnrefused|enotfound|socket|network|fetchfailed/i.test(name)) return "TRANSPORT_ERROR";
  if (typeof info.status === "number" && info.status >= 400) return "PROVIDER_ERROR";
  return "TRANSPORT_ERROR";
}

/** The result of a (possibly retried) generation attempt. */
export interface GenerationAttempt {
  outcome: GenerateOutcome;
  /** the last provider response (null if every attempt threw). */
  response: ProviderResponse | null;
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
    failureCode: "TRANSPORT_ERROR",
    attempts: 0,
  };

  for (let attempt = 1; attempt <= 2; attempt++) {
    let outcome: GenerateOutcome;
    let response: ProviderResponse | null = null;
    try {
      response = await generate();
      outcome = classifyProviderResponse(response);
    } catch (err) {
      outcome = { ok: false, code: classifyThrownError(errorInfo(err)) };
    }
    const failureCode = outcome.ok ? null : outcome.code;
    last = { outcome, response, failureCode, attempts: attempt };
    if (outcome.ok) return last;
    // Exactly one retry, only for retryable failures.
    if (attempt === 1 && failureCode && isRetryableFailure(failureCode)) continue;
    return last;
  }
  return last;
}
