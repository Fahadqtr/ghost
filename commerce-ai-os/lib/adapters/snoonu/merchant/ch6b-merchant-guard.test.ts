// CH.6B — Snoonu merchant image-recovery guard (source scan). Proves §16.
// node --conditions=react-server --experimental-strip-types --test lib/adapters/snoonu/merchant/ch6b-merchant-guard.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../../..", import.meta.url));
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

const D = "lib/adapters/snoonu/merchant";
const PURE = [`${D}/merchant-contract.ts`, `${D}/image-host-policy.ts`, `${D}/image-safety.ts`, `${D}/image-match.ts`, `${D}/missing-image-scan.ts`, `${D}/import-plan.ts`];
const SERVER = [`${D}/session.server.ts`, `${D}/image-recovery.server.ts`];
const ALL = [...PURE, ...SERVER];
const ORCH = `${D}/image-recovery.server.ts`;

test("pure modules stay pure (no @/ imports, no server-only)", () => {
  for (const f of PURE) {
    const s = read(f);
    assert.equal(/from\s+["']@\//.test(s), false, `${f} pure`);
    assert.equal(/import\s+["']server-only["']/.test(s), false, `${f} not server-only`);
  }
});

test("connector uses the ECL identity table, never legacy products id columns", () => {
  const orch = strip(read(ORCH));
  assert.ok(/external_channel_listings/.test(orch), "reads ECL for SPIs");
  for (const f of ALL) {
    const s = strip(read(f));
    assert.equal(/\bsnoonu_id\b/.test(s), false, `${f} must not read products.snoonu_id`);
    assert.equal(/\bpure_seoul_id\b/.test(s), false, `${f} must not read products.pure_seoul_id`);
  }
});

test("apply is writer-gated (CH.3b) and reuses the existing media pipeline", () => {
  const orch = strip(read(ORCH));
  assert.ok(/requireMalakWriter\(/.test(orch), "apply gates on the writer allow-list");
  assert.ok(/storePrimaryProductImage\(/.test(orch), "reuses the existing media store (no second storage)");
});

test("no quantity / availability / barcode writes anywhere in the flow", () => {
  for (const f of ALL) {
    const s = strip(read(f));
    // the ONLY mutation is the image store; no direct table writes at all here
    for (const w of [/\.insert\(/, /\.update\(/, /\.upsert\(/, /\.delete\(/, /\.rpc\(/]) {
      assert.equal(w.test(s), false, `${f} performs no direct table writes (matched ${w})`);
    }
    assert.equal(/\b(availability|channel_stock|quantity|stock_quantity)\b\s*[:=]/.test(s), false, `${f} writes no availability/quantity`);
  }
});

test("no arbitrary URL fetch — allow-list is checked BEFORE the fetch (no SSRF)", () => {
  const orch = strip(read(ORCH));
  assert.ok(/isAllowedSnoonuImageUrl\(/.test(orch), "host allow-list applied");
  assert.ok(/safeFetchImage\(/.test(orch), "uses the SSRF-guarded fetcher");
  const gate = orch.indexOf("isAllowedSnoonuImageUrl(");
  const fetchAt = orch.indexOf("safeFetchImage(");
  assert.ok(gate >= 0 && fetchAt >= 0 && gate < fetchAt, "allow-list is enforced before fetching");
});

test("no merchant credentials in code; session file is server-only", () => {
  assert.ok(/import\s+["']server-only["']/.test(read(`${D}/session.server.ts`)), "session is server-only");
  for (const f of ALL) {
    const s = read(f);
    assert.equal(/password\s*[:=]\s*["'][^"']+["']/i.test(s), false, `${f} contains no hardcoded password`);
  }
});

test("no fuzzy/name auto-accept: MATCHED requires SKU/barcode, not name", () => {
  const m = read(`${D}/image-match.ts`);
  assert.ok(/skuOk/.test(m) && /barcodeOk/.test(m), "match keys on exact SKU/barcode");
  assert.equal(/jaccard|fuzzy|levenshtein|includes\(.*name/i.test(m), false, "no fuzzy/name matching");
});

test("no screenshot-first / visual-coordinate automation", () => {
  for (const f of ALL) {
    const s = read(f);
    assert.equal(/playwright|puppeteer|screenshot|page\.(goto|click|mouse)|\.mouse\./i.test(s), false, `${f} uses no visual automation`);
  }
});
