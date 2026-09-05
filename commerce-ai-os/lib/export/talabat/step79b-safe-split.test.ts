// STEP 79B — barcode changes are split OUT of the normal Talabat update.
//
// Owner decision after reviewing the STEP 79 artifacts: of the 270 barcode
// differences, 126 are rows where Talabat's value passes the EAN check digit
// and ours does not. Submitting those would replace a real manufacturer barcode
// with a synthetic one. So the normal update carries NAME and PRICE only, and
// every barcode difference becomes a separate review artifact.
//
// The tests below exist mostly to make the WRONG thing impossible rather than
// merely absent: the safe workbook must not carry a barcode value even in the
// column, and the barcode email must not be dispatchable.
//
// node --conditions=react-server --experimental-strip-types --test lib/export/talabat/step79b-safe-split.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  parseTalabatBaseline, compareTalabatBaseline, updateDeltaRows, newDeltaRows,
  TALABAT_BASELINE_COLUMNS,
} from "./baseline-delta.ts";
import {
  safeUpdateRows, buildTalabatSafeUpdateAoa, buildBarcodeReviewAoa, barcodeReviewCounts,
  classifyBarcodeDifference, BARCODE_RECOMMENDED_ACTION, BARCODE_REVIEW_COLUMNS,
  SAFE_UPDATE_FIELDS, deltaWorkbookName, buildTalabatNewProductsAoa,
} from "./delta-workbooks.ts";
import {
  buildTalabatBarcodeCorrectionEmail, buildTalabatEmailPair, isTalabatEmailSendable,
  TALABAT_SENDABLE_EMAIL_KINDS,
} from "./email-templates.ts";

