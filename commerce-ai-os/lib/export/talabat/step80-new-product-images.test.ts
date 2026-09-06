// STEP 80 — the new-product image package, and the category gate on Email B.
//
// Two things are being proved here.
//
// 1. The delta image package is the CERTIFIED pipeline with a narrower input,
//    not a second implementation. The only new code is a row filter; every
//    test below drives createTalabatPackageJob, so naming, gallery rules,
//    dedupe, path safety and the integrity check are exercised as they ship.
//
// 2. Email B cannot be sent while we do not know what value Talabat's
//    new-product importer expects in `category 1`. The live menu stores
//    "All Face Care"; the historical import template used "Face Care". Guessing
//    would create wrongly-categorised products in a live menu, so the unknown
//    is a blocker rather than a default.
//
// node --conditions=react-server --experimental-strip-types --test lib/export/talabat/step80-new-product-images.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { parseTalabatBaseline, compareTalabatBaseline, TALABAT_BASELINE_COLUMNS } from "./baseline-delta.ts";
import { newProductPreviewRows, newProductImageScope, newProductsImagesZipName } from "./delta-workbooks.ts";
import {
  CATEGORY_IMPORT_FORMAT_CONFIRMED, CATEGORY_IMPORT_EVIDENCE, categoryMappingTable,
  categoriesAbsentFromBaseline, evaluateNewProductsReadiness,
} from "./new-products-readiness.ts";
import { createTalabatPackageJob, advanceTalabatPackageJob, type TalabatJobAdvanceDeps } from "./package-job.ts";
import { buildTalabatPreview, type TalabatPreviewProduct } from "./preview.ts";
import {
  buildTalabatNewProductsEmail, buildTalabatEmailPair, buildTalabatBarcodeCorrectionEmail,
  buildTalabatUpdateEmail, isTalabatEmailSendable,
} from "./email-templates.ts";
import { TALABAT_OUTPUT_CATEGORIES } from "./native-template.ts";

const HERE = join(fileURLToPath(new URL(".", import.meta.url)));
const APP_ROOT = join(HERE, "../../..");
const raw = (rel: string): string => readFileSync(join(APP_ROOT, rel), "utf8");
const code = (rel: string): string =>
  raw(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, ...new Array(64).fill(7)]);

function product(n: number, over: Partial<TalabatPreviewProduct> = {}): TalabatPreviewProduct {
  const sku = `mk${1000 + n}`;
  return {
    id: `p${n}`, sku, barcode: `12345678${String(90000 + n)}`,
    nameEn: `EN ${sku}`, nameAr: `ع ${sku}`, price: 50, discountPrice: null, channelPrice: null,
    category: "Face Care", descriptionEn: "d", descriptionAr: "و",
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

/** Build a delta where `newCount` products are absent from the baseline. */
function delta(total: number, existing: number, over: (n: number) => Partial<TalabatPreviewProduct> = () => ({})) {
  const products = Array.from({ length: total }, (_, i) => product(i, over(i)));
  const preview = buildTalabatPreview({ products });
  const baseline = parse(products.slice(0, existing).map((p) => baseRow(p.sku)));
  return { result: compareTalabatBaseline(preview.rows, baseline), preview, baseline };
}

// ── 1: scope — only the new products, never the existing ones ───────────────

test("1: the image scope contains only products absent from the baseline", () => {
  const { result } = delta(6, 4);
  const scope = newProductImageScope(result);
  const rows = newProductPreviewRows(result);
  assert.equal(scope.newDistinctProducts, 2);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.sku).sort(), ["mk1004", "mk1005"]);
  // the four Talabat already lists appear nowhere in the scope
  for (const existing of ["mk1000", "mk1001", "mk1002", "mk1003"]) {
    assert.equal(scope.skus.includes(existing), false, `${existing} is already listed`);
    assert.equal(scope.productIds.includes(`p${existing.slice(-1)}`), false);
  }
});

