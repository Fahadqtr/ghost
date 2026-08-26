// RAFEEQ.FULLSYNC.1 — file-sync workflow guard (source scan). Proves:
//   • pending-NEW is delivery-derived: never products.created_at, never the
//     legacy per-store id column, never ECL identity presence as the signal
//   • sent state is EXPLICIT: generation/recording never writes sent_at; only
//     the owner mark-as-sent action does (and only once — sent_at IS NULL)
//   • the owner boundary gates mark-as-sent and the returned-file apply; the
//     writer boundary gates generation + preview
//   • the fullsync generator keeps the certified order (collision + integrity
//     BEFORE the zip) and performs no direct DB write (recording lives in the
//     dedicated server boundary, called by the route)
//   • reconciliation matches by SKU/barcode ONLY — no title/name evidence, no
//     fuzzy matching (§16); the apply plan is re-derived server-side and ECL
//     writes stay storefront-scoped to rafeeq:malikas
//   • no Rafeeq API publish anywhere in the workflow
//   • the additive migration ships the durable model (NOT auto-applied)
// node --conditions=react-server --experimental-strip-types --test lib/export/rafeeq/rafeeq-fullsync-guard.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
// Strip //-line and /*…*/ comments so documentation sentences never trip a scan.
const code = (rel: string) => read(rel).replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, "");

const FULLSYNC = "lib/export/rafeeq/fullsync.ts";
const RECONCILE = "lib/export/rafeeq/reconcile.ts";
const SERVER = "lib/rafeeq/fullsync.server.ts";
const GEN = "lib/rafeeq/package.server.ts";
const JOB_SERVER = "lib/rafeeq/package-job.server.ts";
const ROUTE = "app/api/export/rafeeq/package/route.ts";
const ACTIONS = "app/(v2)/v2/export/rafeeq-fullsync-actions.ts";
const COMPONENT = "components/v2/export/RafeeqFullSync.tsx";
const MIGRATION = "supabase/migrations/20260824100000_rafeeq_fullsync_packages.sql";
const MIGRATION2 = "supabase/migrations/20260824130000_rafeeq_fullsync_variant_grain.sql";
const ALL = [FULLSYNC, RECONCILE, SERVER, GEN, ROUTE, ACTIONS, COMPONENT];

// ── pending is delivery-derived, never identity/created_at ────────────────────
test("pending-NEW never reads products.created_at or the legacy per-store id column", () => {
  for (const f of ALL) {
    assert.equal(code(f).includes("rafeeq_product_id"), false, `${f} must not reference the legacy id column`);
  }
  const fullsync = code(FULLSYNC);
  assert.equal(/created_at/.test(fullsync), false, "pending logic must not consult created_at");
  // the derivation is the SENT PRODUCT baseline (fingerprints), not identity evidence
  assert.ok(/if \(!isFullIncludable\(r\)\) continue;/.test(fullsync), "pending filters on FULL-includability");
  assert.ok(/pendingKindOf\(r, baseline\)/.test(fullsync), "pending kind derives from the sent baseline");
  assert.equal(/rafeeqId\s*[!=]==?\s*null/.test(fullsync.match(/export function pendingRows[\s\S]*?\n}/)?.[0] ?? ""), false,
    "pendingRows must not branch on ECL identity");
  assert.equal(/rafeeqId/.test(fullsync.match(/export function pendingKindOf[\s\S]*?\n}/)?.[0] ?? ""), false,
    "pendingKindOf must not branch on ECL identity");
});

