// MEDIA.2 — bulk Snoonu image recovery: PURE model tests.
// node --conditions=react-server --experimental-strip-types --test lib/adapters/snoonu/merchant/bulk-recovery.test.ts

import test from "node:test";
import assert from "node:assert/strict";

import {
  BULK_REPORT_LABEL,
  buildBulkCsv,
  buildProgressLine,
  buildScanSummaryLine,
  bulkReportKey,
  estimateRemainingMs,
  formatDurationAr,
  reviewQueueRows,
  safeRecoveryRows,
  summarizeBulk,
  type BulkItemResult,
} from "./bulk-recovery.ts";
import type { ImagePreviewRow } from "./merchant-contract.ts";

const row = (over: Partial<ImagePreviewRow> = {}): ImagePreviewRow => ({
  productId: "p1",
  sku: "mk1",
  barcode: "555",
  storefrontKey: "snoonu:malikas",
  spi: "SPI-1",
  currentImage: false,
  merchantImageUrl: "https://images.snoonu.com/p/a.jpeg",
  matchStatus: "MATCHED",
  reason: "تطابق مؤكد.",
  provenance: {
    storefrontKey: "snoonu:malikas", spi: "SPI-1", merchantSku: "mk1", merchantBarcode: "555",
    merchantTitle: "P", internalProductId: "p1", confidence: "high",
  },
  selectable: true,
  ...over,
});

// ── bulk eligibility: SAFE rows only, review queue separate ───────────────────
test("safeRecoveryRows: only selectable MATCHED rows with SPI + source image", () => {
  const rows = [
    row(),
    row({ productId: "p2", matchStatus: "NEEDS_REVIEW", selectable: false }),
    row({ productId: "p3", matchStatus: "NOT_FOUND", selectable: false, spi: null, merchantImageUrl: null }),
    row({ productId: "p4", matchStatus: "SESSION_REQUIRED", selectable: false }),
    // defensive: a MATCHED row can never lack an SPI/image, but if it did it is excluded
    row({ productId: "p5", spi: null }),
    row({ productId: "p6", merchantImageUrl: null }),
    // defensive: selectable flag is honored — a non-selectable MATCHED row is excluded
    row({ productId: "p7", selectable: false }),
  ];
  assert.deepEqual(safeRecoveryRows(rows).map((r) => r.productId), ["p1"]);
});

test("reviewQueueRows: exactly the NEEDS_REVIEW rows (never NOT_FOUND / SESSION_REQUIRED)", () => {
  const rows = [
    row(),
    row({ productId: "p2", matchStatus: "NEEDS_REVIEW", selectable: false }),
    row({ productId: "p3", matchStatus: "NOT_FOUND", selectable: false }),
    row({ productId: "p4", matchStatus: "SESSION_REQUIRED", selectable: false }),
  ];
  assert.deepEqual(reviewQueueRows(rows).map((r) => r.productId), ["p2"]);
});

// ── final report aggregation ──────────────────────────────────────────────────
test("bulkReportKey buckets every recovery status into the operator categories", () => {
  assert.equal(bulkReportKey("RECOVERED"), "recovered");
  assert.equal(bulkReportKey("UNCHANGED"), "alreadyHadImage");
  assert.equal(bulkReportKey("STALE"), "skipped");
  assert.equal(bulkReportKey("NEEDS_REVIEW"), "needsReview");
  assert.equal(bulkReportKey("SESSION_REQUIRED"), "sessionExpired");
  for (const s of ["NO_MATCH", "NO_IMAGE_SOURCE", "FAILED"] as const) {
    assert.equal(bulkReportKey(s), "failed");
  }
});

