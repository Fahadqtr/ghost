// CI.3 — Cross-Platform Diff (PURE) tests.
// Run: node --conditions=react-server --experimental-strip-types --test lib/operations/cross-platform-diff.test.ts

import test from "node:test";
import assert from "node:assert/strict";

import {
  buildCrossPlatformDiff,
  classifyFieldDiff,
  sotPrice,
  sotTitle,
  totalDiffIssues,
  DIFF_FIELD_LABELS,
  type MalikasSource,
} from "./cross-platform-diff.ts";
import type { MatrixState, PlatformMatrixCell } from "./platform-matrix.ts";
import type { PlatformType } from "./shared/models.ts";

// ── builders ─────────────────────────────────────────────────────────────────

function cell(over: Partial<PlatformMatrixCell> & { platform: PlatformType; state: MatrixState }): PlatformMatrixCell {
  return {
    label: over.platform,
    source: "snapshot",
    externalId: null,
    status: null,
    price: null,
    availability: null,
    title: null,
    capturedAt: null,
    stale: false,
    flags: [],
    ...over,
  };
}

function source(over: Partial<MalikasSource> = {}): MalikasSource {
  return { productId: "p1", price: 100, discountPrice: null, nameAr: "منتج", nameEn: "Product", ...over };
}

// ── SoT rules ────────────────────────────────────────────────────────────────

test("sotPrice: discountPrice wins when present; else price", () => {
  assert.equal(sotPrice(source({ price: 100, discountPrice: 80 })), 80);
  assert.equal(sotPrice(source({ price: 100, discountPrice: null })), 100);
  assert.equal(sotPrice(source({ price: null, discountPrice: null })), null);
  // discountPrice of 0 is a real value and wins over price
  assert.equal(sotPrice(source({ price: 100, discountPrice: 0 })), 0);
});

test("sotTitle: English name first, then Arabic", () => {
  assert.equal(sotTitle(source({ nameEn: "Product", nameAr: "منتج" })), "Product");
  assert.equal(sotTitle(source({ nameEn: null, nameAr: "منتج" })), "منتج");
  assert.equal(sotTitle(source({ nameEn: null, nameAr: null })), null);
});

// ── classifyFieldDiff: null/unavailable is NEVER a difference ─────────────────

test("classifyFieldDiff: null on EITHER side → unavailable (never different)", () => {
  assert.equal(classifyFieldDiff(100, null), "unavailable");
  assert.equal(classifyFieldDiff(null, 100), "unavailable");
  assert.equal(classifyFieldDiff(null, null), "unavailable");
});

test("classifyFieldDiff: numbers compare numerically", () => {
  assert.equal(classifyFieldDiff(100, 100), "equal");
  assert.equal(classifyFieldDiff(100, 80), "different");
});

test("classifyFieldDiff: titles compare trimmed + case-insensitively", () => {
  assert.equal(classifyFieldDiff("Product", "product"), "equal");
  assert.equal(classifyFieldDiff("  Product ", "Product"), "equal");
  assert.equal(classifyFieldDiff("Product", "Widget"), "different");
});

// ── PureSoul: the only platform with trustworthy comparable values today ──────

test("PureSoul price equal → equal row, issueCount 0", () => {
  const items = buildCrossPlatformDiff(
    source({ price: 100, discountPrice: null }),
    [cell({ platform: "puresoul", state: "present", price: 100, title: "Product" })],
  );
  const ps = items.find((i) => i.platform === "puresoul")!;
  const price = ps.fields.find((f) => f.field === "price")!;
  assert.equal(price.status, "equal");
  assert.equal(price.sourceValue, 100);
  assert.equal(price.platformValue, 100);
  assert.equal(ps.issueCount, 0);
});

test("PureSoul price different → different row, issueCount 1", () => {
  const items = buildCrossPlatformDiff(
    source({ price: 100, discountPrice: null }),
    [cell({ platform: "puresoul", state: "different", price: 80, title: null })],
  );
  const ps = items.find((i) => i.platform === "puresoul")!;
  const price = ps.fields.find((f) => f.field === "price")!;
  assert.equal(price.status, "different");
  assert.equal(price.platformValue, 80);
  assert.equal(ps.issueCount, 1);
});

test("discountPrice is the SoT price for comparison", () => {
  const items = buildCrossPlatformDiff(
    source({ price: 100, discountPrice: 80 }),
    [cell({ platform: "puresoul", state: "present", price: 80 })],
  );
  const price = items.find((i) => i.platform === "puresoul")!.fields.find((f) => f.field === "price")!;
  assert.equal(price.status, "equal"); // compared against discountPrice (80), not price (100)
  assert.equal(price.sourceValue, 80);
});

test("PureSoul title equal / different", () => {
  const eq = buildCrossPlatformDiff(
    source({ nameEn: "Rose Oil" }),
    [cell({ platform: "puresoul", state: "present", title: "rose oil" })],
  );
  assert.equal(eq[0]!.fields.find((f) => f.field === "title")!.status, "equal");

  const df = buildCrossPlatformDiff(
    source({ nameEn: "Rose Oil" }),
    [cell({ platform: "puresoul", state: "different", title: "Rose Water" })],
  );
  const t = df[0]!.fields.find((f) => f.field === "title")!;
  assert.equal(t.status, "different");
  assert.equal(df[0]!.issueCount, 1);
});

