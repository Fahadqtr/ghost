// OPS.6 — Platform Health Center guard (source scan §19). Proves the Health Center
// is READ-ONLY cross-cutting diagnostics: the composer is pure & does no IO; the
// server assembler is server-only, read-only, reuses the single aggregated
// operations read + OPS.3/4 composers + bounded COUNT-only queries (no heavy
// scanner inline); it adds no schema, writes nothing, fabricates no health history
// and no fake operational state; and no inventory/availability/ECL/media/AI/channel
// writes exist anywhere.
// node --conditions=react-server --experimental-strip-types --test lib/operations/health/ch-ops6-guard.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

const COMPOSER = "lib/operations/health/health-center.ts";
const SERVER = "lib/operations/health/health-center.server.ts";
const COMPONENT = "components/v2/operations/PlatformHealthCenter.tsx";
const PAGE = "app/(v2)/v2/operations/health/page.tsx";
const ALL = [COMPOSER, SERVER, COMPONENT, PAGE];

const WRITES = [/\.insert\(/, /\.update\(/, /\.upsert\(/, /\.delete\(/, /\.rpc\(/, /createAdminClient/];

// ── composer purity + no IO ──────────────────────────────────────────────────────
test("composer is PURE (no @/ imports, no server-only, no DB/SDK, no IO)", () => {
  const raw = read(COMPOSER);
  assert.equal(/from\s+["']@\//.test(raw), false, "no @/ imports");
  assert.equal(/import\s+["']server-only["']/.test(raw), false, "not server-only");
  assert.equal(/@anthropic-ai|openai|gemini/i.test(raw), false, "no AI SDK");
  const s = strip(raw);
  for (const bad of [...WRITES, /\.from\(/, /\.select\(/, /createClient/, /fetch\(/, /process\.env/]) {
    assert.equal(bad.test(s), false, `composer must not contain ${bad}`);
  }
});

// ── server assembler: server-only, READ-ONLY, no schema ─────────────────────────
test("server assembler is server-only and performs NO writes / NO schema changes", () => {
  assert.ok(/import\s+["']server-only["']/.test(read(SERVER)), "server is server-only");
  const s = strip(read(SERVER));
  for (const w of WRITES) assert.equal(w.test(s), false, `assembler performs no ${w}`);
  for (const ddl of [/create\s+table/i, /alter\s+table/i, /apply_migration/i, /information_schema/i]) {
    assert.equal(ddl.test(s), false, `assembler adds no schema (${ddl})`);
  }
});

test("server reuses the SINGLE aggregated read + OPS.3/4 composers; runs NO heavy scanner inline", () => {
  const s = strip(read(SERVER));
  assert.equal((s.match(/loadOperationsDashboard\(/g) ?? []).length, 1, "one aggregated read only");
  assert.ok(/loadChannelGapCounts\(/.test(s) && /buildChannelCenter\(/.test(s) && /loadSnoonuMalikasOperational\(/.test(s), "reuses OPS.3/4 gap counts + channel composer + snoonu session");
  for (const heavy of ["scanReconciliation", "reconciliation-scan", "loadSnoonuDiagnostics", "getLowStockAlerts", "scanEnrichmentCandidates", "buildBackfill", "readOnlyGapReport"]) {
    assert.equal(s.includes(heavy), false, `must not run heavy scanner ${heavy}`);
  }
});

test("bounded signal reads are COUNT-only (head:true) — no row transfer, no paging", () => {
  const s = strip(read(SERVER));
  assert.ok(/count:\s*["']exact["']/.test(s) && /head:\s*true/.test(s), "uses COUNT-only head queries");
  assert.equal(/\.range\(/.test(s), false, "no manual paging in the assembler");
});

// ── no synthetic health history / no fake operational state (§19) ────────────────
test("no synthetic health history ledger is created or written", () => {
  for (const f of ALL) {
    const s = strip(read(f));
    assert.equal(/health_history|healthHistory/i.test(s), false, `${f} creates no health-history ledger`);
    assert.equal(/\.from\(["']health[_-]?history["']\)/.test(s), false, `${f} writes no health-history table`);
  }
});

test("no fake operational state — unread signals degrade to null (UNKNOWN), never fabricated", () => {
  const s = read(SERVER);
  // the bounded reader returns null on error (→ UNKNOWN), and provider health is a
  // SAFE boolean from env presence (never the key)
  assert.ok(/return null/.test(s), "head-count failures degrade to null (UNKNOWN)");
  assert.ok(/!!process\.env\.ANTHROPIC_API_KEY/.test(s), "provider signal is a safe boolean");
  // the composer keeps UNKNOWN in its state vocabulary and ranks it above HEALTHY
  assert.ok(/"UNKNOWN"/.test(read(COMPOSER)), "UNKNOWN is a first-class state");
});

// ── no domain writes anywhere (§19) ──────────────────────────────────────────────
test("no inventory / availability / ECL / media / AI / channel writes anywhere in OPS.6", () => {
  for (const f of ALL) {
    const s = strip(read(f));
    for (const tbl of ["inventory", "external_channel_listings", "platform_status", "channel_products", "channel_variant_mappings", "product_images"]) {
      assert.equal(new RegExp(`\\.(insert|update|upsert|delete)\\([^)]*\\)\\.?[\\s\\S]{0,40}${tbl}`).test(s), false, `${f} performs no write near ${tbl}`);
    }
    for (const col of ["stock_quantity", "sold_quantity", "stock_status", "channel_status", "keywords_en", "keywords_ar", "description_en", "barcode", "image_url"]) {
      assert.equal(new RegExp(`\\.update\\([^)]*${col}`).test(s), false, `${f} never updates ${col}`);
    }
  }
});

// ── component: presentational, read-only, no secrets ─────────────────────────────
test("component is presentational — no data client, no writes, no secrets", () => {
  const s = read(COMPONENT);
  for (const bad of [/createAdminClient/, /createClient\(/, /@\/lib\/supabase/, /\.from\(/, /"use server"/, /@anthropic-ai/, /process\.env/, /ANTHROPIC/]) {
    assert.equal(bad.test(s), false, `component must not contain ${bad}`);
  }
  assert.ok(/from "next\/link"/.test(s), "navigates via next/link");
});

// ── page: read-only render ───────────────────────────────────────────────────────
test("page loads the read-only view and renders the health center", () => {
  const s = strip(read(PAGE));
  assert.ok(/loadHealthCenter\(/.test(s), "loads the read-only health view");
  assert.ok(/<PlatformHealthCenter/.test(s), "renders the health center");
  for (const w of WRITES) assert.equal(w.test(s), false, `page performs no ${w}`);
});

// ── findings deep-link only to existing workflows (§13) ──────────────────────────
test("findings deep-link only to existing v2 workflow routes", () => {
  const s = read(COMPOSER);
  const routes = (s.match(/\/v2\/[a-z/-]+/g) ?? []).map((r) => r.replace(/[)"'`].*$/, ""));
  const allowed = ["/v2/operations", "/v2/operations/health", "/v2/catalog", "/v2/operations/media", "/v2/operations/ai", "/v2/operations/channels", "/v2/operations/availability-sync", "/v2/operations/barcode-completion", "/v2/operations/missing-products"];
  for (const r of routes) assert.ok(allowed.includes(r), `route ${r} is an existing workflow`);
});

// ── OPS.1 links to the Health Center (§1) ────────────────────────────────────────
test("the main operations page links to the Health Center", () => {
  assert.ok(/\/v2\/operations\/health/.test(read("app/(v2)/v2/operations/page.tsx")), "OPS.1 links to /v2/operations/health");
});
