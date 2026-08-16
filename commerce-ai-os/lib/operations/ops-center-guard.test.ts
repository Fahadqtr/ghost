// OPS.1 — Operations Center guard (source scan §15). Proves the dashboard is an
// ORCHESTRATION layer only: the composer is pure and performs no IO; the page
// composes from already-loaded aggregates (no extra reads) and the component is
// presentational (no data client, no queries). It cannot write inventory,
// availability, channels, or invoke AI.
// node --conditions=react-server --experimental-strip-types --test lib/operations/ops-center-guard.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

const COMPOSER = "lib/operations/ops-center.ts";
const COMPONENT = "components/v2/operations/OperationsCenter.tsx";
const PAGE = "app/(v2)/v2/operations/page.tsx";

test("composer is PURE (no @/ imports, no server-only, no DB/SDK)", () => {
  const s = read(COMPOSER);
  assert.equal(/from\s+["']@\//.test(s), false, "no @/ imports");
  assert.equal(/import\s+["']server-only["']/.test(s), false, "not server-only");
  assert.equal(/@anthropic-ai|openai|gemini/i.test(s), false, "no AI SDK");
});

test("composer performs NO IO and NO writes (orchestration only)", () => {
  const s = strip(read(COMPOSER));
  for (const bad of [/\.from\(/, /\.select\(/, /\.insert\(/, /\.update\(/, /\.upsert\(/, /\.delete\(/, /\.rpc\(/, /createClient/, /createAdminClient/, /fetch\(/, /createProductCore/, /writeEclMapping/, /requireMalakWriter/]) {
    assert.equal(bad.test(s), false, `composer must not contain ${bad}`);
  }
});

test("composer never references inventory/availability/channel write columns or tables", () => {
  const s = strip(read(COMPOSER));
  for (const tok of ["stock_quantity", "sold_quantity", "stock_status", "channel_status", "external_channel_listings", "inventory", "platform_status"]) {
    assert.equal(new RegExp(tok).test(s), false, `composer must not reference ${tok}`);
  }
});

test("composer only links to EXISTING workflow routes (no parallel screens)", () => {
  const s = read(COMPOSER);
  const routes = (s.match(/\/v2\/[a-z/-]+/g) ?? []).map((r) => r.replace(/[)"'`].*$/, ""));
  const allowed = ["/v2/catalog", "/v2/operations", "/v2/operations/missing-products", "/v2/operations/media", "/v2/operations/ai-enrichment", "/v2/operations/barcode-completion", "/v2/operations/availability-sync"];
  for (const r of routes) assert.ok(allowed.includes(r), `route ${r} is an existing workflow`);
});

test("component is presentational — no data client, no queries, no writes", () => {
  const s = read(COMPONENT);
  for (const bad of [/createAdminClient/, /createClient\(/, /@\/lib\/supabase/, /\.from\(/, /\.rpc\(/, /\.insert\(/, /\.update\(/, /"use server"/, /@anthropic-ai/]) {
    assert.equal(bad.test(s), false, `component must not contain ${bad}`);
  }
});

test("page composes the Operations Center from already-loaded data (no new read for it)", () => {
  const s = strip(read(PAGE));
  assert.ok(/buildOperationsCenter\(/.test(s), "page builds the ops-center model");
  assert.ok(/<OperationsCenter\s+model=/.test(s), "page renders the OperationsCenter");
  // the composer is fed the SAME summary/health/items already computed — assert
  // no dedicated reader was introduced for it.
  assert.equal(/loadOperationsCenter|scanOperationsCenter|ops-center\.server/.test(s), false, "no parallel ops-center reader");
});

test("the dashboard page renders no mutation affordance of its own (links only)", () => {
  const comp = strip(read(COMPONENT));
  // navigation via Link/href only; no form actions or onClick mutations here
  assert.equal(/action=\{/.test(comp), false, "no server-action form in the center");
  assert.ok(/from "next\/link"/.test(read(COMPONENT)), "navigates via next/link");
});
