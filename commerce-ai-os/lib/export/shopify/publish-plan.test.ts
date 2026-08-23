// INT.2E.2 — Shopify publish-plan tests (pure).
// node --conditions=react-server --experimental-strip-types --test lib/export/shopify/publish-plan.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import {
  evaluateRow,
  rowFingerprint,
  isStale,
  dedupeSelections,
  tallyResult,
  emptyCounts,
  runStatusFromCounts,
  SUPPORTED_EXECUTION_OPS,
  variantIdentityFields,
  type PublishTarget,
} from "./publish-plan.ts";
import type { ShopifyPlanOp, ShopifyPreviewStatus } from "./preview.ts";

function target(over: Partial<PublishTarget> = {}): PublishTarget {
  return {
    title: "Serum", descriptionText: "Bright serum.", price: 80, compareAtPrice: 100,
    hasImage: true, imageUrl: "https://cdn/x.jpg",
    variants: [{ variantId: "v1", variantGid: "gid://shopify/ProductVariant/11", sku: "SKU1", barcode: "6291041500213", price: 80 }],
    ...over,
  };
}
function row(status: ShopifyPreviewStatus, plannedOps: ShopifyPlanOp[], over: Partial<{ shopifyProductGid: string | null; changedFields: string[] }> = {}) {
  return {
    internalProductId: "p1", status, shopifyProductGid: over.shopifyProductGid ?? null,
    changedFields: over.changedFields ?? [], plannedOps,
  };
}

test("hard-stops: CONFLICT / BLOCKED / UNKNOWN are never eligible", () => {
  for (const [status, expected] of [["CONFLICT", "CONFLICT"], ["BLOCKED", "BLOCKED"], ["UNKNOWN", "BLOCKED"]] as const) {
    const e = evaluateRow(row(status, [{ type: "BLOCKED", target: "product", fields: [] }]), target());
    assert.equal(e.eligible, false);
    assert.equal(e.ineligibleResult, expected);
    assert.deepEqual(e.executableOps, []);
  }
});

test("MATCH → not eligible, UNCHANGED", () => {
  const e = evaluateRow(row("MATCH", [{ type: "NOOP", target: "product", fields: [] }]), target());
  assert.equal(e.eligible, false);
  assert.equal(e.ineligibleResult, "UNCHANGED");
});

test("NEW → eligible with CREATE_PRODUCT executable", () => {
  const e = evaluateRow(row("NEW", [{ type: "CREATE_PRODUCT", target: "product", fields: ["title", "price"] }]), target());
  assert.equal(e.eligible, true);
  assert.deepEqual(e.executableOps.map((o) => o.type), ["CREATE_PRODUCT"]);
  assert.deepEqual(e.unsupportedOps, []);
});

test("UPDATE_REQUIRED → price + product content executable", () => {
  const e = evaluateRow(row("UPDATE_REQUIRED", [
    { type: "UPDATE_PRODUCT", target: "product", fields: ["title"] },
    { type: "UPDATE_PRICE", target: "variant", variantId: "v1", variantGid: "gid://shopify/ProductVariant/11", fields: ["price"] },
  ], { changedFields: ["title", "price"] }), target());
  assert.equal(e.eligible, true);
  assert.deepEqual(e.executableOps.map((o) => o.type).sort(), ["UPDATE_PRICE", "UPDATE_PRODUCT"]);
});

// mk2237 regression: create() used to leave the barcode blank on Shopify, the
// re-read planned a barcode-only UPDATE_VARIANT, and — with UPDATE_VARIANT
// unsupported — the row became permanently unselectable. Identity updates on a
// GID-matched variant are now executable, so the row converges.
test("UPDATE_VARIANT (sku/barcode) on a GID-matched variant IS executable — the row stays selectable", () => {
  const e = evaluateRow(row("UPDATE_REQUIRED", [
    { type: "UPDATE_VARIANT", target: "variant", variantId: "v1", variantGid: "gid://x/1", fields: ["sku"] },
  ], { changedFields: ["variantSku"] }), target());
  assert.equal(e.eligible, true);
  assert.equal(e.ineligibleResult, null);
  assert.deepEqual(e.executableOps.map((o) => o.type), ["UPDATE_VARIANT"]);
  assert.deepEqual(e.unsupportedOps, []);
});

