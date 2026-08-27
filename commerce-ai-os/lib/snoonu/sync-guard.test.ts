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
  // the page's own preview is now the availability flow — writer-gated there.
  const actions = read(ACTIONS);
  assert.ok(/previewSnoonuAvailabilityAction[\s\S]*?requireMalakWriter/.test(actions), "preview is at least writer-gated");
});

test("apply is OWNER-gated, confirmation-driven, and drift fails closed via the plan fingerprint", () => {
  const actions = read(ACTIONS);
  const apply = actions.slice(actions.indexOf("export async function applySnoonuAvailabilityAction"));
  assert.ok(apply.includes("requireOwner()"), "apply requires the OWNER");
  assert.ok(apply.indexOf("requireOwner()") < apply.indexOf("parseBoth"), "gate before any work");
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

test("modes 15+16: apply REBUILDS the plan server-side in the EXPLICIT mode — FULL removal semantics are unreachable from a PARTIAL request", () => {
  const server = read(SERVER);
  assert.ok(server.includes("planSnoonuSync({ mode: input.mode,"), "the plan is rebuilt server-side in the request's explicit mode");
  assert.ok(server.includes('input.mode !== "FULL" && plan.removals.length > 0'), "hard invariant: non-FULL removals fail closed");
  assert.ok(server.includes('plan.mode === "FULL" ? plan.removals : []'), "the removal executor itself is FULL-gated");
  // The single-workbook FULL/PARTIAL uploader is gone from the page, so no
  // caller can request FULL semantics at all; the engine invariants above are
  // what still make removal unreachable if one ever returns.
  assert.ok(server.includes("import_mode: plan.mode"), "the audit records import_mode");
});

test("zero-price safety: only an owner-resolved SPI that the REBUILT plan flagged can ever write a zero price", () => {
  const server = read(SERVER);
  assert.ok(server.includes("plan.zeroPriceReviews.map"), "the review set comes from the rebuilt plan");
  assert.ok(server.includes("if (!review) continue;"), "an override not in the plan's review list writes nothing");
  const zeroWrites = server.match(/update\(\{ price: 0 \}\)/g) ?? [];
  assert.equal(zeroWrites.length, 1, "exactly ONE code path can write price 0 — the explicit per-row resolution");
  // the availability page writes no price at all, so it carries no zero-price
  // resolution UI — the engine guard above is what keeps the rule.
});

test("duplicate resolution is SEPARATE and read-only: Snoonu Sync never merges canonical products", () => {
  const dup = read("lib/products/duplicate-resolution.server.ts");
  for (const bad of [".insert(", ".update(", ".upsert(", ".delete(", ".rpc("]) {
    assert.ok(!dup.includes(bad), `duplicate-resolution audit performs no write (${bad})`);
  }
  const server = read(SERVER);
  for (const bad of ["merge", "auditDuplicatePair"]) {
    assert.ok(!server.toLowerCase().includes(bad.toLowerCase()), `the sync apply layer contains no merge/resolution path (${bad})`);
  }
  const actions = read(ACTIONS);
  assert.ok(!actions.includes("auditDuplicatePair"), "the availability page offers no merge/resolution path at all");
});

test("reconcile 2+3+11: RECONCILE_EXISTING writes ONLY the certified snoonu listing — no product insert, target revalidated by the rebuilt plan", () => {
  const server = read(SERVER);
  const recSlice = server.slice(server.indexOf("RECONCILE_EXISTING — link the SPI"), server.indexOf("NEW Snoonu products"));
  assert.ok(recSlice.includes('from("external_channel_listings").insert'), "the SPI link goes through the certified ECL boundary");
  assert.ok(recSlice.includes('identity_type: "snoonu_spi"'), "typed snoonu identity");
  assert.ok(!recSlice.includes("createProductCore"), "reconciliation NEVER creates a product");
  assert.ok(!/from\("products"\)\s*\.insert\(/.test(recSlice), "no product insert of any kind");
  assert.ok(!/update\(\s*\{[\s\S]{0,120}?(sku|barcode)/.test(recSlice), "canonical SKU/barcode are never renamed by reconciliation");
  assert.ok(recSlice.includes("plan.reconciles"), "targets come EXCLUSIVELY from the server-rebuilt plan — no client product id is trusted");
  assert.ok(server.includes("reconciled_existing_count"), "the audit payload records the reconciled count + row detail");
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

test("reconcile 6+7+8 (apply): the placeholder row is UPGRADED IN PLACE — no second ECL row, no product insert, identity preserved", () => {
  const server = read(SERVER);
  const rec = server.slice(server.indexOf("IDENTITY UPGRADE"), server.indexOf("NEW Snoonu products"));
  assert.ok(rec.includes("rec.placeholderMappings.length === 1"), "one placeholder ⇒ in-place upgrade branch");
  assert.ok(/\.update\(\{[\s\S]*?external_product_id: rec\.spi[\s\S]*?identity_type: "snoonu_spi"[\s\S]*?mapping_status: "active"/.test(rec),
    "the SAME row becomes the real SPI listing");
  assert.ok(rec.includes('.eq("external_product_id", rec.placeholderMappings[0])'), "targeted at the exact placeholder row");
  assert.ok(rec.includes('"placeholder drift"'), "a moved/missing placeholder fails closed instead of inserting");
  assert.ok(rec.includes("rec.placeholderMappings.length === 0"), "only a product with NO snoonu mapping gets an insert");
  assert.ok(rec.includes('"ambiguous placeholder set"'), ">1 placeholder fails closed at apply too");
  assert.ok(!rec.includes("createProductCore") && !/from\("products"\)\s*\.insert\(/.test(rec), "no product is ever created");
  assert.ok(!/update\(\s*\{[\s\S]{0,160}?\b(sku|barcode):/.test(rec), "canonical SKU/barcode are never rewritten");
});

test("removal 10+11+12 (apply): ACTIVE stops via the certified transition; DRAFT/STOPPED archive the listing only, and the result says which", () => {
  const server = read(SERVER);
  const rem = server.slice(server.indexOf('"REMOVED FROM SNOONU" means'));
  assert.ok(rem.includes('r.lifecycleState === "ACTIVE"'), "the lifecycle transition is attempted ONLY for ACTIVE products");
  assert.ok(rem.includes('expectedFromState: "ACTIVE"'), "the transition is pinned to the state the plan saw");
  assert.ok(rem.includes("transitionProductLifecycle"), "and it is the certified boundary");
  assert.ok(rem.includes('mapping_status: "archived"'), "every removal archives the snoonu listing");
  assert.ok(rem.includes("أُوقف المنتج (ACTIVE → STOPPED) وأُرشف ربط سنونو"), "explicit ACTIVE outcome message");
  assert.ok(rem.includes("أُرشف ربط سنونو فقط"), "explicit archive-only outcome message naming the lifecycle");
  assert.ok(!rem.includes(".delete("), "never a delete");
});

test("repair preview is read-only and scoped: it re-plans live data and returns only outstanding operations", () => {
  const server = read(SERVER);
  const fn = server.slice(server.indexOf("export async function previewSnoonuRepairPlan"), server.indexOf("export interface SnoonuApplyRowResult"));
  assert.ok(fn.includes("previewSnoonuSyncPlan"), "built from the READ-ONLY preview path");
  assert.ok(fn.includes("selectSnoonuRepairPlan"), "narrowed by the pure repair selector");
  for (const bad of [".insert(", ".update(", ".upsert(", ".delete(", ".rpc("]) {
    assert.ok(!fn.includes(bad), `the repair preview performs no write (${bad})`);
  }
});
