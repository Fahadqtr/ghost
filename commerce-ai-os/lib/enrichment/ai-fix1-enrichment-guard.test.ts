// AI.FIX.1 — Sonnet 5 enrichment hardening guard (source scan). Proves:
//   • the provider uses structured output + a documented token budget (not 1500),
//     disables SDK retries, and returns structured diagnostic metadata;
//   • the provider never returns/logs the API key or auth headers;
//   • the orchestrator delegates the single-retry policy to the pure module and
//     exposes safe diagnostics (counts + stop_reason + request id), never raw
//     prompts/responses or secrets;
//   • the failure taxonomy + single-retry bound live in the pure diagnostics core.
// node --conditions=react-server --experimental-strip-types --test lib/enrichment/ai-fix1-enrichment-guard.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

const PROVIDER = "lib/enrichment/enrichment-provider.server.ts";
const ORCH = "lib/enrichment/enrichment.server.ts";
const DIAG = "lib/enrichment/enrichment-diagnostics.ts";
const PROMPT = "lib/enrichment/enrichment-prompt.ts";

test("provider uses structured output constrained to the enrichment schema", () => {
  const p = strip(read(PROVIDER));
  assert.ok(/output_config\s*:\s*\{\s*format\s*:/.test(p), "sets output_config.format");
  assert.ok(/type\s*:\s*["']json_schema["']/.test(p), "uses json_schema structured output");
  assert.ok(/ENRICHMENT_OUTPUT_SCHEMA/.test(p), "constrains to the exact enrichment schema");
});

test("provider uses the documented token budget, not the old 1500 cap", () => {
  const p = strip(read(PROVIDER));
  assert.ok(/max_tokens\s*:\s*ENRICHMENT_MAX_TOKENS/.test(p), "max_tokens is the documented constant");
  assert.equal(/max_tokens\s*:\s*1500/.test(p), false, "the 1500 cap is gone");
});

test("provider disables SDK auto-retries (single-retry policy owns retries)", () => {
  const p = strip(read(PROVIDER));
  assert.ok(/maxRetries\s*:\s*0/.test(p), "maxRetries: 0");
});

test("provider returns structured diagnostic metadata (text + stop_reason + usage + request id)", () => {
  const p = strip(read(PROVIDER));
  assert.ok(/stopReason\s*:/.test(p) && /stop_reason/.test(p), "returns stop_reason");
  assert.ok(/usage\s*:/.test(p) && /input_tokens/.test(p) && /output_tokens/.test(p), "returns token usage");
  assert.ok(/requestId/.test(p) && /_request_id/.test(p), "returns a safe request id");
});

test("provider never returns or logs the API key / auth header", () => {
  const p = strip(read(PROVIDER));
  // apiKey may appear ONLY where it is read from env and handed to the client
  // constructor — never on a return/response line, never logged.
  const apiKeyLines = p.split("\n").filter((l) => /\bapiKey\b/.test(l));
  for (const l of apiKeyLines) {
    const ok = /process\.env\.ANTHROPIC_API_KEY/.test(l) || /new Anthropic\(\s*\{\s*apiKey/.test(l) || /if\s*\(!apiKey\)/.test(l);
    assert.ok(ok, `apiKey only used for env-read/client-ctor, not: ${l.trim()}`);
  }
  assert.equal(/return[^\n]*apiKey/.test(p), false, "apiKey is never on a return line");
  assert.equal(/console\.(log|error|warn|info)/.test(p), false, "provider does not log");
  for (const k of ["authorization", "x-api-key", "Bearer"]) assert.equal(new RegExp(k, "i").test(p), false, `no ${k} literal`);
});

test("orchestrator delegates to the single-retry policy and does not hand-roll retries", () => {
  const o = strip(read(ORCH));
  assert.ok(/generateWithRetry\(/.test(o), "uses the pure single-retry helper");
  // no ad-hoc double-call retry pattern (the old try/catch-then-call-again is gone)
  assert.equal(/catch\s*\{[^}]*provider\.generate/.test(o), false, "no hand-rolled catch-and-retry");
});

test("orchestrator exposes a precise failure taxonomy + safe diagnostics", () => {
  const o = strip(read(ORCH));
  assert.ok(/byFailureCode/.test(o), "stats break down by failure code");
  assert.ok(/diagnostics/.test(o), "exposes per-item diagnostics");
  assert.ok(/stopReason/.test(o) && /usage/.test(o) && /requestId/.test(o), "diagnostics carry stop_reason/usage/request id");
});

test("diagnostics expose counts + metadata only — no raw prompt/response or secrets persisted", () => {
  const o = strip(read(ORCH));
  // The diagnostic object must NOT carry the raw model text, the prompt, or a key.
  assert.equal(/text\s*:\s*attempt\.response/.test(o), false, "raw response text is not surfaced in diagnostics");
  for (const bad of ["apiKey", "authorization", "systemPrompt", "userPrompt", "rawText"]) {
    assert.equal(new RegExp(bad).test(o), false, `diagnostics do not carry ${bad}`);
  }
});

test("failure taxonomy, retryable set, and a bounded single retry live in the pure core", () => {
  const d = read(DIAG);
  for (const code of ["PROVIDER_ERROR", "TRANSPORT_ERROR", "TIMEOUT", "TRUNCATED_OUTPUT", "MALFORMED_JSON", "SCHEMA_MISMATCH"]) {
    assert.ok(d.includes(code), `taxonomy includes ${code}`);
  }
  assert.ok(/RETRYABLE_FAILURES/.test(d), "declares the retryable set");
  assert.ok(/attempt\s*<=\s*2/.test(d), "retry loop is bounded to at most two attempts (one retry)");
  // the pure core must stay SDK-free
  assert.equal(/@anthropic-ai|new Anthropic/.test(d), false, "diagnostics core imports no provider SDK");
});

test("truncation is classified distinctly from malformed JSON", () => {
  const d = strip(read(DIAG));
  assert.ok(/stopReason\s*===\s*["']max_tokens["'][\s\S]*TRUNCATED_OUTPUT/.test(d), "max_tokens → TRUNCATED_OUTPUT");
  assert.ok(/ENRICHMENT_OUTPUT_SCHEMA/.test(read(PROMPT)), "schema is defined in the pure prompt module");
});
