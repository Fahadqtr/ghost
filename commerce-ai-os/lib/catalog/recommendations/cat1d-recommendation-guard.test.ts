// CAT.1D — Certified Recommendation Engine guard (source scan §15). Proves the
// engine is READ-ONLY and derives recommendations from CANONICAL evidence ONLY:
// the pure core reads evidence (never product data / health rules / a DB / a
// clock), the servers are server-only and perform NO writes / schema / migration
// / lifecycle / inventory / availability / ECL mutation, and the Action Center
// consumes recommendations (never generates them).
// node --conditions=react-server --experimental-strip-types --test lib/catalog/recommendations/cat1d-recommendation-guard.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

const DIR = "lib/catalog/recommendations";
const MODEL = `${DIR}/recommendation-model.ts`;
const ENGINE = `${DIR}/recommendation-engine.ts`;
const PURE = [MODEL, ENGINE];
const SERVERS = [`${DIR}/recommendations.server.ts`, `${DIR}/recommendation-summary.server.ts`];
const ACTIONS = "lib/actions/recommendation-actions.ts";
const AC_SERVER = "lib/actions/action-center.server.ts";
const ALL = [...PURE, ...SERVERS, ACTIONS];

const WRITES = [/\.update\(/, /\.insert\(/, /\.upsert\(/, /\.delete\(/, /\.rpc\(/, /createAdminClient/];
const AUTO_EXEC = [/generateEnrichment/, /applyEnrichment/, /messages\.create/, /transitionProductLifecycle/, /setProductStatus/, /"use server"/];

// ── pure core stays pure and reads EVIDENCE only (§1/§13) ─────────────────────
test("recommendation model + engine are pure (no server-only, no @/ import, no SDK/DB/fetch/clock/random)", () => {
  for (const f of PURE) {
    const raw = read(f);
    assert.equal(/import\s+["']server-only["']/.test(raw), false, `${f} not server-only`);
    assert.equal(/from\s+["']@\//.test(raw), false, `${f} no @/ import (relative only)`);
    const s = strip(raw);
    for (const bad of [...WRITES, /\.from\(/, /createClient/, /\bfetch\(/, /new Date\(/, /Date\.now/, /Math\.random/]) {
      assert.equal(bad.test(s), false, `${f} contains ${bad}`);
    }
  }
});

test("the engine derives from CANONICAL evidence and inspects NO product data / health rules", () => {
  const raw = read(ENGINE);
  assert.ok(/from\s+["']\.\.\/evidence\/evidence-model\.ts["']/.test(raw), "reads the canonical evidence model");
  assert.ok(/EVIDENCE_RULES\[/.test(raw), "resolves canonical evidence ids (no re-derivation)");
  const s = strip(raw);
  for (const bad of [/computeCatalogHealth/, /HEALTH_RULES/, /health-rules/, /\bproducts\b.*select/i]) {
    assert.equal(bad.test(s), false, `engine must not inspect product data / recompute health (${bad})`);
  }
  // no recommendation without evidence — a rule must have matched evidence to fire
  assert.ok(/matched\.length === 0/.test(s), "a rule with no matched evidence emits nothing");
  assert.ok(/sourceEvidenceIds/.test(s), "recommendations carry their supporting evidence ids");
});

// ── servers are server-only and perform NO writes / persistence ───────────────
test("recommendation servers are server-only, read-only, and reuse evidence (no own scan/writes)", () => {
  for (const f of SERVERS) {
    const raw = read(f);
    assert.ok(/import\s+["']server-only["']/.test(raw), `${f} server-only`);
    const s = strip(raw);
    for (const w of WRITES) assert.equal(w.test(s), false, `${f} performs no write (${w})`);
    assert.equal(/\.from\(/.test(s), false, `${f} runs no scan of its own`);
    assert.equal(/createClient/.test(s), false, `${f} opens no client of its own`);
  }
  // they read evidence only (loadEvidence / the shared evidence batch)
  assert.ok(/loadEvidence\b/.test(strip(read(`${DIR}/recommendations.server.ts`))), "per-product reads evidence");
  assert.ok(/loadCatalogEvidenceBatch/.test(strip(read(`${DIR}/recommendation-summary.server.ts`))), "summary reuses the shared batch");
});

// ── no writes / auto-exec / schema anywhere in CAT.1D ─────────────────────────
test("CAT.1D adds no writes, no auto-execution, no schema / migration / persistence", () => {
  for (const f of ALL) {
    const s = strip(read(f));
    for (const w of WRITES) assert.equal(w.test(s), false, `${f} performs no ${w}`);
    for (const x of AUTO_EXEC) assert.equal(x.test(s), false, `${f} has no auto-execution (${x})`);
    for (const ddl of [/create\s+table/i, /alter\s+table/i, /apply_migration/i]) {
      assert.equal(ddl.test(s), false, `${f} adds no schema (${ddl})`);
    }
  }
  const files = existsSync(join(ROOT, DIR)) ? readdirSync(join(ROOT, DIR)) : [];
  assert.equal(files.some((f) => f.endsWith(".sql")), false, "no .sql in the recommendations dir");
});

// ── the projection is pure + 1:1 with the recommendation identity ─────────────
test("recommendation-actions is pure and dedupes by recommendation identity", () => {
  const raw = read(ACTIONS);
  assert.equal(/import\s+["']server-only["']/.test(raw), false, "not server-only");
  assert.ok(/REC:\$\{r\.id\}/.test(raw), "action id embeds the recommendation identity");
  const s = strip(raw);
  for (const bad of [...WRITES, /\.from\(/, /createClient/, /new Date\(/, /Math\.random/]) {
    assert.equal(bad.test(s), false, `projection contains ${bad}`);
  }
});

// ── Action Center consumes recommendations, never generates them (§11) ────────
test("the Action Center consumes the Recommendation Engine (no in-center generation)", () => {
  const s = strip(read(AC_SERVER));
  assert.ok(/actionsFromRecommendations/.test(s), "projects recommendations");
  assert.ok(/buildAllRecommendations/.test(s), "builds recommendations from the shared evidence batch");
  // the superseded direct evidence projection is gone
  assert.equal(/actionsFromEvidence/.test(s), false, "no direct evidence projection remains");
  // no direct table access in the assembler
  for (const bad of [/\.from\(/, /createClient/, /@\/lib\/supabase/]) {
    assert.equal(bad.test(s), false, `assembler reads no table directly (${bad})`);
  }
});