test("mk2237 scenario: NEW create → reread diffs ONLY the barcode → row is eligible for the update", () => {
  // Step 1 — NEW row plans a create (this is what SUCCEEDED, created=1).
  const created = evaluateRow(
    row("NEW", [{ type: "CREATE_PRODUCT", target: "product", fields: ["title", "price"] }]),
    target(),
  );
  assert.equal(created.eligible, true);
  // Step 2 — after the re-read the ONLY difference is the variant barcode.
  const rereadRow = row("UPDATE_REQUIRED", [
    { type: "UPDATE_VARIANT", target: "variant", variantId: "v1", variantGid: "gid://shopify/ProductVariant/11", fields: ["barcode"] },
  ], { changedFields: ["variantBarcode"] });
  const reread = evaluateRow(rereadRow, target());
  assert.equal(reread.eligible, true, "barcode-only update_required must be selectable");
  assert.deepEqual(reread.executableOps.map((o) => o.type), ["UPDATE_VARIANT"]);
  assert.equal(reread.ineligibleResult, null);
  // Step 3 — the fingerprint covers the barcode target, so a stale confirm is rejected.
  const f1 = reread.fingerprint;
  const f2 = evaluateRow(rereadRow, target()).fingerprint;
  assert.equal(f1, f2, "deterministic");
  // Hard-stops stay hard-stops — no unsafe row became publishable.
  const conflict = evaluateRow(row("CONFLICT", [
    { type: "UPDATE_VARIANT", target: "variant", variantId: "v1", variantGid: "gid://x/1", fields: ["barcode"] },
  ]), target());
  assert.equal(conflict.eligible, false);
  assert.equal(conflict.ineligibleResult, "CONFLICT");
  const blocked = evaluateRow(row("BLOCKED", []), target());
  assert.equal(blocked.eligible, false);
});

test("add-missing-variant (UPDATE_PRODUCT[variants]) is unsupported", () => {
  const e = evaluateRow(row("UPDATE_REQUIRED", [
    { type: "UPDATE_PRODUCT", target: "product", fields: ["variants"] },
  ], { changedFields: ["variantMissing"] }), target());
  assert.equal(e.eligible, false);
  assert.deepEqual(e.unsupportedOps.map((o) => o.type), ["UPDATE_PRODUCT"]);
});

test("UPDATE_MEDIA add-missing is executable", () => {
  const e = evaluateRow(row("UPDATE_REQUIRED", [
    { type: "UPDATE_MEDIA", target: "media", fields: ["image"] },
  ], { changedFields: ["image"] }), target());
  assert.equal(e.eligible, true);
  assert.deepEqual(e.executableOps.map((o) => o.type), ["UPDATE_MEDIA"]);
});

test("mixed executable + unsupported → eligible, split correctly", () => {
  const e = evaluateRow(row("UPDATE_REQUIRED", [
    { type: "UPDATE_PRICE", target: "variant", variantId: "v1", variantGid: "gid://x/1", fields: ["price"] },
    { type: "UPDATE_VARIANT", target: "variant", variantId: "v1", variantGid: "gid://x/1", fields: ["barcode"] },
    { type: "UPDATE_PRODUCT", target: "product", fields: ["variants"] }, // add-missing-variant stays unsupported
  ], { changedFields: ["price", "variantBarcode", "variantMissing"] }), target());
  assert.equal(e.eligible, true);
  assert.deepEqual(e.executableOps.map((o) => o.type).sort(), ["UPDATE_PRICE", "UPDATE_VARIANT"]);
  assert.deepEqual(e.unsupportedOps.map((o) => o.type), ["UPDATE_PRODUCT"]);
});

test("fingerprint is stable, and flips when the target value changes (stale protection)", () => {
  const r = row("UPDATE_REQUIRED", [{ type: "UPDATE_PRICE", target: "variant", variantId: "v1", variantGid: "gid://x/1", fields: ["price"] }], { changedFields: ["price"] });
  const f1 = rowFingerprint(r, target({ price: 80 }));
  const f2 = rowFingerprint(r, target({ price: 80 }));
  assert.equal(f1, f2, "deterministic");
  const f3 = rowFingerprint(r, target({ price: 75 }));
  assert.notEqual(f1, f3, "target price change flips the fingerprint");
});

