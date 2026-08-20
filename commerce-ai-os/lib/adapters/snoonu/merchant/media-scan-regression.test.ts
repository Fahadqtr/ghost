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

import { discoveryResultToPreviewRow, recoveryOutcomeToApplyResult } from "./recovery-model.ts";
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

test("recovery outcomes map onto the Media Center apply statuses", () => {
  assert.deepEqual(recoveryOutcomeToApplyResult("p1", { status: "RECOVERED", reason: "ok", url: "u" }), { productId: "p1", status: "IMPORTED", url: "u" });
  assert.equal(recoveryOutcomeToApplyResult("p1", { status: "UNCHANGED", reason: "r" }).status, "SKIPPED");
  assert.equal(recoveryOutcomeToApplyResult("p1", { status: "STALE", reason: "r" }).status, "SKIPPED");
  assert.equal(recoveryOutcomeToApplyResult("p1", { status: "NEEDS_REVIEW", reason: "r" }).status, "NEEDS_REVIEW");
  for (const s of ["NO_MATCH", "NO_IMAGE_SOURCE", "SESSION_REQUIRED", "FAILED"] as const) {
    assert.equal(recoveryOutcomeToApplyResult("p1", { status: s, reason: "r" }).status, "FAILED");
  }
});

// ── source guard: the dead CH.6B SPI port is out of the Media Center path ─────
test("batch scan runs the LIVE pipeline — never the hardcoded CH.6B session port", () => {
  const raw = read(SCAN);
  assert.ok(/import\s+["']server-only["']/.test(raw), "server-only");
  assert.ok(/createConfiguredSnoonuDiscoveryProvider\(key\)/.test(raw), "uses the configured live provider (same resolver as Test Connection)");
  assert.ok(/runSnoonuDiscovery\(provider/.test(raw), "invokes the untouched MEDIA.1B engine per candidate");
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
  assert.ok(/recoveryOutcomeToApplyResult\(/.test(s), "outcomes mapped by the pure model");
  assert.equal(/scanSnoonuMissingImages\(|applySnoonuImageImports\(/.test(s), false, "no legacy CH.6B delegation remains");
});
