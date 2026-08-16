// CH.6C — Snoonu availability sync guard (source scan). Proves the safety
// contract: apply ONLY through the Availability Engine, ECL identity only, no
// quantity/inventory/channel writes, no direct table writes, writer-gated.
// node --conditions=react-server --experimental-strip-types --test lib/adapters/snoonu/availability/ch6c-availability-guard.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../../..", import.meta.url));
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
// strip block + line comments so guards match CODE, not documentation.
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

const D = "lib/adapters/snoonu/availability";
const PURE = [
  `${D}/snoonu-availability-normalize.ts`,
  `${D}/snoonu-availability-diff.ts`,
  `${D}/snoonu-availability-plan.ts`,
];
const SERVER = [`${D}/availability-source.server.ts`, `${D}/availability-sync.server.ts`];
const ORCH = `${D}/availability-sync.server.ts`;
const ACTIONS = "app/(v2)/v2/operations/availability-sync-actions.ts";
const COMPONENT = "components/v2/operations/AvailabilitySync.tsx";
const PAGE = "app/(v2)/v2/operations/availability-sync/page.tsx";
const ALL = [...PURE, ...SERVER, ACTIONS, COMPONENT, PAGE];

test("pure modules stay pure (no @/ imports, no server-only)", () => {
  for (const f of PURE) {
    const s = read(f);
    assert.equal(/from\s+["']@\//.test(s), false, `${f} pure`);
    assert.equal(/import\s+["']server-only["']/.test(s), false, `${f} not server-only`);
  }
});

test("server modules are server-only", () => {
  for (const f of SERVER) {
    assert.ok(/import\s+["']server-only["']/.test(read(f)), `${f} is server-only`);
  }
});

test("resolves products through the ECL identity table, never legacy id columns", () => {
  const orch = strip(read(ORCH));
  assert.ok(/external_channel_listings/.test(orch), "reads ECL for identity");
  assert.ok(/mapping_status["']\s*,\s*["']active/.test(orch) || /"active"/.test(orch), "uses ACTIVE mappings");
  assert.ok(/storefront_key/.test(orch), "scopes by storefront_key (cross-store isolation)");
  for (const f of [...SERVER, ACTIONS]) {
    const s = strip(read(f));
    assert.equal(/\bsnoonu_id\b/.test(s), false, `${f} must not read products.snoonu_id`);
    assert.equal(/\bpure_seoul_id\b/.test(s), false, `${f} must not read products.pure_seoul_id`);
  }
});

test("apply is writer-gated (CH.3b) and writes ONLY through the Availability Engine", () => {
  const orch = strip(read(ORCH));
  assert.ok(/requireMalakWriter\(/.test(orch), "apply gates on the writer allow-list");
  assert.ok(/writeProductAvailability\(/.test(orch), "availability is written through the engine");
});

test("orchestrator + source perform NO direct table mutations (engine + audit only)", () => {
  for (const f of SERVER) {
    const s = strip(read(f));
    for (const w of [/\.update\(/, /\.upsert\(/, /\.delete\(/, /\.rpc\(/, /\.insert\(/]) {
      assert.equal(w.test(s), false, `${f} performs no direct table write (matched ${w})`);
    }
  }
});

test("never touches quantity / inventory / channel overlay tables", () => {
  for (const f of SERVER) {
    const s = strip(read(f));
    // no quantity/shelf/sold columns anywhere
    for (const col of ["stock_quantity", "sold_quantity", "shelf_stock", "variant_shelf_stock", "channel_stock"]) {
      assert.equal(new RegExp(`\\b${col}\\b`).test(s), false, `${f} references no ${col}`);
    }
    // never SELECTS from or WRITES the inventory / channel / overlay tables
    for (const tbl of ["inventory", "platform_status", "channel_products", "product_variants"]) {
      assert.equal(new RegExp(`\\.from\\(["']${tbl}["']\\)`).test(s), false, `${f} does not touch table ${tbl}`);
    }
  }
});

test("orchestrator reads authoritative availability from products.stock_status only", () => {
  const orch = strip(read(ORCH));
  // the ONLY table it selects for internal state is products
  assert.ok(/\.from\(["']products["']\)/.test(orch), "reads products for internal availability + lifecycle");
});

test("every applied change is audited (timestamp, storefront, SPI, product, old, new, reason)", () => {
  const orch = strip(read(ORCH));
  assert.ok(/insertAuditRow\(/.test(orch), "records an audit row");
  for (const key of ["storefront", "spi", "old_value", "new_value", "reason", "product_id"]) {
    assert.ok(new RegExp(key).test(orch), `audit carries ${key}`);
  }
});

test("actions delegate to the orchestrator — no DB/admin client of their own", () => {
  const s = strip(read(ACTIONS));
  assert.ok(/applySnoonuAvailability\(/.test(s) && /scanSnoonuAvailability\(/.test(s), "delegates to orchestrator");
  assert.equal(/createAdminClient\(/.test(s), false, "actions hold no service-role client");
  assert.equal(/\.from\(/.test(s), false, "actions issue no direct queries");
});

test("client component never holds a DB/admin client and issues no queries", () => {
  const s = read(COMPONENT);
  assert.ok(/"use client"/.test(s), "is a client component");
  for (const bad of [/createAdminClient/, /createClient\(/, /@\/lib\/supabase/, /\.from\(/]) {
    assert.equal(bad.test(s), false, `component must not contain ${bad}`);
  }
});

test("page gates the Apply affordance on the writer allow-list", () => {
  const s = strip(read(PAGE));
  assert.ok(/requireMalakWriter\(/.test(s), "page computes canWrite from the writer gate");
  assert.ok(/canWrite/.test(s), "passes canWrite to the surface");
});

test("no visual/scraping automation anywhere in the flow", () => {
  for (const f of ALL) {
    const s = read(f);
    assert.equal(/playwright|puppeteer|screenshot|page\.(goto|click)|\.mouse\./i.test(s), false, `${f} uses no visual automation`);
  }
});