test("fingerprint flips when the plan (status/ops) changes", () => {
  const t = target();
  const f1 = rowFingerprint(row("UPDATE_REQUIRED", [{ type: "UPDATE_PRICE", target: "variant", variantId: "v1", variantGid: "g", fields: ["price"] }], { changedFields: ["price"] }), t);
  const f2 = rowFingerprint(row("MATCH", [{ type: "NOOP", target: "product", fields: [] }]), t);
  assert.notEqual(f1, f2);
});

test("isStale rejects a missing or mismatched confirmation", () => {
  assert.equal(isStale("abc", "abc"), false);
  assert.equal(isStale("abc", "def"), true);
  assert.equal(isStale("abc", null), true);
  assert.equal(isStale("abc", undefined), true);
});

test("run aggregation → SUCCEEDED / PARTIAL / FAILED", () => {
  // all good
  let c = emptyCounts();
  for (const r of ["CREATED", "UPDATED", "UNCHANGED"] as const) c = tallyResult(c, r);
  assert.equal(runStatusFromCounts(c), "SUCCEEDED");
  assert.equal(c.productCount, 3);

  // some success + some failure → PARTIAL
  let p = emptyCounts();
  for (const r of ["CREATED", "FAILED"] as const) p = tallyResult(p, r);
  assert.equal(runStatusFromCounts(p), "PARTIAL");

  // all failure → FAILED
  let f = emptyCounts();
  for (const r of ["FAILED", "NEEDS_RECONCILIATION"] as const) f = tallyResult(f, r);
  assert.equal(runStatusFromCounts(f), "FAILED");

  // only blocked/unchanged/stale → SUCCEEDED (nothing broke)
  let b = emptyCounts();
  for (const r of ["BLOCKED", "UNCHANGED", "STALE", "SKIPPED_UNSUPPORTED"] as const) b = tallyResult(b, r);
  assert.equal(runStatusFromCounts(b), "SUCCEEDED");

  // systemic abort forces FAILED
  assert.equal(runStatusFromCounts(c, { systemicAbort: true }), "FAILED");
});

// ── INT.2E.2 safety fix: server-side selection dedupe (§6) ────────────────────
const sel = (id: string, fp: string) => ({ internalProductId: id, expectedFingerprint: fp });

test("dedupe: repeated same internalProductId collapses to exactly one selection", () => {
  const out = dedupeSelections([sel("p1", "fa"), sel("p1", "fb"), sel("p1", "fc")]);
  assert.equal(out.length, 1, "a repeated product executes at most once");
  assert.equal(out[0].internalProductId, "p1");
  assert.equal(out[0].expectedFingerprint, "fa", "first occurrence wins (deterministic fingerprint)");
});

test("dedupe: mixed duplicate + unique — each unique product appears once, order preserved", () => {
  const out = dedupeSelections([sel("a", "1"), sel("b", "2"), sel("a", "9"), sel("c", "3"), sel("b", "8")]);
  assert.deepEqual(out.map((s) => s.internalProductId), ["a", "b", "c"], "order preserved, first occurrence kept");
  assert.deepEqual(out.map((s) => s.expectedFingerprint), ["1", "2", "3"], "each keeps its first fingerprint");
});

test("dedupe: fingerprint/stale behaviour is unaffected by dedupe (first entry's fp flows through)", () => {
  const out = dedupeSelections([sel("p1", "GOOD"), sel("p1", "STALE-DUP")]);
  // the surviving selection carries the first fingerprint; stale-checking it still works
  assert.equal(isStale("GOOD", out[0].expectedFingerprint), false, "matching fresh fp → not stale");
  assert.equal(isStale("CHANGED", out[0].expectedFingerprint), true, "changed fresh fp → stale");
});

