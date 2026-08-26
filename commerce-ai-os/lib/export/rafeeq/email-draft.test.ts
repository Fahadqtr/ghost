// RAFEEQ EMAIL DRAFT — owner-contract tests (proofs 1–15 of the post-
// generation UX request). Pure: buildRafeeqEmailDraft is a function of the
// ACTUAL package metadata passed in — these tests prove every required
// sentence, the three-sheet explanation, the option/pricing/image semantics,
// FULL vs NEW vs CORRECTION wording, and that nothing is hardcoded and no
// internal identity leaks.
// node --conditions=react-server --experimental-strip-types --test lib/export/rafeeq/email-draft.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import {
  buildRafeeqEmailDraft,
  RAFEEQ_GUIDE_PNG,
  RAFEEQ_EMAIL_MAX_ATTACH_BYTES,
  type RafeeqEmailContext,
} from "./email-draft.ts";

/** Realistic FULL-package context (values deliberately unlike production). */
function ctx(over: Partial<RafeeqEmailContext> = {}): RafeeqEmailContext {
  return {
    mode: "FULL",
    filename: "rafeeq-full-2026-08-26.zip",
    generatedAt: "2026-08-26T10:00:00.000Z",
    productCount: 137,
    physicalRowCount: 151,
    productsWithOptions: 9,
    optionCount: 23,
    imageCount: 137,
    warningCount: 2,
    zipBytes: 400 * 1024 * 1024,
    correction: null,
    newPackage: null,
    samePriceExample: {
      parentSku: "mk9001",
      title: "Silk Hair Serum",
      options: [
        { name: "50 ml", price: 95 },
        { name: "100 ml", price: 95 },
      ],
    },
    differingPriceExample: {
      parentSku: "mk9002",
      title: "Lash Kit",
      options: [
        { name: "Classic", price: 60 },
        { name: "Volume", price: 85 },
      ],
    },
    ...over,
  };
}

test("1: every count in the draft is the ACTUAL package metadata — subject, summary and Arabic text all carry it", () => {
  const d = buildRafeeqEmailDraft(ctx());
  assert.ok(d.subject.includes("137 products"), "subject uses the real product-identity count");
  assert.ok(d.subject.includes("rafeeq-full-2026-08-26.zip"), "subject names the real file");
  for (const needle of ["137", "151", "9", "23"]) assert.ok(d.html.includes(`<b>${needle}</b>`) || d.html.includes(`<td>${needle}</td>`), `summary table carries ${needle}`);
  assert.ok(d.html.includes("2026-08-26T10:00:00.000Z"), "real generation timestamp");
  assert.ok(d.textAr.includes("137") && d.textAr.includes("151"), "Arabic summary carries the same real counts");
});

test("2: product identities and physical rows are stated SEPARATELY, with the does-NOT-mean sentence", () => {
  const d = buildRafeeqEmailDraft(ctx());
  assert.ok(d.html.includes("Products (product identities)"), "identities labeled as identities");
  assert.ok(d.html.includes("Physical Excel rows"), "physical rows labeled as rows");
  assert.ok(d.html.includes("<b>151 physical rows does NOT mean 151 products.</b>"), "the exact distinction sentence, with real numbers");
});

test("3: the NOT-separate-products sentence is present verbatim", () => {
  const d = buildRafeeqEmailDraft(ctx());
  assert.ok(
    d.html.includes("<b>These repeated rows represent ONE product with multiple options — not separate products.</b>"),
    "required option-model sentence",
  );
  assert.ok(d.textAr.includes("ليست منتجات منفصلة"), "Arabic counterpart present");
});

test("4: the three-sheet workbook is explained — and `data` is named as the sheet to import", () => {
  const d = buildRafeeqEmailDraft(ctx());
  assert.ok(d.html.includes("<b>data</b>"), "data sheet");
  assert.ok(d.html.includes("<b>Malikas Reference</b>"), "reference sheet");
  assert.ok(d.html.includes("<b>Options Overview</b>"), "overview sheet");
  assert.ok(d.html.includes("<b>Use this sheet for the actual import.</b>"), "import instruction points at data");
  assert.ok(d.html.includes("ONLY the products that have options"), "overview scope explained");
});

