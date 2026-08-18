// MEDIA.1B — Snoonu Media Discovery guard (source scan). Proves the discovery
// pipeline is READ-ONLY and DISCOVERS ONLY: pure contract/engine invent no Snoonu
// endpoint and hold no rule; the server layer reuses the injectable session port,
// writes nothing, recovers no image, and makes no real Snoonu request (default
// provider is inert); the UI is presentational; and nothing anywhere adds browser
// automation, a scraping framework, or credential storage.
// node --conditions=react-server --experimental-strip-types --test lib/adapters/snoonu/merchant/discovery-guard.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../../..", import.meta.url));
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

const CONTRACT = "lib/adapters/snoonu/merchant/discovery-contract.ts";
const ENGINE = "lib/adapters/snoonu/merchant/discovery-engine.ts";
const PROVIDER = "lib/adapters/snoonu/merchant/discovery-provider.server.ts";
const SERVER = "lib/adapters/snoonu/merchant/discovery.server.ts";
const PANEL = "components/v2/operations/SnoonuDiscovery.tsx";
const PAGE = "app/(v2)/v2/operations/media/discovery/page.tsx";

const ALL = [CONTRACT, ENGINE, PROVIDER, SERVER, PANEL, PAGE];
const WRITES = [/\.update\(/, /\.insert\(/, /\.upsert\(/, /\.delete\(/, /\.rpc\(/];
const RECOVERY = [/imageStore/, /storePrimaryProductImage/, /product_images/, /writeEclMapping/, /safeFetchImage/];
const AUTOMATION = [/playwright/i, /puppeteer/i, /selenium/i, /chromium/i, /page\.goto/, /page\.click/, /\.mouse\./, /browserbase/i];

// ── nothing in the whole feature adds automation, scraping, or a real endpoint ─
test("no browser automation / scraping framework / invented Snoonu endpoint anywhere", () => {
  for (const f of ALL) {
    const s = strip(read(f));
    for (const a of AUTOMATION) assert.equal(a.test(s), false, `${f} must not contain ${a}`);
    // no hardcoded Snoonu portal/endpoint URL is invented in this phase
    assert.equal(/https?:\/\/[^"'`]*snoonu/i.test(s), false, `${f} must not hardcode a Snoonu URL/endpoint`);
    // no credential/cookie storage
    for (const c of [/setCookie/, /password/i, /SNOONU_[A-Z_]*SESSION/]) assert.equal(c.test(s), false, `${f} must not handle credentials (${c})`);
  }
});

// ── pure contract + engine: no IO, no writes, no recovery ─────────────────────
test("contract + engine are pure (no server-only, no @/, no IO, no writes, no recovery)", () => {
  for (const f of [CONTRACT, ENGINE]) {
    const raw = read(f);
    assert.equal(/import\s+["']server-only["']/.test(raw), false, `${f} not server-only`);
    assert.equal(/from\s+["']@\//.test(raw), false, `${f} no @/ import`);
    const s = strip(raw);
    for (const bad of [...WRITES, ...RECOVERY, /\.from\(["'`]/, /createClient/, /\bfetch\(/, /process\.env/, /new Date\(\s*\)/, /Math\.random/]) {
      assert.equal(bad.test(s), false, `${f} contains ${bad}`);
    }
  }
});

// ── server layer: read-only, reuses the port, no writes, no recovery, inert ───
test("provider + orchestrator are read-only, reuse the session port, and never write/recover", () => {
  for (const f of [PROVIDER, SERVER]) {
    const raw = read(f);
    assert.ok(/import\s+["']server-only["']/.test(raw), `${f} is server-only`);
    const s = strip(raw);
    for (const bad of [...WRITES, ...RECOVERY]) assert.equal(bad.test(s), false, `${f} must not write/recover (${bad})`);
    // no real Snoonu network request in this phase
    assert.equal(/\bfetch\(/.test(s), false, `${f} makes no network request`);
  }
  // the default provider mirrors the session and stays inert (session_required)
  const prov = read(PROVIDER);
  assert.ok(/createSnoonuMerchantSession/.test(prov), "reuses the existing merchant session port");
  assert.ok(/session_required/.test(prov), "default provider is session_required (never fabricated)");
  // the orchestrator only READS the catalog (select), never writes it
  const server = read(SERVER);
  assert.ok(/\.from\("products"\)[\s\S]*\.select\(/.test(server), "reads products read-only");
  assert.ok(/runSnoonuDiscovery\(/.test(server), "delegates to the pure engine");
  assert.ok(/SNOONU_STOREFRONT_KEYS/.test(server), "runs per storefront (isolation)");
});

// ── UI is presentational and offers NO recovery/import action ─────────────────
test("discovery UI is presentational — no data client, writes, recovery, secrets or network", () => {
  const s = strip(read(PANEL));
  for (const bad of [/createClient\(/, /@\/lib\/supabase/, /\.from\(["'`]/, ...WRITES, ...RECOVERY, /"use server"/, /process\.env/, /\bfetch\(/]) {
    assert.equal(bad.test(s), false, `${PANEL} must not contain ${bad}`);
  }
  assert.ok(/SESSION_REQUIRED/.test(read(PANEL)), "UI surfaces the SESSION_REQUIRED state honestly");
});

// ── the page composes discovery read-only ─────────────────────────────────────
test("the discovery page composes the read-only view", () => {
  assert.ok(existsSync(join(ROOT, PAGE)), "discovery page exists");
  const raw = read(PAGE);
  assert.ok(/loadSnoonuDiscovery\(/.test(raw), "page loads the discovery view");
  for (const bad of [...WRITES, ...RECOVERY] ) assert.equal(bad.test(strip(raw)), false, `page must not write/recover (${bad})`);
});