test("2: the package built from that scope contains ONLY new-product images", async () => {
  const { result } = delta(6, 4);
  const created = createTalabatPackageJob({
    jobId: "00000000-0000-4000-8000-000000000080", mode: "ready",
    previewRows: newProductPreviewRows(result), actor: "t@t", nowIso: "2026-09-05T00:00:00.000Z",
  });
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const names = created.plan.images.map((i) => i.filename);
  assert.equal(names.length, 2, "one primary per new row");
  assert.deepEqual([...names].sort(), ["mk1004.jpg", "mk1005.jpg"]);
  for (const existing of ["mk1000.jpg", "mk1001.jpg", "mk1002.jpg", "mk1003.jpg"]) {
    assert.equal(names.includes(existing), false, `EXISTING_PRODUCT_IMAGES_INCLUDED must be 0 (${existing})`);
  }
});

// ── 2: the certified pipeline is reused, not reimplemented ──────────────────

test("3: gallery rules, naming and dedupe come from the certified planner", async () => {
  const { result } = delta(3, 1, (i) => i >= 1
    ? { galleryImageUrls: [`https://x.test/g${i}a.jpg`, `https://x.test/g${i}b.jpg`] , imageCount: 3 }
    : {});
  const created = createTalabatPackageJob({
    jobId: "00000000-0000-4000-8000-000000000081", mode: "ready",
    previewRows: newProductPreviewRows(result), actor: "t@t", nowIso: "2026-09-05T00:00:00.000Z",
  });
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const imgs = created.plan.images;
  const primary = imgs.filter((i) => i.kind === "primary");
  const gallery = imgs.filter((i) => i.kind === "gallery");
  assert.equal(primary.length, 2, "one primary per new row");
  assert.equal(gallery.length, 4, "certified gallery inclusion, not a reimplementation");
  // certified naming: primary is <sku>.jpg, gallery is <sku>_N.<ext>
  assert.deepEqual(primary.map((i) => i.filename).sort(), ["mk1001.jpg", "mk1002.jpg"]);
  for (const g of gallery) assert.match(g.filename, /^mk100[12]_\d+\.jpg$/);
  // dedupe: every packaged filename is unique
  const names = imgs.map((i) => i.filename);
  assert.equal(new Set(names).size, names.length, "no duplicate paths");
  // path safety
  for (const n of names) assert.equal(/[\/\\]|\.\./.test(n), false, `unsafe path ${n}`);
});

test("4: the delta package runs the same engine to a COMPLETED artifact", async () => {
  const { result } = delta(4, 2);
  const created = createTalabatPackageJob({
    jobId: "00000000-0000-4000-8000-000000000082", mode: "ready",
    previewRows: newProductPreviewRows(result), actor: "t@t", nowIso: "2026-09-05T00:00:00.000Z",
  });
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const store = new Map<string, Uint8Array>();
  const deps: TalabatJobAdvanceDeps = {
    ports: {
      async fetchImage() { return { bytes: JPEG, ext: "jpg" }; },
      async putPart(path, bytes) { store.set(path, bytes); },
    },
    budget: { maxImages: 1 },
  };
  let s = created.state;
  let steps = 0;
  while (s.status === "running" && steps < 60) { s = await advanceTalabatPackageJob(s, created.plan, deps); steps++; }
  assert.equal(s.status, "completed");
  assert.equal(s.packaged.length, 2, "both new-product images packaged");
  assert.notEqual(s.artifact, null, "a real archive was produced");
  assert.equal(s.summary?.integrityOk, true, "the certified integrity check ran and passed");
  assert.ok(store.size > 0, "parts were written");
});