test("summarizeBulk counts a mixed partial-failure run correctly (one failure never hides the rest)", () => {
  const results: BulkItemResult[] = [
    { productId: "a", sku: "s1", status: "RECOVERED", reason: "ok", url: "u" },
    { productId: "b", sku: "s2", status: "RECOVERED", reason: "ok", url: "u" },
    { productId: "c", sku: "s3", status: "UNCHANGED", reason: "r" },
    { productId: "d", sku: "s4", status: "STALE", reason: "r" },
    { productId: "e", sku: "s5", status: "NEEDS_REVIEW", reason: "r" },
    { productId: "f", sku: "s6", status: "SESSION_REQUIRED", reason: "r" },
    { productId: "g", sku: "s7", status: "FAILED", reason: "r" },
    { productId: "h", sku: "s8", status: "NO_MATCH", reason: "r" },
  ];
  assert.deepEqual(summarizeBulk(results), {
    total: 8, recovered: 2, alreadyHadImage: 1, skipped: 1, needsReview: 1, sessionExpired: 1, failed: 2,
  });
  assert.deepEqual(summarizeBulk([]), {
    total: 0, recovered: 0, alreadyHadImage: 0, skipped: 0, needsReview: 0, sessionExpired: 0, failed: 0,
  });
});

test("every report bucket has an Arabic label", () => {
  for (const k of ["recovered", "alreadyHadImage", "skipped", "needsReview", "sessionExpired", "failed"] as const) {
    assert.ok(BULK_REPORT_LABEL[k].length > 0, k);
  }
});

// ── operator-facing lines ─────────────────────────────────────────────────────
test("scan summary line matches the spec shape («58 ناقصة · 34 آمنة · 18 مراجعة · 6 غير موجود»)", () => {
  assert.equal(
    buildScanSummaryLine({ missing: 58, matched: 34, needsReview: 18, notFound: 6, sessionRequired: 0 }),
    "58 ناقصة · 34 آمنة · 18 مراجعة · 6 غير موجود",
  );
  assert.equal(
    buildScanSummaryLine({ missing: 59, matched: 0, needsReview: 0, notFound: 0, sessionRequired: 59 }),
    "59 ناقصة · 0 آمنة · 0 مراجعة · 0 غير موجود · 59 بحاجة جلسة",
  );
});

test("progress line shows count + current SKU", () => {
  assert.equal(buildProgressLine(23, 58, "mk2245"), "جارٍ الاسترجاع… 23/58 · الحالي: mk2245");
  assert.equal(buildProgressLine(0, 58, null), "جارٍ الاسترجاع… 0/58");
});

test("ETA: linear from elapsed; null before the first completion and at the end", () => {
  assert.equal(estimateRemainingMs(10_000, 0, 58), null, "no basis yet");
  assert.equal(estimateRemainingMs(10_000, 10, 10), null, "done");
  assert.equal(estimateRemainingMs(10_000, 10, 30), 20_000, "1s/item × 20 remaining");
  assert.equal(estimateRemainingMs(-5, 3, 10), null, "garbage elapsed is rejected");
});

test("duration formatting", () => {
  assert.equal(formatDurationAr(45_000), "~45 ث");
  assert.equal(formatDurationAr(200_000), "~3 د 20 ث");
  assert.equal(formatDurationAr(0), "~0 ث");
});

// ── CSV export ────────────────────────────────────────────────────────────────
test("CSV: header + one row per product; quotes/commas/newlines escaped; Arabic label included", () => {
  const csv = buildBulkCsv([
    { productId: "p1", sku: "mk1", status: "RECOVERED", reason: "ok", url: "https://x/y.jpg" },
    { productId: "p2", sku: null, status: "FAILED", reason: 'صيغة "خاصة", مع فاصلة' },
  ]);
  const lines = csv.split("\n");
  assert.equal(lines[0], "product_id,sku,status,status_label,reason,url");
  assert.equal(lines[1], "p1,mk1,RECOVERED,تم الاستيراد,ok,https://x/y.jpg");
  assert.equal(lines[2], 'p2,,FAILED,فشل,"صيغة ""خاصة"", مع فاصلة",');
  assert.equal(lines.length, 3);
});
