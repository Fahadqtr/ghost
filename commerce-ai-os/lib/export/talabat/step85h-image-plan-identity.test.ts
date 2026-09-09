// STEP 85H — a package is bound to its IMAGE SET, not to the whole comparison.
//
// PRODUCTION, 2026-09-09. After the STEP 85F fix the live status read:
//
//   { "ready": false, "staged": true, "imageCount": 632, "expectedImages": 622,
//     "scopeProducts": 402, "scopeRows": 511,
//     "blockers": ["stale previous comparison",
//                  "stored image package does not match current comparison"],
//     "readyJob": null, "publishProgress": null }
//
// The scope fix worked. But `image_package_stale_run` had ALSO started firing —
// silent the day before — which means the run fingerprint had moved overnight.
// It had: 48 products were edited between 04:54 and 05:13, all inside the
// master. None of them added, removed or re-photographed anything; the scope
// stayed at 402/511/622. They changed names and prices.
//
// `runFingerprint` is built from the comparison COUNTS — nameDiffs, priceDiffs
// among them — so editing the price of an existing product moves it. That is
// the right identity for a workbook and the wrong one for an archive of
// photographs: it invalidated four completed 622-image jobs whose images were
// still exactly the images today's email needs, and offered the owner nothing
// but a fifth 324 MB download.
//
// The fix binds the package to what it actually holds: every planned image, in
// plan order, by stored filename and source URL. A price edit does not move it;
// an added row, a dropped gallery shot or a re-uploaded photograph does.
//
// node --conditions=react-server --experimental-strip-types --test lib/export/talabat/step85h-image-plan-identity.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  imagePlanFingerprintOf, verifyDeltaImagePackage, parseDeltaImageMeta,
  type DeltaImageMeta,
} from "./delta-image-package.ts";

