// STEP 86A — a fresh workbook must not be refused over its image package's binding.
//
// PRODUCTION, 2026-09-09. The publish finally landed (20 PATCHes, all 204) and
// generation ran clean:
//
//   images.zip   339,430,589 bytes   23:08:40
//   images.json  556 bytes           23:08:41
//   talabat-new-products-2026-09-09.xlsx   289,383 bytes   23:16:08
//
// 402 products · 511 rows · 622 images. Zero catalog writes since. And the
// preview still refused to send, saying the files belong to an earlier
// comparison — regenerate.
//
// Regenerating could never have cleared it. `verifyArtifactScope` judged the
// referenced archive by `ip.runFingerprint !== currentFingerprint`, and the
// archive carries the fingerprint of the JOB that planned it — bound
// 2026-09-08 23:11, before the 48 price and name edits of the following
// morning. Every regeneration copies that same value out of the sidecar.
//
// STEP 85H had already established the rule for exactly this: an archive is
// judged by the image SET it holds, because a comparison-wide fingerprint moves
// on edits that do not touch a single photograph. That rule reached
// verifyDeltaImagePackage and not verifyArtifactScope, which holds its own copy
// of the same comparison — so generation accepted the package and the preview
// then rejected the artifact referencing it. Two ends of one pipeline
// disagreeing about the same archive.
//
// node --conditions=react-server --experimental-strip-types --test lib/export/talabat/step86a-artifact-image-binding.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  verifyArtifactScope, ARTIFACT_BLOCK_AR,
  type TalabatArtifactScope, type TalabatImagePackageRef,
} from "./email-artifacts.ts";

const HERE = join(fileURLToPath(new URL(".", import.meta.url)));
const APP_ROOT = join(HERE, "../../..");
const raw = (rel: string): string => readFileSync(join(APP_ROOT, rel), "utf8");
const code = (rel: string): string =>
  raw(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const SERVER = "lib/talabat/email-workflow.server.ts";
const ROUTE = "app/api/export/talabat/email/workflow/[kind]/route.ts";
const UI = "app/(v2)/v2/operations/channels/talabat-email/TalabatEmailWorkflow.tsx";

/** The comparison as it stood when the workbook was generated, and still does. */
const RUN_NOW = "r1.CURRENT-AFTER-THE-48-EDITS";
const IMAGESET_NOW = "i1.622.ffff";
/** What the job that packaged the images was bound to, the evening before. */
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
  imagePlanFingerprint: IMAGESET_NOW,
  ...over,
});

const SCOPE = (over: Partial<TalabatArtifactScope> = {}): TalabatArtifactScope => ({
  kind: "new_products",
  runFingerprint: RUN_NOW,
  baselineFingerprint: "b1.fb06",
  generatedAtIso: "2026-09-09T23:16:08.943Z",
  files: [{ filename: "talabat-new-products-2026-09-09.xlsx", bytes: 289383, contentType: "x", crc32: 1 }],
  workbookProducts: 402, workbookRows: 511, imageCount: 622,
  barcodeValueRows: 0, activeValueRows: 0, categoryValueRows: 0,
  rowsMissingImage: 0, excludedCategoryRows: 0,
  extensionAudit: { mismatches: 0, renamed: 0, collisions: 0 },
  imagePackage: PKG(),
  ...over,
} as TalabatArtifactScope);

// ── the regression ──────────────────────────────────────────────────────────

test("1. the exact production artifact is accepted", () => {
  assert.deepEqual(
    verifyArtifactScope(SCOPE(), RUN_NOW, "b1.fb06", IMAGESET_NOW), [],
    "fresh workbook + archive holding this comparison's 622 images");
});

test("2. …and was refused before, purely on the package's bound run", () => {
  // The same scope with the image set unknown falls back to the old rule, which
  // is what production was doing — and it blocks.
  const legacy = SCOPE({ imagePackage: PKG({ imagePlanFingerprint: null }) });
  assert.deepEqual(
    verifyArtifactScope(legacy, RUN_NOW, "b1.fb06", IMAGESET_NOW),
    ["image_package_unbound"],
    "the fallback still refuses, so the fix is the image set — not a loosening");
});

test("3. an archive holding DIFFERENT images is still refused", () => {
  const wrong = SCOPE({ imagePackage: PKG({ imagePlanFingerprint: "i1.621.aaaa" }) });
  assert.deepEqual(
    verifyArtifactScope(wrong, RUN_NOW, "b1.fb06", IMAGESET_NOW),
    ["image_package_unbound"]);
});

test("4. a workbook from an earlier comparison is STILL stale — run binding intact", () => {
  const old = SCOPE({ runFingerprint: "r1.YESTERDAY" });
  assert.deepEqual(
    verifyArtifactScope(old, RUN_NOW, "b1.fb06", IMAGESET_NOW), ["artifact_stale"],
    "the workbook's own binding is untouched by this change");
});

test("5. every other artifact guard is unchanged", () => {
  assert.ok(verifyArtifactScope(SCOPE({ baselineFingerprint: "b1.OTHER" }), RUN_NOW, "b1.fb06", IMAGESET_NOW)
    .includes("baseline_changed"));
  assert.ok(verifyArtifactScope(SCOPE({ rowsMissingImage: 1 }), RUN_NOW, "b1.fb06", IMAGESET_NOW)
    .includes("rows_missing_image"));
  assert.ok(verifyArtifactScope(SCOPE({ excludedCategoryRows: 1 }), RUN_NOW, "b1.fb06", IMAGESET_NOW)
    .includes("excluded_category_rows"));
  assert.ok(verifyArtifactScope(SCOPE({ workbookRows: 0 }), RUN_NOW, "b1.fb06", IMAGESET_NOW)
    .includes("artifact_empty"));
  assert.ok(verifyArtifactScope(SCOPE({
    extensionAudit: { mismatches: 0, renamed: 0, collisions: 2 },
  }), RUN_NOW, "b1.fb06", IMAGESET_NOW).includes("extension_mismatch_unfixed"));
  assert.deepEqual(verifyArtifactScope(null, RUN_NOW, "b1.fb06", IMAGESET_NOW), ["artifact_missing"]);
});

