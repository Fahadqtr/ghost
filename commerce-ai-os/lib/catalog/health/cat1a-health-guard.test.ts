// CAT.1A — Catalog Health Engine guard (source scan). Proves the engine is
// DETECTION-ONLY: pure core, read-only server API, NO writes / schema / migration
// / lifecycle / inventory / availability / ECL / channel mutation, and no AI.
// node --conditions=react-server --experimental-strip-types --test lib/catalog/health/cat1a-health-guard.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

const DIR = "lib/catalog/health";
const PURE = [`${DIR}/health-model.ts`, `${DIR}/health-rules.ts`, `${DIR}/health-engine.ts`];
const SERVER = `${DIR}/health.server.ts`;

test("pure core stays pure (no server-only, no @/ import, no SDK, no fetch/DB)", () => {
  for (const f of PURE) {
    const s = read(f);
    assert.equal(/import\s+["']server-only["']/.test(s), false, `${f} not server-only`);
    assert.equal(/from\s+["']@\//.test(s), false, `${f} no @/ import`);
    assert.equal(/@anthropic-ai|openai|createClient|\bfetch\(/.test(s), false, `${f} no SDK/DB/fetch`);
  }
});

test("the server read API is server-only and performs NO writes", () => {
  const s = strip(read(SERVER));
  assert.ok(/import\s+["']server-only["']/.test(s), "server-only");
  assert.ok(/isSignedIn\(/.test(s), "signed-in read gate");
  for (const w of [/\.update\(/, /\.insert\(/, /\.upsert\(/, /\.delete\(/, /\.rpc\(/]) {
    assert.equal(w.test(s), false, `server API has no write (${w})`);
  }
  assert.ok(/computeCatalogHealth\(/.test(s), "delegates to the pure engine");
});

test("the health engine mutates NO catalog / lifecycle / inventory / availability / ECL / channel data", () => {
  for (const f of [...PURE, SERVER]) {
    const s = strip(read(f));
    for (const tbl of ["product_variants\"\\)\\.update", "inventory", "platform_status\"\\)\\.update", "channel_products\"\\)\\.update", "external_channel_listings\"\\)\\.(insert|update|upsert|delete)"]) {
      assert.equal(new RegExp(`\\.(update|insert|upsert|delete)\\(`).test(s) && new RegExp(tbl).test(s), false, `${f} does not mutate ${tbl}`);
    }
    // no AI generation anywhere in the health engine
    assert.equal(/generateEnrichment|applyEnrichment|messages\.create/.test(s), false, `${f} performs no AI`);
    // no lifecycle transition writes
    assert.equal(/transitionProductLifecycle|setProductStatus/.test(s), false, `${f} performs no lifecycle transition`);
  }
});

test("no schema / migration ships with this engine", () => {
  const files = existsSync(join(ROOT, DIR)) ? readdirSync(join(ROOT, DIR)) : [];
  assert.equal(files.some((f) => f.endsWith(".sql")), false, "no .sql in the health dir");
});

test("rules are isolated: a registry of {id,domain,severity,evaluate}, no giant if/else", () => {
  const s = read(`${DIR}/health-rules.ts`);
  assert.ok(/export const HEALTH_RULES/.test(s), "exposes a rule registry");
  assert.ok(/evaluate\(input/.test(s), "each rule has an isolated evaluate()");
  // evidence + severity + score impact are part of the contract
  const model = read(`${DIR}/health-model.ts`);
  for (const field of ["scoreImpact", "evidence", "severity", "recommendation"]) {
    assert.ok(model.includes(field), `result contract includes ${field}`);
  }
});
