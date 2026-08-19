// MEDIA.1A-P2 — live Snoonu adapter guard (source scan). Proves the live adapter
// is built ONLY from the verified capture and stays read-only + honest:
//   • the ONLY portal URL is the verified origin, defined once in the pure
//     contract module — the server adapter hardcodes no URL of its own;
//   • only the VERIFIED searchTermType (name) exists — barcode/SKU modes are
//     explicitly NOT wired (no guessed values, no request);
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

test("pure contract module: pure, and pins EXACTLY the verified endpoint + name searchTermType", () => {
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
  // no OTHER searchTermType constant exists (barcode/SKU values are unverified)
  const typeConsts = raw.match(/SEARCH_TERM_TYPE_[A-Z_]+/g) ?? [];
  assert.deepEqual([...new Set(typeConsts)], ["SEARCH_TERM_TYPE_NAME"], "no guessed barcode/SKU searchTermType");
});

test("live adapter: server-only, no URL/searchTermType of its own, no automation, no writes", () => {
  const raw = read(ADAPTER);
  assert.ok(/import\s+["']server-only["']/.test(raw), "server-only");
  const s = strip(raw);
  // the fetch target is composed ONLY from the verified pure constants
  assert.equal(/https?:\/\//.test(s), false, "adapter hardcodes no URL — origin comes from live-contract");
  assert.ok(/fetch\(SNOONU_PORTAL_ORIGIN \+ SNOONU_PRODUCTS_SEARCH_PATH/.test(raw), "fetches only the verified endpoint");
  assert.equal(/searchTermType/.test(s), false, "search body is built only by the verified pure builder");
  for (const a of AUTOMATION) assert.equal(a.test(s), false, `${ADAPTER} must not contain ${a}`);
  for (const w of [...WRITES, ...RECOVERY]) assert.equal(w.test(s), false, `${ADAPTER} must not write/recover (${w})`);
});

test("barcode/SKU search modes are NOT wired (unverified searchTermType ⇒ no request, no candidates)", () => {
  const raw = read(ADAPTER);
  assert.ok(/findByBarcode:\s*\(\)\s*=>\s*modeNotWired\(\)/.test(raw), "barcode mode not wired");
  assert.ok(/findBySku:\s*\(\)\s*=>\s*modeNotWired\(\)/.test(raw), "SKU mode not wired");
  assert.ok(/modeNotWired[\s\S]{0,200}candidates:\s*\[\]/.test(raw), "unwired modes return zero candidates");
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