test("5: there is exactly ONE image implementation — the delta adds a filter only", () => {
  const wb = code("lib/export/talabat/delta-workbooks.ts");
  // the delta must not fetch, name, dedupe or zip anything itself
  for (const forbidden of ["fetch(", "JSZip", "deflate", "crc32", "sniffImageExtension", "planRowImages", "resolvePackagedExtension"]) {
    assert.equal(wb.includes(forbidden), false, `delta-workbooks must not contain ${forbidden}`);
  }
  assert.match(wb, /export function newProductPreviewRows/);
  // and the engine has no knowledge of the delta
  const engine = code("lib/export/talabat/package-job.ts");
  assert.equal(/baseline-delta|delta-workbooks|new-products-readiness/.test(engine), false);
});

// ── 3: the category evidence and the gate ───────────────────────────────────

test("6: the 16 certified categories map to the live menu, and 3 are absent", () => {
  const baseline = parse([
    baseRow("a", "All Face Care"), baseRow("b", "All Makeup"), baseRow("c", "All Masks"),
  ]);
  const table = categoryMappingTable(baseline);
  assert.equal(table.length, TALABAT_OUTPUT_CATEGORIES.length, "one row per certified category");
  const face = table.find((r) => r.certifiedCategory === "Face Care")!;
  assert.equal(face.currentBaselineCategory, "All Face Care");
  assert.equal(face.confidence, "high");
  const toys = table.find((r) => r.certifiedCategory === "✨Toys")!;
  assert.equal(toys.currentBaselineCategory, null);
  assert.equal(toys.confidence, "none");
  // STEP 81: still absent from the menu, now also excluded from the channel —
  // the evidence line says which, and the absence itself is unchanged.
  assert.match(toys.evidence, /EXCLUDED FROM TALABAT/);
  assert.ok(categoriesAbsentFromBaseline(baseline).includes("✨Toys"));
  const summer = table.find((r) => r.certifiedCategory === "Summer And Camping Supplies")!;
  assert.equal(summer.currentBaselineCategory, null);
  assert.match(summer.evidence, /owner-approved/);
});

test("7: the import value is emitted only because the OWNER settled the format", () => {
  // STEP 80 emitted nothing here because the evidence was ambiguous. STEP 81
  // did not resolve that ambiguity with new evidence from Talabat — the owner
  // ruled. The flag flips, the evidence record does not, and the source of the
  // decision is recorded so nobody later reads this as Talabat confirmation.
  assert.equal(CATEGORY_IMPORT_FORMAT_CONFIRMED, true);
  const table = categoryMappingTable(parse([baseRow("a", "All Face Care")]));
  for (const r of table) {
    if (r.certifiedCategory === "Electronics" || r.certifiedCategory === "✨Toys") {
      assert.equal(r.newProductImportValue, null, "an excluded category has no correct value to send");
      continue;
    }
    assert.equal(r.newProductImportValue, `All ${r.certifiedCategory}`);
  }
  // the evidence that was ambiguous is kept verbatim, both forms and all
  assert.equal(CATEGORY_IMPORT_EVIDENCE.historicalTemplate.form, "bare");
  assert.equal(CATEGORY_IMPORT_EVIDENCE.currentBaselineExport.form, "All-prefixed");
  assert.match(CATEGORY_IMPORT_EVIDENCE.missingArtifact, /import template/);
  assert.match(CATEGORY_IMPORT_EVIDENCE.resolution, /owner decision/);
});

test("8: the certified registry is NOT changed by this step", () => {
  // the evidence does not prove a different output representation is required,
  // so the resolver keeps emitting exactly what STEP 64 certified.
  assert.ok(TALABAT_OUTPUT_CATEGORIES.includes("Face Care"));
  assert.ok(TALABAT_OUTPUT_CATEGORIES.includes("✨Toys"));
  assert.ok(TALABAT_OUTPUT_CATEGORIES.includes("Women’s Essentials"));
  assert.equal(TALABAT_OUTPUT_CATEGORIES.some((c) => c.startsWith("All ")), false,
    "no 'All ' prefix was baked into the registry on suspicion");
  const registry = code("lib/export/talabat/native-template.ts");
  assert.equal(registry.includes('"All '), false);
});

