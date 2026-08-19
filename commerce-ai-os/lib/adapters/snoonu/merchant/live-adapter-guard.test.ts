// MEDIA.1A-P2/P3 — live Snoonu adapter guard (source scan). Proves the live
// adapter is built ONLY from the verified captures and stays read-only + honest:
//   • the ONLY portal URL is the verified origin, defined once in the pure
//     contract module — the server adapter hardcodes no URL of its own;
//   • only the VERIFIED searchTermType values exist (name=2, sku/barcode=1) and
//     every search mode goes through its verified pure body builder;
//   • no browser automation, no CAPTCHA handling, no Snoonu/catalog/image/ECL
//     write, no image recovery;
//   • the session secret is read per-storefront, never logged/serialized/returned.
// node --conditions=react-server --experimental-strip-types --test lib/adapters/snoonu/merchant/live-adapter-guard.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../../..", import.meta.url));
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

const CONTRACT = "lib/adapters/snoonu/merchant/live-contract.ts";
const ADAPTER = "lib/adapters/snoonu/merchant/live-adapter.server.ts";

const WRITES = [/\.update\(/, /\.insert\(/, /\.upsert\(/, /\.delete\(/, /\.rpc\(/, /\.from\(["'`]/];
const RECOVERY = [/imageStore/, /storePrimaryProductImage/, /product_images/, /writeEclMapping/, /safeFetchImage/];
const AUTOMATION = [/playwright/i, /puppeteer/i, /selenium/i, /chromium/i, /page\.goto/, /page\.click/, /captcha/i, /browserbase/i];

test("pure contract module: pure, and pins EXACTLY the verified endpoint + searchTermType values", () => {
  const raw = read(CONTRACT);
  assert.equal(/import\s+["']server-only["']/.test(raw), false, "contract stays pure");
  assert.equal(/from\s+["']@\//.test(raw), false, "no @/ import");
  const s = strip(raw);
  for (const bad of [/process\.env/, /\bfetch\(/, /password/i, ...WRITES, ...RECOVERY]) {
    assert.equal(bad.test(s), false, `${CONTRACT} must not contain ${bad}`);
  }
  // the verified origin appears — and it is the ONLY absolute URL in the module
  const urls = s.match(/https?:\/\/[^\s"'`]+/g) ?? [];
  assert.deepEqual([...new Set(urls)], ["https://api-portal.snoonu.com"], "only the verified portal origin");
  assert.ok(/SNOONU_PRODUCTS_SEARCH_PATH\s*=\s*"\/api\/marketplace\/CatalogManagement\/Products"/.test(raw), "verified endpoint path");
  assert.ok(/SEARCH_TERM_TYPE_NAME\s*=\s*2\b/.test(raw), "verified NAME searchTermType");
  assert.ok(/SEARCH_TERM_TYPE_SKU_OR_BARCODE\s*=\s*1\b/.test(raw), "verified SKU/BARCODE searchTermType");
  // ONLY the two verified searchTermType constants exist — nothing guessed
  const typeConsts = [...new Set(raw.match(/SEARCH_TERM_TYPE_[A-Z_]+/g) ?? [])].sort();
  assert.deepEqual(typeConsts, ["SEARCH_TERM_TYPE_NAME", "SEARCH_TERM_TYPE_SKU_OR_BARCODE"], "no unverified searchTermType");
});

test("live adapter: server-only, no URL/searchTermType of its own, no automation, no writes", () => {
  const raw = read(ADAPTER);
  assert.ok(/import\s+["']server-only["']/.test(raw), "server-only");
  const s = strip(raw);
  // the fetch target is composed ONLY from the verified pure constants
  assert.equal(/https?:\/\//.test(s), false, "adapter hardcodes no URL — origin comes from live-contract");
  assert.ok(/fetch\(SNOONU_PORTAL_ORIGIN \+ SNOONU_PRODUCTS_SEARCH_PATH/.test(raw), "fetches only the verified endpoint");
  // it may READ body.searchTermType (memo key) but never assigns a value itself
  assert.equal(/searchTermType\s*[:=]\s*\d/.test(s), false, "search bodies are built only by the verified pure builders");
  for (const a of AUTOMATION) assert.equal(a.test(s), false, `${ADAPTER} must not contain ${a}`);
  for (const w of [...WRITES, ...RECOVERY]) assert.equal(w.test(s), false, `${ADAPTER} must not write/recover (${w})`);
});

test("all three search modes are wired through their VERIFIED pure builders + exact filters", () => {
  const raw = read(ADAPTER);
  // barcode + SKU go through the verified identity search (searchTermType=1)…
  assert.ok(/findByBarcode:\s*\(barcode\)\s*=>\s*identityLookup\(barcode,\s*filterExactBarcode\)/.test(raw), "barcode wired via identity lookup + exact barcode filter");
  assert.ok(/findBySku:\s*\(sku\)\s*=>\s*identityLookup\(sku,\s*filterExactSku\)/.test(raw), "SKU wired via identity lookup + exact SKU filter");
  assert.ok(/identityLookup[\s\S]{0,300}buildIdentitySearchBody\(config\.businessUnitId/.test(raw), "identity lookup builds its body ONLY via buildIdentitySearchBody");
  // …and name searches go through the verified name search (searchTermType=2)
  assert.ok(/nameLookup[\s\S]{0,120}buildNameSearchBody\(config\.businessUnitId/.test(raw), "name lookup builds its body ONLY via buildNameSearchBody");
  assert.equal(/modeNotWired/.test(raw), false, "no unwired search mode remains");
});

test("MEDIA.1B search order + classification are untouched (engine still owns them)", () => {
  const engine = read("lib/adapters/snoonu/merchant/discovery-engine.ts");
  // fixed authoritative order: Barcode → SKU → Exact Name → Contains Name
  const order = [
    engine.indexOf("findByBarcode"),
    engine.indexOf("findBySku"),
    engine.indexOf("searchExactName"),
    engine.indexOf("searchContainsName"),
  ];
  assert.ok(order.every((i) => i >= 0) && order.every((v, i) => i === 0 || v > order[i - 1]), "search order unchanged");
  assert.ok(/"SAFE_MATCH",\s*singleReason/.test(engine), "single identity match still classifies SAFE_MATCH");
  assert.ok(/"NEEDS_REVIEW",\s*reason,\s*"medium",\s*lk\.candidates/.test(engine), "name results still classify NEEDS_REVIEW");
});

test("the secret is read per storefront and never logged/serialized/returned", () => {
  const raw = read(ADAPTER);
  assert.ok(/process\.env\[SESSION_ENV\[storefrontKey\]\]/.test(raw), "reads only the requested storefront's env");
  const s = strip(raw);
  assert.equal(/console\./.test(s), false, "no logging at all in the adapter");
  assert.equal(/return\s+raw\b/.test(s), false, "never returns the raw secret");
  assert.equal(/JSON\.stringify\([^)]*raw/.test(s), false, "never serializes the raw secret");
  assert.equal(/password/i.test(s), false, "no password handling");
});

test("wiring: discovery + session-status defaults resolve through the live adapter (injection preserved)", () => {
  const discovery = read("lib/adapters/snoonu/merchant/discovery.server.ts");
  assert.ok(/createConfiguredSnoonuDiscoveryProvider\(key\)/.test(discovery), "discovery defaults to the configured provider");
  assert.ok(/deps\?\.providers\?\.\[key\]/.test(discovery), "test injection still wins");
  const status = read("lib/adapters/snoonu/merchant/session-status.server.ts");
  assert.ok(/createConfiguredLiveSessionReader\(storefrontKey\)/.test(status), "session test defaults to the verified live reader");
  // the MEDIA.1B classification engine remains untouched by the live adapter
  const engine = read("lib/adapters/snoonu/merchant/discovery-engine.ts");
  assert.equal(/live-adapter|live-contract/.test(engine), false, "engine has no live-adapter coupling");
});
