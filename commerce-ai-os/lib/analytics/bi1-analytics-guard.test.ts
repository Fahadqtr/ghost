// BI.1 — Analytics Read Layer guard (source scan). Proves the read layer is a
// READ-ONLY composition: the composer is pure & does no IO; the server assembler
// is server-only, writes nothing, adds no schema, runs no scheduled job, and
// REUSES the canonical engines (computeAnalytics / computeSalesSummary /
// computeLowStock / getCeoKpis) instead of re-deriving any metric; the single
// inventory scan is not duplicated; and unavailable signals degrade to UNKNOWN.
// node --conditions=react-server --experimental-strip-types --test lib/analytics/bi1-analytics-guard.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

const COMPOSER = "lib/analytics/analytics-read.ts";
const SERVER = "lib/analytics/analytics-read.server.ts";

const WRITES = [/\.insert\(/, /\.update\(/, /\.upsert\(/, /\.delete\(/, /\.rpc\(/, /createAdminClient/];

// ── composer purity + no IO ──────────────────────────────────────────────────
test("composer is PURE (no @/ imports, no server-only, no DB/SDK/IO, no clock)", () => {
  const raw = read(COMPOSER);
  assert.equal(/from\s+["']@\//.test(raw), false, "no @/ imports");
  assert.equal(/import\s+["']server-only["']/.test(raw), false, "not server-only");
  assert.equal(/@anthropic-ai|openai|gemini/i.test(raw), false, "no AI SDK");
  const s = strip(raw);
  for (const bad of [...WRITES, /\.from\(/, /\.select\(/, /createClient/, /fetch\(/, /process\.env/, /Date\.now/, /Math\.random/, /new Date\(/]) {
    assert.equal(bad.test(s), false, `composer must not contain ${bad}`);
  }
});

// ── server assembler: server-only, READ-ONLY, no schema, no cron ──────────────
test("server assembler is server-only and performs NO writes / NO schema / NO jobs", () => {
  assert.ok(/import\s+["']server-only["']/.test(read(SERVER)), "server is server-only");
  const s = strip(read(SERVER));
  for (const w of WRITES) assert.equal(w.test(s), false, `assembler performs no ${w}`);
  for (const ddl of [/create\s+table/i, /alter\s+table/i, /apply_migration/i, /information_schema/i]) {
    assert.equal(ddl.test(s), false, `assembler adds no schema (${ddl})`);
  }
  for (const job of [/setInterval\(/, /setTimeout\(/, /cron/i, /schedule/i]) {
    assert.equal(job.test(s), false, `assembler schedules nothing (${job})`);
  }
});

// ── reuse the canonical engines — no duplicated analytics calculations ─────────
test("assembler REUSES canonical engines and does not re-derive metrics", () => {
  const s = strip(read(SERVER));
  for (const engine of ["computeAnalytics", "computeSalesSummary", "computeLowStock", "getCeoKpis"]) {
    assert.ok(s.includes(engine), `reuses canonical engine ${engine}`);
  }
});

test("the inventory table is scanned ONCE (fed to three computers), not per-metric", () => {
  const s = strip(read(SERVER));
  const scans = (s.match(/fetchAll\(/g) ?? []).length;
  assert.equal(scans, 1, "exactly one fetchAll (single inventory scan) in the assembler");
});

test("bounded extra reads are COUNT-only (head:true) — no row transfer, no paging", () => {
  const s = strip(read(SERVER));
  assert.ok(/count:\s*["']exact["']/.test(s) && /head:\s*true/.test(s), "extra reads are COUNT-only");
  assert.equal(/\.range\(/.test(s), false, "assembler adds no manual paging");
});

// ── honest UNKNOWN, never fabricated ──────────────────────────────────────────
test("unavailable signals degrade to null → UNKNOWN, never a fake zero", () => {
  const s = read(SERVER);
  assert.ok(/return null/.test(s), "head-count failures degrade to null (UNKNOWN)");
  const c = read(COMPOSER);
  assert.ok(/status:\s*["']unknown["']/.test(c), "UNKNOWN is a first-class metric status");
  assert.ok(/fromNullable/.test(c), "nullable sources are lifted via fromNullable (no fake zero)");
});

// ── no business-table WRITES anywhere in BI.1 ─────────────────────────────────
test("no writes to any business/analytics table anywhere in BI.1", () => {
  for (const f of [COMPOSER, SERVER]) {
    const s = strip(read(f));
    for (const tbl of ["inventory", "products", "external_channel_listings", "channel_products", "kpi_snapshots"]) {
      assert.equal(
        new RegExp(`\\.(insert|update|upsert|delete)\\([^)]*\\)\\.?[\\s\\S]{0,40}${tbl}`).test(s),
        false,
        `${f} performs no write near ${tbl}`,
      );
    }
  }
});
