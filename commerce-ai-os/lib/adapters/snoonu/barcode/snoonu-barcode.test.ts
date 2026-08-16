// CH.6D — Snoonu barcode completion unit tests (pure modules + source + writer).
// node --conditions=react-server --experimental-strip-types --test lib/adapters/snoonu/barcode/snoonu-barcode.test.ts

import test from "node:test";
import assert from "node:assert/strict";

import { normalizeBarcode, isBarcodeEmpty, isSyntacticallyValidBarcode } from "./snoonu-barcode-normalize.ts";
import {
  classifyBarcode,
  summarizeBarcode,
  type BarcodeCandidate,
  type BarcodeEvidence,
} from "./snoonu-barcode-diff.ts";
import { planBarcodeApply, targetKey } from "./snoonu-barcode-plan.ts";
import { createSnoonuBarcodeSource } from "./barcode-source.server.ts";
import { writeProductBarcode, writeVariantBarcode, type BarcodeWriteClient } from "../../../products/barcode-write.ts";

const M = "snoonu:malikas" as const;
const P = "snoonu:pure_seoul" as const;
const never = () => false;

// ── normalize ────────────────────────────────────────────────────────────────
test("normalize preserves leading zeros and never numerically coerces", () => {
  assert.equal(normalizeBarcode("  012345678  "), "012345678");
  assert.equal(normalizeBarcode("007"), "007");
  assert.equal(normalizeBarcode(12345678), "12345678");
  assert.equal(normalizeBarcode(""), null);
  assert.equal(normalizeBarcode("   "), null);
  assert.equal(normalizeBarcode(null), null);
  assert.equal(normalizeBarcode(undefined), null);
});

test("isBarcodeEmpty / isSyntacticallyValidBarcode reuse the catalog rules", () => {
  assert.equal(isBarcodeEmpty(null), true);
  assert.equal(isBarcodeEmpty(" 1 "), false);
  // loose 6–14 digit shape is catalog-supported
  assert.equal(isSyntacticallyValidBarcode("12345678"), true);
  assert.equal(isSyntacticallyValidBarcode("01234567"), true); // leading zero kept
  // too short / non-digit → invalid, never coerced
  assert.equal(isSyntacticallyValidBarcode("123"), false);
  assert.equal(isSyntacticallyValidBarcode("12ab56"), false);
});

// ── classify: helpers ────────────────────────────────────────────────────────
function candidate(over: Partial<BarcodeCandidate> & { evidence: BarcodeEvidence[] }): BarcodeCandidate {
  return {
    targetKind: "product", productId: "p1", variantId: null, sku: "mk1", name: "Item",
    currentBarcode: null, ...over,
  };
}

// ── product / variant completion, single-store ───────────────────────────────
test("product barcode completion from one storefront → AUTO_COMPLETABLE (product grain)", () => {
  const r = classifyBarcode(candidate({ evidence: [{ storefront: M, spi: "spiM", rawBarcode: "12345678" }] }), never);
  assert.equal(r.status, "AUTO_COMPLETABLE");
  assert.equal(r.targetKind, "product");
  assert.equal(r.incoming, "12345678");
  assert.equal(r.actionable, true);
  assert.deepEqual(r.evidenceStorefronts, [M]);
});

test("variant barcode completion → AUTO_COMPLETABLE (variant grain)", () => {
  const r = classifyBarcode(candidate({ targetKind: "variant", variantId: "v1", evidence: [{ storefront: P, spi: "spiP", rawBarcode: "87654321" }] }), never);
  assert.equal(r.status, "AUTO_COMPLETABLE");
  assert.equal(r.targetKind, "variant");
  assert.equal(r.variantId, "v1");
  assert.equal(r.incoming, "87654321");
});

test("Malikas-only and Pure-Seoul-only deterministic sources are each eligible", () => {
  assert.equal(classifyBarcode(candidate({ evidence: [{ storefront: M, spi: "s", rawBarcode: "11111111" }] }), never).status, "AUTO_COMPLETABLE");
  assert.equal(classifyBarcode(candidate({ evidence: [{ storefront: P, spi: "s", rawBarcode: "22222222" }] }), never).status, "AUTO_COMPLETABLE");
});

// ── multi-store agreement / disagreement ─────────────────────────────────────
test("both stores AGREE → AUTO_COMPLETABLE with both storefronts as evidence", () => {
  const r = classifyBarcode(candidate({ evidence: [
    { storefront: M, spi: "sM", rawBarcode: "55550000" },
    { storefront: P, spi: "sP", rawBarcode: "55550000" },
  ] }), never);
  assert.equal(r.status, "AUTO_COMPLETABLE");
  assert.equal(r.evidenceStorefronts.length, 2);
});

