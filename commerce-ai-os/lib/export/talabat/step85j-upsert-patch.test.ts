// STEP 85J — every request of a resumable upload carries x-upsert.
//
// PRODUCTION, 2026-09-09. The publish token was finally visible, and it said
// nothing had been uploaded:
//
//   "readyJob": { "jobId": "63b76cf0-…", "archiveBytes": 339430589 },
//   "publishProgress": { "uploadedBytes": 0, "percent": 0, "resumeAvailable": false }
//
// The token was right. The project's own logs show why — two attempts, and not
// one byte accepted by the server in either:
//
//   05:35:08  POST  /storage/v1/upload/resumable        → 201   resource created
//   05:35:11  PATCH /storage/v1/upload/resumable/<id>   → 409   first chunk refused
//   05:39:42  HEAD  /storage/v1/upload/resumable/<id>   → 200   resource still there
//   05:39:44  PATCH /storage/v1/upload/resumable/<id>   → 409   refused again
//
// The upload id decodes to `talabat-packages/email-artifacts/new_products/
// source/images.zip`, where the 632-image archive from 2026-09-07 already sat.
// Storage defers the duplicate check to the write: creation returns 201, and a
// PATCH without `x-upsert` may not overwrite an existing object — 409 Conflict.
// `x-upsert` was set on the creation call only. The single stage that ever
// succeeded was the one where that path was still empty.
//
// So the resume had nothing to resume, correctly, and the earlier fixes were
// each real but none of them could have made a byte land.
//
// node --conditions=react-server --experimental-strip-types --test lib/export/talabat/step85j-upsert-patch.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { publishProgressOf, resumeVerdict, type DeltaImagePublishState } from "./delta-image-publish.ts";

