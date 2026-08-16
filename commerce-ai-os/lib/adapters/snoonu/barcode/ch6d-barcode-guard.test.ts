// CH.6D — Snoonu barcode completion guard (source scan). Proves the safety
// contract: barcode-only writes through the approved boundary, ECL identity only,
// writer-gated, and NO inventory / availability / image / AI / fuzzy behavior.
// node --conditions=react-server --experimental-strip-types --test lib/adapters/snoonu/barcode/ch6d-barcode-guard.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../../..", import.meta.url));
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

const D = "lib/adapters/snoonu/barcode";
const PURE = [`${D}/snoonu-barcode-normalize.ts`, `${D}/snoonu-barcode-diff.ts`, `${D}/snoonu-barcode-plan.ts`];
const SERVER = [`${D}/barcode-source.server.ts`, `${D}/barcode-completion.server.ts`];
const ORCH = `${D}/barcode-completion.server.ts`;
const WRITER = "lib/products/barcode-write.ts";
const ACTIONS = "app/(v2)/v2/operations/barcode-completion-actions.ts";
const COMPONENT = "components/v2/operations/BarcodeCompletion.tsx";
const PAGE = "app/(v2)/v2/operations/barcode-completion/page.tsx";
const ALL = [...PURE, ...SERVER, WRITER, ACTIONS, COMPONENT, PAGE];

test("pure modules stay pure (no @/ imports, no server-only)", () => {
  for (const f of PURE) {
    const s = read(f);
    assert.equal(/from\s+["']@\//.test(s), false, `${f} pure`);
    assert.equal(/import\s+["']server-only["']/.test(s), false, `${f} not server-only`);
  }
});

test("server modules (orchestrator, source, writer) are server-only", () => {
  for (const f of [...SERVER, WRITER]) {
    assert.ok(/import\s+["']server-only["']/.test(read(f)), `${f} is server-only`);
  }
});

test("resolves through the ECL identity table, never legacy id columns", () => {
  const orch = strip(read(ORCH));
  assert.ok(/external_channel_listings/.test(orch), "reads ECL for identity + evidence");
  assert.ok(/mapping_status/.test(orch) && /"active"/.test(orch), "uses ACTIVE mappings");
  assert.ok(/storefront_key/.test(orch), "storefront-scoped (cross-store isolation)");
  for (const f of [...SERVER, WRITER, ACTIONS]) {
    const s = strip(read(f));
    assert.equal(/\bsnoonu_id\b/.test(s), false, `${f} must not read products.snoonu_id`);
    assert.equal(/\bpure_seoul_id\b/.test(s), false, `${f} must not read products.pure_seoul_id`);
  }
});

test("apply is writer-gated (CH.3b) and writes ONLY through the Catalog barcode boundary", () => {
  const orch = strip(read(ORCH));
  assert.ok(/requireMalakWriter\(/.test(orch), "apply gates on the writer allow-list");
  assert.ok(/writeProductBarcode\(/.test(orch) && /writeVariantBarcode\(/.test(orch), "writes via the barcode boundary");
});

test("orchestrator + source perform NO direct table mutations", () => {
  for (const f of SERVER) {
    const s = strip(read(f));
    for (const w of [/\.update\(/, /\.upsert\(/, /\.delete\(/, /\.rpc\(/, /\.insert\(/]) {
      assert.equal(w.test(s), false, `${f} performs no direct table write (matched ${w})`);
    }
  }
});

test("the write boundary touches ONLY the barcode column, grain-exact", () => {
  const w = strip(read(WRITER));
  assert.ok(/update\(\{\s*barcode/.test(w), "updates the barcode column");
  assert.ok(/"products"/.test(w) && /"product_variants"/.test(w), "both grains handled separately");
  assert.ok(/\.eq\("id"/.test(w), "filtered by id (one row)");
  for (const col of ["stock_quantity", "sold_quantity", "shelf_stock", "stock_status", "availability", "image_url", "image_filename", "price"]) {
    assert.equal(new RegExp(`\\b${col}\\b`).test(w), false, `boundary never writes ${col}`);
  }
});

test("no inventory / availability / image writes anywhere in the flow", () => {
  for (const f of [...SERVER, WRITER]) {
    const s = strip(read(f));
    for (const col of ["stock_quantity", "sold_quantity", "shelf_stock", "variant_shelf_stock", "stock_status", "channel_status", "image_url", "image_filename"]) {
      assert.equal(new RegExp(`\\b${col}\\b`).test(s), false, `${f} references no ${col}`);
    }
    for (const tbl of ["inventory", "platform_status", "channel_products", "product_images"]) {
      assert.equal(new RegExp(`\\.from\\(["']${tbl}["']\\)`).test(s), false, `${f} does not touch table ${tbl}`);
    }
  }
});

test("no AI generation and no barcode INVENTION (never generate a barcode)", () => {
  for (const f of ALL) {
    const s = read(f);
    assert.equal(/generateEan13|generateUniqueEan13Batch|nextMainBarcode|fillMissingVariantBarcodes/.test(s), false, `${f} never generates/invents a barcode`);
    assert.equal(/openai|gemini|anthropic|generateContent|product-generation/i.test(s), false, `${f} uses no AI generation`);
  }
});

test("no fuzzy / name-based auto matching — identity is SPI via ECL", () => {
  for (const f of [...PURE, ...SERVER]) {
    const s = read(f);
    assert.equal(/jaccard|fuzzy|levenshtein|similarity/i.test(s), false, `${f} uses no fuzzy matching`);
  }
  // the classifier keys on evidence/SPI, never on the product name text
  const diff = strip(read(`${D}/snoonu-barcode-diff.ts`));
  assert.equal(/\.name\b.*(match|includes|===)/.test(diff), false, "classifier does not match on name");
});

test("actions delegate to the orchestrator — no DB/admin client of their own", () => {
  const s = strip(read(ACTIONS));
  assert.ok(/scanBarcodeCompletion\(/.test(s) && /applyBarcodeCompletion\(/.test(s), "delegates to orchestrator");
  assert.equal(/createAdminClient\(/.test(s), false, "actions hold no service-role client");
  assert.equal(/\.from\(/.test(s), false, "actions issue no direct queries");
});

test("client component holds no DB/admin client and issues no queries", () => {
  const s = read(COMPONENT);
  assert.ok(/"use client"/.test(s), "is a client component");
  for (const bad of [/createAdminClient/, /createClient\(/, /@\/lib\/supabase/, /\.from\(/]) {
    assert.equal(bad.test(s), false, `component must not contain ${bad}`);
  }
});

test("page gates the Apply affordance on the writer allow-list", () => {
  const s = strip(read(PAGE));
  assert.ok(/requireMalakWriter\(/.test(s) && /canWrite/.test(s), "page computes + passes canWrite");
});

test("every applied change is audited (source=snoonu, storefront, SPI, old, new, reason)", () => {
  const orch = strip(read(ORCH));
  assert.ok(/insertAuditRow\(/.test(orch), "records an audit row");
  for (const key of ["source", "storefronts", "spis", "old_value", "new_value", "reason"]) {
    assert.ok(new RegExp(key).test(orch), `audit carries ${key}`);
  }
});
