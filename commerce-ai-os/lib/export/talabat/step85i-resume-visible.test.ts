// STEP 85I — a partly uploaded archive must stay visible, and stay preferred.
//
// PRODUCTION, 2026-09-09. With the resumable publish deployed, the live status
// read:
//
//   { "ready": false, "readyJob": { "jobId": "63b76cf0-…",
//     "imageCount": 622, "archiveBytes": 339430589 },
//     "publishProgress": null }
//
// …while `jobs/63b76cf0-…/publish.json` existed in storage, 544 bytes, written
// at 05:35:09 and advanced at 05:39:46 by two publish attempts. The token was
// there. The reader threw it away.
//
// `resumeVerdict` required the token's runFingerprint to equal the caller's.
// The token carries the fingerprint its JOB was bound to (2026-09-08 23:11);
// the status screen asks with the CURRENT one; and 48 unrelated price edits
// between 04:54 and 05:13 had moved the current one. So a 324 MB upload already
// part-way to the server reported no progress, and the owner was offered a
// fresh start instead of the resume sitting right there — who then pressed
// "prepare" again, minting a sixth identical job.
//
// Two corrections, both narrow:
//   1. The token identifies an UPLOAD — job, target path, byte count. Whether
//      that job still serves today's comparison is settled by
//      findStageableDeltaImageJob before the token is ever read.
//   2. Discovery prefers a candidate with real upload progress over a merely
//      newer one, so pressing "prepare" again cannot orphan a live transfer.
//
// node --conditions=react-server --experimental-strip-types --test lib/export/talabat/step85i-resume-visible.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  resumeVerdict, publishProgressOf, parseDeltaImagePublishState, publishStatePath,
  type DeltaImagePublishState,
} from "./delta-image-publish.ts";

