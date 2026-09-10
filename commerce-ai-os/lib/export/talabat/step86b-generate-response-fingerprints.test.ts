// STEP 86B — the image set must actually REACH the check that asks for it.
//
// PRODUCTION, 2026-09-10. PR #745 is on master (merge 9305ad8) and there were
// ZERO catalogue writes that day: 0 products, 0 images, 0 channel listings. The
// workbook and the 339,430,589-byte archive are both correct. The screen still
// said:
//
//   "حزمة الصور المرتبطة لا تخص هذه المقارنة — أعد تجهيزها ثم أعد التوليد."
//
// STEP 86A gave `verifyArtifactScope` the current image set and published that
// value on `talabatEmailScopeSummary`. But the workflow screen never calls that
// endpoint. It seeds BOTH fingerprints from the generate response and from
// nowhere else — and the generate response carried `runFingerprint` only. So
// `imagePlanFingerprint` arrived undefined, `imagePlan` stayed "", the query
// parameter was dropped by `...(imagePlan ? { imagePlan } : {})`, and the
// preview fell back to `ip.runFingerprint !== currentFingerprint` — the exact
// comparison-wide rule STEP 86A had just replaced. The value existed at both
// ends of the pipeline and never crossed the middle.
//
// The companion `artifact_stale` has the same shape: `run` also lives only in
// React state, so a page reload, or a preview in a tab that did not generate,
// leaves it empty and the artifact reads as unbound too.
//
// Two fixes, both narrowing rather than loosening:
//   1. generation REPORTS the image set it built against (null for Email A,
//      which has no image package);
//   2. the preview ANSWERS the question itself when the caller states nothing,
//      instead of treating an unstated comparison as a mismatched one.
//
// node --conditions=react-server --experimental-strip-types --test lib/export/talabat/step86b-generate-response-fingerprints.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  verifyArtifactScope,
  type TalabatArtifactScope, type TalabatImagePackageRef,
} from "./email-artifacts.ts";

