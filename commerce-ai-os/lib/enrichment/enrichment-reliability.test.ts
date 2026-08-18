// AI.FIX.1 — enrichment reliability tests (PURE): structured-output validation,
// failure taxonomy, truncation handling, and the single-retry policy.
// node --conditions=react-server --experimental-strip-types --test lib/enrichment/enrichment-reliability.test.ts

import test from "node:test";
import assert from "node:assert/strict";

import {
  parseEnrichmentResult,
  ENRICHMENT_OUTPUT_SCHEMA,
} from "./enrichment-prompt.ts";
import {
  ENRICHMENT_MAX_TOKENS,
  RETRYABLE_FAILURES,
  isRetryableFailure,
  classifyProviderResponse,
  classifyThrownError,
  errorInfo,
  generateWithRetry,
  type ProviderResponse,
  type FailureCode,
} from "./enrichment-diagnostics.ts";

const FULL = {
  keywords_en: "Rhode, lip tint, gift set",
  keywords_ar: "رود, صبغة شفاه, هدية",
  description_en: "A glossy tint that comfortably exceeds the length threshold.",
  description_ar: "صبغة لامعة وطويلة بما يكفي لتجاوز الحد الأدنى للطول المطلوب هنا تمامًا.",
  insufficient_data: false,
  notes: "ok",
};
const resp = (over: Partial<ProviderResponse> = {}): ProviderResponse => ({
  text: JSON.stringify(FULL), stopReason: "end_turn",
  usage: { input_tokens: 100, output_tokens: 200, thinking_tokens: 50 }, requestId: "req_1", ...over,
});

// ── token budget ──────────────────────────────────────────────────────────────
test("token budget is documented, sized above the old 1500 cap, and not arbitrarily huge", () => {
  assert.equal(ENRICHMENT_MAX_TOKENS, 4000);
  assert.ok(ENRICHMENT_MAX_TOKENS > 1500, "raised above the DIAG.AI.1 cap");
  assert.ok(ENRICHMENT_MAX_TOKENS <= 8000, "not an arbitrary huge ceiling");
});

// ── structured schema ─────────────────────────────────────────────────────────
test("the structured-output schema names exactly the six enrichment keys, all required", () => {
  assert.deepEqual(Object.keys(ENRICHMENT_OUTPUT_SCHEMA.properties).sort(),
    ["description_ar", "description_en", "insufficient_data", "keywords_ar", "keywords_en", "notes"]);
  assert.deepEqual([...ENRICHMENT_OUTPUT_SCHEMA.required].sort(),
    ["description_ar", "description_en", "insufficient_data", "keywords_ar", "keywords_en", "notes"]);
  assert.equal(ENRICHMENT_OUTPUT_SCHEMA.additionalProperties, false);
});

// ── response classification: valid ─────────────────────────────────────────────
test("valid structured response → ok with normalized output", () => {
  const r = classifyProviderResponse(resp());
  assert.ok(r.ok);
  assert.equal(r.output.keywords_en, "Rhode, lip tint, gift set");
  assert.equal(r.output.notes, "ok");
});

test("Arabic + English four-field response is preserved and classified ok", () => {
  const r = classifyProviderResponse(resp());
  assert.ok(r.ok);
  assert.equal(r.output.description_ar, FULL.description_ar);
  assert.equal(r.output.description_en, FULL.description_en);
  assert.equal(r.output.keywords_ar, "رود, صبغة شفاه, هدية");
});

// ── truncation vs malformed ────────────────────────────────────────────────────
test("stop_reason=max_tokens → TRUNCATED_OUTPUT (never mislabeled malformed), even with partial JSON", () => {
  const partial = '{"keywords_en":"serum, glow","keywords_ar":"سيروم';
  const r = classifyProviderResponse(resp({ text: partial, stopReason: "max_tokens" }));
  assert.equal(r.ok, false);
  assert.equal((r as { code: FailureCode }).code, "TRUNCATED_OUTPUT");
});

test("empty response → MALFORMED_JSON", () => {
  const r = classifyProviderResponse(resp({ text: "" }));
  assert.equal(r.ok, false);
  assert.equal((r as { code: FailureCode }).code, "MALFORMED_JSON");
});

test("malformed (non-JSON prose) → MALFORMED_JSON", () => {
  const r = classifyProviderResponse(resp({ text: "sorry, I cannot do that" }));
  assert.equal(r.ok, false);
  assert.equal((r as { code: FailureCode }).code, "MALFORMED_JSON");
});

test("schema mismatch (valid JSON, missing/mistyped key) → SCHEMA_MISMATCH", () => {
  const missing = classifyProviderResponse(resp({ text: '{"keywords_en":"a","keywords_ar":"b","description_en":"c","description_ar":"d","notes":"e"}' }));
  assert.equal((missing as { code: FailureCode }).code, "SCHEMA_MISMATCH"); // no insufficient_data
  const mistyped = classifyProviderResponse(resp({ text: JSON.stringify({ ...FULL, insufficient_data: "no" }) }));
  assert.equal((mistyped as { code: FailureCode }).code, "SCHEMA_MISMATCH");
});

test("refusal stop_reason → PROVIDER_ERROR", () => {
  const r = classifyProviderResponse(resp({ text: "", stopReason: "refusal" }));
  assert.equal((r as { code: FailureCode }).code, "PROVIDER_ERROR");
});

