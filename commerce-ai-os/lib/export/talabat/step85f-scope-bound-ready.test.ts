// STEP 85F — a staged image package is "ready" only for the scope it serves.
//
// PRODUCTION, 2026-09-08. The owner-authenticated status endpoint returned:
//
//   { "ready": true, "staged": true, "imageCount": 632, "expectedImages": 622,
//     "zipBytes": 346244336, "stagedAtIso": "2026-09-07T01:12:46.690Z",
//     "scopeProducts": 402, "scopeRows": 511, "blockers": [], "readyJob": null }
//
// A package holding 632 images was declared ready for a comparison that plans
// 622 — with an EMPTY blocker list, while the same response printed both numbers
// side by side. Two defects, one cause:
//
//  1. verifyDeltaImagePackage compared meta.imageCount against
//     meta.expectedImages — two fields the SAME sidecar wrote about ITSELF. A
//     package that finished cleanly always agrees with itself, so the check
//     could never fail for a package built against a different plan. The
//     CURRENT plan was computed in the same function and never passed in.
//  2. The run fingerprint could not catch it either, and by construction never
//     will: it is derived from the comparison COUNTS, and the Talabat-only
//     authenticity hold changes which rows are ALLOWED without moving a count.
//
// And because deltaImagePackageStatus only looks for a recoverable job when the
// published package is unusable, a false `ready` also hid `readyJob` — which is
// why four completed 622-image jobs sat unpublishable behind a button that
// never rendered.
//
// The fix passes the current scope into the verifier as a REQUIRED argument, so
// no call site can omit it, and records the scope on the binding and sidecar so
// future packages state what they serve instead of being guessed at.
//
// node --conditions=react-server --experimental-strip-types --test lib/export/talabat/step85f-scope-bound-ready.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  verifyDeltaImagePackage, parseDeltaImageMeta, DELTA_IMAGE_BLOCK_AR,
  type DeltaImageMeta,
} from "./delta-image-package.ts";

