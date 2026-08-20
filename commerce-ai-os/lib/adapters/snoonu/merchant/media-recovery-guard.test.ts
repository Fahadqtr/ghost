// MEDIA.1C — image recovery guard (source scan). Proves recovery is SAFE:
//   • EXACTLY ONE canonical image write boundary (storePrimaryProductImage) — no
//     direct product_images insert, no direct products.image_url update, no
//     second storage path, no DB write of any other kind in the orchestrator;
//   • discovery is REUSED (engine + configured live provider), never duplicated;
//   • recovery requires the writer gate + a CONNECTED session, re-reads the
//     product fresh (stale protection), validates host/SSRF/bytes before write;
//   • no fuzzy auto-apply (the pure decision model owns eligibility);
//   • no ECL / inventory / availability / lifecycle / channel-publish mutation,
//     no duplicate readiness logic, no secret material in code or audit;
//   • storefronts stay isolated (provider built from the requested key only);
//   • the UI triggers recovery ONLY via the gated server action.
// node --conditions=react-server --experimental-strip-types --test lib/adapters/snoonu/merchant/media-recovery-guard.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../../..", import.meta.url));
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

const MODEL = "lib/adapters/snoonu/merchant/recovery-model.ts";
const SERVER = "lib/adapters/snoonu/merchant/media-recovery.server.ts";
const ACTION = "app/(v2)/v2/operations/media/discovery/actions.ts";
const PANEL = "components/v2/operations/SnoonuDiscovery.tsx";
const ENGINE = "lib/adapters/snoonu/merchant/discovery-engine.ts";