const HERE = join(fileURLToPath(new URL(".", import.meta.url)));
const APP_ROOT = join(HERE, "../../..");
const raw = (rel: string): string => readFileSync(join(APP_ROOT, rel), "utf8");
const code = (rel: string): string =>
  raw(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const TUS = "lib/storage/tus.server.ts";
const JOBS = "lib/talabat/package-job.server.ts";

// ── the transport: one header set, no request can omit it ────────────────────

test("1. x-upsert is defined ONCE, in the shared header set", () => {
  const tus = code(TUS);
  assert.equal((tus.match(/"x-upsert"/g) ?? []).length, 1,
    "one definition — not one per call site to forget");
  const at = tus.indexOf("const uploadHeaders");
  assert.notEqual(at, -1);
  const body = tus.slice(at, tus.indexOf("});", at));
  assert.match(body, /"x-upsert": "true"/);
  assert.match(body, /"tus-resumable": "1\.0\.0"/);
  assert.match(body, /Authorization: `Bearer \$\{key\}`/);
  assert.match(body, /apikey: key/);
});

test("2. create, patch and offset ALL spread that set", () => {
  const tus = code(TUS);
  assert.equal((tus.match(/uploadHeaders\(env\.key\)/g) ?? []).length, 3,
    "tusCreate + tusPatch + tusOffset");
  // and none of them hand-rolls its own auth any more
  assert.equal((tus.match(/Authorization: `Bearer \$\{env\.key\}`/g) ?? []).length, 0,
    "no per-call-site header block left to drift");
});

test("3. the PATCH — the request that was refused — carries it", () => {
  const tus = code(TUS);
  const patch = tus.slice(tus.indexOf("async tusPatch"), tus.indexOf("async tusOffset"));
  assert.match(patch, /\.\.\.uploadHeaders\(env\.key\)/, "upsert reaches the write");
  assert.match(patch, /"upload-offset": String\(offset\)/, "still exactly at the server's offset");
  assert.match(patch, /"Content-Type": "application\/offset\+octet-stream"/);
  assert.match(patch, /res\.status !== 204/, "and still only 204 counts as accepted");
});

test("4. the HEAD that reads the remote offset carries it too", () => {
  const tus = code(TUS);
  const head = tus.slice(tus.indexOf("async tusOffset"), tus.indexOf("async statObject"));
  assert.match(head, /headers: uploadHeaders\(env\.key\)/);
  assert.match(head, /method: "HEAD"/);
  assert.equal(/method: "PATCH"|body:/.test(head), false, "reads, never writes");
});

test("5. the creation call keeps its own extra headers alongside the shared set", () => {
  const tus = code(TUS);
  const create = tus.slice(tus.indexOf("async tusCreate"), tus.indexOf("async tusPatch"));
  assert.match(create, /\.\.\.uploadHeaders\(env\.key\)/);
  assert.match(create, /"upload-length": String\(totalBytes\)/);
  assert.match(create, /"upload-metadata": \[/);
  assert.match(create, /res\.status !== 201/);
});

test("6. credentials are still read at call time and never returned", () => {
  const tus = code(TUS);
  assert.match(tus, /process\.env\.SUPABASE_SERVICE_ROLE_KEY/);
  // the key only ever flows into request headers
  for (const leak of ["console.log", "console.error", "return env.key", "JSON.stringify(env"]) {
    assert.equal(tus.includes(leak), false, `must not ${leak}`);
  }
});

// ── the token was telling the truth ─────────────────────────────────────────

test("7. offset 0 with a live upload reference is correctly NOT resumable", () => {
  // publish.json existed, the TUS resource existed (HEAD 200), and still
  // nothing had been accepted. Reporting a resume here would be a lie.
  const token: DeltaImagePublishState = {
    jobId: "63b76cf0-544f-497d-b2bd-569279e4b94b",
    objectPath: "email-artifacts/new_products/source/images.zip",
    uploadUrl: "https://storage.example/upload/resumable/abc",
    totalBytes: 339430589,
    runFingerprint: "r1.BOUND",
    scopeProducts: 402, scopeRows: 511,
    confirmedOffset: 0,
    updatedAtIso: "2026-09-09T05:39:46.139Z",
    leaseUntilIso: null,
  };
  const identity = { jobId: token.jobId, objectPath: token.objectPath, totalBytes: token.totalBytes };
  assert.deepEqual(resumeVerdict(token, identity), { usable: true }, "the token is still usable…");
  const p = publishProgressOf(token, identity);
  assert.ok(p !== null, "…and reported, so the screen can show 0%");
  assert.equal(p.uploadedBytes, 0);
  assert.equal(p.percent, 0);
  assert.equal(p.resumeAvailable, false, "nothing to resume is not a resume");
});

test("8. a usable token is still handed to the stream, offset 0 or not", () => {
  // Which is what makes the next press continue rather than start over: the
  // engine asks the server for the offset, it does not trust the token's.
  const jobs = code(JOBS);
  const stage = jobs.slice(jobs.indexOf("export async function stageTalabatDeltaImagePackage"),
    jobs.indexOf("export async function readDeltaImagePublishProgress"));
  assert.match(stage, /const resumable = resumeVerdict\(prior, identity\)\.usable \? prior : null/);
  assert.match(stage, /resume: resumable \? \{ uploadUrl: resumable\.uploadUrl \} : null/);
  const eng = code("lib/export/artifact-stream.ts");
  assert.match(eng, /const remote = await ports\.tusOffset\(input\.resume\.uploadUrl\)/,
    "the server is the authority on the offset");
});

test("9. a dead upload reference clears the token, so the next press starts clean", () => {
  const jobs = code(JOBS);
  const stage = jobs.slice(jobs.indexOf("export async function stageTalabatDeltaImagePackage"),
    jobs.indexOf("export async function readDeltaImagePublishProgress"));
  assert.match(stage, /if \(streamed\.error === "resume_invalid"\)/);
  const branch = stage.slice(stage.indexOf('if (streamed.error === "resume_invalid")'));
  assert.match(branch.slice(0, 300), /publishStatePath\(jobId\), json\(\{ cleared: true \}\)/,
    "cleared, so the following attempt creates a fresh resource from the SAME archive");
  assert.equal(/startTalabatDeltaImageJob|fetch\(/.test(branch.slice(0, 300)), false,
    "and never by re-fetching an image or minting a job");
});

// ── nothing else moved ──────────────────────────────────────────────────────

test("10. publishing still streams the job's own durable parts", () => {
  const jobs = code(JOBS);
  const stage = jobs.slice(jobs.indexOf("export async function stageTalabatDeltaImagePackage"),
    jobs.indexOf("export async function readDeltaImagePublishProgress"));
  assert.match(stage, /state\.parts\.map\(\(p\) => \(\{ path: p\.path, bytes: p\.bytes \}\)\)/);
  for (const forbidden of ["fetch(", "planRowImages", "JSZip", "sendMail", ".remove("]) {
    assert.equal(stage.includes(forbidden), false, `publishing must not ${forbidden}`);
  }
});

test("11. the sidecar is still written only after the stored size is verified", () => {
  const eng = code("lib/export/artifact-stream.ts");
  const tail = eng.slice(eng.indexOf("const stored = await ports.statObject"));
  assert.match(tail, /stored !== input\.totalBytes/);
  assert.ok(tail.indexOf("stored !== input.totalBytes") < tail.indexOf("sha256: hash.digest"));
  const jobs = code(JOBS);
  const stage = jobs.slice(jobs.indexOf("export async function stageTalabatDeltaImagePackage"));
  assert.ok(stage.indexOf("streamPartsToObject(") < stage.indexOf("putObject(DELTA_IMAGE_META_PATH"));
});

test("12. Rafeeq shares the corrected transport, unchanged in behaviour", () => {
  const srv = code("lib/rafeeq/artifact-object.server.ts");
  assert.match(srv, /makeTusPorts\(RAFEEQ_JOB_BUCKET\)/);
  assert.match(srv, /tusCreate, tusPatch, tusOffset, statObject/);
  assert.equal(code("lib/export/rafeeq/artifact-object.ts").includes("resume:"), false);
});

test("13. the authenticity hold is untouched — still exactly 13 SKUs", () => {
  const policy = code("lib/export/talabat/category-policy.ts");
  const list = policy.slice(policy.indexOf("TALABAT_AUTHENTICITY_HOLD:"),
    policy.indexOf("TALABAT_AUTHENTICITY_HOLD_REASON"));
  assert.equal((list.match(/"mk\d+"/g) ?? []).length, 13);
});
