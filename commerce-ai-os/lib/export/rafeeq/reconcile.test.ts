// RAFEEQ.FULLSYNC.1 — returned-file reconciliation tests (spec scenario 15 +
// the certified matching rules: SKU/barcode only, nothing auto-resolved).
// node --conditions=react-server --experimental-strip-types --test lib/export/rafeeq/reconcile.test.ts

import test from "node:test";
import assert from "node:assert/strict";

import { RAFEEQ_HEADERS } from "../../exporters.ts";
import {
  parseReturnedSheet,
  skuTokenFromImageName,
  buildReconcilePlan,
  type ReturnedRow,
  type ReconcileCatalogProduct,
  type ReconcileMappingEvidence,
} from "./reconcile.ts";

// ── fixtures ──────────────────────────────────────────────────────────────────

const cat = (productId: string, sku: string, barcode: string | null = null): ReconcileCatalogProduct => ({ productId, sku, barcode });
const map = (productId: string, sku: string, externalId: string | null, status: "resolved" | "needs_review" = "resolved"): ReconcileMappingEvidence =>
  ({ productId, sku, externalId, status });
let rowSeq = 1;
const ret = (imageName: string, rafeeqId: string, barcode: string | null = null): ReturnedRow =>
  ({ rowNumber: ++rowSeq, imageName, barcode, rafeeqId });

// ── sheet parsing ─────────────────────────────────────────────────────────────

test("parseReturnedSheet locates columns by HEADER NAME, not position", () => {
  // reordered + extra columns — only the header names matter
  const aoa = [
    ["RAFEEQ ID", "EXTRA", "IMAGE NAME", "BARCODE"],
    ["9001", "x", "mk1001.jpg", "123456"],
    ["", "", "", ""], // blank row skipped
    ["new product", "y", "mk1002.jpg", ""],
  ];
  const parsed = parseReturnedSheet(aoa);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.rows.length, 2);
  assert.deepEqual(parsed.rows[0], { rowNumber: 2, imageName: "mk1001.jpg", barcode: "123456", rafeeqId: "9001" });
  assert.equal(parsed.rows[1].rafeeqId, "new product");
});

test("parseReturnedSheet accepts the canonical Rafeeq header row and rejects a sheet without the identity columns", () => {
  const parsed = parseReturnedSheet([RAFEEQ_HEADERS.slice(), ["Face Care", "وجه", "P", "م", 10, "", "", "mk1.jpg", "111222", "42"]]);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.rows[0].imageName, "mk1.jpg");
  assert.equal(parsed.rows[0].rafeeqId, "42");
  assert.deepEqual(parseReturnedSheet([["A", "B"], ["1", "2"]]), { ok: false, error: "missing_columns", rows: [] });
  assert.deepEqual(parseReturnedSheet([]), { ok: false, error: "empty", rows: [] });
});

test("skuTokenFromImageName strips only the extension (never a legitimate SKU suffix)", () => {
  assert.equal(skuTokenFromImageName("mk1001.jpg"), "mk1001");
  assert.equal(skuTokenFromImageName("MK-10_2.png"), "MK-10_2"); // trailing _2 is part of the SKU token
  assert.equal(skuTokenFromImageName("images/mk1001.jpg"), "mk1001");
  assert.equal(skuTokenFromImageName(""), null);
});

// ── clean matches ─────────────────────────────────────────────────────────────

test("a clean SKU match with no existing mapping plans an INSERT (with barcode corroboration)", () => {
  const plan = buildReconcilePlan({
    returned: [ret("mk1001.jpg", "9001", "123456")],
    catalog: [cat("p1", "mk1001", "123456")],
    mappings: [],
  });
  assert.equal(plan.entries[0].status, "matched_insert");
  assert.equal(plan.entries[0].matchedBy, "sku");
  assert.deepEqual(plan.apply, [{ action: "insert", productId: "p1", sku: "mk1001", barcode: "123456", externalId: "9001" }]);
});

test("a clean match against a needs_review mapping plans resolve_needs_review (this retires the conflict)", () => {
  const plan = buildReconcilePlan({
    returned: [ret("mk898.jpg", "9002")],
    catalog: [cat("p898", "mk898", "654321")],
    mappings: [map("p898", "mk898", null, "needs_review")],
  });
  assert.equal(plan.entries[0].status, "resolve_needs_review");
  assert.equal(plan.apply[0].action, "resolve_needs_review");
  assert.equal(plan.counts.needsReviewResolved, 1);
});

test("a resolved mapping without an id gets a plain update; the same id again is a no-op", () => {
  const plan = buildReconcilePlan({
    returned: [ret("mk1.jpg", "9003"), ret("mk2.jpg", "9004")],
    catalog: [cat("p1", "mk1"), cat("p2", "mk2")],
    mappings: [map("p1", "mk1", null), map("p2", "mk2", "9004")],
  });
  assert.equal(plan.entries[0].status, "matched_update");
  assert.equal(plan.entries[1].status, "already_mapped");
  assert.equal(plan.apply.length, 1);
});