// ── 4: Email B readiness ────────────────────────────────────────────────────

const READY = {
  categoryFormatConfirmed: true,
  categoriesToRequest: [] as { talabatCategory: string; rowCount: number }[],
  unapprovedAbsentCategories: [] as string[],
  rowsInUnapprovedCategories: 0,
  policyExcludedRows: 0,
  workbookRows: 517, imagePackageBuilt: true, rowsMissingRequiredImage: 0,
  imagesInPackage: 632, blockedRows: 0, senderAuthenticated: true,
};

test("9: Email B is BLOCKED while the category import format is unconfirmed", () => {
  const r = evaluateNewProductsReadiness({ ...READY, categoryFormatConfirmed: false });
  assert.equal(r.sendable, false);
  assert.ok(r.blockers.some((b) => b.includes("CATEGORY_IMPORT_FORMAT_CONFIRMED = NO")));
  // but the owner can still review the artifacts — that is how it gets resolved
  assert.equal(r.readyForOwnerReview, true);
});

test("10: Email B is BLOCKED when the image package is incomplete or absent", () => {
  const missing = evaluateNewProductsReadiness({ ...READY, rowsMissingRequiredImage: 3 });
  assert.equal(missing.sendable, false);
  assert.equal(missing.readyForOwnerReview, false);
  assert.ok(missing.blockers.some((b) => b.includes("3 workbook rows have no packaged image")));

  const unbuilt = evaluateNewProductsReadiness({ ...READY, imagePackageBuilt: false });
  assert.equal(unbuilt.sendable, false);
  assert.equal(unbuilt.readyForOwnerReview, false);
  assert.ok(unbuilt.blockers.some((b) => b.includes("image package has not been built")));
});

test("11: Email B is BLOCKED only for absences NOBODY approved", () => {
  // STEP 80 blocked on any absent category. STEP 81 splits that: Electronics
  // and ✨Toys are excluded from the channel so they never reach readiness at
  // all, and an owner-approved absence ships with a request. What is left —
  // an absence with no decision behind it — still blocks.
  const r = evaluateNewProductsReadiness({
    ...READY, unapprovedAbsentCategories: ["Nobody Approved This"], rowsInUnapprovedCategories: 73,
  });
  assert.equal(r.sendable, false);
  assert.ok(r.blockers.some((b) => b.includes("73 new rows") && b.includes("Nobody Approved This")));

  const requested = evaluateNewProductsReadiness({
    ...READY, categoriesToRequest: [{ talabatCategory: "All Summer And Camping Supplies", rowCount: 26 }],
  });
  assert.equal(requested.sendable, true, "an approved category request is carried, not blocking");
  assert.deepEqual(requested.categoryRequests, ["All Summer And Camping Supplies"]);
});

test("12: Email B is BLOCKED when the sender is not authenticated — review still allowed", () => {
  const r = evaluateNewProductsReadiness({ ...READY, senderAuthenticated: false });
  assert.equal(r.sendable, false);
  assert.equal(r.readyForOwnerReview, true, "an unauthenticated transport does not stop reading a draft");
  assert.ok(r.blockers.some((b) => b.includes("sender identity is not authenticated")));
});

test("13: every condition satisfied → sendable", () => {
  const r = evaluateNewProductsReadiness(READY);
  assert.deepEqual(r.blockers, []);
  assert.equal(r.sendable, true);
  assert.equal(r.readyForOwnerReview, true);
});

test("14: the Email B draft REFUSES to be sendable by default", () => {
  const noArg = buildTalabatNewProductsEmail("n.xlsx", "i.zip");
  assert.equal(noArg.sendable, false, "omitting readiness must not mean 'send it'");
  const blocked = buildTalabatNewProductsEmail("n.xlsx", "i.zip", { sendable: false });
  assert.equal(blocked.sendable, false);
  const allowed = buildTalabatNewProductsEmail("n.xlsx", "i.zip", { sendable: true });
  assert.equal(allowed.sendable, true);
  // and the pair defaults the same way
  const pair = buildTalabatEmailPair({ updateWorkbookName: "u.xlsx", newWorkbookName: "n.xlsx", imagesZipName: "i.zip" });
  assert.equal(pair.newProducts.sendable, false);
  assert.equal(pair.updates.sendable, true, "Email A is unaffected");
});

