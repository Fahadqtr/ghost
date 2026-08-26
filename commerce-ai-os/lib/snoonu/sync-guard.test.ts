// SNOONU CATALOG SYNC — architecture guard (source scan). Proves at the seams
// node:test cannot execute:
//   • preview is WRITE-FREE (the pure planner + a read-only context loader);
//   • apply is OWNER-gated behind an explicit confirmation and a fingerprint
//     drift check;
//   • removal is the safe lifecycle mechanism (STOPPED + listing archive) —
//     never a destructive DELETE of a product;
//   • availability writes go EXCLUSIVELY through the certified Availability
//     Engine; creation goes EXCLUSIVELY through createProductCore (no new
//     products-insert site);
//   • identity is never invented: the only synthetic SKU is the explicit
//     PENDING sentinel, and the return workbook blanks it (pure tests own
//     that rule; here we pin no EAN/mk-SKU generator is reachable).
// node --conditions=react-server --experimental-strip-types --test lib/snoonu/sync-guard.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

const PURE = "lib/snoonu/sync.ts";
const SERVER = "lib/snoonu/sync.server.ts";
const ACTIONS = "app/(v2)/v2/catalog/snoonu-sync/actions.ts";
const UI = "components/v2/catalog/SnoonuSync.tsx";

test("preview is write-free: the pure planner has no I/O and the preview path performs no write call", () => {
  const pure = read(PURE);
  for (const bad of ["createAdminClient", "createClient", "fetch(", ".insert(", ".upsert(", ".delete(", ".rpc("]) {
    assert.ok(!pure.includes(bad), `pure planner is I/O-free (${bad})`);
  }
  const server = read(SERVER);
  const previewSlice = server.slice(0, server.indexOf("applySnoonuSyncPlan"));
  for (const bad of [".insert(", ".update(", ".upsert(", ".delete(", ".rpc("]) {
    assert.ok(!previewSlice.includes(bad), `context/preview performs no write (${bad})`);
  }
  const actions = read(ACTIONS);
  assert.ok(/previewSnoonuSyncAction[\s\S]*?requireMalakWriter/.test(actions), "preview is at least writer-gated");
});

test("apply is OWNER-gated, confirmation-driven, and drift fails closed via the plan fingerprint", () => {
  const actions = read(ACTIONS);
  const apply = actions.slice(actions.indexOf("export async function applySnoonuSyncAction"));
  assert.ok(apply.includes("requireOwner()"), "apply requires the OWNER");
  assert.ok(apply.indexOf("requireOwner()") < apply.indexOf("parseSnoonuFile"), "gate before any work");
  const server = read(SERVER);
  assert.ok(server.includes("plan.fingerprint !== input.expectedFingerprint"), "recomputed plan must equal what the owner previewed");
  assert.ok(server.includes('return { ok: false, error: "plan_changed" }'), "drift fails closed");
  assert.ok(server.includes("plan.applyBlocked"), "a duplicate-SPI workbook can never apply");
  const ui = read(UI);
  assert.ok(ui.includes("تطبيق الآن (نهائي)") && ui.includes("setConfirming"), "the UI requires an explicit second confirmation");
  assert.ok(ui.includes("fingerprint"), "the UI sends the previewed fingerprint");
});

test("removal is lifecycle-safe: STOPPED via the CANONICAL transition boundary + listing archive — never a destructive product DELETE", () => {
  const server = read(SERVER);
  assert.ok(server.includes("transitionProductLifecycle"), "removal goes through the ONE sanctioned lifecycle writer");
  assert.ok(server.includes('targetState: "STOPPED"'), "removal = lifecycle stop");
  assert.ok(!server.includes("lifecycle_state:"), "no direct lifecycle_state write anywhere in the sync layer");
  assert.ok(server.includes('mapping_status: "archived"'), "the snoonu listing is archived, not deleted");
  assert.ok(!/from\("products"\)[\s\S]{0,80}?\.delete\(/.test(server), "no product delete");
  assert.ok(!server.includes("archive_product_bundle"), "the bundle-archive (deletion) RPC is never used here");
});

test("availability goes through the certified engine; creation through the canonical core; identity is never invented", () => {
  const server = read(SERVER);
  assert.ok(server.includes("writeProductAvailability"), "engine is the sole availability writer");
  assert.ok(!/update\(\s*\{[\s\S]{0,120}?stock_status/.test(server), "no direct stock_status write outside the engine");
  assert.ok(server.includes("createProductCore"), "creation uses the canonical core (no new insert site)");
  assert.ok(!/from\("products"\)\s*\.insert\(/.test(server), "no ad-hoc products insert");
  for (const bad of ["nextMkSku", "generateUniqueEan13", "randomUUID()"]) {
    assert.ok(!server.includes(bad), `no identifier is ever generated/invented (${bad})`);
  }
  assert.ok(server.includes("pendingSkuForSpi"), "the only synthetic SKU is the explicit PENDING sentinel");
});

test("the audit migration is additive-only", () => {
  const m = read("supabase/migrations/20260828000000_snoonu_sync_audits.sql").replace(/--[^\n]*/g, "").toLowerCase();
  assert.ok(m.includes("create table if not exists public.snoonu_sync_audits"));
  assert.ok(!m.includes("drop table") && !/alter table (?!public\.snoonu_sync_audits)/.test(m), "nothing else is touched");
});

test("the generic Excel importer is untouched: SPI stays reference-only there and its availability ban stands", () => {
  const core = read("lib/products/excel-import/core.ts");
  assert.ok(core.includes('"spi", "spiuniqueidentifier"'), "generic import still ignores SPI as a match key");
  assert.ok(core.includes('"availability"'), "generic import still refuses availability columns");
});
