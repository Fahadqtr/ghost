// CAT.1B — Unified Evidence Engine guard (source scan). Proves the engine is
// READ-ONLY / detection-only: pure core, read-only server APIs, NO writes /
// schema / migration / persistence / lifecycle / inventory / availability / ECL /
// channel mutation, no AI generation, and no fabricated evidence.
// node --conditions=react-server --experimental-strip-types --test lib/catalog/evidence/cat1b-evidence-guard.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

const DIR = "lib/catalog/evidence";
const PURE = [`${DIR}/evidence-model.ts`, `${DIR}/evidence-engine.ts`];
const SERVERS = [`${DIR}/evidence.server.ts`, `${DIR}/evidence-overview.server.ts`];

test("pure core stays pure (no server-only, no @/ import, no SDK/DB/fetch/clock)", () => {
  for (const f of PURE) {
    const s = read(f);
    assert.equal(/import\s+["']server-only["']/.test(s), false, `${f} not server-only`);
    assert.equal(/from\s+["']@\//.test(s), false, `${f} no @/ import`);
    assert.equal(/@anthropic-ai|openai|createClient|\bfetch\(|new Date\(|Date\.now/.test(s), false, `${f} no SDK/DB/fetch/clock`);
  }
});

test("server read APIs are server-only and perform NO writes / persistence", () => {
  for (const f of SERVERS) {
    const s = strip(read(f));
    assert.ok(/import\s+["']server-only["']/.test(s), `${f} server-only`);
    for (const w of [/\.update\(/, /\.insert\(/, /\.upsert\(/, /\.delete\(/, /\.rpc\(/]) {
      assert.equal(w.test(s), false, `${f} no write (${w})`);
    }
  }
});

test("the evidence engine mutates NO lifecycle / inventory / availability / ECL / channel data + no AI", () => {
  for (const f of [...PURE, ...SERVERS]) {
    const s = strip(read(f));
    assert.equal(/\.(update|insert|upsert|delete|rpc)\(/.test(s), false, `${f} performs no mutation`);
    assert.equal(/generateEnrichment|applyEnrichment|messages\.create/.test(s), false, `${f} performs no AI`);
    assert.equal(/transitionProductLifecycle|setProductStatus|writeProductEnrichment/.test(s), false, `${f} performs no lifecycle/metadata write`);
  }
});

test("no schema / migration / persistence ships with the evidence engine", () => {
  const files = existsSync(join(ROOT, DIR)) ? readdirSync(join(ROOT, DIR)) : [];
  assert.equal(files.some((f) => f.endsWith(".sql")), false, "no .sql in the evidence dir");
  // freshness fields exist but nothing persists them this phase
  const model = read(`${DIR}/evidence-model.ts`);
  assert.ok(/observedAt/.test(model) && /resolvedAt/.test(model) && /active/.test(model), "freshness fields declared");
});

test("evidence is never fabricated — only registered certified rules become evidence", () => {
  const eng = strip(read(`${DIR}/evidence-engine.ts`));
  assert.ok(/EVIDENCE_RULES\[r\.id\]/.test(eng), "looks up rule metadata by the CAT.1A rule id");
  assert.ok(/if \(!meta\) continue/.test(eng), "skips any rule without registered metadata (no fabrication)");
  // the contract carries the full required field set
  const model = read(`${DIR}/evidence-model.ts`);
  for (const field of ["id", "type", "domain", "severity", "confidence", "source", "productId", "observedAt", "ruleId", "facts", "summary", "details"]) {
    assert.ok(new RegExp(`\\b${field}\\b`).test(model), `contract includes ${field}`);
  }
});

test("severity + confidence are closed sets (no invented values)", () => {
  const model = read(`${DIR}/evidence-model.ts`);
  const sevLine = model.split("\n").find((l) => l.includes("type EvidenceSeverity")) ?? "";
  for (const v of ["INFO", "WARNING", "ERROR", "CRITICAL"]) assert.ok(sevLine.includes(`"${v}"`), `severity includes ${v}`);
  const confLine = model.split("\n").find((l) => l.includes("type EvidenceConfidence")) ?? "";
  for (const v of ["HIGH", "MEDIUM", "LOW", "UNKNOWN"]) assert.ok(confLine.includes(`"${v}"`), `confidence includes ${v}`);
  // "manual" must never be a source VALUE (ignore the doc-comment that names it).
  assert.equal(/["']manual["']/.test(strip(model)), false, "source is never 'manual'");
});

test("dedupe is present (one evidence per identity)", () => {
  assert.ok(/export function dedupeEvidence/.test(read(`${DIR}/evidence-engine.ts`)), "dedupeEvidence exists");
});