const HERE = join(fileURLToPath(new URL(".", import.meta.url)));
const APP_ROOT = join(HERE, "../../..");
const raw = (rel: string): string => readFileSync(join(APP_ROOT, rel), "utf8");
const code = (rel: string): string =>
  raw(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const JOBS = "lib/talabat/package-job.server.ts";
const WORKFLOW = "lib/talabat/email-workflow.server.ts";

/** The production upload: job 63b76cf0, 339,430,589 bytes, part-way up. */
const JOB = "63b76cf0-544f-497d-b2bd-569279e4b94b";
const ZIP = "email-artifacts/new_products/source/images.zip";
const IDENTITY = { jobId: JOB, objectPath: ZIP, totalBytes: 339430589 };

const TOKEN = (over: Partial<DeltaImagePublishState> = {}): DeltaImagePublishState => ({
  ...IDENTITY,
  uploadUrl: "https://storage.example/upload/resumable/xyz",
  // the fingerprint the JOB was bound to, on 2026-09-08 23:11
  runFingerprint: "r1.BOUND-AT-2026-09-08T23-11",
  scopeProducts: 402, scopeRows: 511,
  confirmedOffset: 201_326_592,
  updatedAtIso: "2026-09-09T05:39:46.139Z",
  leaseUntilIso: null,
  ...over,
});

// ── the regression ──────────────────────────────────────────────────────────

test("1. a comparison fingerprint that moved does not hide the upload", () => {
  // 48 price edits later, the current fingerprint is not the bound one.
  assert.deepEqual(resumeVerdict(TOKEN(), IDENTITY), { usable: true });
  const p = publishProgressOf(TOKEN(), IDENTITY);
  assert.ok(p !== null, "publishProgress is no longer null");
  assert.equal(p.uploadedBytes, 201_326_592);
  assert.equal(p.totalBytes, 339430589);
  assert.equal(p.percent, 59);
  assert.equal(p.resumeAvailable, true);
});

test("2. the upload's own identity is still enforced, on every field", () => {
  assert.deepEqual(resumeVerdict(TOKEN({ jobId: "another-job" }), IDENTITY),
    { usable: false, reason: "different_job" });
  assert.deepEqual(resumeVerdict(TOKEN({ objectPath: "email-artifacts/elsewhere.zip" }), IDENTITY),
    { usable: false, reason: "different_path" });
  assert.deepEqual(resumeVerdict(TOKEN({ totalBytes: 346244336 }), IDENTITY),
    { usable: false, reason: "different_size" });
  assert.deepEqual(resumeVerdict(null, IDENTITY), { usable: false, reason: "no_state" });
  for (const bad of [{ jobId: "another-job" }, { totalBytes: 1 }]) {
    assert.equal(publishProgressOf(TOKEN(bad), IDENTITY), null,
      "and progress is never shown for an upload that is not this one");
  }
});

test("3. the token still records the comparison it came from", () => {
  // Dropped as a GATE, kept as a fact: it is how an audit ties the archive back
  // to the run that planned it.
  const parsed = parseDeltaImagePublishState({
    ...IDENTITY, uploadUrl: "u", runFingerprint: "r1.SOMETHING",
    confirmedOffset: 10, updatedAtIso: "t", scopeProducts: 402, scopeRows: 511,
  });
  assert.equal(parsed?.runFingerprint, "r1.SOMETHING");
  const jobs = code(JOBS);
  const stage = jobs.slice(jobs.indexOf("export async function stageTalabatDeltaImagePackage"));
  assert.match(stage, /runFingerprint: binding\.runFingerprint/, "still written down");
});

test("4. a finished or empty upload still offers no resume", () => {
  assert.equal(publishProgressOf(TOKEN({ confirmedOffset: 339430589 }), IDENTITY)?.resumeAvailable, false);
  assert.equal(publishProgressOf(TOKEN({ confirmedOffset: 0 }), IDENTITY)?.resumeAvailable, false);
});

// ── discovery prefers the upload in flight ──────────────────────────────────

test("5. a part-uploaded job is preferred over a merely newer identical one", () => {
  const jobs = code(JOBS);
  const finder = jobs.slice(jobs.indexOf("export async function findStageableDeltaImageJob"));
  assert.match(finder, /const progress = await readDeltaImagePublishProgress\(row\.id, candidate\.archiveBytes\)/);
  assert.match(finder, /if \(progress\?\.resumeAvailable\) return candidate;/,
    "the first candidate with real progress wins");
  assert.match(finder, /if \(best === null\) best = candidate;/, "newest is the fallback");
  assert.match(finder, /return best;/);
  // candidates are still newest-first, so the fallback is still the newest
  assert.match(finder, /\.order\("completed_at", \{ ascending: false \}\)/);
});

test("6. preference is by REAL progress, not by the mere existence of a token", () => {
  // A token at offset 0 — written and then immediately lost — must not pin
  // discovery to an older job for nothing.
  assert.equal(publishProgressOf(TOKEN({ confirmedOffset: 0 }), IDENTITY)?.resumeAvailable, false);
  const jobs = code(JOBS);
  const finder = jobs.slice(jobs.indexOf("export async function findStageableDeltaImageJob"));
  assert.equal(/if \(progress\b(?!\?\.resumeAvailable)/.test(finder), false,
    "gated on resumeAvailable, never on the token merely existing");
});

test("7. the status reads progress for the job it is actually offering", () => {
  const wf = code(WORKFLOW);
  assert.match(wf, /await readDeltaImagePublishProgress\(readyJob\.jobId, readyJob\.archiveBytes\)/);
  const jobs = code(JOBS);
  assert.match(jobs, /export async function readDeltaImagePublishProgress\(\s*jobId: string, totalBytes: number,/);
  assert.equal(publishStatePath(JOB), `jobs/${JOB}/publish.json`);
});

// ── everything STEP 85G promised still holds ────────────────────────────────

test("8. the token is still written before bytes and advanced as they land", () => {
  const jobs = code(JOBS);
  const stage = jobs.slice(jobs.indexOf("export async function stageTalabatDeltaImagePackage"),
    jobs.indexOf("export async function readDeltaImagePublishProgress"));
  assert.match(stage, /resume: resumable \? \{ uploadUrl: resumable\.uploadUrl \} : null/);
  assert.match(stage, /await writePublishState\(\{ uploadUrl: p\.uploadUrl, confirmedOffset: p\.confirmedOffset \}\)/);
  assert.match(stage, /if \(publishLeaseHeld\(prior, nowMs\)\) return errResult\("conflict", 409\)/);
});

test("9. publishing still clears the token and never re-fetches an image", () => {
  const jobs = code(JOBS);
  const stage = jobs.slice(jobs.indexOf("export async function stageTalabatDeltaImagePackage"),
    jobs.indexOf("export async function readDeltaImagePublishProgress"));
  const afterMeta = stage.slice(stage.indexOf("putObject(DELTA_IMAGE_META_PATH"));
  assert.match(afterMeta, /publishStatePath\(jobId\), json\(\{ cleared: true \}\)/);
  for (const forbidden of ["fetch(", "planRowImages", "JSZip", "startTalabatDeltaImageJob", "sendMail"]) {
    assert.equal(stage.includes(forbidden), false, `publishing must not ${forbidden}`);
  }
});

test("10. the image-set rule from STEP 85H is untouched", () => {
  const jobs = code(JOBS);
  const finder = jobs.slice(jobs.indexOf("export async function findStageableDeltaImageJob"));
  assert.match(finder, /binding\.imagePlanFingerprint \?\? await imagePlanFingerprintOfJob\(row\.id\)/);
  assert.match(finder, /jobPlan !== imagePlanFingerprint/);
});

test("11. the authenticity hold is untouched — still exactly 13 SKUs", () => {
  const policy = code("lib/export/talabat/category-policy.ts");
  const list = policy.slice(policy.indexOf("TALABAT_AUTHENTICITY_HOLD:"),
    policy.indexOf("TALABAT_AUTHENTICITY_HOLD_REASON"));
  assert.equal((list.match(/"mk\d+"/g) ?? []).length, 13);
});