const FORBIDDEN_MUTATIONS = [
  /\.insert\(/, /\.update\(/, /\.upsert\(/, /\.delete\(/, /\.rpc\(/, //         no direct DB write anywhere here
  /\.from\(["'`]product_images/, /\.from\(["'`]external_channel_listings/, //   media rows + ECL untouched directly
  /writeEclMapping/, //                                                          ECL boundary not invoked
  /inv_sell|inv_apply|inv_shelf|sync_product_variants|stock_status|quantity/, // inventory/availability untouched
  /transitionProductLifecycle|lifecycle_status|platform_status/, //              lifecycle untouched
  /pushProductsToShopify|publishProducts|\.publish\(/, //                        no channel publish
];
const AUTOMATION = [/playwright/i, /puppeteer/i, /selenium/i, /chromium/i, /page\.goto/, /captcha/i, /browserbase/i];
const SECRETS = [/process\.env/, /SNOONU_[A-Z_]*SESSION/, /config\.headers/, /Authorization/, /Cookie/, /password/i];

test("pure decision model: pure, IO-free, and requires explicit confirmation for NEEDS_REVIEW", () => {
  const raw = read(MODEL);
  assert.equal(/import\s+["']server-only["']/.test(raw), false, "model stays pure");
  assert.equal(/from\s+["']@\//.test(raw), false, "no @/ import");
  const s = strip(raw);
  for (const bad of [/\bfetch\(/, /createClient/, /\.from\(["'`]/, ...FORBIDDEN_MUTATIONS, ...SECRETS]) {
    assert.equal(bad.test(s), false, `${MODEL} must not contain ${bad}`);
  }
  assert.ok(/confirmedSpi/.test(raw), "explicit operator selection is part of the contract");
});

test("orchestrator: writer-gated, CONNECTED-gated, fresh reads, and EXACTLY ONE write boundary", () => {
  const raw = read(SERVER);
  assert.ok(/import\s+["']server-only["']/.test(raw), "server-only");
  assert.ok(/requireMalakWriter\(\)/.test(raw), "writer gate before any mutation");
  assert.ok(/testSnoonuSession\(storefrontKey\)/.test(raw) && /=== "CONNECTED"/.test(raw), "recovery requires a proven CONNECTED session");
  // stale protection: fresh product read incl. image state, fed to the pure decision
  assert.ok(/image_url,\s*image_filename/.test(raw), "re-reads the product's image state immediately before write");
  assert.ok(/decideSnoonuRecovery\(/.test(raw), "eligibility decided ONLY by the pure model (no fuzzy auto-apply)");
  // discovery is reused, not duplicated
  assert.ok(/runSnoonuDiscovery\(createConfiguredSnoonuDiscoveryProvider\(storefrontKey\)/.test(raw), "reuses MEDIA.1B engine + the configured live provider for THIS storefront only");
  assert.equal(/searchTermType|buildIdentitySearchBody|buildNameSearchBody|api-portal/.test(strip(raw)), false, "no duplicated portal/search logic");
  // image safety chain before the single write
  for (const req of [/isAllowedSnoonuImageUrl\(/, /safeFetchImage\(/, /validateFetchedImage\(/]) {
    assert.ok(req.test(raw), `image safety step present (${req})`);
  }
  // EXACTLY ONE canonical write boundary
  const writes = raw.match(/storePrimaryProductImage\(/g) ?? [];
  assert.equal(writes.length, 1, "exactly one storePrimaryProductImage call");
  const s = strip(raw);
  for (const bad of [...FORBIDDEN_MUTATIONS, ...AUTOMATION, ...SECRETS, /console\./]) {
    assert.equal(bad.test(s), false, `${SERVER} must not contain ${bad}`);
  }
  // audit reuses the shared helper with identifiers only
  assert.ok(/insertAuditRow\(/.test(raw), "audit via the shared malak_audit helper");
  assert.ok(/IMAGE_RECOVERED_FROM_SNOONU/.test(raw), "audit action name recorded");
  // no cross-store leakage: storefront literals never hardcoded here
  assert.equal(/"snoonu:(malikas|pure_seoul)"/.test(s), false, "no hardcoded storefront (isolation by parameter)");
  // no duplicate readiness/health logic
  assert.equal(/health-rules|launchReadiness|buildLaunchReadiness|readiness/i.test(s), false, "readiness surfaces update naturally — no duplicate logic");
});

test("server action: validates the storefront and only delegates to the gated orchestrator", () => {
  const raw = read(ACTION);
  assert.ok(/recoverImageFromSnoonu/.test(raw), "recovery action exists");
  assert.ok(/SNOONU_STOREFRONT_KEYS\.find/.test(raw), "storefront validated");
  assert.ok(/recoverSnoonuImage\(\{/.test(raw), "delegates to media-recovery.server (gate inside)");
});

test("UI: recovery ONLY via the gated action; explicit per-candidate confirmation; no direct IO", () => {
  const raw = read(PANEL);
  const s = strip(raw);
  for (const bad of [/\bfetch\(/, /createClient/, /\.from\(["'`]/, ...FORBIDDEN_MUTATIONS, /storePrimaryProductImage/, /safeFetchImage/, ...SECRETS]) {
    assert.equal(bad.test(s), false, `${PANEL} must not contain ${bad}`);
  }
  assert.ok(/recoverImageFromSnoonu\(\{/.test(raw), "recovery goes through the server action only");
  assert.ok(/confirmedSpi:\s*c\.spi/.test(raw), "the clicked candidate's SPI is pinned (explicit selection)");
  assert.ok(/!hasImage/.test(raw), "no recover button for a product that already has an image");
  assert.ok(/onClick=\{\(\)\s*=>\s*recover\(c\)\}/.test(raw), "recovery fires only on an explicit click — never automatically");
});

test("MEDIA.1B engine remains untouched by recovery (search order + classification intact)", () => {
  const engine = read(ENGINE);
  assert.equal(/recovery|imageStore|media-recovery/i.test(engine), false, "engine has no recovery coupling");
  const order = ["findByBarcode", "findBySku", "searchExactName", "searchContainsName"].map((m) => engine.indexOf(m));
  assert.ok(order.every((i) => i >= 0) && order.every((v, i) => i === 0 || v > order[i - 1]), "search order unchanged");
});
