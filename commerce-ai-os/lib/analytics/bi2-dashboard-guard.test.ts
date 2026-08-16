// BI.2 — Executive Dashboard guard (source scan §14). Proves the dashboard is a
// READ-ONLY presentation layer that consumes the BI.1 Analytics Read Layer + the
// certified OPS read models ONLY: it performs no writes, duplicates no analytics
// calculations, and does no direct business-table aggregation. The pure composer
// is @/-free; the server assembler is server-only, makes ONE analytics request and
// reuses OPS loaders; the components are presentational; the page streams the
// secondary widgets; and there is no "Fix All".
// node --conditions=react-server --experimental-strip-types --test lib/analytics/bi2-dashboard-guard.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

const COMPOSER = "lib/analytics/executive-dashboard.ts";
const SERVER = "lib/analytics/executive-dashboard.server.ts";
const COMPONENT = "components/v2/analytics/ExecutiveDashboard.tsx";
const SECTIONS = "components/v2/analytics/DashboardSections.tsx";
const PAGE = "app/(v2)/v2/analytics/page.tsx";
const ALL = [COMPOSER, SERVER, COMPONENT, SECTIONS, PAGE];

const WRITES = [/\.insert\(/, /\.update\(/, /\.upsert\(/, /\.delete\(/, /\.rpc\(/, /createAdminClient/];
// analytics calculators BI.2 must NOT re-run (it consumes BI.1's shaped result)
const CALCULATORS = ["computeAnalytics", "computeSalesSummary", "computeLowStock", "getCeoKpis", "getInventoryAnalytics", "getSalesSummary"];

// ── §14 no writes anywhere ────────────────────────────────────────────────────
test("no writes anywhere in BI.2", () => {
  for (const f of ALL) {
    const s = strip(read(f));
    for (const w of WRITES) assert.equal(w.test(s), false, `${f} performs no ${w}`);
  }
});

// ── §14 no direct business-table aggregation ──────────────────────────────────
test("no direct business-table reads/aggregation anywhere in BI.2", () => {
  for (const f of ALL) {
    // neutralise Array.from (a render helper, not a Supabase table read)
    const s = strip(read(f)).replace(/Array\.from\(/g, "Array_from(");
    for (const bad of [/\.from\(/, /\.select\(/, /fetchAll\(/, /createClient/, /@\/lib\/supabase/]) {
      assert.equal(bad.test(s), false, `${f} must not read business tables directly (${bad})`);
    }
  }
});

// ── §14 no duplicated analytics calculations ──────────────────────────────────
test("BI.2 duplicates NO analytics calculations — it consumes BI.1 only", () => {
  for (const f of [COMPOSER, SERVER]) {
    const s = strip(read(f));
    for (const calc of CALCULATORS) {
      assert.equal(s.includes(calc), false, `${f} must not re-run calculator ${calc}`);
    }
    for (const raw of [/@\/lib\/inventory/, /@\/lib\/dashboard/]) {
      assert.equal(raw.test(s), false, `${f} must not import raw compute module ${raw}`);
    }
  }
});

// ── composer purity ───────────────────────────────────────────────────────────
test("composer is PURE (no @/ imports, no server-only, no IO, no clock)", () => {
  const raw = read(COMPOSER);
  assert.equal(/from\s+["']@\//.test(raw), false, "no @/ imports");
  assert.equal(/import\s+["']server-only["']/.test(raw), false, "not server-only");
  const s = strip(raw);
  for (const bad of [...WRITES, /\.from\(/, /createClient/, /fetch\(/, /process\.env/, /Date\.now/, /new Date\(/]) {
    assert.equal(bad.test(s), false, `composer must not contain ${bad}`);
  }
});

// ── server: server-only, ONE analytics request, reuses BI.1 + OPS ─────────────
test("server assembler is server-only, makes ONE analytics request, reuses BI.1 + OPS", () => {
  const raw = read(SERVER);
  assert.ok(/import\s+["']server-only["']/.test(raw), "server is server-only");
  const s = strip(raw);
  assert.equal((s.match(/loadAnalytics\(/g) ?? []).length, 1, "exactly one BI.1 analytics request");
  assert.ok(/loadExecutiveDashboard/.test(s) && /buildExecutiveDashboard\(/.test(s), "shapes via the pure builder");
  assert.ok(/loadHealthCenter/.test(s) && /loadChannelCenter/.test(s), "reuses OPS.6 health + OPS.3 channel read models");
  assert.ok(/\bcache\(/.test(s), "shared OPS reads are request-cached (no repeated loading)");
  for (const ddl of [/create\s+table/i, /alter\s+table/i, /apply_migration/i]) {
    assert.equal(ddl.test(s), false, `assembler adds no schema (${ddl})`);
  }
});

// ── components: presentational ─────────────────────────────────────────────────
test("components are presentational — no data client, no writes, no secrets, link-based", () => {
  for (const f of [COMPONENT, SECTIONS]) {
    const s = read(f);
    for (const bad of [/createAdminClient/, /createClient\(/, /@\/lib\/supabase/, /\.from\(/, /"use server"/, /@anthropic-ai/, /process\.env/]) {
      assert.equal(bad.test(s), false, `${f} must not contain ${bad}`);
    }
    assert.ok(/from "next\/link"/.test(s), `${f} navigates via next/link`);
  }
});

// ── §9 no "Fix All" / no bulk mutation entrypoint ─────────────────────────────
test("no Fix All or bulk-apply action anywhere in BI.2", () => {
  for (const f of ALL) {
    const s = strip(read(f)); // ignore doc comments that merely mention the rule
    assert.equal(/fix all/i.test(s), false, `${f} has no "Fix All"`);
    assert.equal(/"use server"/.test(s), false, `${f} exposes no server action`);
  }
});

// ── page: read-only render, force-dynamic, streams secondary widgets ───────────
test("page is force-dynamic, streams secondary widgets, renders the dashboard", () => {
  const s = strip(read(PAGE));
  assert.ok(/force-dynamic/.test(s), "force-dynamic");
  assert.ok(/loadExecutiveDashboard\(/.test(s), "makes the single analytics request");
  assert.ok(/<Suspense/.test(s), "secondary widgets are lazy (Suspense)");
  assert.ok(/<ExecutiveDashboard/.test(s), "renders the dashboard");
  for (const w of WRITES) assert.equal(w.test(s), false, `page performs no ${w}`);
});

// ── deep-links only to existing routes ────────────────────────────────────────
test("dashboard deep-links only to existing v2 routes", () => {
  const s = read(COMPOSER);
  const routes = (s.match(/\/v2\/[a-z/-]+/g) ?? []).map((r) => r.replace(/[)"'`].*$/, ""));
  const allowed = [
    "/v2/analytics",
    "/v2/catalog",
    "/v2/operations/media",
    "/v2/operations/ai",
    "/v2/operations/availability-sync",
    "/v2/operations/barcode-completion",
    "/v2/operations/missing-products",
    "/v2/operations/channels",
    "/v2/operations/health",
  ];
  for (const r of routes) assert.ok(allowed.includes(r), `route ${r} is an existing workflow`);
});
