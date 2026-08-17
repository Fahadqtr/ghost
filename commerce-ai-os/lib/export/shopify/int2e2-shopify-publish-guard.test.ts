// INT.2E.2 — Shopify publish safety guard (source scan). Proves the live write
// workflow is safe by construction (§23):
//   • the publisher REUSES the INT.2E preview/plan (loadShopifyPreviewContext +
//     evaluateRow) — there is NO second Shopify diff engine and NO import of the
//     legacy fuzzy diff (lib/shopify-diff)
//   • CONFLICT / UNKNOWN / BLOCKED are hard-stops (never executed)
//   • no auto-publish: batch confirmation is required, new products are created as
//     DRAFT, and product status is never written
//   • no fuzzy identity matching; no legacy identity columns; GID comes from the
//     create response, not fabricated
//   • no destructive media reconciliation (add-only; no delete/reorder)
//   • no direct inventory write (create uses locationId:null, quantity:0) and no
//     availability write
//   • ECL is the durable identity authority (writeEclMapping)
//   • writer-gated + server-only; credentials never in the client
//   • durable export_runs audit is written; the run store tolerates an unmigrated DB
//   • the legacy Shopify operator export path is fenced
// node --conditions=react-server --experimental-strip-types --test lib/export/shopify/int2e2-shopify-publish-guard.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

const PLAN = "lib/export/shopify/publish-plan.ts";
const SERVER = "lib/export/shopify/publish.server.ts";
const RUN_STORE = "lib/export/shopify/run-store.server.ts";
const ROUTE = "app/api/export/shopify/publish/route.ts";
const COMPONENT = "components/v2/export/ShopifyPreview.tsx";
const PREVIEW_SERVER = "lib/export/shopify/preview.server.ts";
const LEGACY_ROUTE = "app/api/export/[channel]/route.ts";
const MIGRATION = "supabase/export_runs.sql";

