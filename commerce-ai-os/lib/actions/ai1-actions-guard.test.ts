// AI.1 — Unified Action Center guard (source scan §12). Proves this is a
// READ-ONLY orchestration layer: it performs NO writes, duplicates NO business
// logic, and adds NO new scanner. The pure model + adapters are runtime-pure
// (adapters import reader shapes as `import type` only — erased at runtime); the
// server assembler is server-only, reuses the certified OPS/BI readers via
// React.cache and touches no business table; the components are presentational;
// and the page is force-dynamic, streams the secondary read, and mutates nothing.
// node --conditions=react-server --experimental-strip-types --test lib/actions/ai1-actions-guard.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

const MODEL = "lib/actions/action-model.ts";
const SOURCES = "lib/actions/action-sources.ts";
const SERVER = "lib/actions/action-center.server.ts";
const CENTER = "components/v2/actions/ActionCenter.tsx";
const DRAWER = "components/v2/actions/ReviewDrawer.tsx";
const PAGE = "app/(v2)/v2/actions/page.tsx";
const COMPONENTS = [CENTER, DRAWER];
const ALL = [MODEL, SOURCES, SERVER, CENTER, DRAWER, PAGE];

const WRITES = [/\.insert\(/, /\.update\(/, /\.upsert\(/, /\.delete\(/, /\.rpc\(/, /createAdminClient/];
// scanners / compute engines AI.1 must NEVER call (it consumes their readers' output)
const SCANNERS = [
  /scanMissingProducts\(/,
  /scanBarcodeCompletion\(/,
  /scanSnoonuAvailability\(/,
  /scanEnrichmentCandidates\(/,
  /loadOperationsDashboard\(/,
  /computeAnalytics\(/,
  /getCeoKpis\(/,
  /computeProductReadiness\(/,
  /generateProductTasks\(/,
];

// ── §10/§12 no writes anywhere ────────────────────────────────────────────────
test("no writes anywhere in AI.1", () => {
  for (const f of ALL) {
    const s = strip(read(f));
    for (const w of WRITES) assert.equal(w.test(s), false, `${f} performs no ${w}`);
    assert.equal(/"use server"/.test(s), false, `${f} exposes no server action`);
  }
});

// ── §12 no new scanners / no duplicated business logic ────────────────────────
test("AI.1 adds NO scanner and duplicates NO compute — it consumes certified readers only", () => {
  for (const f of [MODEL, SOURCES, SERVER]) {
    const s = strip(read(f));
    for (const scan of SCANNERS) assert.equal(scan.test(s), false, `${f} must not call ${scan}`);
  }
});

// ── the pure model + adapters are runtime-pure ────────────────────────────────
test("action-model is fully pure (no imports from @/, no server-only, no IO/clock/writes)", () => {
  const raw = read(MODEL);
  assert.equal(/from\s+["']@\//.test(raw), false, "no @/ imports at all");
  assert.equal(/import\s+["']server-only["']/.test(raw), false, "not server-only");
  const s = strip(raw);
  for (const bad of [...WRITES, /\.from\(/, /createClient/, /fetch\(/, /process\.env/, /Date\.now/, /new Date\(/]) {
    assert.equal(bad.test(s), false, `model must not contain ${bad}`);
  }
});

test("action-sources is runtime-pure: every @/ import is `import type` (erased at runtime)", () => {
  const raw = read(SOURCES);
  // any @/ import line must be a type-only import
  const importLines = raw.split("\n").filter((l) => /from\s+["']@\//.test(l));
  assert.ok(importLines.length > 0, "adapters do reference reader shapes");
  for (const line of importLines) {
    assert.ok(/^\s*import\s+type\b/.test(line), `@/ import must be type-only: ${line.trim()}`);
  }
  assert.equal(/import\s+["']server-only["']/.test(raw), false, "adapters are not server-only");
  const s = strip(raw);
  for (const bad of [...WRITES, /\.from\(/, /createClient/, /fetch\(/, /process\.env/, /Date\.now/, /new Date\(/]) {
    assert.equal(bad.test(s), false, `adapters must not contain ${bad}`);
  }
});

// ── §8 server reuses the certified readers via React.cache, no direct reads ────
test("server assembler is server-only, reuses certified readers via cache, reads no table", () => {
  const raw = read(SERVER);
  assert.ok(/import\s+["']server-only["']/.test(raw), "server is server-only");
  const s = strip(raw);
  // CAT.1C — the AI needsGeneration projection was retired; the server now reuses
  // the canonical CAT.1B evidence batch (loadEvidenceActions) as the catalog-quality source.
  for (const reader of [/loadHealthCenter/, /loadAnalytics/, /loadMediaCenter/, /loadEvidenceActions/]) {
    assert.ok(reader.test(s), `server reuses ${reader}`);
  }
  assert.ok(/\bcache\(/.test(s), "certified reads are request-cached (no repeated scans)");
  for (const bad of [/\.from\(/, /createClient/, /@\/lib\/supabase/, ...WRITES]) {
    assert.equal(bad.test(s), false, `server must not read/write tables directly (${bad})`);
  }
  for (const ddl of [/create\s+table/i, /alter\s+table/i, /apply_migration/i]) {
    assert.equal(ddl.test(s), false, `server adds no schema (${ddl})`);
  }
});

// ── components are presentational ─────────────────────────────────────────────
test("components are presentational — no data client, writes, actions, secrets or network", () => {
  for (const f of COMPONENTS) {
    const s = strip(read(f));
    for (const bad of [/createAdminClient/, /createClient\(/, /@\/lib\/supabase/, /\.from\(/, /\.insert\(/, /\.rpc\(/, /"use server"/, /@anthropic-ai/, /process\.env/, /fetch\(/]) {
      assert.equal(bad.test(s), false, `${f} must not contain ${bad}`);
    }
  }
  // the drawer's only navigation is a link; the center reads only the pure model
  assert.ok(/from\s+["']next\/link["']/.test(read(DRAWER)), "drawer opens the workflow via next/link");
  const centerAtImports = (read(CENTER).match(/from\s+["']@\/[^"']+["']/g) ?? []).map((m) => m.replace(/from\s+["']|["']/g, ""));
  for (const imp of centerAtImports) {
    assert.ok(imp === "@/lib/actions/action-model", `unexpected @/ import in ActionCenter: ${imp}`);
  }
});

// ── §6 review drawer has NO execution buttons ─────────────────────────────────
test("review drawer opens the original workflow but exposes NO execution", () => {
  const s = strip(read(DRAWER));
  // read-only: only navigation, no form submit / action handlers that mutate
  assert.equal(/onSubmit|formAction|"use server"/.test(s), false, "no execution surface in the drawer");
});

// ── page: read-only render, force-dynamic, streams secondary section ───────────
test("page is force-dynamic, streams the secondary read, renders read-only", () => {
  const s = strip(read(PAGE));
  assert.ok(/force-dynamic/.test(s), "force-dynamic");
  assert.ok(/loadActionCenter\(/.test(s), "makes the primary aggregated read");
  assert.ok(/<Suspense/.test(s), "secondary section is lazy (Suspense)");
  assert.ok(/loadActionCenterDetail\(/.test(s), "streams the product-level detail");
  for (const w of WRITES) assert.equal(w.test(s), false, `page performs no ${w}`);
});
