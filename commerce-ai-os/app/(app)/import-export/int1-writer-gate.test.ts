// INT.1 — Integration Security Closure: writer-authorization wiring guarantees.
//
// Every MUTATING server action under app/(app)/import-export must call
// requireMalakWriter() BEFORE any DB write or external side effect, so the gate
// cannot be bypassed by invoking the action directly. Read-only diagnostics stay
// on the lighter session gate (not silently escalated); snapshot captures stay
// OWNER-only; the Talabat webhook stays token-authenticated (documented
// exception). This is a source-scan test (the actions import `server-only` +
// `@/…`), matching the repo's owner-only-actions.test.ts style. INT.1 changes
// authorization only — it adds no schema, migration, or route.
// Run: node --conditions=react-server --experimental-strip-types --test "app/(app)/import-export/int1-writer-gate.test.ts"

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

/** Slice a single `export async function NAME(` body up to the next top-level export. */
function fnBody(src: string, name: string): string {
  const start = src.indexOf(`export async function ${name}(`);
  assert.notEqual(start, -1, `function ${name} not found`);
  const rest = src.slice(start + 1);
  const next = rest.indexOf("\nexport ");
  return next === -1 ? src.slice(start) : src.slice(start, start + 1 + next);
}

// Tokens that begin a DB write or an external channel side effect — the writer
// gate must appear before ALL of them.
const SIDE_EFFECT = [
  ".from(", ".upsert(", ".update(", ".insert(", ".delete(", ".rpc(", "createAdminClient(",
  "setInventoryQuantities(", "updateVariantPrice(", "updateShopifyProductContent(",
  "createShopifyProduct(", "addProductImage(", "createProductCore(", "createProductsBatchCore(",
  "storePrimaryProductImage",
];

function firstSideEffectIdx(body: string): number {
  let min = Infinity;
  for (const tok of SIDE_EFFECT) {
    const i = body.indexOf(tok);
    if (i !== -1 && i < min) min = i;
  }
  return min;
}

const AVAIL = "app/(app)/import-export/availability-actions.ts";
const PURESEOUL = "app/(app)/import-export/pure-seoul-actions.ts";
const SHOPIFY = "app/(app)/import-export/shopify-actions.ts";
const SNOONU = "app/(app)/import-export/snoonu-actions.ts";
const TALABAT = "app/(app)/import-export/talabat-actions.ts";
const IMAGE_UPLOAD = "components/ImageUpload.tsx";
const IMAGE_ACTIONS = "app/(app)/products/image-actions.ts";
const WEBHOOK = "app/api/webhooks/talabat/[token]/route.ts";

// Every mutating action → (file, fn). All must be writer-gated before side effects.
const MUTATING: Array<[string, string]> = [
  // INT.1 closures (were login-only):
  [AVAIL, "applyReconciledAvailability"],
  [AVAIL, "applyReconciledToShopify"],
  [AVAIL, "applySystemOutOfStockToShopify"],
  [PURESEOUL, "setPureSeoulApproval"],
  [PURESEOUL, "applyPureSeoulAvailability"],
  // Pre-existing writer gates (verified still correct):
  [PURESEOUL, "setPureSeoulIds"],
  [PURESEOUL, "addPureSeoulNewProducts"],
  [SHOPIFY, "applyShopifyPrices"],
  [SHOPIFY, "applyShopifyContent"],
  [SHOPIFY, "syncShopifyInventory"],
  [SHOPIFY, "pushProductsToShopify"],
  [SHOPIFY, "importShopifyProducts"],
  [SHOPIFY, "pushShopifyImages"],
  [SNOONU, "applySnoonuUpdates"],
  [SNOONU, "addSnoonuNewProducts"],
  [TALABAT, "markTalabatSent"],
  [TALABAT, "verifyCatalogEntries"],
];

// ── every mutating action is writer-gated before any side effect ──────────────
test("every mutating import-export action calls requireMalakWriter before any write", () => {
  const cache = new Map<string, string>();
  const src = (f: string) => cache.get(f) ?? (cache.set(f, read(f)), cache.get(f)!);
  for (const [file, fn] of MUTATING) {
    const body = fnBody(src(file), fn);
    const gate = body.indexOf("requireMalakWriter");
    assert.notEqual(gate, -1, `${fn} (${file}) must call requireMalakWriter`);
    const se = firstSideEffectIdx(body);
    assert.ok(gate < se, `${fn} (${file}) must gate BEFORE its first side effect (gate@${gate} < write@${se})`);
  }
});

// ── the INT.1 closures specifically no longer accept a login-only caller ──────
test("INT.1 closures are writer-gated (not the old login-only getUser/isSignedIn check)", () => {
  const avail = read(AVAIL);
  for (const fn of ["applyReconciledAvailability", "applyReconciledToShopify", "applySystemOutOfStockToShopify"]) {
    const body = fnBody(avail, fn);
    assert.ok(/requireMalakWriter/.test(body), `${fn} writer-gated`);
    assert.ok(!/auth\.getUser\(\)/.test(body), `${fn} no longer relies on a login-only getUser gate`);
  }
  const ps = read(PURESEOUL);
  for (const fn of ["setPureSeoulApproval", "applyPureSeoulAvailability"]) {
    const body = fnBody(ps, fn);
    assert.ok(/requireMalakWriter/.test(body), `${fn} writer-gated`);
    assert.ok(!/isSignedIn\(\)/.test(body), `${fn} no longer relies on a login-only isSignedIn gate`);
  }
});

