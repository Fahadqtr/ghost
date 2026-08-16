// CH.6E — bulk AI enrichment guard (source scan). Proves CH.6E cannot write
// inventory / availability / barcode / images / ECL identity / channels, cannot
// bypass Catalog writer authorization, cannot auto-overwrite GOOD content, and
// cannot apply AI output without preview/approval.
// node --conditions=react-server --experimental-strip-types --test lib/enrichment/ch6e-enrichment-guard.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

const D = "lib/enrichment";
const PURE = [`${D}/enrichment-fields.ts`, `${D}/enrichment-keywords.ts`, `${D}/enrichment-classify.ts`, `${D}/enrichment-prompt.ts`, `${D}/enrichment-plan.ts`];
const PROVIDER = `${D}/enrichment-provider.server.ts`;
const ORCH = `${D}/enrichment.server.ts`;
const WRITER = "lib/products/enrichment-write.ts";
const SERVER = [PROVIDER, ORCH, WRITER];
const ACTIONS = "app/(v2)/v2/operations/ai-enrichment-actions.ts";
const COMPONENT = "components/v2/operations/AiEnrichment.tsx";
const PAGE = "app/(v2)/v2/operations/ai-enrichment/page.tsx";

test("pure modules stay pure (no @/ imports, no server-only, no SDK)", () => {
  for (const f of PURE) {
    const s = read(f);
    assert.equal(/from\s+["']@\//.test(s), false, `${f} pure`);
    assert.equal(/import\s+["']server-only["']/.test(s), false, `${f} not server-only`);
    assert.equal(/@anthropic-ai|openai|gemini/i.test(s), false, `${f} no provider SDK`);
  }
});

test("server modules are server-only", () => {
  for (const f of SERVER) assert.ok(/import\s+["']server-only["']/.test(read(f)), `${f} is server-only`);
});

test("AI provider SDK is isolated behind the boundary (business logic is SDK-free §15)", () => {
  assert.ok(/@anthropic-ai\/sdk/.test(read(PROVIDER)), "provider owns the SDK");
  assert.equal(/@anthropic-ai\/sdk|new Anthropic/.test(read(ORCH)), false, "orchestrator does not import the SDK directly");
});

test("generate + apply are writer-gated (CH.3b); apply writes ONLY via the metadata boundary", () => {
  const orch = strip(read(ORCH));
  assert.ok((orch.match(/requireMalakWriter\(/g) ?? []).length >= 2, "generate AND apply gate on the writer allow-list");
  assert.ok(/writeProductEnrichment\(/.test(orch), "writes via the enrichment boundary");
});

test("orchestrator performs NO direct table mutations (boundary + audit only)", () => {
  const orch = strip(read(ORCH));
  for (const w of [/\.update\(/, /\.upsert\(/, /\.delete\(/, /\.rpc\(/, /\.insert\(/]) {
    assert.equal(w.test(orch), false, `orchestrator has no direct table write (matched ${w})`);
  }
});

test("the AI generation path cannot write (provider is model-call only)", () => {
  const p = strip(read(PROVIDER));
  assert.equal(/\.from\(|\.update\(|\.insert\(|writeProductEnrichment|insertAuditRow/.test(p), false, "provider never touches the DB");
});

test("the write boundary writes ONLY whitelisted enrichment columns on products", () => {
  const w = strip(read(WRITER));
  assert.ok(/ENRICHMENT_WRITE_COLUMNS/.test(w), "declares the column whitelist");
  assert.ok(/\.from\(\s*["']products["']\s*\)/.test(w) || /from\(table\)/.test(w), "targets products");
  for (const banned of ["stock_quantity", "sold_quantity", "stock_status", "availability", "barcode", "image_url", "image_filename", "price", "brand_id", "channel_status"]) {
    assert.equal(new RegExp(`["']${banned}["']`).test(w), false, `boundary never names column ${banned}`);
  }
});

test("no inventory / availability / barcode / image / channel / ECL writes anywhere", () => {
  for (const f of [...SERVER, ACTIONS]) {
    const s = strip(read(f));
    for (const col of ["stock_quantity", "sold_quantity", "stock_status", "channel_status", "image_url", "image_filename"]) {
      assert.equal(new RegExp(`\\.update\\(|\\.upsert\\(`).test(s) && new RegExp(`${col}`).test(s), false, `${f} does not write ${col}`);
    }
    for (const tbl of ["inventory", "platform_status", "channel_products", "external_channel_listings", "product_images"]) {
      assert.equal(new RegExp(`\\.from\\(["']${tbl}["']\\)`).test(s), false, `${f} does not touch table ${tbl}`);
    }
    // barcode is never written by enrichment (it may not even appear as a write target)
    assert.equal(/\.update\([^)]*barcode/.test(s), false, `${f} never updates barcode`);
  }
});

test("no auto-overwrite path: GOOD content is protected, no 'overwrite everything' option", () => {
  for (const f of [ORCH, `${D}/enrichment-plan.ts`, `${D}/enrichment-classify.ts`]) {
    assert.equal(/overwrite/i.test(read(f)), false, `${f} exposes no overwrite behavior`);
  }
});

test("AI output is never applied without preview/approval (apply takes approved suggestions)", () => {
  const orch = strip(read(ORCH));
  assert.ok(/ApprovedSuggestion/.test(orch), "apply consumes operator-approved suggestions");
  // generate returns suggestions, not writes — the boundary import is used by apply only
  assert.ok(/GenerateResult|suggestions:/.test(orch), "generate produces suggestions (preview), not writes");
});

test("every applied change is audited (actor, field, old, new, source)", () => {
  const orch = strip(read(ORCH));
  assert.ok(/insertAuditRow\(/.test(orch), "records an audit row");
  for (const key of ["actor", "field", "old_value", "new_value", "source"]) assert.ok(new RegExp(key).test(orch), `audit carries ${key}`);
});

test("actions delegate to the orchestrator — no DB/admin client of their own", () => {
  const s = strip(read(ACTIONS));
  assert.equal(/createAdminClient\(|createClient\(/.test(s), false, "actions hold no DB client");
  assert.equal(/\.from\(/.test(s), false, "actions issue no direct queries");
});

test("client component holds no DB/admin client and issues no queries", () => {
  const s = read(COMPONENT);
  assert.ok(/"use client"/.test(s), "is a client component");
  for (const bad of [/createAdminClient/, /createClient\(/, /@\/lib\/supabase/, /\.from\(/, /@anthropic-ai/]) {
    assert.equal(bad.test(s), false, `component must not contain ${bad}`);
  }
});

test("page gates generation/apply affordance on the writer allow-list", () => {
  const s = strip(read(PAGE));
  assert.ok(/requireMalakWriter\(/.test(s) && /canWrite/.test(s), "page computes + passes canWrite");
});
