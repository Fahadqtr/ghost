// MEDIA.1C-HOTFIX2 — Media Center batch-scan regression. The deployed bug:
// Connection Manager = CONNECTED but the Media Center scan reported
// SESSION_REQUIRED for all 59 candidates. Trace: the scan delegated to the
// legacy CH.6B SnoonuMerchantSession SPI port, whose state() is a HARDCODED
// session_required no-op (session.server.ts) — the live discovery provider was
// never invoked and no HTTP request was ever made. These tests pin the rewire.
// node --conditions=react-server --experimental-strip-types --test lib/adapters/snoonu/merchant/media-scan-regression.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { buildRowModeTrace, discoveryResultToPreviewRow, formatModeTraceReason, recoveryOutcomeToApplyResult, unlinkedProductToPreviewRow } from "./recovery-model.ts";
import type { EmittedLookupTrace } from "./recovery-model.ts";
import type { DiscoveryCandidate, DiscoveryResult } from "./discovery-contract.ts";

const ROOT = fileURLToPath(new URL("../../../..", import.meta.url));
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

const SCAN = "lib/adapters/snoonu/merchant/media-scan.server.ts";
const ACTIONS = "app/(v2)/v2/operations/media-actions.ts";

const cand = (over: Partial<DiscoveryCandidate> = {}): DiscoveryCandidate => ({
  storefrontKey: "snoonu:malikas", spi: "SPI-9", name: "P", sku: "mk2245", barcode: "555",
  imageUrl: "https://images.snoonu.com/p/x.jpeg", imageWidth: null, imageHeight: null, ...over,
});

const result = (over: Partial<DiscoveryResult> = {}): DiscoveryResult => ({
  storefrontKey: "snoonu:malikas", sessionState: "authenticated", classification: "SAFE_MATCH",
  matchReason: "exact_barcode", confidence: "high", candidates: [cand()], candidateCount: 1, error: null, ...over,
});

const product = { id: "p1", sku: "mk2245", barcode: "555" };

// ── pure mapping: live discovery → the Media Center's existing row shape ──────
test("SAFE_MATCH with a source image → MATCHED and selectable (bulk-eligible)", () => {
  const row = discoveryResultToPreviewRow(product, result());
  assert.equal(row.matchStatus, "MATCHED");
  assert.equal(row.selectable, true);
  assert.equal(row.spi, "SPI-9");
  assert.equal(row.merchantImageUrl, "https://images.snoonu.com/p/x.jpeg");
  assert.equal(row.provenance.internalProductId, "p1");
  assert.equal(row.provenance.confidence, "high");
});

test("ambiguous / name / no-image / error results are NEVER selectable", () => {
  const review = discoveryResultToPreviewRow(product, result({ classification: "NEEDS_REVIEW", matchReason: "contains_name" }));
  assert.equal(review.matchStatus, "NEEDS_REVIEW");
  assert.equal(review.selectable, false);
  const noImg = discoveryResultToPreviewRow(product, result({ candidates: [cand({ imageUrl: null })] }));
  assert.equal(noImg.matchStatus, "NEEDS_REVIEW", "SAFE identity without a source image needs review");
  assert.equal(noImg.selectable, false);
  const err = discoveryResultToPreviewRow(product, result({ classification: "ERROR", matchReason: "error", candidates: [] }));
  assert.equal(err.matchStatus, "NEEDS_REVIEW");
  assert.equal(err.selectable, false);
});

test("NO_MATCH → NOT_FOUND; SESSION_REQUIRED stays truthful", () => {
  const none = discoveryResultToPreviewRow(product, result({ classification: "NO_MATCH", matchReason: "no_match", candidates: [] }));
  assert.equal(none.matchStatus, "NOT_FOUND");
  const sess = discoveryResultToPreviewRow(product, result({ classification: "SESSION_REQUIRED", matchReason: "session_required", sessionState: "session_required", candidates: [] }));
  assert.equal(sess.matchStatus, "SESSION_REQUIRED");
});

test("no active storefront SPI → UNLINKED and never selectable", () => {
  const row = unlinkedProductToPreviewRow(product, "snoonu:malikas");
  assert.equal(row.matchStatus, "UNLINKED");
  assert.equal(row.selectable, false);
  assert.equal(row.spi, null);
  assert.match(row.reason, /غير مرتبط/);
});

test("recovery outcomes map onto the Media Center apply statuses", () => {
  assert.deepEqual(recoveryOutcomeToApplyResult("p1", { status: "RECOVERED", reason: "ok", url: "u" }), { productId: "p1", status: "IMPORTED", url: "u" });
  assert.equal(recoveryOutcomeToApplyResult("p1", { status: "UNCHANGED", reason: "r" }).status, "SKIPPED");
  assert.equal(recoveryOutcomeToApplyResult("p1", { status: "STALE", reason: "r" }).status, "SKIPPED");
  assert.equal(recoveryOutcomeToApplyResult("p1", { status: "NEEDS_REVIEW", reason: "r" }).status, "NEEDS_REVIEW");
  for (const s of ["NO_MATCH", "NO_IMAGE_SOURCE", "SESSION_REQUIRED", "FAILED"] as const) {
    assert.equal(recoveryOutcomeToApplyResult("p1", { status: s, reason: "r" }).status, "FAILED");
  }
});

