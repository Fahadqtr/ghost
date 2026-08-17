// INT.2F.1 — Talabat mapping-sync convergence guard (source scan). Proves:
//   • the certified boundary is server-only, audited, and delegates to the single
//     canonical writer (persistTalabatMappings) — no re-implemented write
//   • the legacy Talabat export route DELEGATES to the boundary and no longer
//     calls the low-level writer directly
//   • the route still owns the writer gate (requireMalakWriter runs before the
//     delegation) — identical fail-closed behavior
//   • no legacy identity columns / fuzzy matching are introduced
// node --conditions=react-server --experimental-strip-types --test lib/talabat/mapping-sync/int2f1-mapping-sync-guard.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

const BOUNDARY = "lib/talabat/mapping-sync/mapping-sync.server.ts";
const ROUTE = "app/api/export/[channel]/route.ts";
const WRITER = "lib/talabat/persist-mappings.ts";

test("the boundary is server-only, audited, and delegates to the canonical writer", () => {
  const b = read(BOUNDARY);
  assert.ok(/import "server-only"/.test(b), "server-only");
  assert.ok(/persistTalabatMappings\(/.test(b), "delegates to the canonical writer");
  assert.ok(/insertAuditRow\(/.test(b) && /talabat_mapping_sync/.test(b), "records an audit row");
  // no second write engine: the boundary must not touch the table itself
  assert.equal(/\.from\(["']channel_variant_mappings["']\)/.test(b), false, "no direct table write in the boundary");
});

test("the legacy route delegates to the boundary and not to the low-level writer", () => {
  const r = read(ROUTE);
  assert.ok(/syncTalabatMappings\(/.test(r), "route calls the boundary");
  assert.equal(/persistTalabatMappings\(/.test(r), false, "route no longer calls the low-level writer directly");
  assert.equal(/from "@\/lib\/talabat\/persist-mappings"/.test(r), false, "route no longer imports the low-level writer");
});

test("the route owns the writer gate BEFORE delegating (fail-closed unchanged)", () => {
  const r = read(ROUTE);
  const gateIdx = r.indexOf("requireMalakWriter(");
  const syncIdx = r.indexOf("syncTalabatMappings(");
  assert.ok(gateIdx > -1 && syncIdx > -1, "route gates and delegates");
  assert.ok(gateIdx < syncIdx, "writer gate runs before the mapping delegation");
  // the boundary receives the verified actor (writer email) as its last argument
  assert.ok(/writer\.email\s*\)/.test(r), "verified actor (writer.email) forwarded to the boundary");
});

test("no legacy identity columns / fuzzy matching are introduced", () => {
  for (const f of [BOUNDARY, WRITER]) {
    const s = read(f);
    assert.equal(/snoonu_id|rafeeq_product_id|pure_seoul_id/.test(s), false, `${f} uses no legacy id column`);
    for (const re of [/levenshtein/i, /fuzzy/i, /similarity/i, /normTitle/]) {
      assert.equal(re.test(s), false, `${f} must not fuzzy-match (${re})`);
    }
  }
  // identity remains durable: channel_id + master_product_id + master_variant_sku
  const w = read(WRITER);
  assert.ok(/master_product_id/.test(w) && /master_variant_sku/.test(w) && /channel_id/.test(w), "durable identity keys retained");
});
