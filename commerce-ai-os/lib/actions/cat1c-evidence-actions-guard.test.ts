// CAT.1C — Evidence → Action Center guard (source scan §15). Proves the
// projection is READ-MODEL + ORCHESTRATION only: the pure adapter invents no
// severity / confidence / detection heuristic and re-uses the CANONICAL CAT.1B
// evidence layer; the server bridge is server-only and reuses the single bounded
// evidence batch (no writes / schema / migration / auto-execution); one active
// evidence identity yields at most one active action.
// node --conditions=react-server --experimental-strip-types --test lib/actions/cat1c-evidence-actions-guard.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

const ADAPTER = "lib/actions/evidence-actions.ts";
const EV_SOURCE = "lib/actions/evidence-source.server.ts";
const EV_BATCH = "lib/catalog/evidence/evidence-batch.server.ts";
const SERVER = "lib/actions/action-center.server.ts";
const MODEL = "lib/actions/action-model.ts";
const ALL = [ADAPTER, EV_SOURCE, EV_BATCH, SERVER];

const WRITES = [/\.insert\(/, /\.update\(/, /\.upsert\(/, /\.delete\(/, /\.rpc\(/, /createAdminClient/];
const AUTO_EXEC = [/generateEnrichment/, /applyEnrichment/, /messages\.create/, /transitionProductLifecycle/, /setProductStatus/, /"use server"/];

// ── the pure projection is fully pure — no IO / clock / random / writes ────────
test("evidence-actions is runtime-pure (no @/ import, no server-only, no IO/clock/random/writes)", () => {
  const raw = read(ADAPTER);
  assert.equal(/from\s+["']@\//.test(raw), false, "no @/ imports — relative only");
  assert.equal(/import\s+["']server-only["']/.test(raw), false, "not server-only");
  const s = strip(raw);
  for (const bad of [...WRITES, /\.from\(/, /createClient/, /fetch\(/, /process\.env/, /Date\.now/, /new Date\(/, /Math\.random/]) {
    assert.equal(bad.test(s), false, `adapter must not contain ${bad}`);
  }
});

// ── CAT.1B is the canonical evidence source; no duplicated evidence logic ──────
test("the adapter consumes the CANONICAL CAT.1B evidence registry — it does not redefine evidence logic", () => {
  const raw = read(ADAPTER);
  assert.ok(/from\s+["']\.\.\/catalog\/evidence\/evidence-model\.ts["']/.test(raw), "imports the canonical evidence model");
  assert.ok(/EVIDENCE_RULES\[/.test(raw), "looks up canonical rule metadata (no re-derivation)");
  const s = strip(raw);
  // no NEW detection: it must not recompute health or import the rule/engine layer
  for (const bad of [/computeCatalogHealth/, /HEALTH_RULES/, /health-rules/, /health-engine/]) {
    assert.equal(bad.test(s), false, `adapter must not run detection (${bad})`);
  }
});

// ── it invents no severity / confidence — it maps from the evidence values ─────
test("severity + confidence are projected from the evidence values via closed maps (never invented)", () => {
  const s = strip(read(ADAPTER));
  assert.ok(/EVIDENCE_TO_ACTION_SEVERITY\[e\.severity\]/.test(s), "severity is mapped from e.severity");
  assert.ok(/EVIDENCE_TO_ACTION_CONFIDENCE\[e\.confidence\]/.test(s), "confidence is mapped from e.confidence");
});

// ── active/resolved + lifecycle-ownership are respected (§7/§9) ────────────────
test("only active, unresolved, non-lifecycle evidence is projected", () => {
  const s = strip(read(ADAPTER));
  assert.ok(/e\.active\s*!==\s*true/.test(s), "skips inactive evidence");
  assert.ok(/e\.resolvedAt\s*!==\s*null/.test(s), "skips resolved evidence");
  assert.ok(/e\.domain\s*===\s*["']lifecycle["']/.test(s), "skips lifecycle-domain evidence (owned by lifecycle source)");
});

// ── one evidence identity → one action id (§3/§15) ────────────────────────────
test("the projected action id embeds the evidence identity; the model dedupes by id", () => {
  assert.ok(/EV:\$\{e\.id\}/.test(read(ADAPTER)), "action id is derived 1:1 from the evidence identity");
  const model = strip(read(MODEL));
  assert.ok(/seen\.has\(action\.id\)/.test(model), "buildActionCenter dedupes by action id");
});

// ── server bridge + batch are server-only, read-only, single bounded scan ─────
test("evidence server bridge + batch are server-only and perform NO writes", () => {
  for (const f of [EV_SOURCE, EV_BATCH]) {
    const raw = read(f);
    assert.ok(/import\s+["']server-only["']/.test(raw), `${f} is server-only`);
    const s = strip(raw);
    for (const w of WRITES) assert.equal(w.test(s), false, `${f} performs no write (${w})`);
  }
  // the batch reuses the certified CAT.1A engine + CAT.1B projection (one scan)
  const batch = strip(read(EV_BATCH));
  assert.ok(/computeCatalogHealth/.test(batch), "batch reuses the certified CAT.1A engine");
  assert.ok(/buildEvidenceFromHealth/.test(batch), "batch reuses the CAT.1B projection");
  // the source bridge does not scan itself — it delegates to the shared batch
  const src = strip(read(EV_SOURCE));
  assert.ok(/loadCatalogEvidenceBatch/.test(src), "source reuses the shared bounded batch");
  assert.equal(/\.from\(/.test(src), false, "source bridge runs no scan of its own");
});

// ── no writes / auto-execution / schema anywhere in CAT.1C ────────────────────
test("CAT.1C adds no writes, no auto-execution, no schema / migration", () => {
  for (const f of ALL) {
    const s = strip(read(f));
    for (const w of WRITES) assert.equal(w.test(s), false, `${f} performs no ${w}`);
    for (const x of AUTO_EXEC) assert.equal(x.test(s), false, `${f} has no auto-execution (${x})`);
    for (const ddl of [/create\s+table/i, /alter\s+table/i, /apply_migration/i]) {
      assert.equal(ddl.test(s), false, `${f} adds no schema (${ddl})`);
    }
  }
});

// ── the server wires evidence as the canonical catalog-quality source ─────────
test("the action-center server reuses loadEvidenceActions and adds no direct table read", () => {
  const s = strip(read(SERVER));
  assert.ok(/loadEvidenceActions/.test(s), "server projects canonical evidence");
  assert.ok(/actionsFromEvidence/.test(s), "server uses the pure evidence projection");
  for (const bad of [/\.from\(/, /createClient/, /@\/lib\/supabase/]) {
    assert.equal(bad.test(s), false, `server reads no table directly (${bad})`);
  }
  // retired overlaps are no longer wired
  assert.equal(/actionsFromAi\b/.test(s), false, "the AI needsGeneration projection is retired");
});
