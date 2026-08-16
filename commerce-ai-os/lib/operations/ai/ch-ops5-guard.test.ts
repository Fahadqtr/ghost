// OPS.5 — AI Center guard (source scan §20). Proves the AI Center is ORCHESTRATION
// over CH.6E: the composer is pure & does no IO; the server assembler is
// server-only, read-only, reuses the CH.6E scanner + pure composer; the client
// delegates generate/apply to the EXISTING CH.6E actions; there is NO second AI
// provider stack; nothing auto-applies; GOOD content is never queued/selected; and
// no inventory/availability/ECL/barcode/channel writes exist anywhere.
// node --conditions=react-server --experimental-strip-types --test lib/operations/ai/ch-ops5-guard.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

const COMPOSER = "lib/operations/ai/ai-center.ts";
const SERVER = "lib/operations/ai/ai-center.server.ts";
const COMPONENT = "components/v2/operations/AiCenter.tsx";
const PAGE = "app/(v2)/v2/operations/ai/page.tsx";
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

// ── server assembler: server-only, read-only, reuse ──────────────────────────────
test("server assembler is server-only and performs NO writes", () => {
  assert.ok(/import\s+["']server-only["']/.test(read(SERVER)), "server is server-only");
  const s = strip(read(SERVER));
  for (const w of WRITES) assert.equal(w.test(s), false, `assembler performs no ${w}`);
});

test("server reuses the CH.6E scanner ONCE + the pure composer (no rescan, no new engine)", () => {
  const s = strip(read(SERVER));
  assert.ok(/scanEnrichmentCandidates\(/.test(s), "reuses the CH.6E candidate scanner");
  assert.ok(/buildAiCenter\(/.test(s), "composes via the pure AI-center composer");
  assert.equal((s.match(/scanEnrichmentCandidates\(/g) ?? []).length, 1, "scans exactly once per request");
});

// ── no second AI provider stack (§20) ────────────────────────────────────────────
test("no duplicate AI provider — OPS.5 never imports/instantiates a provider", () => {
  for (const f of ALL) {
    const s = read(f);
    assert.equal(/@anthropic-ai\/sdk|new Anthropic|createAnthropicEnrichmentProvider|enrichment-provider/.test(s), false, `${f} must not build/import an AI provider`);
  }
});

// ── CH.6E remains the engine (§20) ───────────────────────────────────────────────
test("generate + apply are DELEGATED to the existing CH.6E actions (not reimplemented)", () => {
  const c = read(COMPONENT);
  assert.ok(/from ["']@\/app\/\(v2\)\/v2\/operations\/ai-enrichment-actions["']/.test(c), "imports the CH.6E server actions");
  assert.ok(/generateEnrichmentAction|generateAllEligibleAction/.test(c) && /applyEnrichmentAction\(/.test(c), "delegates generate + apply to CH.6E");
  // the composer reuses the CH.6E pure cores rather than copying them
  const comp = read(COMPOSER);
  assert.ok(/from "\.\.\/\.\.\/enrichment\//.test(comp), "reuses CH.6E pure cores (classify/fields/keywords/plan)");
});

// ── no automatic AI apply (§20) ──────────────────────────────────────────────────
test("nothing auto-applies — apply is a separate explicit step, never inside generate", () => {
  const c = strip(read(COMPONENT));
  // the apply() path is the ONLY caller of applyEnrichmentAction
  assert.equal((c.match(/applyEnrichmentAction\(/g) ?? []).length, 1, "exactly one apply call site");
  // the generate/ingest path must not call apply
  const ingestBlock = c.slice(c.indexOf("function ingest"), c.indexOf("function apply"));
  assert.equal(/applyEnrichmentAction\(/.test(ingestBlock), false, "generate/ingest never applies");
  // composer holds no apply/write path at all
  const comp = strip(read(COMPOSER));
  assert.equal(/applyEnrichment|writeProductEnrichment|insertAuditRow/.test(comp), false, "composer has no apply/write");
});

// ── GOOD content protection (§20) ────────────────────────────────────────────────
test("GOOD content is never queued for generation nor selectable for apply", () => {
  const comp = read(COMPOSER);
  // needs-generation queue skips anything that is not MISSING/WEAK
  assert.ok(/quality !== "MISSING" && q\.quality !== "WEAK"/.test(comp), "queue excludes GOOD (only MISSING/WEAK)");
  // toApproved refuses non-READY (GOOD/UNCHANGED/FAILED)
  assert.ok(/status !== "READY"/.test(comp), "apply mapping requires READY");
  // the client pre-selects ONLY autoEligible (MISSING) — WEAK needs an explicit tick
  assert.ok(/status === "READY" && s\.autoEligible/.test(read(COMPONENT)), "only MISSING (autoEligible) is pre-selected");
});

// ── no inventory / availability / ECL / barcode / channel writes (§20) ───────────
test("no inventory / availability / ECL / barcode / channel writes anywhere in OPS.5", () => {
  for (const f of ALL) {
    const s = strip(read(f));
    for (const tbl of ["inventory", "external_channel_listings", "platform_status", "channel_products", "channel_variant_mappings", "product_images"]) {
      assert.equal(new RegExp(`\\.from\\(["']${tbl}["']\\)`).test(s), false, `${f} does not touch ${tbl}`);
    }
    for (const col of ["stock_quantity", "sold_quantity", "stock_status", "channel_status", "barcode", "image_url", "price"]) {
      assert.equal(new RegExp(`\\.update\\([^)]*${col}`).test(s), false, `${f} never updates ${col}`);
    }
  }
});

// ── client safety: no DB client, no secrets, no AI SDK (§13/§16/§18) ─────────────
test("client component holds no DB client, no secrets, no AI SDK", () => {
  const s = read(COMPONENT);
  assert.ok(/"use client"/.test(s), "is a client component");
  for (const bad of [/createAdminClient/, /createClient\(/, /@\/lib\/supabase/, /\.from\(/, /"use server"/, /@anthropic-ai/, /process\.env/, /ANTHROPIC/, /MERCHANT_SESSION/]) {
    assert.equal(bad.test(s), false, `component must not contain ${bad}`);
  }
});

// ── provider diagnostics never leak the key (§16) ────────────────────────────────
test("provider signal is a SAFE boolean — the key is never returned/rendered", () => {
  const server = read(SERVER);
  // the server may READ env presence, but only as a boolean (!!...), never returning the value
  assert.ok(/!!process\.env\.ANTHROPIC_API_KEY/.test(server), "derives a boolean from env presence");
  assert.equal(/providerKey|apiKey|ANTHROPIC_API_KEY\s*[,}]/.test(strip(server).replace(/!!process\.env\.ANTHROPIC_API_KEY/g, "")), false, "never passes the raw key onward");
});

// ── page: read-only render, writer-gated affordance ──────────────────────────────
test("page loads the read-only view + gates the write affordance", () => {
  const s = strip(read(PAGE));
  assert.ok(/loadAiCenter\(/.test(s), "loads the read-only AI-center view");
  assert.ok(/requireMalakWriter\(/.test(s) && /canWrite/.test(s), "computes + passes canWrite");
  assert.ok(/<AiCenter/.test(s), "renders the AI center");
  for (const w of WRITES) assert.equal(w.test(s), false, `page performs no ${w}`);
});

// ── OPS.1 links to the AI Center (§1) ────────────────────────────────────────────
test("the main operations page links to the AI Center", () => {
  assert.ok(/\/v2\/operations\/ai(["'?]|$)/m.test(read("app/(v2)/v2/operations/page.tsx")), "OPS.1 links to /v2/operations/ai");
});
