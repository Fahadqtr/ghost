// AI.FIX.2 — Anthropic structured-output endpoint guard (source scan). Proves:
//   • structured output goes through the BETA messages surface (client.beta.messages)
//     with the required `structured-outputs-2025-12-15` beta — the DIAG.AI.2 fix;
//   • it is NOT sent on the non-beta client.messages.create (the broken path);
//   • schema, token budget, maxRetries, and the validator are preserved;
//   • there is ONE provider stack (no second provider) and NO silent text fallback;
//   • thrown-provider diagnostics capture status/type/request_id/category safely,
//     with no key/header/cookie leak.
// node --conditions=react-server --experimental-strip-types --test lib/enrichment/ai-fix2-structured-output-guard.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

const PROVIDER = "lib/enrichment/enrichment-provider.server.ts";
const DIAG = "lib/enrichment/enrichment-diagnostics.ts";
const ORCH = "lib/enrichment/enrichment.server.ts";

test("structured output uses the BETA messages surface with the required beta", () => {
  const p = strip(read(PROVIDER));
  assert.ok(/client\.beta\.messages\.create\(/.test(p), "uses client.beta.messages.create");
  assert.ok(/structured-outputs-2025-12-15/.test(p), "supplies the structured-outputs-2025-12-15 beta");
  assert.ok(/betas\s*:\s*\[/.test(p), "passes a betas array");
});

test("the broken non-beta structured-output call is gone", () => {
  const p = strip(read(PROVIDER));
  // output_config must NOT be sent on the non-beta client.messages.create.
  assert.equal(/client\.messages\.create\(/.test(p), false, "no non-beta messages.create in the provider");
});

test("schema, token budget, validator, and maxRetries are preserved", () => {
  const p = strip(read(PROVIDER));
  assert.ok(/output_config\s*:\s*\{\s*format\s*:/.test(p) && /type\s*:\s*["']json_schema["']/.test(p), "output_config.format json_schema kept");
  assert.ok(/ENRICHMENT_OUTPUT_SCHEMA/.test(p), "exact schema kept");
  assert.ok(/max_tokens\s*:\s*ENRICHMENT_MAX_TOKENS/.test(p), "token budget constant kept");
  assert.ok(/maxRetries\s*:\s*0/.test(p), "maxRetries: 0 kept");
  assert.ok(/ENRICHMENT_MAX_TOKENS\s*=\s*4000/.test(read(DIAG)), "token budget remains 4000");
});

test("ONE provider stack, and NO silent text fallback in this PR", () => {
  const p = strip(read(PROVIDER));
  // exactly one create call site (no dual beta+non-beta path, no second provider)
  assert.equal((p.match(/\.messages\.create\(/g) ?? []).length, 1, "single structured-output call site");
  assert.equal(/output_format/.test(p), false, "no deprecated output_format");
  // no try/catch that drops output_config and re-calls plain (no silent fallback)
  assert.equal(/catch[\s\S]{0,200}messages\.create\([^)]*\)(?![\s\S]*output_config)/.test(p), false, "no fallback re-call without output_config");
});

test("failure taxonomy preserved (the stable six codes) + safe ProviderCategory added", () => {
  const d = read(DIAG);
  for (const code of ["PROVIDER_ERROR", "TRANSPORT_ERROR", "TIMEOUT", "TRUNCATED_OUTPUT", "MALFORMED_JSON", "SCHEMA_MISMATCH"]) {
    assert.ok(d.includes(code), `taxonomy includes ${code}`);
  }
  assert.ok(/type ProviderCategory/.test(d), "adds a safe ProviderCategory sub-classification");
  assert.ok(/STRUCTURED_OUTPUT_UNSUPPORTED/.test(d), "can name the structured-output rejection reason");
});

test("thrown-provider diagnostics capture status/type/request_id/category safely", () => {
  const d = strip(read(DIAG));
  assert.ok(/ProviderErrorDetail/.test(d) && /providerErrorDetail\(/.test(d), "builds a safe provider-error detail");
  for (const f of ["status", "type", "requestId", "category"]) assert.ok(new RegExp(f).test(d), `detail carries ${f}`);
  const o = strip(read(ORCH));
  for (const f of ["httpStatus", "errorType", "providerCategory"]) assert.ok(new RegExp(f).test(o), `diagnostic surfaces ${f}`);
});

test("no secret leak: key/header/cookie never read into diagnostics or logged", () => {
  const d = strip(read(DIAG));
  for (const bad of ["apiKey", "authorization", "cookie", "x-api-key", "\\.stack"]) {
    assert.equal(new RegExp(bad, "i").test(d), false, `diagnostics core free of ${bad}`);
  }
  // the message is redacted + capped, not raw
  assert.ok(/sk-ant-/.test(d) && /slice\(/.test(d), "message is redacted + length-capped");
  const p = strip(read(PROVIDER));
  assert.equal(/console\.(log|error|warn|info)/.test(p), false, "provider does not log");
});
