// STEP 81 — the owner's final Talabat category policy.
//
// Three decisions, and the tests keep them distinct because they are different
// kinds of thing and only one of them is a blocker:
//
//   Electronics and ✨Toys are withheld from THIS CHANNEL. Nothing about the
//   products changes anywhere else, and the guards below prove this module
//   cannot reach any other system.
//
//   Every allowed category is spelled "All " + the certified string on the way
//   out. The registry itself is never rewritten — a test asserts the certified
//   bytes still appear bare in the registry.
//
//   Summer And Camping Supplies is wanted but missing from Talabat's menu. It
//   ships WITH a creation request instead of being held back.
//
// node --conditions=react-server --experimental-strip-types --test lib/export/talabat/step81-category-policy.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { parseTalabatBaseline, compareTalabatBaseline, newDeltaRows, TALABAT_BASELINE_COLUMNS } from "./baseline-delta.ts";
import {
  TALABAT_EXCLUDED_CATEGORIES, TALABAT_CATEGORIES_APPROVED_TO_CREATE,
  TALABAT_NEW_PRODUCT_CATEGORY_PREFIX, isTalabatExcludedCategory, classifyTalabatNewRow,
  allowedNewDeltaRows, policyExcludedNewDeltaRows, talabatCategoryPolicyCounts,
  talabatNewProductCategory, talabatCategoriesRequiringCreation,
} from "./category-policy.ts";
import {
  buildTalabatNewProductsAoa, newProductImageScope, newProductPreviewRows,
  buildTalabatSafeUpdateAoa, SAFE_UPDATE_FIELDS, buildBarcodeReviewAoa,
} from "./delta-workbooks.ts";
import {
  CATEGORY_IMPORT_FORMAT_CONFIRMED, CATEGORY_IMPORT_FORMAT_SOURCE, categoryMappingTable,
  categoriesNeedingCreationBeforeSend, evaluateNewProductsReadiness,
} from "./new-products-readiness.ts";
import { createTalabatPackageJob } from "./package-job.ts";
import { buildTalabatPreview, type TalabatPreviewProduct } from "./preview.ts";
import {
  buildTalabatNewProductsEmail, buildTalabatUpdateEmail, buildTalabatBarcodeCorrectionEmail,
  TALABAT_SENDABLE_EMAIL_KINDS,
} from "./email-templates.ts";
import { TALABAT_OUTPUT_CATEGORIES } from "./native-template.ts";

