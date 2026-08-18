// CAT.1E — Product Intelligence Panel guard (source scan §14). Proves the panel
// is READ-ONLY and composes certified engines only: the composer is pure (no
// reads / writes / clock / mutation and no duplicated business logic), the panel
// component is presentational (no data client, no writes, no execution), and the
// product page wires it without introducing any mutation.
// node --conditions=react-server --experimental-strip-types --test lib/catalog/intelligence/cat1e-intelligence-guard.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

const DIR = "lib/catalog/intelligence";
const COMPOSER = `${DIR}/product-intelligence.ts`;
const PANEL = "components/v2/catalog/ProductIntelligencePanel.tsx";
const PAGE = "app/(v2)/v2/catalog/[id]/page.tsx";

const WRITES = [/\.update\(/, /\.insert\(/, /\.upsert\(/, /\.delete\(/, /\.rpc\(/, /createAdminClient/];
const AUTO_EXEC = [/generateEnrichment/, /applyEnrichment/, /messages\.create/, /transitionProductLifecycle/, /setProductStatus/];
const MUTATIONS = [/transitionProductLifecycle/, /commitStock/, /setInventory/, /setAvailability/, /persistTalabatMappings/, /syncEditorVariants/];

// ── the composer is pure and duplicates no business logic ─────────────────────
test("intelligence composer is pure (no server-only, no @/ import, no IO/clock/random/writes)", () => {
  const raw = read(COMPOSER);
  assert.equal(/import\s+["']server-only["']/.test(raw), false, "not server-only");
  assert.equal(/from\s+["']@\//.test(raw), false, "no @/ import (relative only)");
  const s = strip(raw);
  // `.from(` with a string arg = a Supabase table read; `Array.from(new Set())` is fine.
  for (const bad of [...WRITES, /\.from\(["'`]/, /createClient/, /\bfetch\(/, /new Date\(/, /Date\.now/, /Math\.random/]) {
    assert.equal(bad.test(s), false, `composer contains ${bad}`);
  }
  // reuse only — it must not recompute health / evidence detection
  for (const dup of [/computeCatalogHealth/, /buildEvidenceFromHealth/, /HEALTH_RULES/]) {
    assert.equal(dup.test(s), false, `composer must reuse, not recompute (${dup})`);
  }
  // explainability: sections carry evidence/rule/recommendation linkage
  for (const f of ["evidenceIds", "ruleIds", "recommendationIds"]) {
    assert.ok(new RegExp(f).test(raw), `section carries ${f}`);
  }
});

// ── the panel is presentational (read-only) ───────────────────────────────────
test("intelligence panel is presentational — no data client, writes, execution, secrets or network", () => {
  const raw = read(PANEL);
  const s = strip(raw);
  for (const bad of [/createAdminClient/, /createClient\(/, /@\/lib\/supabase/, /\.from\(["'`]/, /\.insert\(/, /\.rpc\(/, /"use server"/, /@anthropic-ai/, /process\.env/, /\bfetch\(/]) {
    assert.equal(bad.test(s), false, `${PANEL} must not contain ${bad}`);
  }
  for (const x of AUTO_EXEC) assert.equal(x.test(s), false, `${PANEL} performs no ${x}`);
});

// ── no schema / migration ships with CAT.1E ───────────────────────────────────
test("no schema / migration / .sql in the intelligence dir", () => {
  const s = strip(read(COMPOSER));
  for (const ddl of [/create\s+table/i, /alter\s+table/i, /apply_migration/i]) {
    assert.equal(ddl.test(s), false, `composer adds no schema (${ddl})`);
  }
  const files = existsSync(join(ROOT, DIR)) ? readdirSync(join(ROOT, DIR)) : [];
  assert.equal(files.some((f) => f.endsWith(".sql")), false, "no .sql in the intelligence dir");
});

// ── the page wiring introduces no mutation via the panel ──────────────────────
test("the product page composes the panel read-only (no new mutation wired for it)", () => {
  const raw = read(PAGE);
  assert.ok(/buildProductIntelligence/.test(raw), "page composes the intelligence model");
  assert.ok(/ProductIntelligencePanel/.test(raw), "page renders the panel");
  // the panel + its composition add no lifecycle/inventory/availability/ECL/channel
  // mutation. (The page's ONLY writer is the pre-existing lifecycle transition
  // action, which is unrelated to CAT.1E.) Assert no NEW mutation calls appear in
  // the intelligence composition path — the composer + panel are import-checked above.
  const s = strip(read(COMPOSER));
  for (const m of MUTATIONS) assert.equal(m.test(s), false, `composer performs no ${m}`);
  const p = strip(read(PANEL));
  for (const m of MUTATIONS) assert.equal(m.test(p), false, `panel performs no ${m}`);
});