test("6. an absent image package is still unbound, and an incomplete one too", () => {
  assert.ok(verifyArtifactScope(SCOPE({ imagePackage: null }), RUN_NOW, "b1.fb06", IMAGESET_NOW)
    .includes("image_package_unbound"));
  assert.ok(verifyArtifactScope(SCOPE({ imagePackage: PKG({ packagedImages: 621 }) }),
    RUN_NOW, "b1.fb06", IMAGESET_NOW).includes("image_package_unbound"));
  assert.ok(verifyArtifactScope(SCOPE({ imagePackage: PKG({ bytes: 0 }) }),
    RUN_NOW, "b1.fb06", IMAGESET_NOW).includes("image_package_unbound"));
  assert.ok(verifyArtifactScope(SCOPE({ imagePackage: PKG({ baselineFingerprint: "b1.OTHER" }) }),
    RUN_NOW, "b1.fb06", IMAGESET_NOW).includes("image_package_unbound"));
});

test("7. omitting the current image set keeps the OLD behaviour exactly", () => {
  // Callers that predate this parameter must not silently change meaning.
  assert.deepEqual(verifyArtifactScope(SCOPE(), RUN_NOW, "b1.fb06"), ["image_package_unbound"]);
  assert.deepEqual(
    verifyArtifactScope(SCOPE({ imagePackage: PKG({ runFingerprint: RUN_NOW }) }), RUN_NOW, "b1.fb06"), []);
});

// ── the owner is told the real reason ───────────────────────────────────────

test("8. the preview reports WHICH artifact check failed, not one catch-all", () => {
  const src = code(SERVER);
  // STEP 86B renamed the two inputs: the gate now reads `currentRun` and
  // `currentImagePlan`, locals that fall back to the server's own delta when the
  // caller states neither. The SHAPE of the gate is deliberately unchanged —
  // both a comparison and zero blocks, or no send.
  assert.match(src, /const artifactBlocks = bundle !== null && currentRun !== null/);
  assert.match(src, /artifactBlockers: artifactBlocks\.map\(\(b\) => ARTIFACT_BLOCK_AR\[b\]\)/);
  assert.match(src, /const artifactFresh = bundle !== null && currentRun !== null\s*&& artifactBlocks\.length === 0/,
    "the gate still fails closed on ANY block");
  // and the screen shows them
  assert.match(code(UI), /preview\.artifactBlockers\.map/);
});

test("9. 'unbound' and 'stale' are different messages — they need different actions", () => {
  assert.notEqual(ARTIFACT_BLOCK_AR.image_package_unbound, ARTIFACT_BLOCK_AR.artifact_stale);
  for (const m of [ARTIFACT_BLOCK_AR.image_package_unbound, ARTIFACT_BLOCK_AR.artifact_stale]) {
    assert.ok(typeof m === "string" && m.length > 0);
  }
});

// ── the image set travels with the run, end to end ──────────────────────────

test("10. the scope summary publishes the current image set beside the run", () => {
  const src = code(SERVER);
  assert.match(src, /imagePlanFingerprint: deltaImagePlanFingerprint\(delta\.result\)/);
});

test("11. the route and the screen carry it on preview AND on send", () => {
  const route = code(ROUTE);
  assert.match(route, /currentImagePlanFingerprint: url\.searchParams\.get\("imagePlan"\)/);
  assert.match(route, /typeof body\.imagePlan === "string" && body\.imagePlan !== "" \? body\.imagePlan : null/);
  const ui = code(UI);
  assert.match(ui, /setImagePlan\(typeof body\?\.imagePlanFingerprint === "string"/);
  assert.match(ui, /\.\.\.\(imagePlan \? \{ imagePlan \} : \{\}\)/);
  assert.match(ui, /JSON\.stringify\(\{ to, cc, greeting, run, imagePlan, confirmationToken: confirmedToken \}\)/);
});

test("12. generation carries the image set into the artifact it writes", () => {
  const src = code(SERVER);
  assert.match(src, /imagePlanFingerprint: parsed\.imagePlanFingerprint/,
    "copied from the published sidecar, so the two ends compare the same value");
});

// ── blast radius ────────────────────────────────────────────────────────────

test("13. nothing here sends, publishes, deletes or writes catalogue rows", () => {
  const src = code(SERVER);
  const preview = src.slice(src.indexOf("export async function buildWorkflowPreview"),
    src.indexOf("export async function sendTalabatTestEmail"));
  for (const forbidden of ["sendMailViaSmtp", "putObject", "streamPartsToObject",
    'from("products")', "lifecycle_state", ".remove("]) {
    assert.equal(preview.includes(forbidden), false, `the preview must not ${forbidden}`);
  }
});

test("14. the official send is still off, and the hold still 13 SKUs", () => {
  assert.match(code("lib/export/talabat/email-workflow.ts"), /OFFICIAL_SEND_ENABLED = false/);
  const policy = code("lib/export/talabat/category-policy.ts");
  const list = policy.slice(policy.indexOf("TALABAT_AUTHENTICITY_HOLD:"),
    policy.indexOf("TALABAT_AUTHENTICITY_HOLD_REASON"));
  assert.equal((list.match(/"mk\d+"/g) ?? []).length, 13);
});
