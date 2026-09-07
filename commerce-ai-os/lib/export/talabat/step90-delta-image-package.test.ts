// STEP 90 — the Email B image package: who builds it, and what proves it is
// the right one.
//
// Email B could not be generated at all. The reader looked for a staged ZIP at
// email-artifacts/new_products/source/images.zip; NOTHING in the codebase ever
// wrote one, so every attempt ended in "تعذّر تجهيز حزمة الصور المطلوبة" —
// a producer that was specified but never built.
//
// The fix is not a new image pipeline. It is the certified job engine, driven
// over exactly the rows Email B's workbook carries, with two opt-in flags and
// two deps deliberately withheld. The proofs below are in three groups:
//
//   • SCOPE — the package covers the workbook's rows and nothing else, so the
//     category exclusions hold here by construction rather than by a copy;
//   • BINDING — a staged ZIP is refused unless it belongs to this run and this
//     baseline. Photographs all look plausible; only the sidecar can tell.
//   • FAIL CLOSED — short or duplicated, the package is refused, never sent
//     with images quietly missing.
//
// node --conditions=react-server --experimental-strip-types --test lib/export/talabat/step90-delta-image-package.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DELTA_IMAGE_ZIP_PATH, DELTA_IMAGE_META_PATH, DELTA_IMAGE_SOURCE_PREFIX,
  deltaImageSelectionKeys, parseDeltaImageMeta, verifyDeltaImagePackage,
  auditDeltaImageCoverage, deltaImagePlannedCount, DELTA_IMAGE_BLOCK_AR, type DeltaImageMeta,
} from "./delta-image-package.ts";
import { parseTalabatBaseline, compareTalabatBaseline, newDeltaRows, TALABAT_BASELINE_COLUMNS } from "./baseline-delta.ts";
import { allowedNewDeltaRows, policyExcludedNewDeltaRows } from "./category-policy.ts";
import { newProductImageScope, safeUpdateRows } from "./delta-workbooks.ts";
import { createTalabatPackageJob } from "./package-job.ts";
import { buildTalabatPreview, type TalabatPreviewProduct } from "./preview.ts";
import { previewRowKey } from "./package.ts";
import { GENERATION_ERROR_AR, generationErrorMessageAr } from "./email-artifacts.ts";
import { OFFICIAL_SEND_ENABLED } from "./email-workflow.ts";
import { RAFEEQ_LINK_TTL_SECONDS } from "../rafeeq/artifact-object.ts";