// ── rejectPureSeoulProducts inherits the gate by delegating to the gated writer ─
test("rejectPureSeoulProducts is protected via delegation to setPureSeoulApproval", () => {
  const body = fnBody(read(PURESEOUL), "rejectPureSeoulProducts");
  assert.ok(/setPureSeoulApproval\(/.test(body), "delegates to the gated setPureSeoulApproval");
  assert.equal(firstSideEffectIdx(body), Infinity, "performs no direct write of its own");
});

// ── read-only diagnostics are NOT escalated (behavior unchanged) ──────────────
test("read-only actions remain on the session gate (not writer-escalated)", () => {
  const readOnly: Array<[string, string]> = [
    [AVAIL, "reconcileAvailabilityAction"],
    [SHOPIFY, "computeShopifyDiff"],
    [SHOPIFY, "listShopifyMissingImages"],
    [SNOONU, "snoonuFillCodes"],
    [SNOONU, "computeSnoonuDiff"],
    [TALABAT, "computeTalabatDiff"],
    [TALABAT, "buildTalabatPackage"],
    [PURESEOUL, "comparePureSeoul"],
    [PURESEOUL, "getPureSeoulRejected"],
  ];
  const cache = new Map<string, string>();
  const src = (f: string) => cache.get(f) ?? (cache.set(f, read(f)), cache.get(f)!);
  for (const [file, fn] of readOnly) {
    const body = fnBody(src(file), fn);
    assert.ok(!/requireMalakWriter/.test(body), `${fn} stays read-only (not writer-gated)`);
  }
});

// ── snapshot captures remain OWNER-only (§7) ──────────────────────────────────
test("snapshot capture actions remain owner-gated", () => {
  for (const [file, fn] of [
    ["app/(app)/import-export/pure-seoul-snapshot-actions.ts", "capturePureSeoulSnapshots"],
    ["app/(app)/import-export/talabat-snapshot-actions.ts", "captureTalabatSnapshotsAction"],
    ["app/(app)/import-export/rafeeq-snapshot-actions.ts", "captureRafeeqSnapshotsAction"],
  ] as const) {
    assert.ok(/requireOwner\(\)/.test(fnBody(read(file), fn)), `${fn} owner-gated`);
  }
});

// ── the Talabat webhook stays token-authenticated (documented exception) ──────
test("Talabat webhook is token-authenticated, not writer-gated", () => {
  const src = read(WEBHOOK);
  assert.ok(/TALABAT_WEBHOOK_TOKEN|constantTimeEqual|handleTalabatWebhookPost/.test(src), "token-authenticated webhook");
  assert.ok(!/requireMalakWriter/.test(src), "webhook does not use the writer gate (external caller)");
});

// ── ImageUpload no longer has an ungated browser write; routes through imageStore ─
test("ImageUpload routes through the certified writer-gated server action (no duplicate write path)", () => {
  const src = read(IMAGE_UPLOAD);
  assert.ok(/uploadProductImage/.test(src), "calls the certified uploadProductImage server action");
  assert.ok(!/@\/lib\/supabase\/client/.test(src), "no browser Supabase client import");
  assert.ok(!/storage\s*\.\s*from\(|\.upload\(/.test(src), "no browser Storage upload");
  assert.ok(!/from\("product_images"\)|from\('product_images'\)/.test(src), "no raw product_images insert from the browser");
  // and the server action it now uses is itself writer-gated via imageStore
  const action = fnBody(read(IMAGE_ACTIONS), "uploadProductImage");
  assert.ok(/requireMalakWriter/.test(action) && /storePrimaryProductImage/.test(action), "server action is writer-gated + imageStore-backed");
});

// ── §9 guard: INT.1 adds no schema / migration wiring in the touched files ─────
// (Note: availability/pure-seoul carry a PRE-EXISTING operator-hint STRING that
// mentions "alter table … availability" — that is help text shown to the owner,
// not schema this phase executes. The guard therefore targets migration wiring
// and DDL executed via rpc, which must be absent.)
test("INT.1 touched files add no migration wiring (authorization-only)", () => {
  for (const f of [AVAIL, PURESEOUL, IMAGE_UPLOAD]) {
    const s = read(f);
    assert.equal(/apply_migration/i.test(s), false, `${f} runs no migration`);
    assert.equal(/\.rpc\(\s*["'`]?(create|alter|drop)\s+/i.test(s), false, `${f} executes no DDL via rpc`);
  }
});

// ── §6/§8 legacy workflow unchanged: only auth changed, not the write logic ────
test("availability + pure-seoul write logic is unchanged (only the gate was added)", () => {
  const avail = fnBody(read(AVAIL), "applyReconciledAvailability");
  assert.ok(/platform_status/.test(avail) && /"OutOfStock"/.test(avail) && /"InStock"/.test(avail), "same platform_status availability write");
  const ps = fnBody(read(PURESEOUL), "applyPureSeoulAvailability");
  assert.ok(/platform_status/.test(ps) && /"OutOfStock"/.test(ps) && /"InStock"/.test(ps), "same PS platform_status availability write");
});