test("both stores DISAGREE → CONFLICT, never silently picked", () => {
  const r = classifyBarcode(candidate({ evidence: [
    { storefront: M, spi: "sM", rawBarcode: "55550000" },
    { storefront: P, spi: "sP", rawBarcode: "99990000" },
  ] }), never);
  assert.equal(r.status, "CONFLICT");
  assert.equal(r.incoming, null);
  assert.equal(r.actionable, false);
});

test("two distinct listings within ONE store → NEEDS_REVIEW (not 'exactly one')", () => {
  const r = classifyBarcode(candidate({ evidence: [
    { storefront: M, spi: "sM1", rawBarcode: "55550000" },
    { storefront: M, spi: "sM2", rawBarcode: "77770000" },
  ] }), never);
  assert.equal(r.status, "NEEDS_REVIEW");
});

// ── uniqueness / validity / no-mapping / not-found ───────────────────────────
test("internal duplicate barcode → DUPLICATE_INTERNAL (never auto-reassigned)", () => {
  const owned = (bc: string) => bc === "12345678"; // owned by a DIFFERENT item
  const r = classifyBarcode(candidate({ evidence: [{ storefront: M, spi: "s", rawBarcode: "12345678" }] }), owned);
  assert.equal(r.status, "DUPLICATE_INTERNAL");
  assert.equal(r.actionable, false);
});

test("invalid source barcode → INVALID_SOURCE_BARCODE", () => {
  const r = classifyBarcode(candidate({ evidence: [{ storefront: M, spi: "s", rawBarcode: "12ab" }] }), never);
  assert.equal(r.status, "INVALID_SOURCE_BARCODE");
});

test("no active mapping (no evidence) → NEEDS_REVIEW", () => {
  const r = classifyBarcode(candidate({ evidence: [] }), never);
  assert.equal(r.status, "NEEDS_REVIEW");
});

test("mapped but no barcode on any listing → NOT_FOUND", () => {
  const r = classifyBarcode(candidate({ evidence: [{ storefront: M, spi: "s", rawBarcode: null }] }), never);
  assert.equal(r.status, "NOT_FOUND");
});

// ── never overwrite a non-empty internal barcode ─────────────────────────────
test("non-empty internal matching source → UNCHANGED; mismatch → CONFLICT (never overwritten)", () => {
  const match = classifyBarcode(candidate({ currentBarcode: "12345678", evidence: [{ storefront: M, spi: "s", rawBarcode: "12345678" }] }), never);
  assert.equal(match.status, "UNCHANGED");
  assert.equal(match.actionable, false);

  const mismatch = classifyBarcode(candidate({ currentBarcode: "12345678", evidence: [{ storefront: M, spi: "s", rawBarcode: "99990000" }] }), never);
  assert.equal(mismatch.status, "CONFLICT");
  assert.equal(mismatch.actionable, false);
});

// ── leading-zero preservation end-to-end ─────────────────────────────────────
test("leading-zero source barcode is completed verbatim", () => {
  const r = classifyBarcode(candidate({ evidence: [{ storefront: P, spi: "s", rawBarcode: "01234567" }] }), never);
  assert.equal(r.status, "AUTO_COMPLETABLE");
  assert.equal(r.incoming, "01234567");
});

// ── summary ──────────────────────────────────────────────────────────────────
test("summary counts by status and by missing grain", () => {
  const rows = [
    classifyBarcode(candidate({ productId: "p1", evidence: [{ storefront: M, spi: "s", rawBarcode: "12345678" }] }), never),
    classifyBarcode(candidate({ targetKind: "variant", variantId: "v1", productId: "p2", evidence: [{ storefront: M, spi: "s", rawBarcode: "12ab" }] }), never),
    classifyBarcode(candidate({ productId: "p3", evidence: [] }), never),
  ];
  const s = summarizeBarcode(rows);
  assert.equal(s.total, 3);
  assert.equal(s.autoCompletable, 1);
  assert.equal(s.invalidSource, 1);
  assert.equal(s.needsReview, 1);
  assert.equal(s.missingProduct, 2);
  assert.equal(s.missingVariant, 1);
});