const HERE = join(fileURLToPath(new URL(".", import.meta.url)));
const APP_ROOT = join(HERE, "../../..");
const raw = (rel: string): string => readFileSync(join(APP_ROOT, rel), "utf8");
const code = (rel: string): string =>
  raw(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const SERVER = "lib/talabat/email-workflow.server.ts";
const ROUTE = "app/api/export/talabat/email/workflow/[kind]/route.ts";
const GENERATE_ROUTE = "app/api/export/talabat/email/generate/[kind]/route.ts";
const UI = "app/(v2)/v2/operations/channels/talabat-email/TalabatEmailWorkflow.tsx";

/** A — the 622 photographs this email needs. Unmoved by price and name edits. */
const IMAGESET_A = "i1.622.3f2a";
/** C — some other set entirely. */
const IMAGESET_C = "i1.617.99bb";
/** B — the comparison as it stands now, after the 48 price/name edits. */
const RUN_B = "r1.1530.1343.511.402.0.0.0.48.0.0.0.0.0.0.0";
/** what the packaging JOB was bound to, the evening before those edits. */
const RUN_WHEN_PACKAGED = "r1.BOUND-2026-09-08T23-11";

const PKG = (over: Partial<TalabatImagePackageRef> = {}): TalabatImagePackageRef => ({
  objectPath: "email-artifacts/new_products/source/images.zip",
  filename: "talabat-new-products-images-2026-09-09.zip",
  bytes: 339430589,
  sha256: "e".repeat(64),
  expectedImages: 622, packagedImages: 622,
  sourceJobId: "63b76cf0-544f-497d-b2bd-569279e4b94b",
  baselineFingerprint: "b1.fb06",
  runFingerprint: RUN_WHEN_PACKAGED,
  imagePlanFingerprint: IMAGESET_A,
  ...over,
});

const SCOPE = (over: Partial<TalabatArtifactScope> = {}): TalabatArtifactScope => ({
  kind: "new_products",
  runFingerprint: RUN_B,
  baselineFingerprint: "b1.fb06",
  generatedAtIso: "2026-09-10T08:41:02.117Z",
  files: [{ filename: "talabat-new-products-2026-09-10.xlsx", bytes: 289383, contentType: "x", crc32: 1 }],
  workbookProducts: 402, workbookRows: 511, imageCount: 622,
  barcodeValueRows: 0, activeValueRows: 0, categoryValueRows: 0,
  rowsMissingImage: 0, excludedCategoryRows: 0,
  extensionAudit: { mismatches: 0, renamed: 0, collisions: 0 },
  imagePackage: PKG(),
  ...over,
} as TalabatArtifactScope);

// ── the two cases the owner asked for, end to end ───────────────────────────

test("1. PASS — package A · artifact referencing A · current comparison B", () => {
  // This is 2026-09-10 exactly: a workbook generated against the CURRENT
  // comparison, referencing an archive that holds the CURRENT image set, whose
  // own run binding predates the price edits. It must send.
  assert.deepEqual(
    verifyArtifactScope(SCOPE(), RUN_B, "b1.fb06", IMAGESET_A), [],
    "nothing blocks: the archive holds this comparison's images");
});

test("2. FAIL — package C while the artifact and the current set are A", () => {
  const wrong = SCOPE({ imagePackage: PKG({ imagePlanFingerprint: IMAGESET_C }) });
  assert.deepEqual(
    verifyArtifactScope(wrong, RUN_B, "b1.fb06", IMAGESET_A),
    ["image_package_unbound"],
    "an archive of different photographs is still refused — the guard is intact");
});

test("3. …and the dropped value REPRODUCES the production refusal", () => {
  // Exactly what the screen did: the parameter omitted, so the check falls back
  // to the comparison-wide rule and the correct archive reads as foreign.
  assert.deepEqual(
    verifyArtifactScope(SCOPE(), RUN_B, "b1.fb06", null),
    ["image_package_unbound"],
    "this is the bug, stated as a test: the value never crossed the middle");
  assert.deepEqual(verifyArtifactScope(SCOPE(), RUN_B, "b1.fb06", ""), ["image_package_unbound"]);
});

test("4. an unstated comparison must not be read as a stale artifact either", () => {
  // The `run` half of the same defect: empty React state ⇒ no parameter ⇒ the
  // preview previously refused with artifact_stale. Passing the real value
  // clears it; passing a different one still blocks.
  assert.deepEqual(verifyArtifactScope(SCOPE(), RUN_B, "b1.fb06", IMAGESET_A), []);
  assert.deepEqual(
    verifyArtifactScope(SCOPE(), "r1.SOMETHING-ELSE", "b1.fb06", IMAGESET_A), ["artifact_stale"]);
});

// ── hop 1: generation reports the image set it built against ────────────────

test("5. the generation DTO declares the image set beside the run", () => {
  const src = code(SERVER);
  assert.match(src, /export interface GenerationResultDTO \{[\s\S]*?imagePlanFingerprint: string \| null;[\s\S]*?\n\}/,
    "the field the screen reads must exist on the type it reads from");
  assert.match(src, /runFingerprint: string;/);
});

test("6. Email B reports the CURRENT delta's image set, Email A reports null", () => {
  const src = code(SERVER);
  const gen = src.slice(src.indexOf("export async function generateTalabatEmailArtifacts"),
    src.indexOf("async function readPublishedImagePackage"));
  assert.match(gen, /imagePlanFingerprint: null/, "Email A has no image package");
  assert.match(gen, /imagePlanFingerprint: deltaImagePlanFingerprint\(delta\.result\)/,
    "Email B reports the set the workbook was built against");
  // and it is computed, never echoed back from the request
  assert.equal(gen.includes("input.currentImagePlanFingerprint"), false);
});

test("7. the generate route returns the DTO verbatim — nothing strips the field", () => {
  assert.match(code(GENERATE_ROUTE), /return jsonRes\(result\.value, 200\)/);
});

// ── hop 2: the screen seeds both from that response ─────────────────────────

test("8. the screen reads BOTH fingerprints out of the generate response", () => {
  const ui = code(UI);
  assert.match(ui, /setRun\(typeof body\?\.runFingerprint === "string" \? body\.runFingerprint : ""\)/);
  assert.match(ui, /setImagePlan\(typeof body\?\.imagePlanFingerprint === "string" \? body\.imagePlanFingerprint : ""\)/);
  // and carries them on preview AND on send
  assert.match(ui, /\.\.\.\(run \? \{ run \} : \{\}\), \.\.\.\(imagePlan \? \{ imagePlan \} : \{\}\)/);
  assert.match(ui, /JSON\.stringify\(\{ to, cc, greeting, run, imagePlan, confirmationToken: confirmedToken \}\)/);
});

test("9. the workflow route accepts both on GET and on POST", () => {
  const route = code(ROUTE);
  assert.match(route, /currentRunFingerprint: url\.searchParams\.get\("run"\)/);
  assert.match(route, /currentImagePlanFingerprint: url\.searchParams\.get\("imagePlan"\)/);
  assert.match(route, /typeof body\.run === "string" && body\.run !== "" \? body\.run : null/);
  assert.match(route, /typeof body\.imagePlan === "string" && body\.imagePlan !== "" \? body\.imagePlan : null/);
});

// ── hop 3: the server answers the question when the caller does not ─────────

test("10. the preview computes the current comparison itself when it is unstated", () => {
  const src = code(SERVER);
  const preview = src.slice(src.indexOf("export async function buildWorkflowPreview"),
    src.indexOf("export async function sendTalabatTestEmail"));
  assert.match(preview, /let currentRun = input\.currentRunFingerprint;/);
  assert.match(preview, /let currentImagePlan = input\.currentImagePlanFingerprint \?\? null;/);
  assert.match(preview,
    /if \(bundle !== null && \(currentRun === null \|\| currentImagePlan === null\)\) \{\s*const delta = await loadCurrentTalabatDelta\(\);/,
    "one delta load, and only when there is an artifact to judge");
  assert.match(preview, /currentRun = currentRun \?\? delta\.fingerprint;/);
  assert.match(preview, /currentImagePlan = currentImagePlan \?\? deltaImagePlanFingerprint\(delta\.result\);/);
});

test("11. a value the caller DID supply wins — the fallback never overwrites it", () => {
  const src = code(SERVER);
  const preview = src.slice(src.indexOf("export async function buildWorkflowPreview"),
    src.indexOf("export async function sendTalabatTestEmail"));
  // `??` on both, so a stated fingerprint is used exactly as stated. An
  // assignment (`=`) here would let the server overrule the caller.
  assert.equal(/currentRun = delta\.fingerprint/.test(preview), false);
  assert.equal(/currentImagePlan = deltaImagePlanFingerprint/.test(preview), false);
});

test("12. no artifact ⇒ no delta load: the fallback cannot cost a scan for nothing", () => {
  const src = code(SERVER);
  const preview = src.slice(src.indexOf("export async function buildWorkflowPreview"),
    src.indexOf("export async function sendTalabatTestEmail"));
  assert.match(preview, /if \(bundle !== null && \(/);
});

test("13. the gate still fails closed — no comparison, no send", () => {
  const src = code(SERVER);
  assert.match(src, /const artifactFresh = bundle !== null && currentRun !== null\s*&& artifactBlocks\.length === 0/,
    "a delta that could not be computed leaves currentRun null, and that blocks");
  assert.match(src, /if \(delta\.ok\) \{/, "a failed delta is not treated as a match");
});

test("14. the test send inherits the same answer — one preview, one truth", () => {
  const src = code(SERVER);
  const send = src.slice(src.indexOf("export async function sendTalabatTestEmail"));
  assert.match(send, /const preview = await buildWorkflowPreview\(\{ \.\.\.input, mode: "test" \}\)/,
    "the send re-uses the preview's verdict rather than re-deriving one");
  assert.match(send, /if \(blocks\.length > 0\) return fail\(/);
});

// ── blast radius ────────────────────────────────────────────────────────────

test("15. nothing in the preview path sends, publishes, deletes or writes rows", () => {
  const src = code(SERVER);
  const preview = src.slice(src.indexOf("export async function buildWorkflowPreview"),
    src.indexOf("export async function sendTalabatTestEmail"));
  for (const forbidden of ["sendMailViaSmtp", "putObject", "streamPartsToObject",
    'from("products")', "lifecycle_state", ".remove("]) {
    assert.equal(preview.includes(forbidden), false, `the preview must not ${forbidden}`);
  }
});

test("16. generation still writes only artifacts, and still sends nothing", () => {
  const src = code(SERVER);
  const gen = src.slice(src.indexOf("export async function generateTalabatEmailArtifacts"),
    src.indexOf("async function readPublishedImagePackage"));
  for (const forbidden of ["sendMailViaSmtp", "lifecycle_state", ".remove("]) {
    assert.equal(gen.includes(forbidden), false, `generation must not ${forbidden}`);
  }
});
