// WAVE.1A — Launch Campaign Workspace guard (source scan). Proves the workspace
// is READ-ONLY and COMPOSES certified read models only: the pure composer holds
// no rule engine, the server read-model reuses the certified loaders + the HOME.2
// Launch Readiness composer through a single shared scan, the UI is presentational
// and deep-links to the EXISTING editor (no new editing UI), and nothing writes.
// node --conditions=react-server --experimental-strip-types --test lib/catalog/launch/launch-workspace-guard.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

const PURE = "lib/catalog/launch/launch-workspace.ts";
const SERVER = "lib/catalog/launch/launch-workspace.server.ts";
const PANEL = "components/v2/catalog/LaunchWorkspace.tsx";
const PAGE = "app/(v2)/v2/catalog/launch/page.tsx";

const WRITES = [/\.update\(/, /\.insert\(/, /\.upsert\(/, /\.delete\(/, /\.rpc\(/];
const DUP_LOGIC = [/computeCatalogHealth/, /buildEvidenceFromHealth/, /HEALTH_RULES/, /computeProductReadiness/, /buildRecommendations\b/];

// ── the composer is pure, reuses certified reasons, invents no rule ───────────
test("launch workspace composer is pure and reuses certified reasons only", () => {
  const raw = read(PURE);
  assert.equal(/import\s+["']server-only["']/.test(raw), false, "not server-only");
  assert.equal(/from\s+["']@\//.test(raw), false, "no @/ import (relative only)");
  const s = strip(raw);
  for (const bad of [...WRITES, /\.from\(["'`]/, /createClient/, /\bfetch\(/, /new Date\(\s*\)/, /Date\.now/, /Math\.random/, /process\.env/]) {
    assert.equal(bad.test(s), false, `composer contains ${bad}`);
  }
  for (const dup of DUP_LOGIC) assert.equal(dup.test(s), false, `composer must reuse, not recompute (${dup})`);
  assert.ok(/READINESS_MESSAGES/.test(raw), "reuses the certified readiness reasons");
});

// ── the server read-model reuses certified loaders + HOME.2, single scan, no writes
test("launch workspace read-model composes certified loaders + HOME.2, no writes", () => {
  const raw = read(SERVER);
  const s = strip(raw);
  for (const bad of WRITES) assert.equal(bad.test(s), false, `read-model must not write (${bad})`);
  for (const dup of DUP_LOGIC) assert.equal(dup.test(s), false, `read-model must reuse, not recompute (${dup})`);
  const REQUIRED = [
    "@/lib/home/home-model", // reuse HOME.2 buildLaunchReadiness
    "@/lib/operations/read-model",
    "@/lib/export/export-center.server",
    "@/lib/actions/action-center.server",
    "@/lib/analytics/analytics-read.server",
    // NOTE: "@/lib/dashboard" (getCeoKpis) is deliberately NOT reused any more.
    // Its head counts are catalog-wide `count(*)` queries that cannot be
    // restricted to the operational master, so Launch's blocker counts included
    // products outside it. Blocker counts now come from the master-scoped
    // readiness scan via the shared countMasterGap helper.
  ];
  for (const mod of REQUIRED) assert.ok(raw.includes(mod), `read-model reuses ${mod}`);
  // Launch is an operational surface: it must be master-scoped and must not
  // fall back to catalog-wide head counts or hardcode the master size.
  assert.ok(/loadMasterScope/.test(raw), "read-model uses the shared membership seam");
  assert.ok(/countMasterGap/.test(raw), "blocker counts come from the scoped readiness scan");
  assert.equal(/getCeoKpis/.test(s), false, "must not use catalog-wide head counts");
  for (const n of ["1343", "1292", "1530", "1418"]) {
    assert.equal(new RegExp(`\\b${n}\\b`).test(s), false, `must not hardcode ${n}`);
  }
  assert.ok(/buildLaunchReadiness\(/.test(raw), "reuses the HOME.2 Launch Readiness composer");
  assert.ok(/buildLaunchWorkspace\(/.test(raw), "feeds the pure workspace composer");
  // single shared scan: exactly one loadOperationsDashboard call, cache-wrapped.
  assert.equal((raw.match(/loadOperationsDashboard\(/g) ?? []).length, 1, "one operations scan only");
  assert.ok(/cache\(/.test(raw), "the shared read is cache-wrapped");
});

// ── the UI is presentational and routes to the EXISTING editor (no new UI) ────
test("launch workspace UI is presentational and deep-links to the existing editor", () => {
  const s = strip(read(PANEL));
  for (const bad of [/createAdminClient/, /createClient\(/, /@\/lib\/supabase/, /\.from\(["'`]/, ...WRITES, /"use server"/, /@anthropic-ai/, /process\.env/, /\bfetch\(/]) {
    assert.equal(bad.test(s), false, `${PANEL} must not contain ${bad}`);
  }
  assert.ok(/\/v2\/catalog\//.test(read(PANEL)) || /productEditorHref/.test(read(PURE)), "rows deep-link to the existing product editor");
});

// ── the page composes the workspace read-only (no writes) ─────────────────────
test("the launch page composes the workspace read-only", () => {
  assert.ok(existsSync(join(ROOT, PAGE)), "launch page exists");
  const raw = read(PAGE);
  assert.ok(/loadLaunchWorkspace\(/.test(raw), "page loads the shared read-model");
  assert.ok(/LaunchWorkspace/.test(raw), "page renders the workspace");
  for (const bad of WRITES) assert.equal(bad.test(strip(raw)), false, `page must not write (${bad})`);
});