// ── explicit sent state ───────────────────────────────────────────────────────
test("generation/recording never writes sent state; only the owner action does, exactly once", () => {
  assert.equal(code(GEN).includes("sent_at"), false, "the generator never touches sent state");
  const server = read(SERVER);
  assert.ok(/sent_at:\s*null/.test(server), "recording a package stores sent_at = NULL (Generated — not sent)");
  assert.ok(/markRafeeqPackageSent/.test(server), "the explicit mark-as-sent operation exists");
  assert.ok(/\.is\("sent_at", null\)/.test(server), "mark-as-sent only stamps a package not yet sent");
  const sentWrites = server.match(/update\(\{ sent_at/g) ?? [];
  assert.equal(sentWrites.length, 1, "exactly ONE code path writes sent_at");
  // RAFEEQ.PKGJOB: recording moved with generation into the job layer — the
  // finalize step records the package (once, after the artifact is committed);
  // the legacy route and the job layer still never mark anything sent.
  const jobServer = code(JOB_SERVER);
  assert.ok(/recordRafeeqPackage\(/.test(jobServer), "the job layer records the generated package");
  assert.equal(/markRafeeqPackageSent|sent_at/.test(jobServer), false, "the job layer never writes sent state");
  const route = code(ROUTE);
  assert.equal(/markRafeeqPackageSent|sent_at/.test(route), false, "route never writes sent state");
});

// ── auth boundaries ───────────────────────────────────────────────────────────
test("owner gates mark-as-sent + apply; writer gates generation + preview", () => {
  const actions = read(ACTIONS);
  const markSrc = actions.slice(actions.indexOf("export async function markPackageSentAction"), actions.indexOf("export interface ReturnedPreviewVM"));
  assert.ok(/requireOwner\(\)/.test(markSrc) && markSrc.indexOf("requireOwner()") < markSrc.indexOf("markRafeeqPackageSent("), "mark-as-sent is OWNER-gated before the write");
  const applySrc = actions.slice(actions.indexOf("export async function applyReturnedFileAction"));
  assert.ok(/requireOwner\(\)/.test(applySrc) && applySrc.indexOf("requireOwner()") < applySrc.indexOf("applyRafeeqReturnedIds("), "apply is OWNER-gated before the write");
  const previewSrc = actions.slice(actions.indexOf("export async function previewReturnedFileAction"), actions.indexOf("export type ApplyReturnedActionResult"));
  assert.ok(/requireMalakWriter\(\)/.test(previewSrc), "preview is writer-gated");
  const route = read(ROUTE);
  assert.ok(/requireMalakWriter\(\)/.test(route) && /if \(!writer\.ok\)/.test(route), "generation stays writer-gated");
});

// ── generator: certified order, no direct DB writes, honest NEW refusal ───────
test("the fullsync generator keeps collision+integrity before the zip and performs no direct DB write", () => {
  const gen = read(GEN);
  const fs = gen.slice(gen.indexOf("export async function generateRafeeqFullSyncPackage"));
  const collisionAt = fs.indexOf("detectFilenameCollisions(");
  const integrityAt = fs.indexOf("checkReferentialIntegrity(");
  const zipAt = fs.indexOf("buildZip(");
  assert.ok(collisionAt > -1 && collisionAt < zipAt, "collision checked before the zip (fullsync path)");
  assert.ok(integrityAt > -1 && integrityAt < zipAt, "integrity checked before the zip (fullsync path)");
  for (const re of [/\.insert\(/, /\.update\(/, /\.upsert\(/, /\.delete\(/, /\.rpc\(/]) {
    assert.equal(re.test(gen), false, `generator must not ${re} (recording lives in fullsync.server)`);
  }
  assert.ok(/loadRafeeqPreview\(\)/.test(fs), "fullsync package derives from the certified preview");
  assert.ok(/resolveFullSyncSet\(/.test(fs), "selection via the pure fullsync plan");
  // RAFEEQ.PKGJOB: FULL/NEW generation now starts through the job layer — the
  // honest NEW refusal (no readable sent-state ⇒ refuse, never guess) lives
  // there, and the legacy route refuses fullsync modes toward the job flow.
  const jobServer = read(JOB_SERVER);
  assert.ok(/input\.mode === "NEW" && delivery\.availability === "UNAVAILABLE"/.test(jobServer), "NEW requires the durable sent-state");
  assert.ok(/503/.test(jobServer));
  const route = read(ROUTE);
  assert.ok(/"use_jobs"/.test(route), "the legacy route routes fullsync modes to the job flow");
});

// ── reconciliation: SKU/barcode only, no fuzzy/title matching (§16) ───────────
test("16: reconciliation carries no title/name evidence and no fuzzy matching", () => {
  for (const f of [FULLSYNC, RECONCILE, SERVER]) {
    const s = code(f);
    for (const re of [/levenshtein/i, /fuzzy/i, /similarity/i]) {
      assert.equal(re.test(s), false, `${f} must not fuzzy-match (${re})`);
    }
  }
  const recon = code(RECONCILE);
  for (const re of [/\btitle\b/, /\btitleAr\b/, /\bnameEn\b/, /\bnameAr\b/, /name_en/, /name_ar/]) {
    assert.equal(re.test(recon), false, `reconcile must not read titles (${re})`);
  }
  const server = read(SERVER);
  assert.equal(/name_en|name_ar/.test(server), false, "the evidence loader never selects product names");
  assert.ok(/select\("id, sku, barcode"\)|"id, sku, barcode"/.test(server), "catalog evidence is id + sku + barcode only");
});

// ── apply: re-derived server-side, storefront-scoped ECL writes only ──────────
test("the apply plan is re-derived server-side and every ECL write is storefront-scoped", () => {
  const server = read(SERVER);
  const apply = server.slice(server.indexOf("export async function applyRafeeqReturnedIds"));
  assert.ok(/previewRafeeqReturnedIds\(bytes\)/.test(apply), "apply re-derives the plan from the uploaded bytes");
  assert.ok(/storefront_key: RAFEEQ_STOREFRONT_KEY/.test(apply), "inserts pin the rafeeq storefront");
  assert.ok(/\.eq\("storefront_key", RAFEEQ_STOREFRONT_KEY\)/.test(apply), "updates are storefront-scoped");
  assert.ok(/storefrontByKey\(RAFEEQ_STOREFRONT_KEY\)/.test(server), "identity type comes from the certified registry");
  // the actions layer never accepts a client-computed plan
  const actions = read(ACTIONS);
  assert.equal(/apply\w*\(.*plan/i.test(actions), false, "no plan payload crosses the client boundary");
});

// ── no Rafeeq API publish anywhere ────────────────────────────────────────────
test("no Rafeeq API publish exists anywhere in the workflow", () => {
  for (const f of ALL) {
    const s = read(f);
    assert.equal(/\.publish\(|publishToRafeeq|rafeeqApi|api\.rafeeq/i.test(s), false, `${f} must not publish to Rafeeq`);
  }
});

// ── the component holds no DB access ──────────────────────────────────────────
test("the fullsync component holds no DB/service-role access", () => {
  const c = read(COMPONENT);
  for (const bad of [/createAdminClient/, /createClient\(/, /@\/lib\/supabase/, /\.from\(/]) {
    assert.equal(bad.test(c), false, `component must not contain ${bad}`);
  }
});

// ── the durable model ships as an additive, guarded migration ─────────────────
test("the migration defines the durable package/sent-state model (additive, not auto-applied)", () => {
  const m = read(MIGRATION);
  assert.ok(/CREATE TABLE IF NOT EXISTS public\.rafeeq_packages/.test(m));
  assert.ok(/CREATE TABLE IF NOT EXISTS public\.rafeeq_package_items/.test(m));
  assert.ok(/sent_at\s+timestamptz/.test(m), "sent_at is nullable timestamptz (NULL = not sent)");
  assert.ok(/CHECK \(mode = ANY \(ARRAY\['FULL','NEW'\]\)\)/.test(m));
  assert.ok(/ENABLE ROW LEVEL SECURITY/.test(m));
  assert.ok(/NOT APPLIED AUTOMATICALLY/.test(m));
  assert.equal(/DROP TABLE|ALTER TABLE public\.products|DELETE FROM/i.test(m), false, "purely additive");
});

// ── FULLSYNC.2 — sellable (variant-aware) durable grain ───────────────────────
test("the variant-grain migration adds sellable item identity + superseded surfacing (additive)", () => {
  const m = read(MIGRATION2);
  assert.ok(/ALTER TABLE public\.rafeeq_package_items\s+ADD COLUMN IF NOT EXISTS variant_id uuid/.test(m), "items gain nullable variant_id");
  assert.ok(/rafeeq_package_items_sellable_uk[\s\S]*COALESCE\(variant_id::text, ''\)/.test(m), "sellable uniqueness (package, product, variant)");
  assert.ok(/ADD COLUMN IF NOT EXISTS superseded_at timestamptz/.test(m), "packages gain superseded_at");
  assert.ok(/NOT APPLIED AUTOMATICALLY/.test(m));
  assert.equal(/DROP TABLE|ALTER TABLE public\.products|DELETE FROM/i.test(m), false, "no destructive change beyond the replaced unique index");
});

test("recording carries the delivery fingerprint and supersedes only prior UNSENT FULL packages", () => {
  const server = read(SERVER);
  assert.ok(/row_fingerprint: it\.fingerprint/.test(server), "item rows record the delivery fingerprint");
  assert.ok(/row_fingerprint/.test(server.match(/const itemColumns[\s\S]*?;/)?.[0] ?? ""), "the baseline reader loads the recorded fingerprint");
  const sup = server.slice(server.indexOf("// Supersede prior UNSENT FULL packages"));
  assert.ok(/\.is\("sent_at", null\)/.test(sup), "supersede never touches a SENT package");
  assert.ok(/\.is\("superseded_at", null\)/.test(sup), "supersede stamps once");
  assert.equal(/\.delete\(/.test(server), false, "history is never deleted");
});

test("returned-id apply is PARENT-PRODUCT-scoped (options never get their own external identity)", () => {
  const server = read(SERVER);
  const apply = server.slice(server.indexOf("export async function applyRafeeqReturnedIds"));
  assert.ok(/variant_id: null/.test(apply), "inserts are product-level (variant_id NULL)");
  assert.ok(/\.is\("variant_id", null\)/.test(apply), "updates touch only the product-level row");
  assert.equal(/\.eq\("variant_id", a\.variantId\)/.test(apply), false, "no per-variant identity writes remain");
});
