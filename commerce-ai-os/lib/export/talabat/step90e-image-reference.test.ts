// STEP 90E — the image archive is REFERENCED, not copied.
//
// Email B's generation reached the workbook, wrote it, and then died with an
// out-of-memory kill. What it was doing at the time was making a second copy of
// a 330 MB archive that nothing needed: it downloaded the published package,
// ran CRC-32 across every byte, and re-uploaded the whole thing into the
// artifact folder — while the email delivers those images by signed link to the
// object it had just finished reading.
//
// This is the third appearance of one mistake — handling a large archive as
// bytes in a serverless function — and the third place it had to be removed.
// STEP 90C fixed staging. This step fixes generation, and also the signed-link
// helper, which was downloading all 330 MB on EVERY preview to learn a number
// the sidecar already records.
//
// The scope now carries a reference: object path, filename, size, SHA-256,
// counts, source job, and the two fingerprints. Everything a partner-facing
// email needs to prove which archive it points at, in a few hundred bytes.
//
// node --conditions=react-server --experimental-strip-types --test lib/export/talabat/step90e-image-reference.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  verifyArtifactScope, parseArtifactScope, ARTIFACT_BLOCK_AR,
  type TalabatArtifactScope, type TalabatImagePackageRef,
} from "./email-artifacts.ts";
import { DELTA_IMAGE_ZIP_PATH, DELTA_IMAGE_META_PATH } from "./delta-image-package.ts";
import { OFFICIAL_SEND_ENABLED } from "./email-workflow.ts";
import { RAFEEQ_LINK_TTL_SECONDS } from "../rafeeq/artifact-object.ts";
import { errorTextFor, SERVER_DIED_AR, REQUEST_FAILED_AR } from "./request-errors.ts";