test("null/untrusted platform value → no row (unavailable is never emitted or counted)", () => {
  const items = buildCrossPlatformDiff(
    source({ price: 100, nameEn: "Product" }),
    [cell({ platform: "puresoul", state: "present", price: null, title: null })],
  );
  const ps = items.find((i) => i.platform === "puresoul")!;
  assert.equal(ps.fields.length, 0); // both sides untrusted → nothing emitted
  assert.equal(ps.issueCount, 0);
});

test("null SoT value → no row even if platform has a value", () => {
  const items = buildCrossPlatformDiff(
    source({ price: null, discountPrice: null, nameEn: null, nameAr: null }),
    [cell({ platform: "puresoul", state: "present", price: 100, title: "Product" })],
  );
  assert.equal(items.find((i) => i.platform === "puresoul")!.fields.length, 0);
});

// ── Shopify / Talabat / Rafeeq: state-only (matrix nulls their value fields) ──

test("Shopify / Talabat / Rafeeq carry no trusted value fields → state-only, no rows", () => {
  const items = buildCrossPlatformDiff(source(), [
    cell({ platform: "shopify", state: "present", price: null, title: null }),
    cell({ platform: "talabat", state: "present", price: null, title: null }),
    cell({ platform: "rafeeq", state: "ready", price: null, title: null }),
  ]);
  for (const p of ["shopify", "talabat", "rafeeq"] as const) {
    const it = items.find((i) => i.platform === p)!;
    assert.equal(it.fields.length, 0, `${p} must emit no field rows`);
    assert.equal(it.issueCount, 0);
  }
});

// ── identity is NEVER a value comparison ──────────────────────────────────────

test("externalId is never compared as a field (identity, not a value)", () => {
  const items = buildCrossPlatformDiff(source(), [
    cell({ platform: "puresoul", state: "present", price: 100, title: "Product", externalId: "PS-123" }),
  ]);
  const fields = items[0]!.fields.map((f) => f.field);
  assert.deepEqual(fields.sort(), ["price", "title"]); // externalId absent
});

// ── MatrixState stays the headline ────────────────────────────────────────────

test("MatrixState is preserved verbatim as the item headline", () => {
  const states: MatrixState[] = ["present", "missing", "different", "review", "ready", "unknown"];
  for (const st of states) {
    const items = buildCrossPlatformDiff(source(), [cell({ platform: "puresoul", state: st, price: 100 })]);
    assert.equal(items.find((i) => i.platform === "puresoul")!.state, st);
  }
});

test("unknown platform → no field rows (nothing to compare)", () => {
  const items = buildCrossPlatformDiff(
    source({ price: 100 }),
    [cell({ platform: "puresoul", state: "unknown", price: 100, title: "Product" })],
  );
  const ps = items.find((i) => i.platform === "puresoul")!;
  assert.equal(ps.fields.length, 0);
  assert.equal(ps.state, "unknown");
});

// ── determinism ───────────────────────────────────────────────────────────────

test("deterministic ordering: different → review → rest, then PLATFORM_TYPES order", () => {
  const items = buildCrossPlatformDiff(source({ price: 100 }), [
    cell({ platform: "rafeeq", state: "present" }),
    cell({ platform: "shopify", state: "review" }),
    cell({ platform: "puresoul", state: "different", price: 80 }),
    cell({ platform: "talabat", state: "present" }),
  ]);
  // puresoul different (rank 0) → shopify review (rank 1) → the rest (present),
  // tiebroken by PLATFORM_TYPES order (shopify,puresoul,talabat,rafeeq): talabat before rafeeq.
  assert.deepEqual(items.map((i) => i.platform), ["puresoul", "shopify", "talabat", "rafeeq"]);
});

test("field order within an item is deterministic: price then title", () => {
  const items = buildCrossPlatformDiff(
    source({ price: 100, nameEn: "Product" }),
    [cell({ platform: "puresoul", state: "present", price: 100, title: "Product" })],
  );
  assert.deepEqual(items[0]!.fields.map((f) => f.field), ["price", "title"]);
});

// ── aggregation + labels ──────────────────────────────────────────────────────

test("totalDiffIssues sums `different` fields across platforms", () => {
  const items = buildCrossPlatformDiff(
    source({ price: 100, nameEn: "Product" }),
    [cell({ platform: "puresoul", state: "different", price: 80, title: "Other" })],
  );
  assert.equal(totalDiffIssues(items), 2); // price + title both different
});

test("DIFF_FIELD_LABELS are Arabic and cover every field", () => {
  assert.equal(DIFF_FIELD_LABELS.price, "السعر");
  assert.equal(DIFF_FIELD_LABELS.title, "الاسم");
});

test("empty cells → empty result (no throw)", () => {
  assert.deepEqual(buildCrossPlatformDiff(source(), []), []);
});
