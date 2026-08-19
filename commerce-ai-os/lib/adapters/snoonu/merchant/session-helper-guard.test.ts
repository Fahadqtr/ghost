// MEDIA.1A-P4 — session capture helper guard (source scan). Proves the helper
// is a safe, owner-only, CLIENT-ONLY setup surface:
//   • the page is requireOwner()-gated; the form renders only for the owner;
//   • the form sends NOTHING to any server: no fetch, no server action, no DB,
//     no query-string, no storage/cookie write, no logging;
//   • no password is requested and no automated capture exists (no cross-origin
//     cookie read, no extension/automation API, no Snoonu request);
//   • the generated JSON comes ONLY from the pure builder, which round-trips
//     the merged adapter's own parser (single schema);
//   • storefront isolation: two distinct env keys, JSON never auto-reused.
// node --conditions=react-server --experimental-strip-types --test lib/adapters/snoonu/merchant/session-helper-guard.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../../..", import.meta.url));
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

const HELPER = "lib/adapters/snoonu/merchant/session-helper.ts";
const PAGE = "app/(v2)/v2/settings/connections/snoonu/session-helper/page.tsx";
const FORM = "app/(v2)/v2/settings/connections/snoonu/session-helper/SessionHelperForm.tsx";

const DB_WRITES = [/\.update\(/, /\.insert\(/, /\.upsert\(/, /\.delete\(/, /\.rpc\(/, /\.from\(["'`]/, /supabase/i];
const AUTOMATION = [/playwright/i, /puppeteer/i, /selenium/i, /chromium/i, /page\.goto/, /browserbase/i, /chrome\.cookies/, /browser\.cookies/, /webRequest/];
const LEAKS = [/\bfetch\(/, /axios/, /XMLHttpRequest/, /sendBeacon/, /localStorage/, /sessionStorage/, /document\.cookie/, /URLSearchParams/, /searchParams/, /console\./, /analytics/i];

test("pure builder: client-safe, IO-free, and reuses the adapter's OWN parser (no second schema)", () => {
  const raw = read(HELPER);
  assert.equal(/import\s+["']server-only["']/.test(raw), false, "helper stays pure/client-safe");
  assert.equal(/from\s+["']@\//.test(raw), false, "no @/ import");
  assert.ok(/import\s*\{\s*parseSnoonuSessionConfig\s*\}\s*from\s*"\.\/live-contract\.ts"/.test(raw), "round-trips the merged adapter's parser");
  const s = strip(raw);
  for (const bad of [/process\.env/, /\bfetch\(/, /console\./, ...DB_WRITES, ...AUTOMATION]) {
    assert.equal(bad.test(s), false, `${HELPER} must not contain ${bad}`);
  }
  // exact reserved env keys, isolated per storefront
  assert.ok(/"snoonu:malikas":\s*"SNOONU_MALIKAS_MERCHANT_SESSION"/.test(raw), "malikas env key exact");
  assert.ok(/"snoonu:pure_seoul":\s*"SNOONU_PURE_SEOUL_MERCHANT_SESSION"/.test(raw), "pure_seoul env key exact");
});

test("page: owner-only gate, no server action, no DB, renders the client form only for the owner", () => {
  const raw = read(PAGE);
  assert.ok(/requireOwner\(\)/.test(raw), "requireOwner() gate");
  assert.ok(/OWNER_ONLY_DENIED/.test(raw), "fixed denial for non-owners");
  assert.ok(/if\s*\(!owner\.ok\)/.test(raw), "form never renders for non-owners");
  const s = strip(raw);
  for (const bad of [/"use server"/, /\bfetch\(/, /process\.env/, ...DB_WRITES]) {
    assert.equal(bad.test(s), false, `${PAGE} must not contain ${bad}`);
  }
});

test("form: client-only — the secret can NEVER leave the browser through this code", () => {
  const raw = read(FORM);
  assert.ok(/^"use client";/.test(raw), "client component");
  const s = strip(raw);
  // nothing is transmitted, persisted, logged, or put in the URL
  for (const bad of [...LEAKS, ...DB_WRITES, ...AUTOMATION, /"use server"/, /process\.env/, /router\.(push|replace)/, /window\.location/]) {
    assert.equal(bad.test(s), false, `${FORM} must not contain ${bad}`);
  }
  // no server action import: the ONLY non-relative imports are react/next + the pure contract modules
  const imports = [...raw.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
  for (const i of imports) {
    assert.ok(
      i === "react" || i === "next/link" || i.startsWith("@/lib/adapters/snoonu/merchant/"),
      `unexpected import in form: ${i}`,
    );
  }
  // the JSON is built ONLY by the pure builder and leaves via the clipboard only
  assert.ok(/buildSnoonuSessionEnvJson\(/.test(raw), "uses the pure builder");
  assert.ok(/navigator\.clipboard\.writeText\(generated\)/.test(raw), "copy is the only exit");
});

test("form: the generated JSON is VISIBLE and copy is never a silent no-op", () => {
  const raw = read(FORM);
  // read-only output the operator can always select manually
  assert.ok(/<textarea[\s\S]{0,120}readOnly/.test(raw), "read-only output textarea exists");
  assert.ok(/value=\{generated\}/.test(raw), "the textarea shows the generated JSON");
  // clipboard API → selection fallback → explicit error; nothing is swallowed
  assert.ok(/document\.execCommand\("copy"\)/.test(raw), "selection fallback when the clipboard API is unavailable");
  assert.ok(/setCopyError\(true\)/.test(raw), "copy failure is surfaced to the operator");
  assert.ok(/setShowJson\(true\)/.test(raw), "the JSON is revealed for manual copy on fallback/failure");
});

test("form: no password capture, sensitive fields masked + never autofilled", () => {
  const raw = read(FORM);
  // never asks for Snoonu credentials
  assert.equal(/username|كلمة السر|اسم المستخدم/i.test(raw.replace(/لا نطلب اسم المستخدم أو كلمة المرور هنا أبدًا/, "")), false, "no username/password fields requested");
  // the three sensitive inputs are masked; every input opts out of autofill
  const masked = raw.match(/type="password"/g) ?? [];
  assert.equal(masked.length, 3, "Authorization + Cookie + extra header value are masked");
  const inputs = raw.match(/<input/g) ?? [];
  const noFill = raw.match(/autoComplete="off"/g) ?? [];
  assert.equal(inputs.length, noFill.length, "every input disables autofill");
});

test("storefront isolation: switching storefront discards the generated JSON; no Snoonu request from the helper", () => {
  const raw = read(FORM);
  assert.ok(/pickStorefront[\s\S]{0,200}setGenerated\(null\)/.test(raw), "generated JSON is dropped on storefront switch");
  for (const f of [HELPER, PAGE, FORM]) {
    assert.equal(/https?:\/\/[^"'`]*snoonu/i.test(strip(read(f))), false, `${f} makes no Snoonu request and hardcodes no Snoonu URL`);
  }
});