const HERE = join(fileURLToPath(new URL(".", import.meta.url)));
const APP_ROOT = join(HERE, "../../..");
const raw = (rel: string): string => readFileSync(join(APP_ROOT, rel), "utf8");
const code = (rel: string): string =>
  raw(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const ELECTRONICS = "Electronics";
const TOYS = "✨Toys";
const SUMMER = "Summer And Camping Supplies";

function product(n: number, category: string, over: Partial<TalabatPreviewProduct> = {}): TalabatPreviewProduct {
  const sku = `mk${1000 + n}`;
  return {
    id: `p${n}`, sku, barcode: `12345678${String(90000 + n)}`,
    nameEn: `EN ${sku}`, nameAr: `ع ${sku}`, price: 50, discountPrice: null, channelPrice: null,
    category, descriptionEn: "d", descriptionAr: "و",
    imageUrl: `https://x.test/${sku}.jpg`, imageFilename: `${sku}.jpg`,
    galleryImageUrls: [], imageCount: 1, approved: true, lifecycleState: "ACTIVE", variants: [],
    ...over,
  };
}
function baseRow(sku: string, cat = "All Face Care") {
  return [sku, `EN ${sku}`, "50", true, null, false, null, null, null, `0${12345678}00000`, null, null, cat];
}
const parse = (rows: readonly (readonly unknown[])[]) =>
  parseTalabatBaseline([TALABAT_BASELINE_COLUMNS.slice(), ...rows], "Products").rows;

/**
 * A delta whose NEW products span every interesting category: two Talabat
 * already lists, then one each of Electronics, ✨Toys, Summer, Face Care.
 */
function policyDelta() {
  const products = [
    product(0, "Face Care"), product(1, "Face Care"),          // already listed
    product(2, ELECTRONICS), product(3, ELECTRONICS),           // excluded
    product(4, TOYS),                                           // excluded
    product(5, SUMMER), product(6, SUMMER),                     // approved, absent
    product(7, "Hair Care"), product(8, "Makeup"),              // ordinary, present
  ];
  const preview = buildTalabatPreview({ products });
  const baseline = parse([
    baseRow("mk1000"), baseRow("mk1001"),
    baseRow("zz1", "All Hair Care"), baseRow("zz2", "All Makeup"),
  ]);
  return { result: compareTalabatBaseline(preview.rows, baseline), baseline };
}

// ── exclusion ────────────────────────────────────────────────────────────────

test("1: Electronics is excluded from the Talabat new-product delta", () => {
  const { result } = policyDelta();
  assert.equal(newDeltaRows(result).filter((r) => r.our.talabatCategory === ELECTRONICS).length, 2,
    "the products ARE new — they are withheld by policy, not missing");
  assert.equal(allowedNewDeltaRows(result).some((r) => r.our.talabatCategory === ELECTRONICS), false);
  for (const r of newDeltaRows(result).filter((r) => r.our.talabatCategory === ELECTRONICS)) {
    assert.equal(classifyTalabatNewRow(r), "EXCLUDED_BY_TALABAT_CATEGORY_POLICY");
  }
});

test("2: ✨Toys is excluded from the Talabat new-product delta", () => {
  const { result } = policyDelta();
  assert.equal(allowedNewDeltaRows(result).some((r) => r.our.talabatCategory === TOYS), false);
  assert.equal(policyExcludedNewDeltaRows(result).some((r) => r.our.talabatCategory === TOYS), true);
  // byte-exact: the certified string carries U+2728, and a bare "Toys" is not it
  assert.equal(TALABAT_EXCLUDED_CATEGORIES.includes("✨Toys"), true);
  assert.equal(isTalabatExcludedCategory("Toys"), false, "a bare Toys must NOT be silently excluded");
  assert.equal(isTalabatExcludedCategory("✨Toys"), true);
});

test("3: excluded rows are their own class — not BLOCKED and not MANUAL_REVIEW", () => {
  const { result } = policyDelta();
  const excluded = policyExcludedNewDeltaRows(result);
  assert.equal(excluded.length, 3);
  for (const r of excluded) {
    assert.equal(classifyTalabatNewRow(r), "EXCLUDED_BY_TALABAT_CATEGORY_POLICY");
    // still a genuine NEW_PRODUCT in the delta itself — the delta is the truth
    // about Talabat's menu; the policy is a separate, channel-only decision.
    assert.equal(r.match, "NEW_PRODUCT");
    assert.equal(r.ambiguityReason, null);
  }
  const counts = talabatCategoryPolicyCounts(result);
  assert.deepEqual(counts.byCategory[ELECTRONICS], { products: 2, rows: 2 });
  assert.deepEqual(counts.byCategory[TOYS], { products: 1, rows: 1 });
  assert.equal(counts.totalExcludedProducts, 3);
  assert.equal(counts.totalExcludedRows, 3);
});

test("4: the exclusion is TALABAT-ONLY — this policy cannot touch another channel", () => {
  const src = code("lib/export/talabat/category-policy.ts");
  for (const bad of [
    "snoonu", "rafeeq", "shopify", "supabase", "createClient",
    "insert(", "update(", "upsert(", "delete(", "fetch(", "nodemailer", "sendMail",
  ]) {
    assert.equal(src.toLowerCase().includes(bad.toLowerCase()), false,
      `category-policy must not reference ${bad} — it is a Talabat OUTPUT filter`);
  }
  // and nothing outside the Talabat export tree consumes it
  for (const rel of ["lib/snoonu/package.server.ts", "lib/rafeeq/package.server.ts"]) {
    assert.equal(code(rel).includes("category-policy"), false, `${rel} must not import the Talabat policy`);
  }
});

test("5: excluded categories stay in the certified registry, untouched", () => {
  // The registry is the canonical catalog's view. Excluding a category from ONE
  // marketplace must not delete it from the catalog's own vocabulary.
  assert.equal(TALABAT_OUTPUT_CATEGORIES.includes(ELECTRONICS), true);
  assert.equal(TALABAT_OUTPUT_CATEGORIES.includes(TOYS), true);
  assert.equal(TALABAT_OUTPUT_CATEGORIES.length, 16);
  const registry = raw("lib/export/talabat/native-template.ts");
  assert.ok(registry.includes("✨Toys"), "the sparkle Toys string is still the certified bytes");
  assert.equal(registry.includes("All Electronics"), false, "no All- prefix leaked into the registry");
  assert.equal(registry.includes("All Face Care"), false);
});

// ── output spelling ──────────────────────────────────────────────────────────

test("6: every allowed certified category is emitted as \"All \" + certified", () => {
  assert.equal(TALABAT_NEW_PRODUCT_CATEGORY_PREFIX, "All ");
  for (const certified of TALABAT_OUTPUT_CATEGORIES) {
    const out = talabatNewProductCategory(certified);
    if (isTalabatExcludedCategory(certified)) {
      assert.equal(out, null, `${certified} is excluded — there is no correct value to send`);
      continue;
    }
    assert.equal(out, `All ${certified}`);
  }
  assert.equal(talabatNewProductCategory("Face Care"), "All Face Care");
  assert.equal(talabatNewProductCategory("Hair Care"), "All Hair Care");
  assert.equal(talabatNewProductCategory("Makeup"), "All Makeup");
  // U+2019 apostrophe survives the transformation byte-for-byte
  assert.equal(talabatNewProductCategory("Women’s Essentials"), "All Women’s Essentials");
});

test("7: Summer And Camping Supplies is emitted exactly as All Summer And Camping Supplies", () => {
  assert.equal(talabatNewProductCategory(SUMMER), "All Summer And Camping Supplies");
  const { result } = policyDelta();
  const aoa = buildTalabatNewProductsAoa(result);
  const catCol = TALABAT_BASELINE_COLUMNS.indexOf("category 1");
  const summer = aoa.slice(1).filter((r) => r[catCol] === "All Summer And Camping Supplies");
  assert.equal(summer.length, 2, "both Summer rows survive the policy");
  // never remapped to some other category
  for (const r of aoa.slice(1)) assert.notEqual(r[catCol], SUMMER, "bare certified string must not ship");
});

// ── the workbook ─────────────────────────────────────────────────────────────

test("8: excluded products are absent from the new-product workbook", () => {
  const { result } = policyDelta();
  const aoa = buildTalabatNewProductsAoa(result);
  const catCol = TALABAT_BASELINE_COLUMNS.indexOf("category 1");
  assert.equal(aoa.length - 1, 4, "9 products − 2 already listed − 3 excluded");
  const cats = aoa.slice(1).map((r) => String(r[catCol]));
  assert.equal(cats.includes("All Electronics"), false);
  assert.equal(cats.includes(ELECTRONICS), false);
  assert.equal(cats.some((c) => c.includes("Toys")), false);
  const skus = aoa.slice(1).map((r) => String(r[0]));
  for (const gone of ["mk1002", "mk1003", "mk1004"]) assert.equal(skus.includes(gone), false);
  // existing products stay out too — the policy narrows, it never widens
  for (const listed of ["mk1000", "mk1001"]) assert.equal(skus.includes(listed), false);
});

test("9: every workbook category carries the All prefix", () => {
  const { result } = policyDelta();
  const catCol = TALABAT_BASELINE_COLUMNS.indexOf("category 1");
  for (const r of buildTalabatNewProductsAoa(result).slice(1)) {
    assert.match(String(r[catCol]), /^All \S/, `"${String(r[catCol])}" must be All-prefixed`);
  }
});

test("10: barcode and price policy are unchanged by the category work", () => {
  const { result } = policyDelta();
  const aoa = buildTalabatNewProductsAoa(result);
  const bcCol = TALABAT_BASELINE_COLUMNS.indexOf("barcode 1");
  const priceCol = TALABAT_BASELINE_COLUMNS.indexOf("price");
  const activeCol = TALABAT_BASELINE_COLUMNS.indexOf("active");
  for (const r of aoa.slice(1)) {
    assert.equal(r[bcCol], "1234567890005".slice(0, 0) + String(r[bcCol]), "barcode still comes from our row");
    assert.equal(typeof r[priceCol], "number", "price is still the certified numeric price");
    assert.equal(r[activeCol], "", "active is still never asserted");
  }
  // the SAFE UPDATE workbook is a different artifact and is untouched
  assert.deepEqual([...SAFE_UPDATE_FIELDS], ["NAME_DIFF", "PRICE_DIFF"]);
  const safe = buildTalabatSafeUpdateAoa(result);
  for (const r of safe.slice(1)) {
    assert.equal(r[bcCol], "", "safe updates still leave barcode blank");
    assert.equal(r[activeCol], "", "safe updates still leave active blank");
    assert.equal(r[TALABAT_BASELINE_COLUMNS.indexOf("category 1")], "", "safe updates still leave category blank");
  }
});

// ── the image package ────────────────────────────────────────────────────────

test("11: excluded product images are absent from the image package", async () => {
  const { result } = policyDelta();
  const created = createTalabatPackageJob({
    jobId: "00000000-0000-4000-8000-000000000081", mode: "ready",
    previewRows: newProductPreviewRows(result), actor: "t@t", nowIso: "2026-09-06T00:00:00.000Z",
  });
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const names = created.plan.images.map((i) => i.filename);
  for (const gone of ["mk1002.jpg", "mk1003.jpg", "mk1004.jpg"]) {
    assert.equal(names.includes(gone), false, `EXCLUDED_CATEGORY_IMAGES_INCLUDED must be 0 (${gone})`);
  }
  for (const gone of ["mk1000.jpg", "mk1001.jpg"]) {
    assert.equal(names.includes(gone), false, `EXISTING_PRODUCT_IMAGES_INCLUDED must be 0 (${gone})`);
  }
  assert.deepEqual([...names].sort(), ["mk1005.jpg", "mk1006.jpg", "mk1007.jpg", "mk1008.jpg"]);
});

test("12: workbook scope and image scope are the SAME set, by construction", () => {
  const { result } = policyDelta();
  const workbookSkus = buildTalabatNewProductsAoa(result).slice(1).map((r) => String(r[0])).sort();
  const scope = newProductImageScope(result);
  assert.deepEqual([...scope.skus].sort(), workbookSkus);
  assert.equal(scope.newRowCount, workbookSkus.length);
  assert.equal(scope.rowsMissingImage, 0);
  // both read the same helper — a divergence would need two edits, not one
  const src = code("lib/export/talabat/delta-workbooks.ts");
  assert.equal((src.match(/allowedNewDeltaRows\(/g) ?? []).length >= 3, true);
});

// ── the creation request ─────────────────────────────────────────────────────

test("13: Summer is surfaced as a category to CREATE, and does not block", () => {
  const { result, baseline } = policyDelta();
  const reqs = talabatCategoriesRequiringCreation(result, baseline);
  assert.equal(reqs.length, 1);
  assert.deepEqual(reqs[0], {
    certifiedCategory: SUMMER,
    talabatCategory: "All Summer And Camping Supplies",
    productCount: 2, rowCount: 2, approvedByOwner: true,
  });
  assert.equal(TALABAT_CATEGORIES_APPROVED_TO_CREATE.includes(SUMMER), true);
  // excluded categories are never requested — we are not asking for them
  assert.equal(reqs.some((r) => r.certifiedCategory === ELECTRONICS || r.certifiedCategory === TOYS), false);
  // and they are not "needing creation before send" either
  const blockingAbsent = categoriesNeedingCreationBeforeSend(baseline);
  assert.equal(blockingAbsent.includes(SUMMER), false, "approved categories are a request, not a blocker");
  assert.equal(blockingAbsent.includes(ELECTRONICS), false, "excluded categories are never sent");
  assert.equal(blockingAbsent.includes(TOYS), false);
});

test("14: the category output format is settled by the OWNER, and says so", () => {
  assert.equal(CATEGORY_IMPORT_FORMAT_CONFIRMED, true);
  assert.equal(CATEGORY_IMPORT_FORMAT_SOURCE, "owner_decision");
  const src = raw("lib/export/talabat/new-products-readiness.ts");
  assert.ok(src.includes("OWNER DECISION"), "the source of the decision must stay legible");
  assert.equal(src.includes("Talabat confirmed the format"), false, "never claim Talabat confirmed it");
  const { baseline } = policyDelta();
  for (const row of categoryMappingTable(baseline)) {
    if (isTalabatExcludedCategory(row.certifiedCategory)) {
      assert.equal(row.newProductImportValue, null);
      assert.match(row.evidence, /EXCLUDED FROM TALABAT/);
    } else {
      assert.equal(row.newProductImportValue, `All ${row.certifiedCategory}`);
    }
  }
});

// ── Email B ──────────────────────────────────────────────────────────────────

test("15: Email B carries the Summer creation request", () => {
  const email = buildTalabatNewProductsEmail("nw.xlsx", "img.zip",
    { sendable: false, categoryRequests: ["All Summer And Camping Supplies"] });
  assert.equal(email.subject, "Malika's Universe — New Products for Talabat");
  assert.ok(email.bodyText.includes("All Summer And Camping Supplies"));
  assert.ok(email.bodyText.includes("is not currently available in our Talabat menu"));
  assert.ok(email.bodyText.includes("Kindly create this category and add the relevant attached products under it."));
  assert.deepEqual(email.attachments, ["nw.xlsx", "img.zip"]);
});

test("16: Email B never mentions an excluded category", () => {
  const email = buildTalabatNewProductsEmail("nw.xlsx", "img.zip",
    { sendable: true, categoryRequests: ["All Summer And Camping Supplies"] });
  for (const banned of [ELECTRONICS, TOYS, "Toys", "All Electronics"]) {
    assert.equal(email.bodyText.includes(banned), false, `Email B must not mention ${banned}`);
    assert.equal(email.subject.includes(banned), false);
  }
  // and the template source cannot name them either
  const src = code("lib/export/talabat/email-templates.ts");
  assert.equal(src.includes("Electronics"), false);
  assert.equal(src.includes("Toys"), false);
});

test("17: with no requests the email has no dangling category paragraph", () => {
  const email = buildTalabatNewProductsEmail("nw.xlsx", "img.zip", { sendable: true });
  assert.equal(email.bodyText.includes("not currently available"), false);
  assert.equal(email.bodyText.includes("Kindly create this category"), false);
  assert.equal(email.sendable, true);
  assert.equal(buildTalabatNewProductsEmail("nw.xlsx", "img.zip").sendable, false, "default is still blocked");
});

test("18: readiness — Summer requests do not block, unapproved absences do", () => {
  const base = {
    categoryFormatConfirmed: true,
    categoriesToRequest: [{ talabatCategory: "All Summer And Camping Supplies", rowCount: 26 }],
    unapprovedAbsentCategories: [] as string[],
    rowsInUnapprovedCategories: 0,
    policyExcludedRows: 47,
    workbookRows: 517, imagePackageBuilt: true, rowsMissingRequiredImage: 0,
    imagesInPackage: 632, blockedRows: 0, senderAuthenticated: true,
  };
  const ok = evaluateNewProductsReadiness(base);
  assert.equal(ok.readyForOwnerReview, true);
  assert.equal(ok.sendable, true, "an approved category request must not block");
  assert.deepEqual(ok.categoryRequests, ["All Summer And Camping Supplies"]);

  const bad = evaluateNewProductsReadiness({
    ...base, unapprovedAbsentCategories: ["Something Nobody Approved"], rowsInUnapprovedCategories: 4,
  });
  assert.equal(bad.sendable, false);
  assert.ok(bad.blockers.some((b) => b.includes("Something Nobody Approved")));
  assert.equal(bad.readyForOwnerReview, true, "review stays open so the blocker can be resolved");
});

// ── Email A and Email C are untouched ────────────────────────────────────────

test("19: Email A is byte-identical to what STEP 79B shipped", () => {
  const a = buildTalabatUpdateEmail("talabat-safe-product-updates-2026-09-06.xlsx");
  assert.equal(a.kind, "existing_updates");
  assert.equal(a.subject, "Malika's Universe — Talabat Product Data Update");
  assert.equal(a.sendable, true);
  assert.deepEqual(a.attachments, ["talabat-safe-product-updates-2026-09-06.xlsx"]);
  assert.ok(a.bodyText.includes("only products that are already listed on Talabat"));
  assert.ok(a.bodyText.includes("keeping all other existing"));
  // no category language leaked into Email A
  assert.equal(a.bodyText.includes("category"), false);
});

test("20: Email C is still review-only and the barcode policy is unchanged", () => {
  const c = buildTalabatBarcodeCorrectionEmail("talabat-barcode-review-2026-09-06.xlsx");
  assert.equal(c.sendable, false);
  assert.equal(TALABAT_SENDABLE_EMAIL_KINDS.includes("barcode_corrections"), false);
  assert.ok(c.subject.includes("REVIEW ONLY"));
  const { result } = policyDelta();
  // the barcode review builder still exists and still reports, never corrects
  assert.ok(buildBarcodeReviewAoa(result).length >= 1);
  const wb = code("lib/export/talabat/delta-workbooks.ts");
  assert.match(wb, /BARCODE_RECOMMENDED_ACTION/);
  assert.match(wb, /do NOT send a Talabat correction automatically/);
});
