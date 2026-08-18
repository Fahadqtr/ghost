// AI.FIX.2 — safe provider-error diagnostics tests (PURE): status/type/request_id
// capture, ProviderCategory classification, secret redaction, retry threading.
// node --conditions=react-server --experimental-strip-types --test lib/enrichment/enrichment-provider-errors.test.ts

import test from "node:test";
import assert from "node:assert/strict";

import {
  errorInfo,
  classifyThrownError,
  classifyProviderCategory,
  providerErrorDetail,
  generateWithRetry,
  type ProviderResponse,
} from "./enrichment-diagnostics.ts";

// Mimic an Anthropic SDK APIError surface (status, type, requestID, message).
function apiError(over: Record<string, unknown> = {}): Error {
  return Object.assign(new Error("bad"), { name: "BadRequestError", status: 400, type: "invalid_request_error", requestID: "req_abc", ...over });
}

// ── safe extraction ────────────────────────────────────────────────────────────
test("errorInfo extracts name/status/type/requestId/message, no secrets/stack", () => {
  const info = errorInfo(apiError({ message: "output_config.format requires beta" }));
  assert.equal(info.name, "BadRequestError");
  assert.equal(info.status, 400);
  assert.equal(info.type, "invalid_request_error");
  assert.equal(info.requestId, "req_abc");
  assert.equal(info.message, "output_config.format requires beta");
  assert.equal("stack" in info, false);
  assert.equal("headers" in info, false);
});

test("errorInfo also reads snake_case request_id and caps/redacts the message", () => {
  const long = "x".repeat(400) + " sk-ant-SECRETKEY123";
  const info = errorInfo(Object.assign(new Error(long), { name: "APIError", status: 500, request_id: "req_snake" }));
  assert.equal(info.requestId, "req_snake");
  assert.ok(info.message!.length <= 301, "message capped");
  assert.equal(/sk-ant-SECRETKEY123/.test(info.message!), false, "api key redacted");
});

// ── FailureCode (stable six) unchanged ──────────────────────────────────────────
test("classifyThrownError still returns the stable six-value taxonomy", () => {
  assert.equal(classifyThrownError({ name: "APIConnectionTimeoutError" }), "TIMEOUT");
  assert.equal(classifyThrownError({ name: "APIConnectionError" }), "TRANSPORT_ERROR");
  assert.equal(classifyThrownError({ status: 400 }), "PROVIDER_ERROR");
  assert.equal(classifyThrownError({ status: 401 }), "PROVIDER_ERROR");
  assert.equal(classifyThrownError({}), "TRANSPORT_ERROR");
});

// ── ProviderCategory (safe sub-reason) ──────────────────────────────────────────
test("classifyProviderCategory surfaces the REAL provider reason safely", () => {
  assert.equal(classifyProviderCategory({ status: 401 }), "AUTHENTICATION");
  assert.equal(classifyProviderCategory({ status: 403 }), "PERMISSION");
  assert.equal(classifyProviderCategory({ status: 403, message: "your account lacks model access" }), "MODEL_ACCESS");
  assert.equal(classifyProviderCategory({ status: 404 }), "MODEL_ACCESS");
  assert.equal(classifyProviderCategory({ status: 402 }), "BILLING");
  assert.equal(classifyProviderCategory({ status: 429 }), "RATE_LIMIT");
  assert.equal(classifyProviderCategory({ status: 413 }), "CONTEXT_LIMIT");
  assert.equal(classifyProviderCategory({ status: 529 }), "OVERLOADED");
  assert.equal(classifyProviderCategory({ status: 400, message: "generic bad param" }), "INVALID_REQUEST");
  assert.equal(classifyProviderCategory({ status: 400, message: "output_config.format is not supported" }), "STRUCTURED_OUTPUT_UNSUPPORTED");
  assert.equal(classifyProviderCategory({ status: 400, type: "invalid_request_error", message: "unknown field json_schema" }), "STRUCTURED_OUTPUT_UNSUPPORTED");
  assert.equal(classifyProviderCategory({ status: 418 }), "OTHER");
});

test("providerErrorDetail bundles safe fields + category, no secrets", () => {
  const d = providerErrorDetail(apiError({ message: "output_config requires the structured-outputs beta" }));
  assert.deepEqual(Object.keys(d).sort(), ["category", "message", "requestId", "status", "type"]);
  assert.equal(d.status, 400);
  assert.equal(d.type, "invalid_request_error");
  assert.equal(d.requestId, "req_abc");
  assert.equal(d.category, "STRUCTURED_OUTPUT_UNSUPPORTED");
  for (const k of ["apiKey", "authorization", "headers", "cookie", "stack"]) assert.equal(k in d, false, `no ${k}`);
});

// ── retry threads the safe error detail through ─────────────────────────────────
const okResp = (): ProviderResponse => ({
  text: JSON.stringify({ keywords_en: "a", keywords_ar: "ب", description_en: "c", description_ar: "د", insufficient_data: false, notes: "" }),
  stopReason: "end_turn", usage: { input_tokens: 10, output_tokens: 20, thinking_tokens: 5 }, requestId: "req_ok",
});

test("thrown 400 → GenerationAttempt.error carries status/type/requestId/category, no retry", async () => {
  let calls = 0;
  const a = await generateWithRetry(async () => { calls++; throw apiError(); });
  assert.equal(a.outcome.ok, false);
  assert.equal(a.failureCode, "PROVIDER_ERROR");
  assert.equal(a.attempts, 1);
  assert.equal(calls, 1); // 400 is not retryable
  assert.ok(a.error);
  assert.equal(a.error!.status, 400);
  assert.equal(a.error!.type, "invalid_request_error");
  assert.equal(a.error!.requestId, "req_abc");
  assert.equal(a.error!.category, "INVALID_REQUEST");
});

test("success → GenerationAttempt.error is null", async () => {
  const a = await generateWithRetry(async () => okResp());
  assert.ok(a.outcome.ok);
  assert.equal(a.error, null);
});