const HERE = join(fileURLToPath(new URL(".", import.meta.url)));
const APP_ROOT = join(HERE, "../../..");
const raw = (rel: string): string => readFileSync(join(APP_ROOT, rel), "utf8");
const code = (rel: string): string =>
  raw(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

type Row = Parameters<typeof compareTalabatBaseline>[0][number];
function ourRow(over: Partial<Row> & { sku: string }): Row {
  return {
    sku: over.sku, title: over.title ?? `Name ${over.sku}`, titleAr: "اسم",
    talabatBarcode: over.talabatBarcode ?? "8860504651481",
    talabatCategory: over.talabatCategory ?? "Face Care",
    price: over.price ?? 79, isVariant: over.isVariant ?? false,
    internalProductId: over.internalProductId ?? `p-${over.sku}`,
    variantId: over.variantId ?? null, primaryImageUrl: "https://x.test/a.jpg",
  } as Row;
}
function baseRow(sku: string, over: Partial<{ name: string; price: string; b1: string | null; cat: string }> = {}) {
  return [sku, over.name ?? `Name ${sku}`, over.price ?? "79", true, null, false, null, null, null,
    over.b1 === undefined ? "08860504651481" : over.b1, null, null, over.cat ?? "All Face Care"];
}
const parse = (rows: readonly (readonly unknown[])[]) =>
  parseTalabatBaseline([TALABAT_BASELINE_COLUMNS.slice(), ...rows], "Products").rows;

const H = [...TALABAT_BASELINE_COLUMNS];
const col = (row: readonly unknown[], name: string) => row[H.indexOf(name)];

// valid EAN-13s used deliberately below
const VALID_A = "4006381333931";
const VALID_B = "5901234123457";
const INVALID_A = "4006381333930";
const INVALID_B = "5901234123456";

// ── 1: the safe workbook carries NAME + PRICE and nothing else ──────────────

test("1: SAFE_UPDATE_FIELDS is exactly name and price", () => {
  assert.deepEqual([...SAFE_UPDATE_FIELDS], ["NAME_DIFF", "PRICE_DIFF"]);
});

test("2: a barcode-only difference is NOT in the safe update workbook", () => {
  const r = compareTalabatBaseline(
    [ourRow({ sku: "bconly", talabatBarcode: VALID_A })],
    parse([baseRow("bconly", { b1: `0${VALID_B}` })]));
  assert.equal(r.counts.barcodeDiffs, 1, "the difference is still detected");
  assert.equal(updateDeltaRows(r).length, 1, "and still in the full audit");
  assert.equal(safeUpdateRows(r).length, 0, "but never in the safe update");
  assert.equal(buildTalabatSafeUpdateAoa(r).length, 1, "header only");
});

test("3: the safe workbook NEVER carries a barcode, even for a product it does update", () => {
  // this product changed BOTH price and barcode — the price must go, the barcode must not
  const r = compareTalabatBaseline(
    [ourRow({ sku: "mk1", price: 99, talabatBarcode: VALID_A })],
    parse([baseRow("mk1", { price: "79", b1: `0${VALID_B}` })]));
  const aoa = buildTalabatSafeUpdateAoa(r);
  assert.equal(aoa.length, 2, "header + one row");
  const row = aoa[1];
  assert.equal(col(row, "price"), 99, "the price update is submitted");
  assert.equal(col(row, "barcode 1"), "", "the barcode is BLANK — the withheld change cannot leak");
  assert.equal(col(row, "barcode 2"), "");
  assert.equal(col(row, "barcode 3"), "");
  assert.equal(col(row, "active"), "", "active is never submitted");
  assert.equal(col(row, "category 1"), "", "our category string is not Talabat's menu string");
  // and nowhere in the whole sheet does our barcode appear
  assert.equal(JSON.stringify(aoa).includes(VALID_A), false);
});

test("4: a product with BOTH name and price differences appears ONCE with both values", () => {
  const r = compareTalabatBaseline(
    [ourRow({ sku: "both", title: "New Name", price: 99 })],
    parse([baseRow("both", { name: "Old Name", price: "79" })]));
  const aoa = buildTalabatSafeUpdateAoa(r);
  assert.equal(aoa.length, 2, "one row, not two");
  assert.equal(col(aoa[1], "sku"), "both");
  assert.equal(col(aoa[1], "name"), "New Name");
  assert.equal(col(aoa[1], "price"), 99);
});

test("5: an unchanged field is left blank rather than restated", () => {
  const priceOnly = compareTalabatBaseline(
    [ourRow({ sku: "p", title: "Same", price: 99 })],
    parse([baseRow("p", { name: "Same", price: "79" })]));
  assert.equal(col(buildTalabatSafeUpdateAoa(priceOnly)[1], "name"), "", "name unchanged → blank");

  const nameOnly = compareTalabatBaseline(
    [ourRow({ sku: "n", title: "New", price: 79 })],
    parse([baseRow("n", { name: "Old", price: "79" })]));
  assert.equal(col(buildTalabatSafeUpdateAoa(nameOnly)[1], "price"), "", "price unchanged → blank");
});

test("6: ambiguous and new products never reach the safe update workbook", () => {
  const ambiguous = compareTalabatBaseline([ourRow({ sku: "mk900" })], parse([baseRow("mk898")]));
  assert.equal(safeUpdateRows(ambiguous).length, 0);
  const brandNew = compareTalabatBaseline([ourRow({ sku: "nope", talabatBarcode: "1111111111116" })], parse([baseRow("other")]));
  assert.equal(safeUpdateRows(brandNew).length, 0);
  assert.equal(buildTalabatSafeUpdateAoa(brandNew).length, 1, "header only");
});

// ── 2: the barcode review artifact ──────────────────────────────────────────

test("7: every barcode difference is classified into exactly one bucket", () => {
  assert.equal(classifyBarcodeDifference(INVALID_A, `0${VALID_B}`), "TALABAT_VALID_OUR_INVALID");
  assert.equal(classifyBarcodeDifference(VALID_A, `0${VALID_B}`), "BOTH_VALID_DIFFERENT");
  assert.equal(classifyBarcodeDifference(INVALID_A, `0${INVALID_B}`), "NEITHER_VALID");
  assert.equal(classifyBarcodeDifference(VALID_A, `0${INVALID_B}`), "OUR_VALID_TALABAT_INVALID");
  // a missing Talabat barcode cannot be "valid"
  assert.equal(classifyBarcodeDifference(VALID_A, null), "OUR_VALID_TALABAT_INVALID");
});

test("8: the review workbook has the owner's columns and a recommendation per row", () => {
  const r = compareTalabatBaseline(
    [ourRow({ sku: "a", talabatBarcode: INVALID_A }), ourRow({ sku: "b", talabatBarcode: VALID_A })],
    parse([baseRow("a", { b1: `0${VALID_B}` }), baseRow("b", { b1: `0${INVALID_B}` })]));
  const aoa = buildBarcodeReviewAoa(r);
  assert.deepEqual(aoa[0], [...BARCODE_REVIEW_COLUMNS]);
  assert.equal(aoa.length, 3);
  const byS = new Map(aoa.slice(1).map((x) => [x[0], x]));
  assert.equal(byS.get("a")![6], "TALABAT_VALID_OUR_INVALID");
  assert.match(String(byS.get("a")![7]), /VERIFY OUR CANONICAL BARCODE/);
  assert.equal(byS.get("a")![4], "true", "TALABAT_EAN_VALID");
  assert.equal(byS.get("a")![5], "false", "OUR_EAN_VALID");
  assert.equal(byS.get("b")![6], "OUR_VALID_TALABAT_INVALID");
  assert.match(String(byS.get("b")![7]), /CANDIDATE_TALABAT_CORRECTION/);
  assert.match(String(byS.get("b")![7]), /owner review/, "even the candidate needs review");
});

test("9: the four recommended actions never authorise an automatic send", () => {
  for (const [cls, action] of Object.entries(BARCODE_RECOMMENDED_ACTION)) {
    assert.ok(action.length > 0, cls);
    assert.equal(/^SEND\b|AUTO[_ ]?SEND|automatically send/i.test(action), false, `${cls} must not authorise a send`);
  }
  assert.match(BARCODE_RECOMMENDED_ACTION.TALABAT_VALID_OUR_INVALID, /do NOT send/i);
});

test("10: review counts and audit counts describe the same rows", () => {
  const r = compareTalabatBaseline(
    [ourRow({ sku: "a", talabatBarcode: INVALID_A }), ourRow({ sku: "b", talabatBarcode: VALID_A }),
     ourRow({ sku: "c", price: 99 })],
    parse([baseRow("a", { b1: `0${VALID_B}` }), baseRow("b", { b1: `0${INVALID_B}` }), baseRow("c", { price: "79" })]));
  const counts = barcodeReviewCounts(r);
  const total = Object.values(counts).reduce((x, y) => x + y, 0);
  assert.equal(total, r.counts.barcodeDiffs, "every barcode diff is classified exactly once");
  assert.equal(buildBarcodeReviewAoa(r).length - 1, total);
  assert.equal(counts.TALABAT_VALID_OUR_INVALID, 1);
  assert.equal(counts.OUR_VALID_TALABAT_INVALID, 1);
});

// ── 3: the flows stay separate ──────────────────────────────────────────────

test("11: safe updates, new products and barcode review are three disjoint sets", () => {
  const r = compareTalabatBaseline(
    [ourRow({ sku: "safe", price: 99 }),
     ourRow({ sku: "bc", talabatBarcode: VALID_A }),
     ourRow({ sku: "fresh", talabatBarcode: "1111111111116" })],
    parse([baseRow("safe", { price: "79" }), baseRow("bc", { b1: `0${VALID_B}` })]));

  const safe = safeUpdateRows(r).map((x) => x.our.sku);
  const fresh = newDeltaRows(r).map((x) => x.our.sku);
  const bc = buildBarcodeReviewAoa(r).slice(1).map((x) => x[0]);

  assert.deepEqual(safe, ["safe"]);
  assert.deepEqual(fresh, ["fresh"]);
  assert.deepEqual(bc, ["bc"]);
  assert.equal(safe.some((s) => bc.includes(s)), false, "no barcode row in the safe update");
  assert.equal(safe.some((s) => fresh.includes(s)), false, "no new product in the safe update");
  assert.equal(fresh.some((s) => bc.includes(s)), false, "no new product in the barcode review");
  // the new-products workbook is untouched by the split
  assert.equal(buildTalabatNewProductsAoa(r).length, 2, "header + the one new product");
});

test("12: the new workbook names are available", () => {
  assert.equal(deltaWorkbookName("safe-product-updates", "2026-09-05T00:00:00Z"), "talabat-safe-product-updates-2026-09-05.xlsx");
  assert.equal(deltaWorkbookName("barcode-review", "2026-09-05T00:00:00Z"), "talabat-barcode-review-2026-09-05.xlsx");
});

// ── 4: email C cannot be sent ───────────────────────────────────────────────

test("13: the barcode email is REVIEW-ONLY and is not in the sendable set", () => {
  const draft = buildTalabatBarcodeCorrectionEmail("talabat-barcode-review-2026-09-05.xlsx");
  assert.equal(draft.sendable, false);
  assert.equal(isTalabatEmailSendable("barcode_corrections"), false);
  assert.equal(TALABAT_SENDABLE_EMAIL_KINDS.includes("barcode_corrections"), false);
  assert.match(draft.subject, /REVIEW ONLY/);
  assert.match(draft.bodyText, /^REVIEW ONLY/);
  assert.match(draft.bodyText, /No action is\nrequired from your side yet/);
});

test("14: the two authorised flows remain separate; B is gated, A is not", () => {
  const args = {
    updateWorkbookName: "talabat-safe-product-updates-2026-09-05.xlsx",
    newWorkbookName: "talabat-new-products-2026-09-05.xlsx",
    imagesZipName: "talabat-new-products-images-2026-09-05.zip",
  };
  const { updates, newProducts } = buildTalabatEmailPair(args);
  assert.equal(updates.sendable, true, "Email A is unconditionally sendable");
  // STEP 80 turned Email B's `sendable` into a readiness GATE rather than a
  // constant: creating products in a live menu is not self-correcting, so the
  // default is refuse. Both kinds remain AUTHORISED flows (unlike Email C).
  assert.equal(newProducts.sendable, false, "Email B defaults to blocked");
  assert.equal(buildTalabatEmailPair({ ...args, newProductsReadiness: { sendable: true } }).newProducts.sendable, true,
    "and becomes sendable only when readiness says so");
  assert.equal(isTalabatEmailSendable("existing_updates"), true);
  assert.equal(isTalabatEmailSendable("new_products"), true);
  // the pair never carries the barcode review
  const all = [...updates.attachments, ...newProducts.attachments];
  assert.equal(all.some((a) => a.includes("barcode-review")), false);
  // and email A now attaches the SAFE workbook
  assert.deepEqual(updates.attachments, ["talabat-safe-product-updates-2026-09-05.xlsx"]);
});

test("15: nothing in the split can send, and availability is never derived", () => {
  const wb = code("lib/export/talabat/delta-workbooks.ts");
  const em = code("lib/export/talabat/email-templates.ts");
  for (const src of [wb, em]) {
    for (const bad of ["nodemailer", "createTransport", "sendMail", "fetch("]) {
      assert.equal(src.includes(bad), false, `must not reference ${bad}`);
    }
  }
  // the safe builder emits no active value at all
  assert.equal(/ACTIVE_STATUS_DIFF/.test(wb), false, "no availability path in the workbook builders");
  assert.match(wb, /SAFE_UPDATE_FIELDS = \["NAME_DIFF", "PRICE_DIFF"\]/);
});
