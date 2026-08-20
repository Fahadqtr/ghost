// MEDIA.1C — recovery decision model unit tests (pure).
// node --conditions=react-server --experimental-strip-types --test lib/adapters/snoonu/merchant/recovery-model.test.ts

import test from "node:test";
import assert from "node:assert/strict";

import { decideSnoonuRecovery, RECOVERY_STATUS_LABEL, type RecoveryDecisionInput } from "./recovery-model.ts";
import type { DiscoveryCandidate } from "./discovery-contract.ts";

const cand = (over: Partial<DiscoveryCandidate> = {}): DiscoveryCandidate => ({
  storefrontKey: "snoonu:malikas",
  spi: "SPI-1",
  name: "COSRX Snail Mucin",
  sku: "mk2001",
  barcode: "8801234567890",
  imageUrl: "https://images.snoonu.com/product/2026-5/a.jpeg",
  imageWidth: null,
  imageHeight: null,
  ...over,
});

const base = (over: Partial<RecoveryDecisionInput> = {}): RecoveryDecisionInput => ({
  hasPrimaryImage: false,
  sessionConnected: true,
  classification: "SAFE_MATCH",
  candidates: [cand()],
  confirmedSpi: null,
  ...over,
});

test("SAFE_MATCH (exact barcode/SKU identity) recovers on one confirm", () => {
  const d = decideSnoonuRecovery(base());
  assert.ok(d.allow);
  if (d.allow) assert.equal(d.candidate.spi, "SPI-1");
});

test("SAFE_MATCH with the previewed SPI pinned: match → allow, mismatch → STALE", () => {
  assert.ok(decideSnoonuRecovery(base({ confirmedSpi: "SPI-1" })).allow);
  const stale = decideSnoonuRecovery(base({ confirmedSpi: "SPI-OLD" }));
  assert.ok(!stale.allow && stale.status === "STALE");
});

test("session not CONNECTED → SESSION_REQUIRED, dominates everything", () => {
  const d = decideSnoonuRecovery(base({ sessionConnected: false }));
  assert.ok(!d.allow && d.status === "SESSION_REQUIRED");
});

test("a product that already has a primary image is NEVER overwritten → UNCHANGED", () => {
  const d = decideSnoonuRecovery(base({ hasPrimaryImage: true }));
  assert.ok(!d.allow && d.status === "UNCHANGED");
  // even with an explicit confirmation
  const d2 = decideSnoonuRecovery(base({ hasPrimaryImage: true, confirmedSpi: "SPI-1" }));
  assert.ok(!d2.allow && d2.status === "UNCHANGED");
});

test("NEEDS_REVIEW (name-only / ambiguous) NEVER auto-recovers — explicit selection required", () => {
  const nameOnly = decideSnoonuRecovery(base({ classification: "NEEDS_REVIEW" }));
  assert.ok(!nameOnly.allow && nameOnly.status === "NEEDS_REVIEW");
  const multi = decideSnoonuRecovery(base({
    classification: "NEEDS_REVIEW",
    candidates: [cand(), cand({ spi: "SPI-2" })],
  }));
  assert.ok(!multi.allow && multi.status === "NEEDS_REVIEW", "multiple candidates also require review");
});

test("NEEDS_REVIEW with an explicit operator-selected SPI recovers that exact candidate", () => {
  const d = decideSnoonuRecovery(base({
    classification: "NEEDS_REVIEW",
    candidates: [cand(), cand({ spi: "SPI-2", imageUrl: "https://images.snoonu.com/p/b.jpeg" })],
    confirmedSpi: "SPI-2",
  }));
  assert.ok(d.allow);
  if (d.allow) assert.equal(d.candidate.spi, "SPI-2");
});

test("NEEDS_REVIEW: selected candidate vanished from the FRESH result → STALE", () => {
  const d = decideSnoonuRecovery(base({ classification: "NEEDS_REVIEW", confirmedSpi: "SPI-GONE" }));
  assert.ok(!d.allow && d.status === "STALE");
});

test("a match without a source image → NO_IMAGE_SOURCE (safe and confirmed alike)", () => {
  const safe = decideSnoonuRecovery(base({ candidates: [cand({ imageUrl: null })] }));
  assert.ok(!safe.allow && safe.status === "NO_IMAGE_SOURCE");
  const review = decideSnoonuRecovery(base({
    classification: "NEEDS_REVIEW",
    candidates: [cand({ imageUrl: "  " })],
    confirmedSpi: "SPI-1",
  }));
  assert.ok(!review.allow && review.status === "NO_IMAGE_SOURCE");
});

test("SAFE_MATCH whose candidate vanished → STALE; NO_MATCH / ERROR / SESSION_REQUIRED map to their states", () => {
  const gone = decideSnoonuRecovery(base({ candidates: [] }));
  assert.ok(!gone.allow && gone.status === "STALE");
  const none = decideSnoonuRecovery(base({ classification: "NO_MATCH", candidates: [] }));
  assert.ok(!none.allow && none.status === "NO_MATCH");
  const err = decideSnoonuRecovery(base({ classification: "ERROR", candidates: [] }));
  assert.ok(!err.allow && err.status === "FAILED");
  const sess = decideSnoonuRecovery(base({ classification: "SESSION_REQUIRED", candidates: [] }));
  assert.ok(!sess.allow && sess.status === "SESSION_REQUIRED");
});

test("every result state carries an Arabic badge label", () => {
  for (const k of ["RECOVERED", "UNCHANGED", "NEEDS_REVIEW", "NO_MATCH", "NO_IMAGE_SOURCE", "SESSION_REQUIRED", "STALE", "FAILED"] as const) {
    assert.ok(RECOVERY_STATUS_LABEL[k].length > 0, `${k} labeled`);
  }
});