const HERE = join(fileURLToPath(new URL(".", import.meta.url)));
const APP_ROOT = join(HERE, "../../..");
const raw = (rel: string): string => readFileSync(join(APP_ROOT, rel), "utf8");
// Scan CODE, not prose — this file's explanations name every forbidden thing.
const code = (rel: string): string =>
  raw(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const GEN = "lib/talabat/email-artifacts.server.ts";
const WORKFLOW = "lib/talabat/email-workflow.server.ts";
const ARTIFACTS = "lib/export/talabat/email-artifacts.ts";
const UI = "app/(v2)/v2/operations/channels/talabat-email/TalabatEmailWorkflow.tsx";

const REF = (over: Partial<TalabatImagePackageRef> = {}): TalabatImagePackageRef => ({
  objectPath: DELTA_IMAGE_ZIP_PATH,
  filename: "talabat-new-products-images-2026-09-07.zip",
  bytes: 346_244_336,
  sha256: "d".repeat(64),
  expectedImages: 632,
  packagedImages: 632,
  sourceJobId: "f03464d8-ff05-4439-ac2a-1c2cc70211e6",
  baselineFingerprint: "b1.fb06",
  runFingerprint: "run-A",
  ...over,
});

const SCOPE = (over: Partial<TalabatArtifactScope> = {}): TalabatArtifactScope => ({
  kind: "new_products",
  runFingerprint: "run-A",
  baselineFingerprint: "b1.fb06",
  generatedAtIso: "2026-09-07T01:17:00.000Z",
  files: [{ filename: "nw.xlsx", bytes: 292_595, contentType: "x", crc32: 1 }],
  workbookRows: 517,
  workbookProducts: 408,
  imageCount: 632,
  rowsMissingImage: 0,
  excludedCategoryRows: 0,
  barcodeValueRows: 0,
  activeValueRows: 0,
  categoryValueRows: 0,
  extensionAudit: null,
  imagePackage: REF(),
  ...over,
});

// ── 1. generation touches no archive bytes ──────────────────────────────────

test("1. generation never downloads the archive", () => {
  const wf = code(WORKFLOW);
  // the package is read from its SIDECAR; the .zip is only ever listed
  assert.match(wf, /download\(DELTA_IMAGE_META_PATH\)/);
  assert.equal(wf.includes("download(DELTA_IMAGE_ZIP_PATH)"), false,
    "the 330 MB archive is never downloaded");
  assert.match(wf, /async function statPublishedImageZip\(\)/);
  assert.match(wf, /\.list\(dir, \{ limit: 100 \}\)/, "size comes from a listing");
});

test("2. generation never uploads a second archive", () => {
  const gen = code(GEN);
  assert.equal(gen.includes("imageZipBytes"), false, "the bytes parameter is gone");
  assert.equal(/ZIP_MIME/.test(gen.split("const ZIP_MIME")[1] ?? ""), false,
    "the ZIP mime constant has no remaining use");
  // exactly one artifact object is written for Email B: the workbook
  const newProducts = gen.slice(gen.indexOf("export async function generateNewProductsArtifact"));
  const puts = (newProducts.match(/await put\(/g) ?? []).length;
  assert.equal(puts, 1, "one put — the workbook; the sidecar goes through putScope");
  assert.match(newProducts, /files: \[fileRecord\(workbookName, workbookBytes, XLSX_MIME\)\]/);
});

test("3. generation never recomputes a CRC over the archive", () => {
  const gen = code(GEN);
  const newProducts = gen.slice(gen.indexOf("export async function generateNewProductsArtifact"));
  // fileRecord is what runs crc32; it is applied to the workbook alone
  assert.equal((newProducts.match(/fileRecord\(/g) ?? []).length, 1);
  assert.match(newProducts, /fileRecord\(workbookName/);
  assert.equal(newProducts.includes("crc32"), false, "no direct hashing of archive bytes");
});

test("4. the counts come from the source sidecar, not from bytes in hand", () => {
  const gen = code(GEN);
  assert.match(gen, /imageCount: input\.imagePackage\.packagedImages/);
  assert.match(gen, /imagePackage: input\.imagePackage/);
});

// ── 2. the source package is authoritative and fail-closed ──────────────────

test("5. the sidecar is the authority, and a missing one is a refusal", () => {
  const wf = code(WORKFLOW);
  assert.match(wf, /parseDeltaImageMeta\(JSON\.parse\(await meta\.data\.text\(\)\)\)/);
  assert.match(wf, /if \(parsed === null\) return \{ ok: false, error: "image_package_missing" \}/);
});

test("6. the stored size must match the sidecar", () => {
  const wf = code(WORKFLOW);
  assert.match(wf, /const stored = await statPublishedImageZip\(\);/);
  assert.match(wf, /if \(stored === null\) return \{ ok: false, error: "image_package_missing" \}/);
  assert.match(wf, /if \(stored !== parsed\.zipBytes\) return \{ ok: false, error: "image_package_stale" \}/);
});

test("7. a sidecar with no SHA-256 is not a usable package", () => {
  const wf = code(WORKFLOW);
  assert.match(wf, /if \(parsed\.sha256 === null\) return \{ ok: false, error: "image_package_incomplete" \}/);
});

test("8. a baseline mismatch fails closed", () => {
  const blocks = verifyArtifactScope(
    SCOPE({ imagePackage: REF({ baselineFingerprint: "b2.other" }) }), "run-A", "b1.fb06");
  assert.ok(blocks.includes("image_package_unbound"));
  assert.ok(ARTIFACT_BLOCK_AR.image_package_unbound.length > 0);
});

test("9. a run mismatch fails closed", () => {
  const blocks = verifyArtifactScope(SCOPE({ imagePackage: REF({ runFingerprint: "run-B" }) }), "run-A", "b1.fb06");
  assert.ok(blocks.includes("image_package_unbound"));
});

test("10. an image-count mismatch fails closed", () => {
  const short = verifyArtifactScope(SCOPE({ imagePackage: REF({ packagedImages: 600 }) }), "run-A", "b1.fb06");
  assert.ok(short.includes("image_package_unbound"));
  const empty = verifyArtifactScope(SCOPE({ imagePackage: REF({ bytes: 0 }) }), "run-A", "b1.fb06");
  assert.ok(empty.includes("image_package_unbound"));
});

test("11. an Email B scope with NO reference at all is unbound", () => {
  assert.ok(verifyArtifactScope(SCOPE({ imagePackage: null }), "run-A", "b1.fb06")
    .includes("image_package_unbound"));
  // …and a correctly bound one passes
  assert.deepEqual(verifyArtifactScope(SCOPE(), "run-A", "b1.fb06"), []);
  // Email A is unaffected — it has no images to bind
  const emailA = SCOPE({ kind: "existing_updates", imageCount: null, imagePackage: null });
  assert.deepEqual(verifyArtifactScope(emailA, "run-A", "b1.fb06"), []);
});

test("12. no fallback to an older archive exists", () => {
  const wf = code(WORKFLOW);
  const reader = wf.slice(wf.indexOf("async function readPublishedImagePackage"));
  const body = reader.slice(0, reader.indexOf("async function statPublishedImageZip"));
  assert.equal(body.includes("catch { return { ok: true"), false, "a failure never yields a package");
  // every early return in the reader is a refusal
  for (const m of body.matchAll(/return \{ ok: false, error: "([a-z_]+)" \}/g)) {
    assert.match(m[1], /^image_package_(missing|stale|incomplete)$/);
  }
});

// ── 3. the scope record ─────────────────────────────────────────────────────

test("13. the scope sidecar carries every reference field", () => {
  const round = parseArtifactScope(JSON.parse(JSON.stringify(SCOPE())), "new_products");
  assert.equal(round.ok, true);
  if (!round.ok) return;
  const ip = round.value.imagePackage;
  assert.ok(ip);
  assert.equal(ip!.objectPath, DELTA_IMAGE_ZIP_PATH);
  assert.equal(ip!.bytes, 346_244_336);
  assert.equal(ip!.sha256, "d".repeat(64));
  assert.equal(ip!.expectedImages, 632);
  assert.equal(ip!.packagedImages, 632);
  assert.equal(ip!.sourceJobId, "f03464d8-ff05-4439-ac2a-1c2cc70211e6");
  assert.equal(ip!.runFingerprint, "run-A");
  assert.equal(ip!.baselineFingerprint, "b1.fb06");
});

test("14. a MALFORMED reference is unreadable, never partly trusted", () => {
  const bad = parseArtifactScope(
    { ...JSON.parse(JSON.stringify(SCOPE())), imagePackage: { objectPath: "x" } }, "new_products");
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.equal(bad.reason, "unreadable");
  // an ABSENT reference still parses (Email A, and scopes written before this)
  const absent = parseArtifactScope(
    { ...JSON.parse(JSON.stringify(SCOPE())), imagePackage: undefined }, "new_products");
  assert.equal(absent.ok, true);
});

test("15. the workbook is the only artifact FILE", () => {
  const scope = SCOPE();
  assert.equal(scope.files.length, 1);
  assert.ok(scope.files[0].filename.endsWith(".xlsx"));
  assert.equal(scope.files.some((f) => f.filename.endsWith(".zip")), false);
});

// ── 4. the signed link ──────────────────────────────────────────────────────

test("16. the link targets the published object named by the reference", () => {
  const wf = code(WORKFLOW);
  assert.match(wf, /createSignedUrl\(ref\.objectPath, TALABAT_LINK_TTL_SECONDS, \{ download: ref\.filename \}\)/);
  assert.match(wf, /const imageRef = kind === "new_products" \? bundle\?\.artifactScope\.imagePackage \?\? null : null;/);
  assert.equal(DELTA_IMAGE_ZIP_PATH, "email-artifacts/new_products/source/images.zip");
  assert.equal(DELTA_IMAGE_META_PATH, "email-artifacts/new_products/source/images.json");
});

test("17. minting the link no longer downloads the archive to size it", () => {
  const wf = code(WORKFLOW);
  // Slice to the NEXT top-level declaration — "\n}" would stop at the end of
  // the destructured parameter type, a few lines in, and assert nothing.
  const sign = wf.slice(wf.indexOf("export async function signImagesLink"));
  const nextDecl = sign.indexOf("\nexport ", 1);
  const body = nextDecl > 0 ? sign.slice(0, nextDecl) : sign;
  assert.ok(body.includes("createSignedUrl"), "the whole function body was captured");
  assert.equal(body.includes("arrayBuffer"), false, "no transfer just to measure");
  assert.equal(body.includes(".download("), false);
  assert.match(body, /const stored = await statPublishedImageZip\(\);/);
  assert.match(body, /stored !== ref\.bytes/);
});

test("18. the link is still minted on demand and never persisted", () => {
  const wf = code(WORKFLOW);
  assert.equal(RAFEEQ_LINK_TTL_SECONDS, 7 * 24 * 3600);
  assert.match(wf, /TALABAT_LINK_TTL_SECONDS = RAFEEQ_LINK_TTL_SECONDS/);
  assert.equal(wf.includes("signed_url"), false, "no persisted URL column");
  // generation does not mint one
  const gen = wf.slice(wf.indexOf("export async function generateTalabatEmailArtifacts"));
  const genBody = gen.slice(0, gen.indexOf("\n}\n"));
  assert.equal(genBody.includes("signImagesLink"), false, "generation mints no link");
  assert.equal(genBody.includes("createSignedUrl"), false);
});

test("19. the workbook is attached and the archive stays link-only", () => {
  const templates = code("lib/export/talabat/email-templates.ts");
  assert.match(templates, /attachments: link === null \? \[newWorkbookName, imagesZipName\] : \[newWorkbookName\]/);
  const wf = code(WORKFLOW);
  assert.match(wf, /\.filter\(\(a\) => draft\.attachments\.includes\(a\.filename\)\)/);
});

// ── 5. the empty-500 message ────────────────────────────────────────────────

test("20. a 500 with no body says the SERVER stopped, not that the request failed", () => {
  assert.equal(errorTextFor({ status: 500 }, {}), SERVER_DIED_AR);
  assert.equal(errorTextFor({ status: 502 }, null), SERVER_DIED_AR);
  assert.ok(SERVER_DIED_AR.includes("توقف الخادم"));
  assert.ok(SERVER_DIED_AR.includes("لم يتم إرسال أي بريد"));
  // and it never blames the mail provider
  assert.equal(SERVER_DIED_AR.includes("مزود البريد"), false);
});

test("21. a real backend message still wins, and 4xx keeps the generic text", () => {
  assert.equal(errorTextFor({ status: 500 }, { message_ar: "رسالة دقيقة" }), "رسالة دقيقة");
  assert.equal(errorTextFor({ status: 409 }, {}), REQUEST_FAILED_AR);
  assert.equal(errorTextFor({ status: 422 }, { other: 1 }), REQUEST_FAILED_AR);
});

// ── 6. safety ───────────────────────────────────────────────────────────────

test("22. generation contacts no mail transport", () => {
  for (const f of [GEN, ARTIFACTS]) {
    const src = code(f);
    for (const forbidden of ["sendMailViaSmtp", "nodemailer", "createTransport"]) {
      assert.equal(src.includes(forbidden), false, `${f} must not reach the transport`);
    }
  }
  const wf = code(WORKFLOW);
  const gen = wf.slice(wf.indexOf("export async function generateTalabatEmailArtifacts"));
  assert.equal(gen.slice(0, gen.indexOf("\n}\n")).includes("sendMailViaSmtp"), false);
});

test("23. the official send is still disabled", () => {
  assert.equal(OFFICIAL_SEND_ENABLED, false);
});

test("24. the generator writes no catalogue or marketplace table", () => {
  const gen = code(GEN);
  assert.equal(/\.from\(["'`]/.test(gen), false, "no database table access at all");
  assert.equal((gen.match(/storage\.from\(/g) ?? []).length, 1, "one bucket handle");
  for (const forbidden of ["product_variants", "channel_variant_mappings", "/snoonu/", "/shopify/"]) {
    assert.equal(gen.includes(forbidden), false, `must not reference ${forbidden}`);
  }
});

test("25. the UI still renders no hard-coded scope figure", () => {
  const ui = code(UI);
  for (const n of ["408", "517", "632", "١٤٧", "٤٠٨"]) {
    assert.equal(ui.includes(n), false, `the screen must not hard-code ${n}`);
  }
});
