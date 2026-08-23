// CATALOG.GOLIVE.3A — Wave 2 plan tests. PURE — no DB, no network.
// Run: node --conditions=react-server --experimental-strip-types --test lib/catalog/wave2/wave2-plan.test.ts

import test from "node:test";
import assert from "node:assert/strict";

import { CATEGORIES } from "../../constants.ts";
import {
  WAVE2_AVAILABILITY_ONLY,
  WAVE2_BATCH_SKUS,
  WAVE2_NEEDS_REVIEW,
  WAVE2_SAFE_DEFAULTS,
  WAVE2_UNKNOWN,
  categorySeed,
  decorateWave2Row,
  filterWave2Rows,
  isValidCategoryChoice,
  wave2Progress,
  type Wave2Row,
} from "./wave2-plan.ts";

function row(over: Partial<Wave2Row> = {}): Wave2Row {
  return {
    id: over.id ?? "p1",
    sku: over.sku ?? "mk2233",
    nameEn: "x", nameAr: "س", imageUrl: "https://e/x.jpg",
    category: null, availability: null, approval: null,
    lifecycle: "DRAFT", readinessStatus: "incomplete", readyToPublish: false,
    variantCount: 0, price: 10,
    ...over,
  };
}

test("audited batch shape: 43 safe + 13 review + 1 unknown + 5 availability-only = 62 unique SKUs", () => {
  assert.equal(Object.keys(WAVE2_SAFE_DEFAULTS).length, 43);
  assert.equal(WAVE2_NEEDS_REVIEW.length, 13);
  assert.equal(WAVE2_UNKNOWN.length, 1);
  assert.equal(WAVE2_AVAILABILITY_ONLY.length, 5);
  assert.equal(WAVE2_BATCH_SKUS.length, 62);
  assert.equal(new Set(WAVE2_BATCH_SKUS).size, 62, "no SKU appears in two seed lists");
});

test("every SAFE default is an EXISTING taxonomy category — nothing invented", () => {
  for (const [sku, cat] of Object.entries(WAVE2_SAFE_DEFAULTS)) {
    assert.ok((CATEGORIES as readonly string[]).includes(cat), `${sku} → ${cat}`);
  }
});

test("category choice validation accepts only the existing taxonomy", () => {
  assert.equal(isValidCategoryChoice("Face Care"), true);
  assert.equal(isValidCategoryChoice("Perfumes"), false, "not a taxonomy value");
  assert.equal(isValidCategoryChoice(""), false);
  assert.equal(isValidCategoryChoice(null), false);
});

test("seeds classify by SKU: safe carries its category; review/unknown carry none", () => {
  assert.deepEqual(categorySeed("mk2270"), { kind: "safe", category: "Rhode Products Section" });
  assert.deepEqual(categorySeed("mk2236"), { kind: "review" });
  assert.deepEqual(categorySeed("mk2262"), { kind: "unknown" });
  assert.deepEqual(categorySeed("mk1"), { kind: "none" });
});

test("approval eligibility REQUIRES a resolved category", () => {
  const unresolved = decorateWave2Row(row({ category: null }));
  assert.equal(unresolved.approveEligible, false, "no category → never approvable");
  const resolved = decorateWave2Row(row({ category: "Hair Care" }));
  assert.equal(resolved.approveEligible, true);
  const already = decorateWave2Row(row({ category: "Hair Care", approval: "Approved" }));
  assert.equal(already.approveEligible, false, "already approved → not re-offered");
});

test("activation eligibility = READY (certified readiness) and not already ACTIVE", () => {
  const notReady = decorateWave2Row(row({ readyToPublish: false }));
  assert.equal(notReady.activationEligible, false);
  const ready = decorateWave2Row(row({ readyToPublish: true, readinessStatus: "ready" }));
  assert.equal(ready.activationEligible, true);
  const active = decorateWave2Row(row({ readyToPublish: true, lifecycle: "ACTIVE" }));
  assert.equal(active.activationEligible, false, "ACTIVE rows are done, not candidates");
  assert.equal(active.activated, true);
});

test("progress counts each dimension over its tracked rows", () => {
  const rows = [
    decorateWave2Row(row({ id: "a", sku: "mk2233", category: "Hair Care", availability: "In Stock", approval: "Approved", lifecycle: "ACTIVE", readyToPublish: false })),
    decorateWave2Row(row({ id: "b", sku: "mk2236" })), // review seed, all unresolved
    decorateWave2Row(row({ id: "c", sku: "mk2227", category: "Face Care", approval: "Approved", readyToPublish: true, readinessStatus: "ready" })), // availability-only SKU
  ];
  const p = wave2Progress(rows);
  assert.deepEqual(p.categories, { done: 1, total: 2 }, "availability-only SKUs are not category-tracked");
  assert.deepEqual(p.availability, { done: 1, total: 3 });
  assert.deepEqual(p.approvals, { done: 2, total: 3 });
  assert.equal(p.activationReady, 1);
  assert.equal(p.activated, 1);
});

test("filters slice by seed kind and unresolved state", () => {
  const rows = [
    decorateWave2Row(row({ id: "a", sku: "mk2270" })), // safe unresolved
    decorateWave2Row(row({ id: "b", sku: "mk2236" })), // review unresolved
    decorateWave2Row(row({ id: "c", sku: "mk2262" })), // unknown unresolved
    decorateWave2Row(row({ id: "d", sku: "mk2233", category: "Hair Care", availability: "In Stock", readyToPublish: true })),
  ];
  assert.deepEqual(filterWave2Rows(rows, "safe_suggestion").map((r) => r.id), ["a"]);
  assert.deepEqual(filterWave2Rows(rows, "needs_review").map((r) => r.id), ["b"]);
  assert.deepEqual(filterWave2Rows(rows, "unknown_category").map((r) => r.id), ["c"]);
  assert.deepEqual(filterWave2Rows(rows, "availability_unresolved").map((r) => r.id), ["a", "b", "c"]);
  assert.deepEqual(filterWave2Rows(rows, "ready_for_activation").map((r) => r.id), ["d"]);
  assert.equal(filterWave2Rows(rows, "all").length, 4);
});
