// CH.5 Phase D — resolver-switch guard (source scan).
//
// Proves (§7):
//   1. dual-read + legacy fallback modules stay PURE;
//   2. the default resolver reads ECL as PRIMARY, legacy as fallback only;
//   3. the Shopify adapter wiring uses the switched default (not the CH.2 reader);
//   4. no Phase D module MUTATES any legacy source (read-only);
//   5. no quantity ownership anywhere in the Phase D identity code;
//   6. the durable resolver surfaces duplicate ids as NEEDS_REVIEW (byClaimedExternalId).
//
// node --conditions=react-server --experimental-strip-types --test lib/channels/ch5-phase-d-guard.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

const PURE = ["lib/channels/dual-read-identity-resolver.ts", "lib/channels/legacy-storefront-resolver.ts"];
const SERVER_DEFAULT = "lib/channels/identity-resolver.server.ts";
const ADAPTER_WIRING = "app/(app)/import-export/shopify-adapter.server.ts";
const ALL_PHASE_D = [...PURE, SERVER_DEFAULT, "lib/channels/external-listing-reader.ts", "lib/channels/durable-identity-resolver.ts"];

test("1. dual-read + legacy fallback stay pure (no @/ imports, no server-only)", () => {
  for (const f of PURE) {
    const s = read(f);
    assert.equal(/from\s+["']@\//.test(s), false, `${f} pure`);
    assert.equal(/import\s+["']server-only["']/.test(s), false, `${f} not server-only`);
  }
});

test("2. the default resolver reads ECL as PRIMARY, legacy as fallback", () => {
  const s = strip(read(SERVER_DEFAULT));
  assert.ok(/import\s+["']server-only["']/.test(read(SERVER_DEFAULT)), "default resolver is server-only");
  assert.ok(/const\s+primary\s*=\s*createDurableIdentityResolver\(/.test(s), "primary is the durable ECL resolver");
  assert.ok(/createExternalListingReader\(/.test(s), "reads external_channel_listings");
  assert.ok(/createLegacyStorefrontResolver\(/.test(s), "legacy is present as fallback");
  assert.ok(/createDualReadResolver\(\s*primary\s*,\s*legacy/.test(s), "dual-read: primary first (ECL), legacy second");
});

test("3. the Shopify adapter uses the switched default resolver", () => {
  const s = strip(read(ADAPTER_WIRING));
  assert.ok(/getExternalIdentityResolver\(/.test(s), "adapter uses the default resolver");
  assert.equal(/createProjectionIdentityResolver/.test(s), false, "no longer wires the CH.2 projection resolver directly");
});

test("4. no Phase D module mutates a legacy source (read-only)", () => {
  for (const f of ALL_PHASE_D) {
    const s = strip(read(f));
    for (const w of [/\.insert\(/, /\.update\(/, /\.delete\(/, /\.upsert\(/, /\.rpc\(/]) {
      assert.equal(w.test(s), false, `${f} must not mutate (matched ${w})`);
    }
  }
});

test("5. no quantity ownership in the Phase D identity code", () => {
  for (const f of ALL_PHASE_D) {
    const s = strip(read(f));
    assert.equal(/\b(channel_stock|channelStock|stock_quantity|stockQuantity|quantity|inventoryQuantity)\b/.test(s), false, `${f} owns no quantity`);
  }
});

test("6. the durable resolver surfaces duplicate ids as NEEDS_REVIEW", () => {
  const s = read("lib/channels/durable-identity-resolver.ts");
  assert.ok(/byClaimedExternalId/.test(s), "claimed-id path exists");
  assert.ok(/needs_review/.test(s) && /NEEDS_REVIEW/.test(s), "returns needs_review for a contested id");
});