// ── 5: the other two emails are unchanged ───────────────────────────────────

test("15: Email C stays non-sendable and Email A stays exactly as it was", () => {
  const c = buildTalabatBarcodeCorrectionEmail("talabat-barcode-review-2026-09-05.xlsx");
  assert.equal(c.sendable, false);
  assert.equal(isTalabatEmailSendable("barcode_corrections"), false);
  assert.match(c.subject, /REVIEW ONLY/);

  const a = buildTalabatUpdateEmail("talabat-safe-product-updates-2026-09-05.xlsx");
  assert.equal(a.sendable, true);
  assert.equal(a.subject, "Malika's Universe — Talabat Product Data Update");
  assert.deepEqual(a.attachments, ["talabat-safe-product-updates-2026-09-05.xlsx"]);
  assert.match(a.bodyText, /only products that are already listed on Talabat/);
});

test("16: the safe update workbook builder is untouched by STEP 80", () => {
  const wb = code("lib/export/talabat/delta-workbooks.ts");
  assert.match(wb, /SAFE_UPDATE_FIELDS = \["NAME_DIFF", "PRICE_DIFF"\]/);
  assert.match(wb, /export function buildTalabatSafeUpdateAoa/);
  // barcode policy untouched
  assert.match(wb, /BARCODE_RECOMMENDED_ACTION/);
  assert.match(wb, /do NOT send a Talabat correction automatically/);
});

test("17: the zip name matches the owner's convention", () => {
  assert.equal(newProductsImagesZipName("2026-09-05T12:00:00Z"), "talabat-new-products-images-2026-09-05.zip");
});

test("18: nothing in the new modules can send mail or write to a marketplace", () => {
  for (const rel of ["lib/export/talabat/new-products-readiness.ts", "lib/export/talabat/delta-workbooks.ts"]) {
    const src = code(rel);
    for (const bad of ["nodemailer", "createTransport", "sendMail", "supabase", "insert(", "update(", "upsert("]) {
      assert.equal(src.includes(bad), false, `${rel} must not contain ${bad}`);
    }
  }
});

// ── 19: the extension correction is OPT-IN, and off by default ─────────────
//
// STEP 80 recorded the finding: the certified planner names each file from the
// SOURCE URL while the fetch port sniffs the bytes only to decide they are an
// image, so 133 of the 720 new-product files carried a .jpg name over PNG
// bytes. STEP 84 fixes it package-locally behind an explicit opt-in.
//
// This test now pins BOTH halves: the planner still derives the plan name from
// the URL (unchanged), and the engine corrects it only when a caller asks. The
// default stays off so the certified full package is byte-for-byte what it has
// always been — the correction is a deliberate choice, never a silent one.
test("19: the planner names from the URL; the engine corrects only on request", () => {
  const planner = code("lib/export/talabat/package.ts");
  assert.match(planner, /const ext = extensionFromUrl\(primaryUrl \|\| null\)/);
  assert.match(planner, /additionalImageName\(sku, position, extensionFromUrl\(url\)\)/);
  assert.match(planner, /export function sniffImageExtension/);

  const engine = code("lib/export/talabat/package-job.ts");
  // the correction exists, is gated, and defaults to absent
  assert.match(engine, /correctExtensionFromBytes\?: boolean/);
  assert.match(engine, /if \(deps\.correctExtensionFromBytes\)/);
  assert.match(engine, /const entryName = `Talabat\/images\/\$\{packagedName\}`/);
  // and with the flag off, the packaged name IS the plan name
  assert.match(engine, /let packagedName = img\.filename;/);
});
