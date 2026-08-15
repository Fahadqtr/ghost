// CH.6A — Snoonu adapter foundation guard (source scan + conformance).
//
// Proves (§13):
//   1. pure Snoonu modules stay pure; adapter conforms to ChannelAdapter;
//   2. the adapter resolves identity through the ECL resolver (not the table);
//   3. NO new Snoonu file reads products.snoonu_id / pure_seoul_id directly;
//   4. the storefront is always EXPLICIT (no channelKeyFromName inference);
//   5. no writes anywhere in the Snoonu foundation (read-only);
//   6. no quantity ownership (no channel/store/listing stock or quantity);
//   7. no browser automation introduced yet;
//   8. the adapter does not hijack the legacy Snoonu/Pure Seoul import actions.
//
// node --conditions=react-server --experimental-strip-types --test lib/adapters/snoonu/ch6a-snoonu-guard.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createSnoonuAdapter } from "./snoonu-adapter.ts";
import { CAPABILITY_METHODS, type ExternalIdentityResolver } from "../types.ts";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

const DIR = "lib/adapters/snoonu";
const PURE = [`${DIR}/snoonu-adapter.ts`, `${DIR}/snoonu-listing.ts`, `${DIR}/snoonu-file-contract.ts`, `${DIR}/snoonu-diagnostics.ts`];
const ALL = [...PURE, `${DIR}/snoonu-diagnostics.server.ts`];
const ADAPTER = `${DIR}/snoonu-adapter.ts`;

test("1. pure modules stay pure; adapter conforms to ChannelAdapter", () => {
  for (const f of PURE) {
    const s = read(f);
    assert.equal(/from\s+["']@\//.test(s), false, `${f} pure`);
    assert.equal(/import\s+["']server-only["']/.test(s), false, `${f} not server-only`);
  }
  const a = createSnoonuAdapter({ resolver: { resolve: async (st) => ({ storeKey: st.storeKey, externalListingId: null, source: "none" }) } as ExternalIdentityResolver });
  for (const m of Object.values(CAPABILITY_METHODS)) {
    assert.equal(typeof (a as unknown as Record<string, unknown>)[m], "function", `implements ${m}`);
  }
});

test("2. the adapter resolves identity via the resolver, not the ECL table", () => {
  const s = strip(read(ADAPTER));
  assert.ok(/deps\.resolver\.resolve\(/.test(s), "uses the injected resolver");
  assert.equal(/external_channel_listings/.test(s), false, "adapter never reads the identity table directly");
});

test("3. no new Snoonu file reads legacy products id columns directly", () => {
  for (const f of ALL) {
    const s = strip(read(f));
    assert.equal(/\bsnoonu_id\b/.test(s), false, `${f} must not read products.snoonu_id`);
    assert.equal(/\bpure_seoul_id\b/.test(s), false, `${f} must not read products.pure_seoul_id`);
  }
});

test("4. storefront is always explicit (no channelKeyFromName inference)", () => {
  const s = strip(read(ADAPTER));
  assert.equal(/channelKeyFromName/.test(s), false, "no implicit channel/store inference");
  assert.ok(/storefrontsForChannel\(/.test(s), "stores come from the explicit registry");
});

test("5. no writes anywhere in the Snoonu foundation", () => {
  for (const f of ALL) {
    const s = strip(read(f));
    for (const w of [/\.insert\(/, /\.update\(/, /\.delete\(/, /\.upsert\(/, /\.rpc\(/]) {
      assert.equal(w.test(s), false, `${f} must not write (matched ${w})`);
    }
  }
});

test("6. no quantity ownership (channel/store/listing stock or quantity)", () => {
  for (const f of ALL) {
    const s = strip(read(f));
    assert.equal(/\b(channel_stock|channelStock|storefront_stock|listing_quantity|stock_quantity|stockQuantity|quantity|inventoryQuantity)\b/.test(s), false, `${f} owns no quantity`);
  }
});

test("7. no browser automation introduced yet", () => {
  for (const f of ALL) {
    const s = read(f);
    assert.equal(/playwright|puppeteer|chromium|\bpage\.goto\b/i.test(s), false, `${f} introduces no browser automation`);
  }
});

test("8. the adapter does not hijack the legacy import actions", () => {
  for (const f of ALL) {
    const s = read(f);
    assert.equal(/import-export\/(snoonu|pure-seoul)-actions/.test(s), false, `${f} must not wire the legacy actions`);
  }
});