const HERE = join(fileURLToPath(new URL(".", import.meta.url)));
const APP_ROOT = join(HERE, "../../..");
const raw = (rel: string): string => readFileSync(join(APP_ROOT, rel), "utf8");
const code = (rel: string): string =>
  raw(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const JOBS = "lib/talabat/package-job.server.ts";
const WORKFLOW = "lib/talabat/email-workflow.server.ts";

/** The 622-image plan the four completed jobs were built from. */
const PLAN_622 = Array.from({ length: 622 }, (_, i) => ({
  filename: `mk${1000 + i}.jpg`,
  sourceUrl: `https://cdn.example/product-images/mk${1000 + i}.jpg?t=1`,
}));
const FP_622 = imagePlanFingerprintOf(PLAN_622);

const CURRENT_SCOPE = { expectedImages: 622, scopeProducts: 402, scopeRows: 511 };

/** The stale package actually published on 2026-09-07: 632 images. */
const STALE_632 = (over: Partial<DeltaImageMeta> = {}): DeltaImageMeta => ({
  imageCount: 632, expectedImages: 632, zipBytes: 346244336,
  extensionAudit: { mismatches: 0, renamed: 0, collisions: 0 },
  runFingerprint: "run-YESTERDAY", baselineFingerprint: "base-A",
  jobId: "f03464d8-ff05-4439-ac2a-1c2cc70211e6",
  stagedAtIso: "2026-09-07T01:12:46.690Z", sha256: "c".repeat(64),
  scopeProducts: null, scopeRows: null, imagePlanFingerprint: null,
  ...over,
});

// ── the fingerprint itself ──────────────────────────────────────────────────

test("1. the image fingerprint is deterministic and order-sensitive", () => {
  assert.equal(imagePlanFingerprintOf(PLAN_622), FP_622, "same input, same value");
  const reordered = [PLAN_622[1]!, PLAN_622[0]!, ...PLAN_622.slice(2)];
  assert.notEqual(imagePlanFingerprintOf(reordered), FP_622, "order is part of the archive");
  assert.match(FP_622, /^i1\.622\.[0-9a-f]{64}$/, "count is visible in the value");
});

test("2. it moves for a changed image set — and only for that", () => {
  const dropped = PLAN_622.slice(0, 621);
  assert.notEqual(imagePlanFingerprintOf(dropped), FP_622, "a dropped gallery shot");
  const added = [...PLAN_622, { filename: "mk9999.jpg", sourceUrl: "https://cdn.example/mk9999.jpg" }];
  assert.notEqual(imagePlanFingerprintOf(added), FP_622, "an added row");
  const reuploaded = PLAN_622.map((e, i) =>
    i === 5 ? { ...e, sourceUrl: `${e.sourceUrl.split("?")[0]}?t=2` } : e);
  assert.notEqual(imagePlanFingerprintOf(reuploaded), FP_622, "a re-uploaded photograph");
  const renamedFile = PLAN_622.map((e, i) => (i === 7 ? { ...e, filename: "other.jpg" } : e));
  assert.notEqual(imagePlanFingerprintOf(renamedFile), FP_622, "a different stored name");
});

// ── the production case ─────────────────────────────────────────────────────

test("3. a price/name edit does NOT invalidate a package whose images are unchanged", () => {
  // The exact regression: same 622 images, a run fingerprint that moved because
  // 48 unrelated products were edited.
  const good = STALE_632({
    imageCount: 622, expectedImages: 622, scopeProducts: 402, scopeRows: 511,
    runFingerprint: "run-YESTERDAY", imagePlanFingerprint: FP_622,
    jobId: "9f4b793f-0000-4000-8000-000000000000",
  });
  assert.deepEqual(
    verifyDeltaImagePackage(good, "run-TODAY-AFTER-48-EDITS", CURRENT_SCOPE, "base-A", FP_622),
    [], "the archive still holds exactly the images today's email needs");
});

test("4. a genuinely different image set is still refused, whatever the run says", () => {
  const wrongImages = STALE_632({
    imageCount: 622, expectedImages: 622, scopeProducts: 402, scopeRows: 511,
    runFingerprint: "run-TODAY", imagePlanFingerprint: imagePlanFingerprintOf(PLAN_622.slice(0, 621)),
  });
  assert.ok(
    verifyDeltaImagePackage(wrongImages, "run-TODAY", CURRENT_SCOPE, "base-A", FP_622)
      .includes("image_package_stale_run"),
    "same run, different photographs — refused");
});

test("5. the stale 632 package stays refused, on both counts", () => {
  const blocks = verifyDeltaImagePackage(STALE_632(), "run-TODAY", CURRENT_SCOPE, "base-A", FP_622);
  assert.ok(blocks.includes("image_package_stale_run"), "no recorded image set → run decides, and it moved");
  assert.ok(blocks.includes("image_package_scope_mismatch"), "and 632 is not 622");
});

test("6. a legacy sidecar with no image set falls back to the run fingerprint", () => {
  const legacy = STALE_632({
    imageCount: 622, expectedImages: 622, scopeProducts: 402, scopeRows: 511,
    runFingerprint: "run-TODAY", imagePlanFingerprint: null,
  });
  assert.deepEqual(
    verifyDeltaImagePackage(legacy, "run-TODAY", CURRENT_SCOPE, "base-A", FP_622), [],
    "matching run, nothing else to go on → accepted, exactly as before");
  assert.ok(
    verifyDeltaImagePackage(legacy, "run-OTHER", CURRENT_SCOPE, "base-A", FP_622)
      .includes("image_package_stale_run"),
    "and a mismatching run is still refused — the fallback is conservative");
});

test("7. the baseline guard is untouched", () => {
  const good = STALE_632({
    imageCount: 622, expectedImages: 622, scopeProducts: 402, scopeRows: 511,
    imagePlanFingerprint: FP_622,
  });
  assert.ok(
    verifyDeltaImagePackage(good, "run-TODAY", CURRENT_SCOPE, "base-B", FP_622)
      .includes("image_package_stale_baseline"),
    "another Talabat export is still another comparison");
});

test("8. the sidecar round-trips the image set, strictly", () => {
  const parsed = parseDeltaImageMeta({
    imageCount: 622, expectedImages: 622, zipBytes: 339430589,
    extensionAudit: { mismatches: 0, renamed: 0, collisions: 0 },
    runFingerprint: "r", baselineFingerprint: "b", jobId: "j", stagedAtIso: "t",
    sha256: "d".repeat(64), scopeProducts: 402, scopeRows: 511,
    imagePlanFingerprint: FP_622,
  });
  assert.equal(parsed?.imagePlanFingerprint, FP_622);
  const junk = parseDeltaImageMeta({
    imageCount: 1, expectedImages: 1, zipBytes: 1,
    extensionAudit: { mismatches: 0, renamed: 0, collisions: 0 },
    runFingerprint: "r", baselineFingerprint: null, jobId: "j", stagedAtIso: "t",
    sha256: null, imagePlanFingerprint: 42,
  });
  assert.equal(junk?.imagePlanFingerprint, null, "a non-string is absent, not a value");
});

// ── legacy jobs are recovered from their own persisted plan ─────────────────

test("9. a legacy binding is matched by recomputing from its immutable plan.json", () => {
  const jobs = code(JOBS);
  const finder = jobs.slice(jobs.indexOf("export async function findStageableDeltaImageJob"));
  assert.match(finder, /binding\.imagePlanFingerprint \?\? await imagePlanFingerprintOfJob\(row\.id\)/,
    "the stored value, else the same function over the job's own plan");
  assert.match(finder, /if \(jobPlan !== imagePlanFingerprint\) \{\s*continue;\s*\}|else if \(jobPlan !== imagePlanFingerprint\) \{/,
    "a plan listing different images is still refused");
  const recompute = jobs.slice(jobs.indexOf("async function imagePlanFingerprintOfJob"));
  assert.match(recompute, /getJson<TalabatPackageJobPlan>\(planPath\(jobId\)\)/, "reads plan.json");
  assert.match(recompute, /plan\.images\.map/, "over the images the job actually fetched");
  for (const forbidden of ["fetch(", "planRowImages", "startTalabatDeltaImageJob"]) {
    assert.equal(recompute.slice(0, recompute.indexOf("\n}")).includes(forbidden), false,
      `reconstruction must not ${forbidden}`);
  }
});

test("10. when neither side can name its image set, the old rule still applies", () => {
  const jobs = code(JOBS);
  const finder = jobs.slice(jobs.indexOf("export async function findStageableDeltaImageJob"));
  assert.match(finder, /if \(jobPlan === null\) \{\s*if \(binding\.runFingerprint !== runFingerprint\) continue;/,
    "no plan to compare → the comparison-wide fingerprint decides, as before");
  assert.match(finder, /\} else if \(binding\.runFingerprint !== runFingerprint\) \{\s*continue;/,
    "and with no current image set either, nothing changes at all");
});

test("11. the status and the generation path both pass the current image set", () => {
  const wf = code(WORKFLOW);
  assert.match(wf, /const imagePlan = deltaImagePlanFingerprint\(delta\.result\);/);
  assert.match(wf, /findStageableDeltaImageJob\(delta\.fingerprint, imagePlan\)/);
  assert.match(wf, /verifyDeltaImagePackage\(\s*meta, delta\.fingerprint, scope, delta\.baseline\?\.fingerprint \?\? null, imagePlan\)/);
  assert.match(wf, /deltaImagePlanFingerprint\(delta\.result\), nowIso\)/, "generation too");
});

test("12. new jobs record their image set on the binding and in the sidecar", () => {
  const jobs = code(JOBS);
  assert.match(jobs, /imagePlanFingerprint: imagePlanFingerprintOf\(\s*created\.plan\.images\.map/);
  const stage = jobs.slice(jobs.indexOf("export async function stageTalabatDeltaImagePackage"));
  assert.match(stage, /imagePlanFingerprint: binding\.imagePlanFingerprint\s*\?\? await imagePlanFingerprintOfJob\(jobId\)/,
    "a legacy job publishes with the set recomputed from its own plan");
});

// ── blast radius ────────────────────────────────────────────────────────────

test("13. nothing here rebuilds, re-downloads, publishes or sends", () => {
  const jobs = code(JOBS);
  const finder = jobs.slice(jobs.indexOf("export async function findStageableDeltaImageJob"));
  for (const forbidden of ["fetch(", "insert(", "sendMail", ".remove(", "streamPartsToObject"]) {
    assert.equal(finder.includes(forbidden), false, `discovery must not ${forbidden}`);
  }
});

test("14. the authenticity hold is untouched — still exactly 13 SKUs", () => {
  const policy = code("lib/export/talabat/category-policy.ts");
  const list = policy.slice(policy.indexOf("TALABAT_AUTHENTICITY_HOLD:"),
    policy.indexOf("TALABAT_AUTHENTICITY_HOLD_REASON"));
  for (const sku of ["mk1127", "mk1128", "mk1111", "mk1129", "mk922", "mk923", "mk2321",
    "mk924", "mk2088", "mk2086", "mk1999", "mk2000", "mk2001"]) {
    assert.ok(list.includes(`"${sku}"`), `${sku} still held`);
  }
  assert.equal((list.match(/"mk\d+"/g) ?? []).length, 13);
});

test("15. the image set is derived from the SAME allowed rows the workbook uses", () => {
  const src = code("lib/export/talabat/delta-image-package.ts");
  const fn = src.slice(src.indexOf("export function deltaImagePlanFingerprint"));
  const body = fn.slice(0, fn.indexOf("\n}"));
  assert.match(body, /allowedNewDeltaRows\(result\)/, "held and excluded rows contribute nothing");
  assert.match(body, /planRowImages\(r\.our\)/, "and the certified per-row planner decides the files");
});