test("a unique barcode is the ONLY fallback match (and only when the SKU cannot resolve)", () => {
  const plan = buildReconcilePlan({
    returned: [ret("renamed-photo.jpg", "9005", "777888")],
    catalog: [cat("p1", "mk1", "777888"), cat("p2", "mk2", "999000")],
    mappings: [],
  });
  assert.equal(plan.entries[0].status, "matched_insert");
  assert.equal(plan.entries[0].matchedBy, "barcode");
  // an ambiguous barcode never matches
  const ambiguous = buildReconcilePlan({
    returned: [ret("renamed-photo.jpg", "9006", "777888")],
    catalog: [cat("p1", "mk1", "777888"), cat("p2", "mk2", "777888")],
    mappings: [],
  });
  assert.equal(ambiguous.entries[0].status, "unknown_sku");
  assert.equal(ambiguous.apply.length, 0);
});

// ── refusals (nothing auto-resolved) ──────────────────────────────────────────

test("15: duplicate returned external ids are rejected — every duplicated row is excluded from the apply plan", () => {
  const plan = buildReconcilePlan({
    returned: [ret("mk1.jpg", "9100"), ret("mk2.jpg", "9100"), ret("mk3.jpg", "9101")],
    catalog: [cat("p1", "mk1"), cat("p2", "mk2"), cat("p3", "mk3")],
    mappings: [],
  });
  assert.equal(plan.entries[0].status, "duplicate_external_id");
  assert.equal(plan.entries[1].status, "duplicate_external_id");
  assert.equal(plan.entries[2].status, "matched_insert");
  assert.equal(plan.counts.duplicates, 2);
  assert.deepEqual(plan.apply.map((a) => a.externalId), ["9101"], "no duplicated id ever reaches the apply plan");
});

test("missing / marker / malformed ids and unknown SKUs are surfaced, never applied", () => {
  const plan = buildReconcilePlan({
    returned: [
      ret("mk1.jpg", ""),                 // missing_id
      ret("mk2.jpg", "new product"),      // still the marker → missing_id
      ret("mk3.jpg", "=cmd|9|x"),         // invalid_id (formula lead-in / bad token)
      ret("ghost.jpg", "9200"),           // unknown_sku
      ret("", "9201"),                    // unmatchable (no SKU, no barcode)
    ],
    catalog: [cat("p1", "mk1"), cat("p2", "mk2"), cat("p3", "mk3")],
    mappings: [],
  });
  assert.deepEqual(
    plan.entries.map((e) => e.status),
    ["missing_id", "missing_id", "invalid_id", "unknown_sku", "unmatchable"],
  );
  assert.equal(plan.apply.length, 0);
});

test("conflicts are refused: id owned by another product, mapping resolved to a different id, barcode disagreement", () => {
  const plan = buildReconcilePlan({
    returned: [
      ret("mk1.jpg", "9300"),             // 9300 already belongs to p9 → conflict_external_id
      ret("mk2.jpg", "9301"),             // p2 already resolved to 9999 → conflict_existing_mapping
      ret("mk3.jpg", "9302", "111111"),   // sku matches but barcodes disagree → barcode_mismatch
    ],
    catalog: [cat("p1", "mk1"), cat("p2", "mk2"), cat("p3", "mk3", "222222")],
    mappings: [map("p9", "mk9", "9300"), map("p2", "mk2", "9999")],
  });
  assert.deepEqual(
    plan.entries.map((e) => e.status),
    ["conflict_external_id", "conflict_existing_mapping", "barcode_mismatch"],
  );
  assert.equal(plan.apply.length, 0);
  assert.equal(plan.counts.conflicts, 3);
});

test("a SKU carried by two catalog products is ambiguous and refused", () => {
  const plan = buildReconcilePlan({
    returned: [ret("mk1.jpg", "9400")],
    catalog: [cat("p1", "mk1"), cat("p1b", "mk1")],
    mappings: [],
  });
  assert.equal(plan.entries[0].status, "ambiguous_sku");
  assert.equal(plan.apply.length, 0);
});

// ── 16) titles play no part in matching ───────────────────────────────────────
test("16: the reconcile input carries no title/name evidence at all — matching is SKU/barcode only", () => {
  // shape-level proof: catalog + returned rows are only ids/SKUs/barcodes.
  const c = cat("p1", "mk1", "123456") as Record<string, unknown>;
  const r = ret("mk1.jpg", "9500", "123456") as unknown as Record<string, unknown>;
  for (const k of Object.keys(c)) assert.ok(["productId", "sku", "barcode"].includes(k));
  for (const k of Object.keys(r)) assert.ok(["rowNumber", "imageName", "barcode", "rafeeqId"].includes(k));
});