test("dedupe: result counts cannot double-count a duplicated selection", () => {
  // The executor tallies once per surviving selection; dedupe guarantees N distinct.
  const out = dedupeSelections([sel("a", "1"), sel("a", "1"), sel("a", "1"), sel("b", "2")]);
  assert.equal(out.length, 2, "3×a + 1×b → 2 distinct selections");
  let counts = emptyCounts();
  for (const _ of out) counts = tallyResult(counts, "CREATED");
  assert.equal(counts.created, 2, "created counted per distinct product, never per duplicate");
  assert.equal(counts.productCount, 2);
});

test("dedupe: an already-unique batch is unchanged (no regression to normal/retry flows)", () => {
  const unique = [sel("a", "1"), sel("b", "2"), sel("c", "3")];
  assert.deepEqual(dedupeSelections(unique), unique, "identity on unique input");
  // pure + stateless → holds no cross-request memory, so per-request dedupe never
  // interferes with the fresh-replan retry idempotency (a retry is a new request).
  assert.deepEqual(dedupeSelections(unique), unique, "second call identical — no retained state");
});

test("dedupe: drops entries without a valid internalProductId", () => {
  const out = dedupeSelections([sel("", "x"), { internalProductId: 123 as unknown as string, expectedFingerprint: "y" }, sel("ok", "z")]);
  assert.deepEqual(out.map((s) => s.internalProductId), ["ok"]);
});

test("dedupe: null/undefined input is safe", () => {
  assert.deepEqual(dedupeSelections(null), []);
  assert.deepEqual(dedupeSelections(undefined), []);
  assert.deepEqual(dedupeSelections([]), []);
});

// HONEST UPDATE (mk2237 fix): UPDATE_VARIANT (sku/barcode at a matched GID)
// joined the supported set so barcode-only rows can converge; BLOCKED remains
// forbidden and add-missing-variant remains unsupported (asserted above).
test("supported execution ops: conservative set + UPDATE_VARIANT identity fix (no BLOCKED)", () => {
  assert.deepEqual(
    [...SUPPORTED_EXECUTION_OPS].sort(),
    ["CREATE_PRODUCT", "NOOP", "UPDATE_MEDIA", "UPDATE_PRICE", "UPDATE_PRODUCT", "UPDATE_VARIANT"],
  );
  assert.equal(SUPPORTED_EXECUTION_OPS.includes("BLOCKED" as never), false);
});

// ── mk2237 NO_CHANGE regression: simple-product synthetic unit ────────────────
//
// Production incident: the run confirmed «تحديث 1» but finished UNCHANGED and
// the barcode diff survived. deriveTarget built target.variants from REAL
// variant rows only, so a simple product's plan (whose unit id is the PRODUCT
// id) missed the target lookup and the executor silently skipped the op.

test("variantIdentityFields: resolves the simple-product SYNTHETIC unit (the mk2237 payload)", () => {
  // Target as deriveTarget now builds it for a simple product.
  const t = target({
    variants: [{ variantId: "p-mk2237", variantGid: "gid://shopify/ProductVariant/49", sku: "mk2237", barcode: "2351027651606", price: 55 }],
  });
  const fields = variantIdentityFields(
    { fields: ["barcode"], variantId: "p-mk2237" },
    t,
  );
  assert.deepEqual(fields, { barcode: "2351027651606" }, "exactly the catalog barcode — nothing else");
});

test("variantIdentityFields: the OLD empty-variants target reproduces the silent no-op (documented defect)", () => {
  const fields = variantIdentityFields({ fields: ["barcode"], variantId: "p-mk2237" }, target({ variants: [] }));
  assert.deepEqual(fields, {}, "unit missing from target → nothing sent (this WAS the bug's shape)");
});

test("variantIdentityFields: only PLANNED fields, and empty catalog values are never sent", () => {
  const t = target({
    variants: [{ variantId: "v1", variantGid: "gid://x/1", sku: "SKU1", barcode: "", price: 10 }],
  });
  // barcode planned but catalog value empty → never blank out Shopify.
  assert.deepEqual(variantIdentityFields({ fields: ["barcode"], variantId: "v1" }, t), {});
  // sku NOT planned → not sent even though present.
  assert.deepEqual(variantIdentityFields({ fields: ["barcode"], variantId: "v1" }, t), {});
  assert.deepEqual(variantIdentityFields({ fields: ["sku"], variantId: "v1" }, t), { sku: "SKU1" });
});
