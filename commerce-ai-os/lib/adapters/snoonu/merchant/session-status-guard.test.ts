// MEDIA.1A-P — Snoonu session-status guard (source scan). Proves the session
// foundation is safe: no password/credential storage, no browser automation, no
// CAPTCHA handling, no invented Snoonu endpoint or real HTTP call, no Snoonu/
// catalog/image/ECL writes, secrets are server-only + never serialized/returned,
// no cross-store fallback, and the MEDIA.1B discovery classification is untouched.
// node --conditions=react-server --experimental-strip-types --test lib/adapters/snoonu/merchant/session-status-guard.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../../..", import.meta.url));
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

const PURE = "lib/adapters/snoonu/merchant/session-status.ts";
const SERVER = "lib/adapters/snoonu/merchant/session-status.server.ts";
const ACTION = "app/(v2)/v2/operations/media/discovery/actions.ts";
const PANEL = "components/v2/operations/SnoonuConnectionManager.tsx";
const ENGINE = "lib/adapters/snoonu/merchant/discovery-engine.ts";

const ALL = [PURE, SERVER, ACTION, PANEL];
const WRITES = [/\.update\(/, /\.insert\(/, /\.upsert\(/, /\.delete\(/, /\.rpc\(/];
const RECOVERY = [/imageStore/, /storePrimaryProductImage/, /product_images/, /writeEclMapping/, /safeFetchImage/];
const AUTOMATION = [/playwright/i, /puppeteer/i, /selenium/i, /chromium/i, /page\.goto/, /page\.click/, /captcha/i, /browserbase/i];

test("no automation / captcha / invented Snoonu endpoint / Snoonu write anywhere", () => {
  for (const f of ALL) {
    const s = strip(read(f));
    for (const a of AUTOMATION) assert.equal(a.test(s), false, `${f} must not contain ${a}`);
    // no invented Snoonu URL/endpoint and no real HTTP call in this phase
    assert.equal(/https?:\/\/[^"'`]*snoonu/i.test(s), false, `${f} must not hardcode a Snoonu URL`);
    assert.equal(/\bfetch\(/.test(s), false, `${f} makes no HTTP request itself (only live-adapter.server.ts does)`);
    for (const w of [...WRITES, ...RECOVERY]) assert.equal(w.test(s), false, `${f} must not write (${w})`);
  }
});

test("pure model holds no secrets, no env, no IO", () => {
  const raw = read(PURE);
  assert.equal(/import\s+["']server-only["']/.test(raw), false, "pure model not server-only");
  assert.equal(/from\s+["']@\//.test(raw), false, "pure model has no @/ import");
  const s = strip(raw);
  for (const bad of [/process\.env/, /password/i, /\bcookie\b/i, /setCookie/]) {
    assert.equal(bad.test(s), false, `pure model must not contain ${bad}`);
  }
});

test("server layer: secret PRESENCE only, server-only, isolated, never returns the value", () => {
  const raw = read(SERVER);
  assert.ok(/import\s+["']server-only["']/.test(raw), "server-only");
  // presence check returns a boolean derived from length — never the raw value
  assert.ok(/\.trim\(\)\.length\s*>\s*0/.test(raw), "presence is a boolean length check");
  const s = strip(raw);
  assert.equal(/return\s+raw\b/.test(s), false, "never returns the raw secret");
  assert.equal(/JSON\.stringify\([^)]*raw/.test(s), false, "never serializes the raw secret");
  assert.equal(/console\.\w+\([^)]*raw/.test(s), false, "never logs the raw secret");
  assert.equal(/password/i.test(s), false, "no password handling");
  // per-storefront isolation: env is keyed by the storefront; the default live
  // reader is the VERIFIED one (MEDIA.1A-P2) and an explicit null still disables it
  assert.ok(/SESSION_ENV\[storefrontKey\]/.test(raw), "reads only the requested storefront's env name");
  assert.ok(
    /deps\.liveReader\s*!==\s*undefined\s*\?\s*deps\.liveReader\s*:\s*createConfiguredLiveSessionReader\(storefrontKey\)/.test(raw),
    "default live reader is the verified adapter's, storefront-scoped, still injectable",
  );
});

test("the Test action is read-only, signed-in gated, validates storefront, returns no secret", () => {
  const raw = read(ACTION);
  assert.ok(/"use server"/.test(raw), "server action");
  assert.ok(/isSignedIn\(/.test(raw), "signed-in gated");
  assert.ok(/SNOONU_STOREFRONT_KEYS\.find/.test(raw), "validates the storefront key");
  const s = strip(raw);
  for (const w of [...WRITES, ...RECOVERY]) assert.equal(w.test(s), false, `action must not write (${w})`);
  assert.equal(/process\.env/.test(s), false, "action never touches env/secret directly");
});

test("the Connection Manager UI collects NO secret and is presentational", () => {
  const raw = read(PANEL);
  const s = strip(raw);
  assert.equal(/type=["']password["']/.test(s), false, "no secret input field");
  assert.equal(/<input/i.test(s), false, "no secret-collection input in the UI");
  for (const bad of [/process\.env/, /\.from\(["'`]/, ...WRITES, ...RECOVERY, /\bfetch\(/]) {
    assert.equal(bad.test(s), false, `${PANEL} must not contain ${bad}`);
  }
});

test("MEDIA.1B discovery classification is untouched (no coupling to session-status)", () => {
  const engine = read(ENGINE);
  assert.equal(/session-status/.test(engine), false, "discovery engine does not import session-status");
  assert.ok(/runSnoonuDiscovery/.test(engine), "discovery engine classification remains in place");
});