// ── HOTFIX3: per-mode evidence on batch-scan rows (attempted/transport/raw/exact) ─
test("mode trace: attributes emitted lookups per candidate; unreached/empty modes are attempted:false", () => {
  const emitted: EmittedLookupTrace[] = [
    { mode: "barcode", term: "555", read: "ok", rawCount: 2, exactCount: 0 },
    { mode: "sku", term: "mk2245", read: "unauthorized", rawCount: 0, exactCount: 0 },
    { mode: "name", term: "P", read: "ok", rawCount: 5, exactCount: 1 },
    { mode: "barcode", term: "OTHER", read: "ok", rawCount: 9, exactCount: 9 }, // another candidate's lookup
  ];
  const t = buildRowModeTrace({ barcode: "555", sku: "mk2245", name: "P" }, emitted);
  assert.deepEqual(t, [
    { mode: "barcode", attempted: true, read: "ok", rawCount: 2, exactCount: 0 },
    { mode: "sku", attempted: true, read: "unauthorized", rawCount: 0, exactCount: 0 },
    { mode: "name", attempted: true, read: "ok", rawCount: 5, exactCount: 1 },
  ]);
  // no barcode on the product → attempted:false; engine short-circuit (no name emit) → attempted:false
  const t2 = buildRowModeTrace({ barcode: null, sku: "mk2245", name: "P" }, emitted.slice(1, 2));
  assert.deepEqual(t2.map((m) => [m.mode, m.attempted, m.read]), [
    ["barcode", false, "skipped"],
    ["sku", true, "unauthorized"],
    ["name", false, "skipped"],
  ]);
});

test("mode trace is exposed on the row and summarized in the visible reason", () => {
  const trace = buildRowModeTrace({ barcode: "555", sku: "mk2245", name: "P" }, [
    { mode: "barcode", term: "555", read: "ok", rawCount: 2, exactCount: 0 },
    { mode: "sku", term: "mk2245", read: "ok", rawCount: 3, exactCount: 0 },
    { mode: "name", term: "P", read: "ok", rawCount: 5, exactCount: 1 },
  ]);
  const row = discoveryResultToPreviewRow(product, result({ classification: "NEEDS_REVIEW", matchReason: "exact_name" }), trace);
  assert.deepEqual(row.modeTrace, trace, "structured per-mode evidence on the row");
  const suffix = formatModeTraceReason(trace);
  assert.ok(row.reason.endsWith(suffix), "reason carries the compact per-mode summary");
  assert.ok(/باركود: نجح خام 2 تام 0/.test(suffix) && /SKU: نجح خام 3 تام 0/.test(suffix) && /اسم: نجح خام 5 تام 1/.test(suffix));
  // classification is still the engine's combined 3-mode outcome, not per-mode
  assert.equal(row.matchStatus, "NEEDS_REVIEW");
});

// ── source guard: the dead CH.6B SPI port is out of the Media Center path ─────
test("batch scan runs the LIVE pipeline — never the hardcoded CH.6B session port", () => {
  const raw = read(SCAN);
  assert.ok(/import\s+["']server-only["']/.test(raw), "server-only");
  assert.ok(/createConfiguredSnoonuDiscoveryProvider\(key,/.test(raw), "uses the configured live provider (same resolver as Test Connection), with the trace hook");
  assert.ok(/buildRowModeTrace\(/.test(raw), "rows carry per-mode evidence (attempted/transport/raw/exact)");
  assert.ok(/runSnoonuDiscovery\(provider/.test(raw), "invokes the untouched MEDIA.1B engine per candidate");
  assert.ok(/\.from\("external_channel_listings"\)/.test(raw), "reads the certified identity table before portal discovery");
  assert.ok(/\.eq\("storefront_key", storefrontKey\)/.test(raw), "identity scope is the exact Snoonu storefront");
  assert.ok(/\.eq\("mapping_status", "active"\)/.test(raw), "only active mappings are eligible");
  assert.ok(/\.not\("external_product_id", "is", null\)/.test(raw), "an actual SPI is required");
  assert.ok(/barcode:\s*c\.barcode/.test(raw), "every row keeps barcode as the first search identity");
  assert.ok(/sku:\s*c\.sku/.test(raw), "every row keeps SKU as the second search identity");
  assert.ok(/name:\s*c\.name/.test(raw), "every row falls through to name discovery");
  assert.ok(/"SAFE_MATCH"\s*\|\|\s*result\?\.classification\s*===\s*"NEEDS_REVIEW"/.test(raw), "positive barcode/SKU/name evidence is surfaced");
  assert.ok(/unlinkedProductToPreviewRow/.test(raw), "unlinked misses remain reported separately");
  const s = strip(raw);
  assert.equal(/createSnoonuMerchantSession|findListingBySpi|image-recovery\.server/.test(s), false, "legacy SPI port not used");
  for (const bad of [/\.insert\(/, /\.update\(/, /\.upsert\(/, /\.delete\(/, /\.rpc\(/, /\bfetch\(/, /storePrimaryProductImage/, /console\./, /process\.env/]) {
    assert.equal(bad.test(s), false, `${SCAN} must not contain ${bad}`);
  }
  // ONE provider per scan: the memoized session probe runs at most once
  assert.equal((raw.match(/createConfiguredSnoonuDiscoveryProvider\(/g) ?? []).length, 1, "single provider instance per scan");
});

test("Media Center actions delegate ONLY to the live scan + MEDIA.1C recovery", () => {
  const s = strip(read(ACTIONS));
  assert.ok(/scanSnoonuMissingImagesLive\(/.test(s), "scan → live discovery batch");
  assert.ok(/recoverSnoonuImage\(\{\s*productId:/.test(s), "apply → MEDIA.1C orchestrator per item");
  // MEDIA.2: the bulk loop moved client-side (live progress + cancel after the
  // current product); the action recovers exactly ONE product per call and
  // returns the RecoveryOutcome unmapped (the pure bulk model aggregates it).
  assert.equal((s.match(/recoverSnoonuImage\(/g) ?? []).length, 1, "exactly one recovery call site — one product per action call");
  assert.equal(/scanSnoonuMissingImages\(|applySnoonuImageImports\(/.test(s), false, "no legacy CH.6B delegation remains");
});