test("parseEnrichmentResult distinguishes malformed from schema-mismatch directly", () => {
  assert.deepEqual(parseEnrichmentResult("not json"), { ok: false, code: "MALFORMED_JSON" });
  assert.deepEqual(parseEnrichmentResult("[1,2,3]"), { ok: false, code: "MALFORMED_JSON" });
  assert.equal(parseEnrichmentResult(JSON.stringify({ keywords_en: "a" })).ok, false); // schema mismatch
  assert.equal(parseEnrichmentResult(JSON.stringify(FULL)).ok, true);
});

// ── thrown-error classification ────────────────────────────────────────────────
test("thrown errors map to TIMEOUT / TRANSPORT_ERROR / PROVIDER_ERROR", () => {
  assert.equal(classifyThrownError({ name: "APIConnectionTimeoutError" }), "TIMEOUT");
  assert.equal(classifyThrownError({ name: "APIConnectionError" }), "TRANSPORT_ERROR");
  assert.equal(classifyThrownError({ name: "ETIMEDOUT" }), "TIMEOUT");
  assert.equal(classifyThrownError({ status: 500 }), "PROVIDER_ERROR");
  assert.equal(classifyThrownError({ status: 400 }), "PROVIDER_ERROR");
  assert.equal(classifyThrownError({}), "TRANSPORT_ERROR"); // unknown → transport (safe, retryable)
});

test("errorInfo extracts safe fields (name/status/type/requestId/message) — never a stack, secrets redacted", () => {
  const info = errorInfo(Object.assign(new Error("secret sk-ant-xxx in message"), { name: "APIError", status: 429 }));
  assert.deepEqual(Object.keys(info).sort(), ["message", "name", "requestId", "status", "type"]);
  assert.equal(info.name, "APIError");
  assert.equal(info.status, 429);
  assert.equal("stack" in info, false, "no stack");
  assert.equal(/sk-ant-xxx/.test(info.message ?? ""), false, "api key redacted from message");
});

// ── retry policy ───────────────────────────────────────────────────────────────
test("retryable set is exactly transport/timeout/truncation", () => {
  assert.deepEqual([...RETRYABLE_FAILURES].sort(), ["TIMEOUT", "TRANSPORT_ERROR", "TRUNCATED_OUTPUT"]);
  for (const c of ["TRANSPORT_ERROR", "TIMEOUT", "TRUNCATED_OUTPUT"] as FailureCode[]) assert.equal(isRetryableFailure(c), true);
  for (const c of ["MALFORMED_JSON", "SCHEMA_MISMATCH", "PROVIDER_ERROR"] as FailureCode[]) assert.equal(isRetryableFailure(c), false);
});

test("success on first attempt → no retry (one provider call)", async () => {
  let calls = 0;
  const a = await generateWithRetry(async () => { calls++; return resp(); });
  assert.ok(a.outcome.ok);
  assert.equal(a.attempts, 1);
  assert.equal(calls, 1);
});

test("truncated then valid → exactly one retry, then success", async () => {
  let calls = 0;
  const a = await generateWithRetry(async () => {
    calls++;
    return calls === 1 ? resp({ text: '{"keywords_en":"x', stopReason: "max_tokens" }) : resp();
  });
  assert.ok(a.outcome.ok);
  assert.equal(a.attempts, 2);
  assert.equal(calls, 2);
});

test("timeout thrown twice → single retry only (never a third call), fails with TIMEOUT", async () => {
  let calls = 0;
  const a = await generateWithRetry(async () => { calls++; throw Object.assign(new Error("t"), { name: "APIConnectionTimeoutError" }); });
  assert.equal(a.outcome.ok, false);
  assert.equal(a.failureCode, "TIMEOUT");
  assert.equal(a.attempts, 2);
  assert.equal(calls, 2); // exactly two — no retry loop
});

test("malformed JSON fails closed with NO retry", async () => {
  let calls = 0;
  const a = await generateWithRetry(async () => { calls++; return resp({ text: "nope" }); });
  assert.equal(a.outcome.ok, false);
  assert.equal(a.failureCode, "MALFORMED_JSON");
  assert.equal(a.attempts, 1);
  assert.equal(calls, 1); // no retry for non-retryable failure
});

test("schema mismatch fails closed with NO retry", async () => {
  let calls = 0;
  const a = await generateWithRetry(async () => { calls++; return resp({ text: JSON.stringify({ keywords_en: "a" }) }); });
  assert.equal(a.failureCode, "SCHEMA_MISMATCH");
  assert.equal(calls, 1);
});

test("provider error (thrown 500) fails closed with NO retry", async () => {
  let calls = 0;
  const a = await generateWithRetry(async () => { calls++; throw Object.assign(new Error("x"), { name: "APIError", status: 500 }); });
  assert.equal(a.failureCode, "PROVIDER_ERROR");
  assert.equal(a.attempts, 1);
  assert.equal(calls, 1);
});

test("transport error then success → one retry recovers", async () => {
  let calls = 0;
  const a = await generateWithRetry(async () => {
    calls++;
    if (calls === 1) throw Object.assign(new Error("net"), { name: "APIConnectionError" });
    return resp();
  });
  assert.ok(a.outcome.ok);
  assert.equal(calls, 2);
});

// ── diagnostics carry no secrets ───────────────────────────────────────────────
test("ProviderResponse surface carries counts + safe request id only (no key/header/payload fields)", () => {
  const r = resp();
  assert.deepEqual(Object.keys(r).sort(), ["requestId", "stopReason", "text", "usage"]);
  assert.deepEqual(Object.keys(r.usage!).sort(), ["input_tokens", "output_tokens", "thinking_tokens"]);
  for (const k of ["apiKey", "authorization", "headers", "cookie"]) assert.equal(k in r, false, `no ${k}`);
});