test("5: same-price example is an inline HTML table built from THIS package's real parent", () => {
  const d = buildRafeeqEmailDraft(ctx());
  assert.ok(d.html.includes("Example A — options with the SAME price"), "example A present");
  assert.ok(d.html.includes("<td>mk9001</td>"), "real parent SKU from the context");
  assert.ok(d.html.includes("<td>50 ml</td>") && d.html.includes("<td>100 ml</td>"), "real option names");
  assert.ok(d.html.includes("<b>These 2 rows represent ONE product with 2 options — not 2 separate products.</b>"), "per-example statement uses the example's own row count");
});

test("6: differing-price example encodes PRICE ON SELECTION with FULL option prices", () => {
  const d = buildRafeeqEmailDraft(ctx());
  assert.ok(d.html.includes("Example B — options with DIFFERENT prices"), "example B present");
  assert.ok(d.html.includes("<td>PRICE ON SELECTION</td>"), "product price column shows PRICE ON SELECTION");
  assert.ok(d.html.includes("<td>60 QAR</td>") && d.html.includes("<td>85 QAR</td>"), "full effective prices per option");
});

test("7: option_price is explained as the FULL selling price — never a surcharge", () => {
  const d = buildRafeeqEmailDraft(ctx());
  assert.ok(
    d.html.includes("<b><code>option_price</code> is the FULL selling price of that selected option, not an additional charge.</b>"),
    "required pricing sentence",
  );
  assert.ok(d.html.includes("never a surcharge/delta"), "pricing-rules section repeats it");
  assert.ok(d.textAr.includes("السعر الكامل للبيع"), "Arabic pricing line");
});

test("8: primary-only original-quality image rules are stated", () => {
  const d = buildRafeeqEmailDraft(ctx());
  assert.ok(d.html.includes("Exactly one primary image per parent product"), "one primary per parent");
  assert.ok(d.html.includes("based on the parent SKU"), "parent-SKU filename");
  assert.ok(d.html.includes("No gallery images and no option/variant-specific images"), "no gallery/variant images");
  assert.ok(d.html.includes("never resizes,\n        recompresses or re-encodes") || /never resizes,\s+recompresses or re-encodes/.test(d.html), "original quality — no re-encoding");
});

test("9: the reading-guide PNG is attached for FULL only, and the text stands on its own without it", () => {
  const full = buildRafeeqEmailDraft(ctx());
  assert.ok(full.attachments.includes(RAFEEQ_GUIDE_PNG), "FULL attaches the guide");
  assert.ok(full.html.includes(RAFEEQ_GUIDE_PNG), "FULL body references the guide");
  assert.ok(full.html.includes("stand on their own if the image is not displayed"), "explicitly readable without the PNG");
  const np = buildRafeeqEmailDraft(ctx({ mode: "NEW", newPackage: { hasSentBaseline: true, equalsWholeCatalog: false } }));
  assert.ok(!np.attachments.includes(RAFEEQ_GUIDE_PNG), "NEW does not attach the guide");
  assert.ok(!np.html.includes(RAFEEQ_GUIDE_PNG), "NEW body does not reference the guide");
});

test("10: no internal UUIDs and no variant SKU/barcode identity in the draft", () => {
  const d = buildRafeeqEmailDraft(ctx());
  const uuidRe = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
  assert.ok(!uuidRe.test(d.html) && !uuidRe.test(d.textAr) && !uuidRe.test(d.subject), "no UUID anywhere");
  assert.ok(!/mk\d+-\d/.test(d.html), "no variant SKU pattern (parent SKUs only)");
  assert.ok(!d.html.toLowerCase().includes("variant sku"), "no variant-SKU wording either");
});

test("11: NEW wording differs by baseline — incremental with a SENT baseline, whole-catalog note without one", () => {
  const withBase = buildRafeeqEmailDraft(ctx({ mode: "NEW", newPackage: { hasSentBaseline: true, equalsWholeCatalog: false } }));
  assert.ok(withBase.subject.includes("New / Pending Products Package"), "NEW subject");
  assert.ok(withBase.html.includes("ONLY the products/updates pending since the last package that was explicitly marked <b>SENT</b>"), "incremental explanation");
  assert.ok(!withBase.html.includes("This package represents the full current Malikas Universe catalog."), "no FULL statement in NEW");
  const noBase = buildRafeeqEmailDraft(ctx({ mode: "NEW", newPackage: { hasSentBaseline: false, equalsWholeCatalog: true } }));
  assert.ok(noBase.html.includes("no SENT baseline exists yet"), "no-baseline note");
  assert.ok(noBase.html.includes("effectively equals the whole current catalog"), "equals-whole-catalog wording");
  assert.ok(noBase.html.includes("we recommend using the FULL catalog package"), "first-upload recommendation");
});