// ── plan: idempotency / stale-preview / grain ────────────────────────────────
test("plan: selected AUTO row with empty internal + unique → apply", () => {
  const rows = [classifyBarcode(candidate({ productId: "p1", evidence: [{ storefront: M, spi: "s", rawBarcode: "12345678" }] }), never)];
  const plan = planBarcodeApply({ rows, selected: new Set(["product:p1"]), currentNow: new Map([["product:p1", null]]), isOwnedByOther: never });
  assert.equal(plan.length, 1);
  assert.equal(plan[0].action, "apply");
  assert.equal(plan[0].incoming, "12345678");
});

test("plan: internal barcode filled since preview → unchanged (stale protection)", () => {
  const rows = [classifyBarcode(candidate({ productId: "p1", evidence: [{ storefront: M, spi: "s", rawBarcode: "12345678" }] }), never)];
  const plan = planBarcodeApply({ rows, selected: new Set(["product:p1"]), currentNow: new Map([["product:p1", "99999999"]]), isOwnedByOther: never });
  assert.equal(plan[0].action, "unchanged");
});

test("plan: a new internal owner appeared → needs_review (no overwrite of newer data)", () => {
  const rows = [classifyBarcode(candidate({ productId: "p1", evidence: [{ storefront: M, spi: "s", rawBarcode: "12345678" }] }), never)];
  const plan = planBarcodeApply({ rows, selected: new Set(["product:p1"]), currentNow: new Map([["product:p1", null]]), isOwnedByOther: (bc) => bc === "12345678" });
  assert.equal(plan[0].action, "needs_review");
});

test("plan: non-actionable selected → skip; unselected excluded", () => {
  const conflict = classifyBarcode(candidate({ productId: "p1", evidence: [
    { storefront: M, spi: "sM", rawBarcode: "11110000" }, { storefront: P, spi: "sP", rawBarcode: "22220000" },
  ] }), never);
  const auto = classifyBarcode(candidate({ productId: "p2", evidence: [{ storefront: M, spi: "s", rawBarcode: "12345678" }] }), never);
  const plan = planBarcodeApply({ rows: [conflict, auto], selected: new Set(["product:p1"]), currentNow: new Map(), isOwnedByOther: never });
  assert.equal(plan.length, 1); // only the selected one
  assert.equal(plan[0].action, "skip");
});

test("targetKey separates product and variant grain", () => {
  assert.equal(targetKey({ targetKind: "product", productId: "p1", variantId: null }), "product:p1");
  assert.equal(targetKey({ targetKind: "variant", productId: "p1", variantId: "v9" }), "variant:v9");
});

// ── source default (safe no-op) ──────────────────────────────────────────────
test("default barcode source reports session_required and yields no data", async () => {
  const src = createSnoonuBarcodeSource(M);
  assert.equal(src.storefront, M);
  assert.equal(await src.state(), "session_required");
  assert.equal((await src.barcodeBySpi()).size, 0);
});

// ── narrow write boundary: grain-exact, barcode column only ───────────────────
function fakeWriteClient() {
  const calls: { table: string; values: Record<string, unknown>; col: string; id: string }[] = [];
  const client: BarcodeWriteClient = {
    from(table) {
      return { update(values) { return { eq(col, id) { calls.push({ table, values, col, id }); return Promise.resolve({ error: null }); } }; } };
    },
  };
  return { client, calls };
}

test("writeProductBarcode writes ONLY products.barcode by id", async () => {
  const { client, calls } = fakeWriteClient();
  const r = await writeProductBarcode(client, "p1", "12345678");
  assert.deepEqual(r, { ok: true });
  assert.equal(calls[0].table, "products");
  assert.deepEqual(Object.keys(calls[0].values), ["barcode"]);
  assert.equal(calls[0].values.barcode, "12345678");
  assert.equal(calls[0].col, "id");
  assert.equal(calls[0].id, "p1");
});

test("writeVariantBarcode writes ONLY product_variants.barcode by id", async () => {
  const { client, calls } = fakeWriteClient();
  await writeVariantBarcode(client, "v1", "87654321");
  assert.equal(calls[0].table, "product_variants");
  assert.deepEqual(Object.keys(calls[0].values), ["barcode"]);
});

test("write boundary refuses empty id or empty barcode (never blanks a barcode)", async () => {
  const { client, calls } = fakeWriteClient();
  assert.equal((await writeProductBarcode(client, "", "12345678") as { ok: false }).ok, false);
  assert.equal((await writeProductBarcode(client, "p1", "   ") as { ok: false }).ok, false);
  assert.equal(calls.length, 0);
});