// ── reuse the certified preview/plan; no second diff engine ───────────────────
test("the publisher reuses the INT.2E preview/plan and adds no second diff engine", () => {
  const s = read(SERVER);
  assert.ok(/loadShopifyPreviewContext\(\)/.test(s), "re-reads + re-plans via the certified context");
  assert.ok(/from "\.\/publish-plan\.ts"/.test(s) && /evaluateRow\(/.test(s), "eligibility via the pure plan");
  // must NOT rebuild/borrow the legacy fuzzy diff
  for (const f of [PLAN, SERVER]) {
    const c = read(f);
    assert.equal(/shopify-diff|diffShopify|indexShopify|normTitle/.test(c), false, `${f} must not use the legacy diff`);
    for (const re of [/levenshtein/i, /fuzzy/i, /similarity/i]) assert.equal(re.test(c), false, `${f} must not fuzzy-match (${re})`);
  }
});

// ── CONFLICT / UNKNOWN / BLOCKED are hard-stops ───────────────────────────────
test("CONFLICT / UNKNOWN / BLOCKED never publish", () => {
  const plan = read(PLAN);
  assert.ok(/CONFLICT:\s*"CONFLICT"/.test(plan) && /BLOCKED:\s*"BLOCKED"/.test(plan) && /UNKNOWN:\s*"BLOCKED"/.test(plan), "hard-stop map covers all three");
  assert.ok(/if \(hardStop\)/.test(plan), "hard-stop short-circuits eligibility");
});

// ── no auto-publish: confirm required, create DRAFT, status never written ──────
test("no auto-publish (confirm required, create as DRAFT, status never sent)", () => {
  const s = read(SERVER);
  assert.ok(/if \(!input\?\.confirm\)/.test(s), "batch confirmation required");
  assert.ok(/confirmCreate !== true/.test(s), "NEW requires explicit create confirmation");
  assert.ok(/status: "DRAFT"/.test(s), "new products are created as DRAFT");
  assert.equal(/status:\s*"ACTIVE"/.test(s), false, "never creates/sets ACTIVE");
  // update content is title-only; product status is intentionally never sent
  assert.ok(/updateShopifyProductContent\(gid, fields\)/.test(s));
  assert.equal(/status:\s*status/.test(s), false, "no status field forwarded to Shopify");
  // the client never publishes on load — it requires an explicit confirm step
  assert.ok(/setConfirmOpen\(true\)/.test(read(COMPONENT)), "explicit confirm step in the UI");
});

// ── no legacy identity columns; GID from the create response, not fabricated ───
test("ECL-first identity; no legacy id columns; GID from the create response", () => {
  for (const f of [PLAN, SERVER, ROUTE, COMPONENT]) {
    assert.equal(/shopify_id|snoonu_id|rafeeq_product_id|pure_seoul_id/.test(read(f)), false, `${f} must not use a legacy id column`);
  }
  const s = read(SERVER);
  assert.ok(/writeEclMapping\(/.test(s), "identity write-back through the approved ECL boundary");
  assert.ok(/const gid = created\.shopifyId/.test(s), "GID is the Shopify create response, never fabricated");
  assert.ok(/externalProductId: gid/.test(s), "ECL records the observed GID");
});

// ── no destructive media reconciliation (add-only) ────────────────────────────
test("media is add-only — no delete / reorder", () => {
  const s = read(SERVER);
  assert.ok(/addProductImage\(/.test(s), "add missing media only");
  assert.equal(/productDeleteMedia|productReorderMedia|deleteMedia|reorderMedia|productUpdateMedia/.test(s), false, "no destructive media op");
});

// ── no direct inventory / availability write ──────────────────────────────────
test("no direct inventory or availability write", () => {
  const s = read(SERVER);
  assert.equal(/setInventoryQuantities|pushInventoryStockToShopify|runShopifyInventorySync|resolveInventoryItemIdBySku/.test(s), false, "no inventory writer");
  assert.ok(/locationId: null/.test(s) && /quantity: 0/.test(s), "create skips the stock step (no quantity write)");
  assert.equal(/@\/lib\/availability\/engine|availability-sync/.test(s), false, "no availability writer");
  assert.equal(/transitionProductLifecycle/.test(s), false, "no lifecycle mutation");
});

// ── writer-gated + server-only; credentials never in the client ───────────────
test("writer-gated, server-only, credentials server-side", () => {
  for (const f of [SERVER, RUN_STORE, PREVIEW_SERVER]) assert.ok(/import "server-only"/.test(read(f)), `${f} is server-only`);
  assert.ok(/requireMalakWriter\(\)/.test(read(SERVER)) && /requireMalakWriter\(\)/.test(read(ROUTE)), "writer-gated in server + route");
  const c = read(COMPONENT);
  for (const bad of [/createAdminClient/, /createClient\(/, /@\/lib\/supabase/, /SHOPIFY_ADMIN_TOKEN/, /X-Shopify-Access-Token/, /\.from\(/]) {
    assert.equal(bad.test(c), false, `component must not contain ${bad}`);
  }
});

// ── durable export_runs audit; unmigrated DB tolerated ────────────────────────
test("durable export_runs audit is written and tolerates an unmigrated database", () => {
  assert.ok(/recordExportRun\(/.test(read(SERVER)), "server records a run");
  const rs = read(RUN_STORE);
  assert.ok(/from\("export_runs"\)/.test(rs), "writes the export_runs row");
  assert.ok(/42P01/.test(rs), "handles the table-absent case (best-effort)");
  assert.ok(/insertAuditRow\(/.test(rs), "malak_audit floor always attempted");
  // no secrets in the run payload
  const s = (read(SERVER) + rs).toLowerCase();
  for (const secret of ["service_role", "x-shopify-access-token", "access_token", "authorization", "bearer "]) {
    assert.equal(s.includes(secret), false, `run store must not persist ${secret}`);
  }
  // migration is additive + RLS-guarded, no destructive DDL in the up-migration
  const m = read(MIGRATION);
  assert.ok(/create table if not exists public\.export_runs/.test(m) && /enable row level security/.test(m));
  assert.equal(/drop table/.test(m), false, "up-migration performs no drop");
});

// ── legacy Shopify operator export path is fenced (§19) ───────────────────────
test("the legacy Shopify export path is fenced (retired in INT.2F)", () => {
  const legacy = read(LEGACY_ROUTE);
  // INT.2F retired the Shopify/Snoonu/Rafeeq legacy file exports (410 → Export Center).
  assert.ok(/shopify:\s*"\/v2\/export\/shopify:malikas"/.test(legacy), "shopify is in the retired→Export Center map");
  assert.ok(/status: 410/.test(legacy), "retired channels return 410");
  assert.equal(/buildShopifyCsv/.test(legacy), false, "the legacy Shopify CSV branch is removed");
});

// ── stale protection is enforced at execution ─────────────────────────────────
test("stale confirmations are rejected before any mutation", () => {
  const s = read(SERVER);
  assert.ok(/rowFingerprint\(row, target\)/.test(s), "recomputes the fingerprint from the fresh plan");
  assert.ok(/isStale\(fresh, sel\.expectedFingerprint\)/.test(s), "compares against the confirmed fingerprint");
});

// ── §6 fix: selections are deduped server-side before execution ───────────────
test("publish selections are deduped by internalProductId before the execution loop", () => {
  const s = read(SERVER);
  const dedupeAt = s.indexOf("dedupeSelections(input.selections");
  const loopAt = s.indexOf("for (const sel of selections)");
  assert.ok(dedupeAt > -1, "server dedupes selections (does not trust the client Set)");
  assert.ok(loopAt > -1 && dedupeAt < loopAt, "dedupe happens before the execution loop");
});
