// CH.2 — read-only / purity guard for the channel read-model. Static source scan.
// Proves CH.2 introduced a READ-ONLY projection layer only: no writes, no admin
// client, no RPC, no service role, and the pure model stays framework-free.
//
// Run: node --conditions=react-server --experimental-strip-types --test lib/channels/ch2-read-model-guard.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

const MODEL = "lib/channels/channel-model.ts";
const READER = "lib/channels/channel-read-model.ts";
const MODEL_SRC = read(MODEL);
const READER_SRC = read(READER);

// A write/escalation is any of these tokens appearing in the channel layer.
const WRITE_TOKENS = [
  ".insert(", ".update(", ".upsert(", ".delete(", ".rpc(",
  "createAdminClient", "service_role", "SUPABASE_SERVICE_ROLE",
];

test("the pure channel-model performs no writes and no privileged access", () => {
  for (const t of WRITE_TOKENS) {
    assert.equal(MODEL_SRC.includes(t), false, `channel-model must not contain ${t}`);
  }
});

test("the pure channel-model is framework-free (node:test loadable)", () => {
  assert.equal(/from\s+["']@\//.test(MODEL_SRC), false, "no @/ alias imports");
  assert.equal(/from\s+["'](react|next|@supabase)/.test(MODEL_SRC), false, "no react/next/supabase imports");
  assert.equal(/import\s+["']server-only["']/.test(MODEL_SRC), false, "pure model is not server-only");
  // its only import is the pure availability channel-policy sibling
  assert.ok(/from\s+["']\.\.\/availability\/channel-policy\.ts["']/.test(MODEL_SRC), "reuses channel-policy for availability mode");
});

test("the reader is server-only, read-only, and never writes or escalates", () => {
  assert.ok(/^import\s+["']server-only["'];/m.test(READER_SRC), "reader is server-only");
  for (const t of WRITE_TOKENS) {
    assert.equal(READER_SRC.includes(t), false, `reader must not contain ${t}`);
  }
  // the injected read client exposes select/eq/in only — no write verbs on the interface
  assert.ok(/interface ChannelReadClient/.test(READER_SRC), "declares a read-only client interface");
  assert.equal(/insert\(|update\(|upsert\(|delete\(|rpc\(/.test(READER_SRC), false, "no write verbs anywhere in the reader");
});

test("the reader targets by product id (no full-catalog scan)", () => {
  assert.ok(/\.eq\("id", productId\)/.test(READER_SRC), "product read is targeted by id");
  assert.ok(/\.eq\("product_id", productId\)/.test(READER_SRC), "overlays read targeted by product_id");
  assert.equal(/\.range\(/.test(READER_SRC), false, "no paginated full-table scan in the single-product reader");
});

test("CH.2 does not modify any channel write path or migration (additive only)", () => {
  // The channel layer is new; assert it references no runtime write module.
  assert.equal(/product-create|inventory\/engine|persist-mappings|order-ledger/.test(MODEL_SRC + READER_SRC), false,
    "channel read-model does not touch create/engine/mapping-write/order modules");
});