const HERE = join(fileURLToPath(new URL(".", import.meta.url)));
const APP_ROOT = join(HERE, "../../..");
const raw = (rel: string): string => readFileSync(join(APP_ROOT, rel), "utf8");
// Scan CODE, not prose — this file's own explanations must never satisfy or
// trip a guard that is about the implementation.
const code = (rel: string): string =>
  raw(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const PURE = "lib/export/talabat/delta-image-package.ts";
const ENGINE = "lib/export/talabat/package-job.ts";
const JOBS = "lib/talabat/package-job.server.ts";
const WORKFLOW = "lib/talabat/email-workflow.server.ts";
const ROUTE = "app/api/export/talabat/email/images/route.ts";
const UI = "app/(v2)/v2/operations/channels/talabat-email/ImagePackage.tsx";
const PAGE = "app/(v2)/v2/operations/channels/talabat-email/page.tsx";

const ELECTRONICS = "Electronics";
const TOYS = "✨Toys";

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
const baseRow = (sku: string, cat = "All Face Care") =>
  [sku, `EN ${sku}`, "50", true, null, false, null, null, null, `0${12345678}00000`, null, null, cat];
const parse = (rows: readonly (readonly unknown[])[]) =>
  parseTalabatBaseline([TALABAT_BASELINE_COLUMNS.slice(), ...rows], "Products").rows;

/**
 * A delta with all four interesting kinds at once: products Talabat lists and
 * we changed, brand-new allowed products, and new products the category policy
 * withholds.
 */
function fixture() {
  const products = [
    product(0, "Face Care", { nameEn: "CHANGED mk1000" }), // existing, name differs
    product(1, "Face Care", { price: 99 }),                // existing, price differs
    product(2, ELECTRONICS), product(3, ELECTRONICS),      // new, excluded
    product(4, TOYS),                                      // new, excluded
    // new + allowed. One carries a gallery, so planned IMAGES outnumber ROWS —
    // the difference this fixture exists to catch.
    product(5, "Hair Care", {
      galleryImageUrls: ["https://x.test/g1.jpg", "https://x.test/g2.jpg"], imageCount: 3,
    }),
    product(6, "Makeup"),
  ];
  const preview = buildTalabatPreview({ products });
  const baseline = parse([baseRow("mk1000"), baseRow("mk1001")]);
  return { preview, result: compareTalabatBaseline(preview.rows, baseline) };
}

const META = (over: Partial<DeltaImageMeta> = {}): DeltaImageMeta => ({
  imageCount: 12, expectedImages: 12,
  extensionAudit: { mismatches: 0, renamed: 0, collisions: 0 },
  runFingerprint: "run-A", baselineFingerprint: "base-A",
  jobId: "11111111-2222-3333-4444-555555555555",
  stagedAtIso: "2026-09-06T21:00:00.000Z", zipBytes: 4096,
  sha256: "a".repeat(64),
  ...over,
});

// ── 1. scope: the package covers the workbook's rows, and only those ─────────

test("1. the package is scoped by the SAME allowed set the workbook uses", () => {
  const { result } = fixture();
  const keys = deltaImageSelectionKeys(result);
  const expected = allowedNewDeltaRows(result).map((r) => previewRowKey(r.our));
  assert.deepEqual(keys, expected);
  assert.ok(keys.length > 0, "the fixture has allowed new rows");
  // and it is delegated, not re-derived
  assert.match(code(PURE), /allowedNewDeltaRows\(result\)\.map\(/);
});

test("2. Electronics rows never reach the image selection", () => {
  const { result } = fixture();
  const keys = new Set(deltaImageSelectionKeys(result));
  const electronics = newDeltaRows(result).filter((r) => r.our.talabatCategory === ELECTRONICS);
  assert.equal(electronics.length, 2, "they ARE new products — withheld, not absent");
  for (const r of electronics) assert.equal(keys.has(previewRowKey(r.our)), false);
});

test("3. ✨Toys rows never reach the image selection", () => {
  const { result } = fixture();
  const keys = new Set(deltaImageSelectionKeys(result));
  const toys = newDeltaRows(result).filter((r) => r.our.talabatCategory === TOYS);
  assert.equal(toys.length, 1);
  for (const r of toys) assert.equal(keys.has(previewRowKey(r.our)), false);
  assert.ok(policyExcludedNewDeltaRows(result).some((r) => r.our.talabatCategory === TOYS));
});

test("4. existing-product update rows are not in the image selection", () => {
  const { result } = fixture();
  const keys = new Set(deltaImageSelectionKeys(result));
  const updates = safeUpdateRows(result);
  assert.ok(updates.length > 0, "the fixture has safe updates");
  for (const r of updates) {
    assert.equal(keys.has(previewRowKey(r.our)), false, `${r.our.sku} is an update, not a new product`);
  }
});

test("5. barcode-review rows are not a source of images", () => {
  // Barcode review is built from UPDATE rows; the new-product allowed set and
  // the update set are disjoint, so a review row cannot enter the package.
  const { result } = fixture();
  const newKeys = new Set(deltaImageSelectionKeys(result));
  const updateKeys = new Set(safeUpdateRows(result).map((r) => previewRowKey(r.our)));
  for (const k of newKeys) assert.equal(updateKeys.has(k), false);
});

test("6. the job plan built from those keys covers exactly the allowed rows", () => {
  const { preview, result } = fixture();
  const keys = deltaImageSelectionKeys(result);
  const created = createTalabatPackageJob({
    jobId: "job-1", mode: "selected", selectedKeys: keys,
    previewRows: preview.rows, actor: null, nowIso: "2026-09-06T21:00:00.000Z",
  });
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const planned = new Set(created.plan.rows.map((r) => previewRowKey(r)));
  assert.deepEqual([...planned].sort(), [...new Set(keys)].sort());
  // the expectation is the PLAN's own image count — derived, never written down
  assert.equal(created.plan.images.length > 0, true);
});

test("6b. planned IMAGES are counted, not rows — galleries are the difference", () => {
  const { preview, result } = fixture();
  const created = createTalabatPackageJob({
    jobId: "job-2", mode: "selected", selectedKeys: deltaImageSelectionKeys(result),
    previewRows: preview.rows, actor: null, nowIso: "2026-09-06T21:00:00.000Z",
  });
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const rows = newProductImageScope(result).newRowCount;
  const images = deltaImagePlannedCount(result);
  assert.equal(images, created.plan.images.length,
    "the screen's expectation IS the engine's plan");
  assert.ok(images > rows, `images (${images}) must exceed rows (${rows}) once a gallery exists`);
});

test("7. no scope figure is hard-coded anywhere in the new code", () => {
  for (const file of [PURE, JOBS, WORKFLOW, ROUTE, UI]) {
    const src = code(file);
    for (const n of ["408", "517", "632", "2501"]) {
      assert.ok(!src.includes(n), `${file} must not hard-code ${n}`);
    }
  }
});

// ── 2. one engine, different deps ────────────────────────────────────────────

test("8. the images-only archive is OPT-IN, so the certified package is untouched", () => {
  const src = code(ENGINE);
  assert.match(src, /imagesOnlyArchive\?: boolean/);
  assert.match(src, /deps\.imagesOnlyArchive\s*\n?\s*\?\s*\[\]/);
  // default off: the tail entries are still the certified pair when unset
  assert.ok(src.includes('"Talabat/talabat-products.xlsx"'), "the workbook entry still exists");
  assert.ok(src.includes('"manifest.json"'), "the manifest entry still exists");
});

test("9. the delta job reuses the certified engine — no second pipeline", () => {
  const src = code(JOBS);
  assert.match(src, /advanceTalabatPackageJob\(state, plan, \{\s*\n?\s*ports: enginePorts,/);
  assert.match(src, /createTalabatPackageJob\(\{\s*\n?\s*jobId, mode: "selected", selectedKeys: input\.selectedKeys,/);
  // exactly one fetch port in the file, shared by both drivers
  assert.equal((src.match(/fetchImage:/g) ?? []).length, 1);
});

test("10. the delta job writes NO mappings and NO audit row", () => {
  const src = code(JOBS);
  const delta = src.slice(src.indexOf("export async function stepTalabatDeltaImageJob"));
  assert.ok(!delta.includes("syncMappings"), "no channel-mapping write");
  assert.ok(!delta.includes("recordAudit"), "no export audit row");
  assert.match(delta, /imagesOnlyArchive: true/);
  assert.match(delta, /correctExtensionFromBytes: true/);
});

test("11. the delta job refuses to adopt any job it did not create", () => {
  const src = code(JOBS);
  const start = src.slice(src.indexOf("export async function startTalabatDeltaImageJob"));
  assert.match(start, /readDeltaBinding\(live\.id\)/);
  assert.match(start, /return errResult\("conflict", 409\)/);
  assert.ok(!start.includes("resumeRecoverableJob"), "never revives the full-catalogue job");
  // and stepping demands the marker too
  assert.match(src, /if \(await readDeltaBinding\(jobId\) === null\) return errResult\("job_not_found", 404\)/);
});

test("12. no database migration is introduced by this step", () => {
  const src = code(JOBS);
  // the existing schema already allows this: same channel, an allowed mode
  assert.match(src, /channel: CHANNEL, mode: "selected"/);
  const migration = raw("supabase/migrations/20260904170000_talabat_package_jobs.sql");
  assert.ok(migration.includes("check (mode in ('ready', 'selected'))"), "'selected' was always allowed");
  assert.ok(migration.includes("check (channel in ('talabat:malikas'))"), "the channel set is unchanged");
});

// ── 3. binding: the staged package must belong to this run ───────────────────

test("13. the package is stored privately, under the email-artifact prefix", () => {
  assert.equal(DELTA_IMAGE_SOURCE_PREFIX, "email-artifacts/new_products/source");
  assert.equal(DELTA_IMAGE_ZIP_PATH, `${DELTA_IMAGE_SOURCE_PREFIX}/images.zip`);
  assert.equal(DELTA_IMAGE_META_PATH, `${DELTA_IMAGE_SOURCE_PREFIX}/images.json`);
  const src = code(JOBS);
  // STEP 90C — the object is written by the streaming uploader now, not by a
  // buffered putObject, but it is the SAME private path.
  assert.match(src, /objectPath: DELTA_IMAGE_ZIP_PATH,/);
  assert.match(src, /makeTusPorts\(BUCKET\)/, "the private job bucket, not a new one");
  // the private bucket, never a public one and never a permanent URL
  assert.ok(!src.includes("getPublicUrl"), "no public URL is ever minted");
  assert.ok(!/public:\s*true/.test(src));
});

test("14. a package built for another RUN is refused", () => {
  const blocks = verifyDeltaImagePackage(META(), "run-B", "base-A");
  assert.deepEqual(blocks, ["image_package_stale_run"]);
  assert.ok(DELTA_IMAGE_BLOCK_AR.image_package_stale_run.length > 0);
});

test("15. a package built against another BASELINE is refused", () => {
  const blocks = verifyDeltaImagePackage(META(), "run-A", "base-B");
  assert.deepEqual(blocks, ["image_package_stale_baseline"]);
});

test("16. a matching package passes, and a missing one is named as missing", () => {
  assert.deepEqual(verifyDeltaImagePackage(META(), "run-A", "base-A"), []);
  assert.deepEqual(verifyDeltaImagePackage(null, "run-A", "base-A"), ["image_package_missing"]);
  assert.deepEqual(verifyDeltaImagePackage(META({ zipBytes: 0 }), "run-A", "base-A"), ["image_package_missing"]);
});

test("17. the sidecar is parsed strictly — a malformed one is NOT a package", () => {
  assert.equal(parseDeltaImageMeta(null), null);
  assert.equal(parseDeltaImageMeta({}), null);
  assert.equal(parseDeltaImageMeta({ ...META(), runFingerprint: "" }), null);
  assert.equal(parseDeltaImageMeta({ ...META(), extensionAudit: undefined }), null);
  const ok = parseDeltaImageMeta(JSON.parse(JSON.stringify(META())));
  assert.deepEqual(ok, META());
});

test("18. the reader verifies the binding before the bytes are used", () => {
  const src = code(WORKFLOW);
  assert.match(src, /readPublishedImagePackage\(delta\.fingerprint, baseline\?\.fingerprint \?\? null, nowIso\)/);
  assert.match(src, /verifyDeltaImagePackage\(parsed, currentRunFingerprint, currentBaselineFingerprint\)/);
  // STEP 90E — the size is compared against a LISTING, never a download.
  assert.match(src, /stored !== parsed\.zipBytes/);
});

test("19. stale and missing are DIFFERENT owner messages", () => {
  const missing = GENERATION_ERROR_AR.image_package_missing;
  const stale = GENERATION_ERROR_AR.image_package_stale;
  const incomplete = GENERATION_ERROR_AR.image_package_incomplete;
  assert.notEqual(missing, stale);
  assert.notEqual(stale, incomplete);
  // and none of them blames the mail provider for a packaging problem
  for (const m of [missing, stale, incomplete]) {
    assert.ok(!m.includes("مزود البريد"), m);
    assert.equal(generationErrorMessageAr("image_package_stale"), stale);
  }
});

// ── 4. fail closed ───────────────────────────────────────────────────────────

test("20. a short package is incomplete — never quietly sent", () => {
  const c = auditDeltaImageCoverage({ expected: 632, packagedNames: names(600), droppedCount: 32 });
  assert.equal(c.complete, false);
  assert.equal(c.missing, 32);
  assert.equal(c.extra, 0);
});

test("21. duplicate filenames fail closed", () => {
  const dup = [...names(5), "img-0.jpg"];
  const c = auditDeltaImageCoverage({ expected: 6, packagedNames: dup, droppedCount: 0 });
  assert.equal(c.packaged, 6);
  assert.equal(c.duplicateNames, 1);
  assert.equal(c.complete, false);
  // and a collision recorded by the extension audit blocks the package too
  assert.deepEqual(
    verifyDeltaImagePackage(META({ extensionAudit: { mismatches: 1, renamed: 0, collisions: 1 } }), "run-A", "base-A"),
    ["image_package_duplicate_names"],
  );
});

test("22. an exactly-complete package is complete", () => {
  const c = auditDeltaImageCoverage({ expected: 4, packagedNames: names(4), droppedCount: 0 });
  assert.deepEqual(c, { expected: 4, packaged: 4, missing: 0, extra: 0, duplicateNames: 0, complete: true });
});

test("23. staging refuses an incomplete package and returns the missing refs", () => {
  const src = code(JOBS);
  const stage = src.slice(src.indexOf("export async function stageTalabatDeltaImagePackage"));
  assert.match(stage, /if \(!coverage\.complete\)/);
  assert.match(stage, /missingRefs/);
  // the ZIP is uploaded only AFTER the completeness check
  assert.ok(stage.indexOf("if (!coverage.complete)") < stage.indexOf("streamPartsToObject("));
  // …and the sidecar only after the upload verified its stored size
  assert.ok(stage.indexOf("streamPartsToObject(") < stage.indexOf("putObject(DELTA_IMAGE_META_PATH"));
  assert.match(stage, /sku: plan\.rows\[img\.rowIndex\]\?\.sku/);
});

test("24. an incomplete package also blocks at read time", () => {
  assert.deepEqual(
    verifyDeltaImagePackage(META({ imageCount: 600, expectedImages: 632 }), "run-A", "base-A"),
    ["image_package_incomplete"],
  );
});

// ── 5. delivery, and what stays off ──────────────────────────────────────────

test("25. the ZIP is delivered by signed link on the existing 7-day policy", () => {
  const src = code(WORKFLOW);
  assert.match(src, /TALABAT_LINK_TTL_SECONDS = RAFEEQ_LINK_TTL_SECONDS/);
  assert.equal(RAFEEQ_LINK_TTL_SECONDS, 7 * 24 * 3600);
  assert.match(src, /createSignedUrl\(/);
  // the URL is minted per request and never written to a row
  assert.ok(!src.includes("signed_url"), "no persisted signed URL column");
});

test("26. the ZIP is never attached to a message", () => {
  const src = code(WORKFLOW);
  // attachments are filtered to what the draft claims, and Email B's draft
  // drops the ZIP the moment a link exists (STEP 88, asserted here too)
  assert.match(src, /\.filter\(\(a\) => draft\.attachments\.includes\(a\.filename\)\)/);
  const templates = code("lib/export/talabat/email-templates.ts");
  assert.match(templates, /attachments: link === null \? \[newWorkbookName, imagesZipName\] : \[newWorkbookName\]/);
});

test("27. the workbook remains an attachment", () => {
  const templates = code("lib/export/talabat/email-templates.ts");
  assert.match(templates, /attachments: \[updateWorkbookName\]/);
  assert.match(templates, /\[newWorkbookName\]/);
});

test("28. nothing in this step sends mail", () => {
  for (const file of [PURE, JOBS, ROUTE, UI]) {
    const src = code(file);
    for (const f of ["sendMailViaSmtp", "nodemailer", "sendTalabatTestEmail"]) {
      assert.ok(!src.includes(f), `${file} must not reach the transport (${f})`);
    }
  }
});

test("29. the official send is still disabled", () => {
  assert.equal(OFFICIAL_SEND_ENABLED, false);
});

test("30. the preparation screen is V2 and owner-gated end to end", () => {
  assert.match(raw(PAGE), /<ImagePackage \/>/);
  assert.match(code(ROUTE), /const owner = await requireOwner\(\);/);
  // every method gates, not just one
  const gates = (code(ROUTE).match(/requireOwner\(\)/g) ?? []).length;
  const methods = (code(ROUTE).match(/export async function (GET|POST)/g) ?? []).length;
  assert.equal(gates, methods);
  assert.equal(methods, 2);
});

test("31. the screen reports the expected count from the current delta", () => {
  const src = code(WORKFLOW);
  assert.match(src, /expectedImages/);
  assert.match(src, /deltaImagePlannedCount\(delta\.result\)/);
  assert.match(code(UI), /status\.expectedImages/);
});

function names(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `img-${i}.jpg`);
}