const HERE = join(fileURLToPath(new URL(".", import.meta.url)));
const APP_ROOT = join(HERE, "../../..");
const raw = (rel: string): string => readFileSync(join(APP_ROOT, rel), "utf8");
const code = (rel: string): string =>
  raw(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const WORKFLOW = "lib/talabat/email-workflow.server.ts";
const JOBS = "lib/talabat/package-job.server.ts";
const UI = "app/(v2)/v2/operations/channels/talabat-email/ImagePackage.tsx";

/** The sidecar production actually had: staged 2026-09-07, 632 images. */
const STALE_632 = (over: Partial<DeltaImageMeta> = {}): DeltaImageMeta => ({
  imageCount: 632, expectedImages: 632, zipBytes: 346244336,
  extensionAudit: { mismatches: 0, renamed: 0, collisions: 0 },
  runFingerprint: "run-A", baselineFingerprint: "base-A",
  jobId: "f03464d8-ff05-4439-ac2a-1c2cc70211e6",
  stagedAtIso: "2026-09-07T01:12:46.690Z", sha256: "c".repeat(64),
  scopeProducts: null, scopeRows: null, imagePlanFingerprint: null,
  ...over,
});

/** The comparison as it stands after the authenticity hold. */
const CURRENT = { expectedImages: 622, scopeProducts: 402, scopeRows: 511 };

// ── A. the exact production case ────────────────────────────────────────────

test("A. 632 staged against a 622-image plan is NOT ready", () => {
  const blocks = verifyDeltaImagePackage(STALE_632(), "run-A", CURRENT, "base-A");
  assert.deepEqual(blocks, ["image_package_scope_mismatch"]);
  assert.ok(blocks.length > 0, "ready would be false");
});

test("A2. the run fingerprint MATCHING does not rescue it — that was the trap", () => {
  // Same run, same baseline, self-consistent sidecar: every pre-existing check
  // passes. Only the scope comparison stands between the old archive and an
  // email that would link 10 images the workbook withholds.
  const meta = STALE_632();
  assert.equal(meta.runFingerprint, "run-A");
  assert.equal(meta.imageCount, meta.expectedImages, "self-consistent, as it was");
  assert.deepEqual(
    verifyDeltaImagePackage(meta, "run-A", CURRENT, "base-A"),
    ["image_package_scope_mismatch"],
  );
});

// ── B. the older guarantees still hold ──────────────────────────────────────

test("B. a package from another RUN is still refused", () => {
  const blocks = verifyDeltaImagePackage(
    STALE_632({ imageCount: 622, expectedImages: 622 }), "run-B", CURRENT, "base-A");
  assert.deepEqual(blocks, ["image_package_stale_run"]);
});

test("B2. a package from another BASELINE is still refused", () => {
  const blocks = verifyDeltaImagePackage(
    STALE_632({ imageCount: 622, expectedImages: 622 }), "run-A", CURRENT, "base-B");
  assert.deepEqual(blocks, ["image_package_stale_baseline"]);
});

test("B3. missing, empty and duplicate-name packages are unchanged", () => {
  assert.deepEqual(verifyDeltaImagePackage(null, "run-A", CURRENT, "base-A"),
    ["image_package_missing"]);
  assert.ok(verifyDeltaImagePackage(STALE_632({ zipBytes: 0 }), "run-A", CURRENT, "base-A")
    .includes("image_package_missing"));
  assert.ok(verifyDeltaImagePackage(
    STALE_632({ imageCount: 622, expectedImages: 622,
      extensionAudit: { mismatches: 0, renamed: 0, collisions: 2 } }),
    "run-A", CURRENT, "base-A").includes("image_package_duplicate_names"));
});

// ── D. the package that IS current ──────────────────────────────────────────

test("D. a 622-image package bound to this run and scope IS ready", () => {
  const good = STALE_632({
    imageCount: 622, expectedImages: 622, scopeProducts: 402, scopeRows: 511,
    jobId: "9f4b793f-0000-4000-8000-000000000000",
  });
  assert.deepEqual(verifyDeltaImagePackage(good, "run-A", CURRENT, "base-A"), []);
});

test("D2. recorded row/product counts are compared when present", () => {
  const rowsOff = STALE_632({ imageCount: 622, expectedImages: 622, scopeProducts: 402, scopeRows: 517 });
  assert.deepEqual(verifyDeltaImagePackage(rowsOff, "run-A", CURRENT, "base-A"),
    ["image_package_scope_mismatch"]);
  const productsOff = STALE_632({ imageCount: 622, expectedImages: 622, scopeProducts: 408, scopeRows: 511 });
  assert.deepEqual(verifyDeltaImagePackage(productsOff, "run-A", CURRENT, "base-A"),
    ["image_package_scope_mismatch"]);
});

test("D3. an absent recorded scope is UNKNOWN, never assumed equal", () => {
  // A sidecar written before these fields existed carries null. It must not be
  // treated as agreeing — but it must not invent a mismatch either: the image
  // count is what judges it, and that needs no stored history.
  const old = STALE_632({ imageCount: 622, expectedImages: 622, scopeProducts: null, scopeRows: null });
  assert.deepEqual(verifyDeltaImagePackage(old, "run-A", CURRENT, "base-A"), []);
  const oldWrongCount = STALE_632({ scopeProducts: null, scopeRows: null });
  assert.deepEqual(verifyDeltaImagePackage(oldWrongCount, "run-A", CURRENT, "base-A"),
    ["image_package_scope_mismatch"]);
});

// ── E. the owner is told which failure this is ──────────────────────────────

test("E. the scope mismatch has its own owner-facing message", () => {
  const msg = DELTA_IMAGE_BLOCK_AR.image_package_scope_mismatch;
  assert.ok(typeof msg === "string" && msg.length > 0);
  for (const other of ["image_package_missing", "image_package_stale_run",
    "image_package_incomplete", "image_package_duplicate_names"] as const) {
    assert.notEqual(msg, DELTA_IMAGE_BLOCK_AR[other], `distinct from ${other}`);
  }
  assert.equal(msg.includes("مزود البريد"), false, "a packaging fault never blames mail");
});

test("E2. the sidecar round-trips the new fields, strictly", () => {
  const parsed = parseDeltaImageMeta({
    imageCount: 622, expectedImages: 622, zipBytes: 339430589,
    extensionAudit: { mismatches: 0, renamed: 0, collisions: 0 },
    runFingerprint: "run-A", baselineFingerprint: "base-A",
    jobId: "9f4b793f-0000-4000-8000-000000000000", stagedAtIso: "t",
    sha256: "d".repeat(64), scopeProducts: 402, scopeRows: 511,
  });
  assert.ok(parsed !== null);
  assert.equal(parsed.scopeProducts, 402);
  assert.equal(parsed.scopeRows, 511);
  // garbage is null, not a default
  const junk = parseDeltaImageMeta({
    imageCount: 622, expectedImages: 622, zipBytes: 1,
    extensionAudit: { mismatches: 0, renamed: 0, collisions: 0 },
    runFingerprint: "r", baselineFingerprint: null, jobId: "j", stagedAtIso: "t",
    sha256: null, scopeProducts: "402", scopeRows: -5,
  });
  assert.ok(junk !== null);
  assert.equal(junk.scopeProducts, null);
  assert.equal(junk.scopeRows, null);
});

// ── C. with ready false, the recoverable job is found again ─────────────────

test("C. the status only hunts for a ready job when the published one is unusable", () => {
  const wf = code(WORKFLOW);
  assert.match(wf, /const readyJob = ready \? null : await findStageableDeltaImageJob\(delta\.fingerprint, imagePlan\)/,
    "reachable, because a stale package no longer reads as ready — and matched on the image set");
  assert.match(wf, /const ready = meta !== null && blocks\.length === 0/);
  assert.match(wf, /verifyDeltaImagePackage\(\s*meta, delta\.fingerprint, scope, delta\.baseline\?\.fingerprint \?\? null, imagePlan\)/,
    "the status passes the CURRENT scope, and the current image set");
});

test("C2. the publish button renders from readyJob, and publishes an existing job", () => {
  const ui = code(UI);
  assert.match(ui, /status\?\.readyJob \? \(/);
  assert.match(ui, /onClick=\{\(\) => void publishReady\(status\.readyJob!\.jobId\)\}/);
  assert.match(ui, /نشر الحزمة الجاهزة/);
});

// ── F. nothing here re-fetches or regenerates ───────────────────────────────

test("F. publishing a discovered job streams stored parts — it never re-fetches", () => {
  const jobs = code(JOBS);
  const stage = jobs.slice(jobs.indexOf("export async function stageTalabatDeltaImagePackage"),
    jobs.indexOf("export async function findStageableDeltaImageJob"));
  assert.match(stage, /streamPartsToObject\(/, "streamed from the durable parts");
  for (const forbidden of ["fetch(", "downloadImage", "planRowImages", "JSZip"]) {
    assert.equal(stage.includes(forbidden), false, `staging must not ${forbidden}`);
  }
});

test("F2. the scope is recorded on the binding and carried into the sidecar", () => {
  const jobs = code(JOBS);
  assert.match(jobs, /scopeProducts: input\.scope\.scopeProducts/);
  assert.match(jobs, /scopeRows: input\.scope\.scopeRows/);
  const stage = jobs.slice(jobs.indexOf("export async function stageTalabatDeltaImagePackage"));
  assert.match(stage, /scopeProducts: binding\.scopeProducts/);
  assert.match(stage, /scopeRows: binding\.scopeRows/);
  assert.match(code(WORKFLOW), /scope: deltaImageScope\(delta\.result\)/);
});

test("F3. the generation path refuses an off-scope package as stale", () => {
  const wf = code(WORKFLOW);
  const reader = wf.slice(wf.indexOf("async function readPublishedImagePackage"));
  assert.match(reader, /blocks\.includes\("image_package_scope_mismatch"\)/);
  const staleBranch = reader.slice(reader.indexOf('blocks.includes("image_package_stale_run")'));
  assert.match(staleBranch.slice(0, 400), /error: "image_package_stale"/);
});

// ── blast radius ────────────────────────────────────────────────────────────

test("G. this step publishes nothing, sends nothing and deletes nothing", () => {
  const wf = code(WORKFLOW);
  const status = wf.slice(wf.indexOf("export async function deltaImagePackageStatus"));
  const body = status.slice(0, status.indexOf("\nexport "));
  for (const forbidden of ["putObject", "streamPartsToObject", "sendMail",
    "generateNewProductsArtifact", "startTalabatDeltaImageJob"]) {
    assert.equal(body.includes(forbidden), false, `reading the status must not ${forbidden}`);
  }
});

test("H. the authenticity hold is untouched — still exactly 13 SKUs", () => {
  const policy = code("lib/export/talabat/category-policy.ts");
  const list = policy.slice(policy.indexOf("TALABAT_AUTHENTICITY_HOLD:"),
    policy.indexOf("TALABAT_AUTHENTICITY_HOLD_REASON"));
  for (const sku of ["mk1127", "mk1128", "mk1111", "mk1129", "mk922", "mk923", "mk2321",
    "mk924", "mk2088", "mk2086", "mk1999", "mk2000", "mk2001"]) {
    assert.ok(list.includes(`"${sku}"`), `${sku} still held`);
  }
  assert.equal((list.match(/"mk\d+"/g) ?? []).length, 13);
});
