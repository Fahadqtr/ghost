// HOME.1 — Executive Home Dashboard guard (source scan). Proves the home is
// READ-ONLY and COMPOSES existing certified engines only: the composer is pure
// (no reads/writes/clock/random and no duplicated business logic), the server
// assembler only REUSES certified loaders and performs NO writes, the UI is
// presentational, and the /v2 entry renders the dashboard (no redirect, no new
// schema).
// node --conditions=react-server --experimental-strip-types --test lib/home/home-guard.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

const COMPOSER = "lib/home/home-model.ts";
const ASSEMBLER = "lib/home/home-dashboard.server.ts";
const ACTIVITY = "lib/home/recent-activity.server.ts";
const PANEL = "components/v2/home/HomeDashboard.tsx";
const PAGE = "app/(v2)/v2/page.tsx";

const WRITES = [/\.update\(/, /\.insert\(/, /\.upsert\(/, /\.delete\(/, /\.rpc\(/];
// certified rule engines the home must REUSE, never re-implement.
const DUP_LOGIC = [
  /computeCatalogHealth/, /buildEvidenceFromHealth/, /HEALTH_RULES/, /HEALTH_DOMAINS/,
  /computeProductReadiness/, /buildRecommendations\b/, /EVIDENCE_RULES/, /gradeForScore/,
];

// ── the composer is pure and duplicates no business logic ─────────────────────
test("home composer is pure (no server-only, no @/ import, no IO/clock/random/writes)", () => {
  const raw = read(COMPOSER);
  assert.equal(/import\s+["']server-only["']/.test(raw), false, "not server-only");
  assert.equal(/from\s+["']@\//.test(raw), false, "no @/ import (relative only)");
  const s = strip(raw);
  for (const bad of [...WRITES, /\.from\(["'`]/, /createClient/, /createAdminClient/, /\bfetch\(/, /new Date\(\s*\)/, /Date\.now/, /Math\.random/, /process\.env/]) {
    assert.equal(bad.test(s), false, `composer contains ${bad}`);
  }
  // it may PARSE an injected timestamp (new Date(iso)) but must own no clock.
  for (const dup of DUP_LOGIC) assert.equal(dup.test(s), false, `composer must reuse, not recompute (${dup})`);
});

// ── the server assembler REUSES certified loaders and never writes ────────────
test("home assembler composes certified loaders only and performs no writes", () => {
  const raw = read(ASSEMBLER);
  const s = strip(raw);
  for (const bad of WRITES) assert.equal(bad.test(s), false, `assembler must not write (${bad})`);
  // it must not re-implement any certified rule engine
  for (const dup of DUP_LOGIC) assert.equal(dup.test(s), false, `assembler must reuse, not recompute (${dup})`);
  // and it must actually reuse the certified read models (compose-only)
  const REQUIRED_REUSE = [
    "@/lib/actions/action-center.server",
    "@/lib/operations/read-model",
    "@/lib/export/export-center.server",
    "@/lib/catalog/health/health-distribution.server",
    "@/lib/catalog/evidence/evidence-overview.server",
    "@/lib/catalog/recommendations/recommendation-summary.server",
    "@/lib/analytics/analytics-read.server",
    "@/lib/operations/ai/ai-center.server",
    "@/lib/dashboard",
    "@/lib/loyalty/rewards",
  ];
  for (const mod of REQUIRED_REUSE) assert.ok(raw.includes(mod), `assembler reuses ${mod}`);
  // it feeds the pure composer
  assert.ok(/buildHomeDashboard\(/.test(raw), "assembler feeds the pure composer");
});

// ── activity reader is a read-only projection of the audit source ─────────────
test("recent-activity reader only reads (audit source), never writes", () => {
  const s = strip(read(ACTIVITY));
  for (const bad of WRITES) assert.equal(bad.test(s), false, `activity reader must not write (${bad})`);
  assert.ok(/malak_audit/.test(s), "reads the existing audit source");
  assert.ok(/\.select\(/.test(s) && !/\.insert\(|\.update\(|\.delete\(|\.upsert\(|\.rpc\(/.test(s), "select-only");
});

// ── the UI is presentational (read-only) ──────────────────────────────────────
test("home panel is presentational — no data client, writes, secrets or network", () => {
  const s = strip(read(PANEL));
  for (const bad of [/createAdminClient/, /createClient\(/, /@\/lib\/supabase/, /\.from\(["'`]/, ...WRITES, /"use server"/, /@anthropic-ai/, /process\.env/, /\bfetch\(/]) {
    assert.equal(bad.test(s), false, `${PANEL} must not contain ${bad}`);
  }
});

// ── the /v2 entry renders the dashboard (no redirect to catalog) ──────────────
test("the /v2 entry composes the home dashboard read-only (no redirect, no writes)", () => {
  const raw = read(PAGE);
  assert.ok(/loadHomeDashboard\(/.test(raw), "page loads the composed model");
  assert.ok(/HomeDashboard/.test(raw), "page renders the dashboard");
  assert.equal(/redirect\(/.test(strip(raw)), false, "no redirect (the home replaces the catalog redirect)");
  for (const bad of WRITES) assert.equal(bad.test(strip(raw)), false, `page must not write (${bad})`);
});

// ── no schema / migration ships with HOME.1 ───────────────────────────────────
test("no schema / migration / .sql in lib/home", () => {
  for (const f of [COMPOSER, ASSEMBLER, ACTIVITY]) {
    const s = strip(read(f));
    for (const ddl of [/create\s+table/i, /alter\s+table/i, /apply_migration/i]) {
      assert.equal(ddl.test(s), false, `${f} adds no schema (${ddl})`);
    }
  }
  const dir = "lib/home";
  const files = existsSync(join(ROOT, dir)) ? readdirSync(join(ROOT, dir)) : [];
  assert.equal(files.some((f) => f.endsWith(".sql")), false, "no .sql in lib/home");
});