test("11b: FULL carries its required whole-catalog statement", () => {
  const d = buildRafeeqEmailDraft(ctx());
  assert.ok(d.html.includes("<b>This package represents the full current Malikas Universe catalog.</b>"), "required FULL sentence");
});

test("12: CORRECTION context prefixes the subject and carries the disregard sentence + the replaced filename", () => {
  const d = buildRafeeqEmailDraft(ctx({ correction: { previousFilename: "rafeeq-full-2026-08-20.zip" } }));
  assert.ok(d.subject.startsWith("CORRECTED PACKAGE — "), "subject prefix");
  assert.ok(d.html.includes("<b>Please disregard the previous package and use this corrected package instead.</b>"), "required correction sentence");
  assert.ok(d.html.includes("rafeeq-full-2026-08-20.zip"), "previous package named");
  assert.ok(d.textAr.includes("حزمة مصحّحة"), "Arabic correction line");
  const plain = buildRafeeqEmailDraft(ctx());
  assert.ok(!plain.subject.includes("CORRECTED") && !plain.html.includes("disregard the previous package"), "absent without correction context");
});

test("13: attachment checklist + oversized-ZIP handling ('shared separately' sentence)", () => {
  const small = buildRafeeqEmailDraft(ctx({ zipBytes: 5 * 1024 * 1024 }));
  assert.equal(small.zipTooLargeForEmail, false);
  assert.deepEqual(small.attachments, ["rafeeq_catalog.xlsx", RAFEEQ_GUIDE_PNG, "rafeeq-full-2026-08-26.zip"], "small ZIP is listed as a direct attachment");
  assert.ok(!small.html.includes("The full catalog package will be shared separately."), "no separately-note when it fits");

  const big = buildRafeeqEmailDraft(ctx({ zipBytes: RAFEEQ_EMAIL_MAX_ATTACH_BYTES + 1 }));
  assert.equal(big.zipTooLargeForEmail, true);
  assert.ok(big.attachments.some((a) => a.includes("shared separately")), "checklist marks the ZIP as shared separately");
  assert.ok(big.html.includes("<b>The full catalog package will be shared separately.</b>"), "required sentence in the body");
  assert.ok(big.textAr.includes("سيُشارَك بشكل منفصل"), "Arabic note");

  const unknown = buildRafeeqEmailDraft(ctx({ zipBytes: undefined }));
  assert.equal(unknown.zipTooLargeForEmail, true, "unknown size defaults to shared-separately (never over-promises an attachment)");
});

test("14: building a draft is pure and side-effect free — no send, no recipient invented", () => {
  const before = ctx();
  const snapshot = JSON.stringify(before);
  const d = buildRafeeqEmailDraft(before);
  assert.equal(JSON.stringify(before), snapshot, "input context is not mutated");
  assert.equal(d.to, "", "no recipient is invented — the human fills it in");
  const src = String(buildRafeeqEmailDraft);
  for (const bad of ["fetch(", "sendMail", "createTransport", "XMLHttpRequest"]) {
    assert.ok(!src.includes(bad), `builder performs no I/O (${bad})`);
  }
});

test("15: nothing is hardcoded — different metadata produces a fully different draft", () => {
  const a = buildRafeeqEmailDraft(ctx());
  const b = buildRafeeqEmailDraft(ctx({
    filename: "rafeeq-full-2026-09-01.zip",
    productCount: 1400,
    physicalRowCount: 1536,
    productsWithOptions: 61,
    optionCount: 195,
    imageCount: 1400,
    samePriceExample: { parentSku: "mk777", title: "Other", options: [{ name: "A", price: 10 }] },
    differingPriceExample: null,
  }));
  assert.notEqual(a.subject, b.subject);
  assert.ok(b.subject.includes("1,400 products"), "counts follow the metadata");
  assert.ok(b.html.includes("mk777") && !b.html.includes("mk9001"), "examples follow the metadata");
  assert.ok(!b.html.includes("Example B"), "missing example is simply omitted, never faked");
  assert.ok(!a.html.includes("1418") && !a.html.includes("1,418"), "no production count baked into the template");
});
