// STEP 85G — publishing the Email B image package survives the request that carries it.
//
// The archive is ~324 MB of durable parts and the route's ceiling is 300
// seconds. streamPartsToObject called tusCreate unconditionally, so every
// attempt opened a NEW upload and re-sent from byte 0: each retry expired in
// roughly the same place and threw away everything the previous one delivered.
// Four completed 622-image jobs sat unpublishable behind it, and the only
// visible alternative was to download 622 photographs again.
//
// The fix is a resume token — the upload resource plus what it belongs to,
// written down BEFORE any byte is sent and advanced as the server confirms
// bytes. The next attempt asks the server for its offset and continues.
//
// Two properties are load-bearing and are proved here byte-for-byte against a
// fake TUS server: the uploaded object equals the concatenated parts exactly
// (no byte duplicated, skipped or reordered), and the recorded SHA-256 is still
// the hash of those exact bytes — the hash is recomputed from byte 0 on every
// attempt because reading the durable parts is cheap next to uploading them,
// which keeps the digest honest without serialising hash state.
//
// node --conditions=react-server --experimental-strip-types --test lib/export/talabat/step85g-resumable-publish.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  streamPartsToObject, TUS_CHUNK_BYTES,
  type StreamedAssemblyPorts, type StreamedAssemblyProgress,
} from "../artifact-stream.ts";
import {
  publishStatePath, parseDeltaImagePublishState, resumeVerdict, publishLeaseHeld,
  publishProgressOf, PUBLISH_LEASE_MS,
  type DeltaImagePublishState,
} from "./delta-image-publish.ts";

const HERE = join(fileURLToPath(new URL(".", import.meta.url)));
const APP_ROOT = join(HERE, "../../..");
const raw = (rel: string): string => readFileSync(join(APP_ROOT, rel), "utf8");
const code = (rel: string): string =>
  raw(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const JOBS = "lib/talabat/package-job.server.ts";
const WORKFLOW = "lib/talabat/email-workflow.server.ts";
const UI = "app/(v2)/v2/operations/channels/talabat-email/ImagePackage.tsx";

// ── a fake TUS server that can be killed mid-upload ─────────────────────────

const PART_SIZES = [TUS_CHUNK_BYTES + 1000, TUS_CHUNK_BYTES * 2, 4321, TUS_CHUNK_BYTES];
const TOTAL = PART_SIZES.reduce((a, b) => a + b, 0);

/** Deterministic, position-dependent bytes, so a shift of one is detectable. */
function partBytes(index: number, size: number, base: number): Uint8Array {
  const out = new Uint8Array(size);
  for (let i = 0; i < size; i++) out[i] = (base + i * 7 + index * 31) % 251;
  return out;
}
const PARTS = PART_SIZES.map((size, i) => ({
  path: `jobs/j/part-${String(i).padStart(5, "0")}`,
  bytes: size,
  data: partBytes(i, size, i * 13),
}));
const EXPECTED = (() => {
  const out = new Uint8Array(TOTAL);
  let at = 0;
  for (const p of PARTS) { out.set(p.data, at); at += p.data.length; }
  return out;
})();
const EXPECTED_SHA = createHash("sha256").update(EXPECTED).digest("hex");

interface Server {
  /** what the "remote object" holds, by offset. */
  received: Uint8Array;
  offset: number;
  urls: string[];
  /** kill the request after this many PATCHes. */
  dieAfterPatches: number;
  patches: number;
  finalized: boolean;
}

function makeServer(over: Partial<Server> = {}): Server {
  return {
    received: new Uint8Array(TOTAL), offset: 0, urls: [],
    dieAfterPatches: Number.POSITIVE_INFINITY, patches: 0, finalized: false, ...over,
  };
}

function portsFor(srv: Server, opts: { missingPart?: string } = {}): StreamedAssemblyPorts {
  return {
    async readPart(path) {
      if (opts.missingPart === path) return null;
      return PARTS.find((p) => p.path === path)?.data ?? null;
    },
    async tusCreate(objectPath, totalBytes) {
      assert.equal(totalBytes, TOTAL, "declared length is the whole archive");
      const url = `https://tus.example/upload/${srv.urls.length}?p=${encodeURIComponent(objectPath)}`;
      srv.urls.push(url);
      return url;
    },
    async tusPatch(uploadUrl, offset, chunk) {
      assert.ok(srv.urls.includes(uploadUrl), "patched a known upload resource");
      if (srv.patches >= srv.dieAfterPatches) return null; // request killed
      srv.patches++;
      assert.equal(offset, srv.offset, "TUS offset must be exactly where the server is");
      srv.received.set(chunk, offset);
      srv.offset += chunk.length;
      if (srv.offset < TOTAL) {
        assert.equal(chunk.length % TUS_CHUNK_BYTES, 0, "non-final PATCH is a chunk multiple");
      }
      return srv.offset;
    },
    async tusOffset(uploadUrl) {
      return srv.urls.includes(uploadUrl) ? srv.offset : null;
    },
    async statObject() {
      srv.finalized = srv.offset === TOTAL;
      return srv.offset;
    },
  };
}

// ── 1-7. the streaming contract ─────────────────────────────────────────────

test("1. a first publish creates an upload and starts at offset 0", async () => {
  const srv = makeServer();
  const seen: StreamedAssemblyProgress[] = [];
  const out = await streamPartsToObject(
    { objectPath: "email-artifacts/new_products/source/images.zip", parts: PARTS, totalBytes: TOTAL },
    portsFor(srv), (p) => { seen.push({ ...p }); });
  assert.ok(out.ok);
  assert.equal(srv.urls.length, 1, "exactly one upload resource created");
  assert.equal(seen[0]?.confirmedOffset, 0, "reported before a byte was sent");
  assert.equal(out.sha256, EXPECTED_SHA);
  assert.deepEqual(Array.from(srv.received), Array.from(EXPECTED));
});

test("2. an interrupted publish leaves the upload resource and its offset", async () => {
  const srv = makeServer({ dieAfterPatches: 2 });
  const seen: StreamedAssemblyProgress[] = [];
  const out = await streamPartsToObject(
    { objectPath: "o", parts: PARTS, totalBytes: TOTAL }, portsFor(srv), (p) => { seen.push({ ...p }); });
  assert.equal(out.ok, false);
  assert.ok(!out.ok && out.error === "upload_failed");
  assert.ok(!out.ok && out.uploadUrl === srv.urls[0], "the resource is handed back to be stored");
  assert.ok(!out.ok && (out.confirmedOffset ?? 0) > 0, "and the offset it reached");
  assert.equal(seen.at(-1)?.confirmedOffset, srv.offset, "the last report matches the server");
  assert.ok(srv.offset > 0 && srv.offset < TOTAL, "a real partial upload");
});

test("3-4. the retry queries the remote offset and resumes from it, not from zero", async () => {
  const srv = makeServer({ dieAfterPatches: 2 });
  const first = await streamPartsToObject({ objectPath: "o", parts: PARTS, totalBytes: TOTAL }, portsFor(srv));
  assert.equal(first.ok, false);
  const resumeFrom = srv.offset;
  assert.ok(resumeFrom > 0);
  srv.dieAfterPatches = Number.POSITIVE_INFINITY; // the retry is allowed to finish

  let queried = 0;
  const ports = portsFor(makeServer()); // placeholder, replaced below
  void ports;
  const live = portsFor(srv);
  const second = await streamPartsToObject(
    { objectPath: "o", parts: PARTS, totalBytes: TOTAL, resume: { uploadUrl: srv.urls[0]! } },
    {
      ...live,
      async tusOffset(u) { queried++; return live.tusOffset(u); },
      async tusCreate() { throw new Error("must NOT create a second upload when resuming"); },
      async tusPatch(u, offset, chunk) {
        assert.ok(offset >= resumeFrom, "never re-sends a byte the server already has");
        return live.tusPatch(u, offset, chunk);
      },
    });
  assert.ok(second.ok);
  assert.equal(queried, 1, "the server is asked exactly once where it got to");
  assert.equal(srv.urls.length, 1, "still one upload resource");
});

test("5-7. resuming mid-part reproduces the archive byte for byte, and the same hash", async () => {
  // Kill at several different points, including inside the middle of a part.
  for (const dieAfter of [1, 2, 3]) {
    const srv = makeServer({ dieAfterPatches: dieAfter });
    const first = await streamPartsToObject({ objectPath: "o", parts: PARTS, totalBytes: TOTAL }, portsFor(srv));
    assert.equal(first.ok, false, `attempt should die after ${dieAfter} patches`);
    const cut = srv.offset;
    assert.ok(cut > 0 && cut < TOTAL);

    srv.dieAfterPatches = Number.POSITIVE_INFINITY;
    const second = await streamPartsToObject(
      { objectPath: "o", parts: PARTS, totalBytes: TOTAL, resume: { uploadUrl: srv.urls[0]! } },
      portsFor(srv));
    assert.ok(second.ok, `resume after ${cut} bytes`);
    // no duplicated bytes, no skipped bytes, no reordering
    assert.deepEqual(Array.from(srv.received), Array.from(EXPECTED), `bytes after cut ${cut}`);
    assert.equal(srv.offset, TOTAL);
    // the digest still covers exactly the uploaded bytes
    assert.equal(second.sha256, EXPECTED_SHA, `hash after cut ${cut}`);
    assert.equal(srv.urls.length, 1, "no second upload resource");
  }
});

test("7b. a cut inside a part is really exercised, not just on part boundaries", async () => {
  const srv = makeServer({ dieAfterPatches: 1 });
  await streamPartsToObject({ objectPath: "o", parts: PARTS, totalBytes: TOTAL }, portsFor(srv));
  const cut = srv.offset;
  const boundaries = PARTS.reduce<number[]>((acc, p) => [...acc, (acc.at(-1) ?? 0) + p.bytes], []);
  assert.equal(boundaries.includes(cut), false,
    "the resume point falls INSIDE a part, which is the case the mapping has to get right");
});

test("8. an unreadable upload resource is refused, never silently restarted", async () => {
  const srv = makeServer();
  const out = await streamPartsToObject(
    { objectPath: "o", parts: PARTS, totalBytes: TOTAL, resume: { uploadUrl: "https://tus.example/gone" } },
    portsFor(srv));
  assert.equal(out.ok, false);
  assert.ok(!out.ok && out.error === "resume_invalid");
  assert.equal(srv.urls.length, 0, "and no replacement upload was quietly created");
});

test("8b. a server claiming MORE bytes than the archive has is refused", async () => {
  const srv = makeServer();
  const live = portsFor(srv);
  srv.urls.push("https://tus.example/upload/0");
  const out = await streamPartsToObject(
    { objectPath: "o", parts: PARTS, totalBytes: TOTAL, resume: { uploadUrl: srv.urls[0]! } },
    { ...live, async tusOffset() { return TOTAL + 1; } });
  assert.ok(!out.ok && out.error === "resume_invalid");
});

test("9. a missing part still fails closed, and reports where the upload stood", async () => {
  const srv = makeServer();
  const out = await streamPartsToObject(
    { objectPath: "o", parts: PARTS, totalBytes: TOTAL },
    portsFor(srv, { missingPart: PARTS[2]!.path }));
  assert.ok(!out.ok && out.error === "part_missing");
  assert.ok(!out.ok && out.uploadUrl !== undefined);
});

// ── the token: identity is checked before anything is resumed ───────────────

const IDENTITY = {
  jobId: "9f4b793f-0000-4000-8000-000000000000",
  objectPath: "email-artifacts/new_products/source/images.zip",
  totalBytes: 339430589,
};
const STATE = (over: Partial<DeltaImagePublishState> = {}): DeltaImagePublishState => ({
  ...IDENTITY,
  runFingerprint: "run-A",
  uploadUrl: "https://tus.example/upload/abc",
  scopeProducts: 402, scopeRows: 511,
  confirmedOffset: 100_000_000,
  updatedAtIso: "2026-09-09T00:00:00.000Z",
  leaseUntilIso: null,
  ...over,
});

test("10. a token for THIS job, run, path and size is resumable", () => {
  assert.deepEqual(resumeVerdict(STATE(), IDENTITY), { usable: true });
});

test("11. a token from another job / path / size is refused", () => {
  assert.deepEqual(resumeVerdict(STATE({ jobId: "other" }), IDENTITY),
    { usable: false, reason: "different_job" });
  assert.deepEqual(resumeVerdict(STATE({ objectPath: "email-artifacts/other/images.zip" }), IDENTITY),
    { usable: false, reason: "different_path" });
  assert.deepEqual(resumeVerdict(STATE({ totalBytes: 346244336 }), IDENTITY),
    { usable: false, reason: "different_size" });
  assert.deepEqual(resumeVerdict(null, IDENTITY), { usable: false, reason: "no_state" });
});

test("11b. STEP 85I — a moved comparison fingerprint does NOT hide the resume", () => {
  // The rule this assertion replaces required state.runFingerprint to equal the
  // caller's. In production the token carried the fingerprint its job was bound
  // to, the status screen asked with the current one, and 48 unrelated price
  // edits moved the current one — so a 324 MB partial upload reported no
  // progress and the owner was offered a fresh start. The job's eligibility for
  // today's comparison is settled before the token is read; the token only
  // identifies an upload.
  assert.deepEqual(resumeVerdict(STATE({ runFingerprint: "run-BOUND-YESTERDAY" }), IDENTITY),
    { usable: true });
  const progress = publishProgressOf(STATE({ runFingerprint: "run-BOUND-YESTERDAY" }), IDENTITY);
  assert.ok(progress !== null, "and the screen can show it");
  assert.equal(progress.resumeAvailable, true);
});

test("12. the token is parsed strictly — malformed is NOT a token", () => {
  assert.equal(parseDeltaImagePublishState(null), null);
  assert.equal(parseDeltaImagePublishState({}), null);
  assert.equal(parseDeltaImagePublishState({ cleared: true }), null);
  // an offset past the end of the archive is nonsense, not a resume point
  assert.equal(parseDeltaImagePublishState({
    ...IDENTITY, runFingerprint: "run-A", uploadUrl: "u",
    confirmedOffset: IDENTITY.totalBytes + 1, updatedAtIso: "t",
  }), null);
  const good = parseDeltaImagePublishState({
    ...IDENTITY, runFingerprint: "run-A", uploadUrl: "u", confirmedOffset: 5, updatedAtIso: "t",
    scopeProducts: 402, scopeRows: 511, leaseUntilIso: null,
  });
  assert.ok(good !== null);
  assert.equal(good.confirmedOffset, 5);
  assert.equal(good.scopeProducts, 402);
});

test("13. a timeout preserves the token — the next attempt still resumes", () => {
  // A killed request writes no "finished" marker; what it leaves is a token
  // whose lease has lapsed and whose offset is whatever the server confirmed.
  const abandoned = STATE({ leaseUntilIso: null, confirmedOffset: 250_000_000 });
  assert.deepEqual(resumeVerdict(abandoned, IDENTITY), { usable: true });
  const progress = publishProgressOf(abandoned, IDENTITY);
  assert.ok(progress !== null);
  assert.equal(progress.resumeAvailable, true);
  assert.equal(progress.uploadedBytes, 250_000_000);
  assert.equal(progress.percent, 73);
});

test("14. concurrent publishes are serialised by a self-expiring lease", () => {
  const now = Date.parse("2026-09-09T00:00:00.000Z");
  const live = STATE({ leaseUntilIso: new Date(now + 60_000).toISOString() });
  assert.equal(publishLeaseHeld(live, now), true, "a live lease blocks a second attempt");
  const lapsed = STATE({ leaseUntilIso: new Date(now - 1).toISOString() });
  assert.equal(publishLeaseHeld(lapsed, now), false, "and it expires on its own");
  assert.equal(publishLeaseHeld(STATE({ leaseUntilIso: null }), now), false);
  assert.equal(publishLeaseHeld(null, now), false);
  assert.ok(PUBLISH_LEASE_MS >= 5 * 60 * 1000, "longer than one request can run");
  // the guard refuses; it never deletes anything to break the lock
  const jobs = code(JOBS);
  const stage = jobs.slice(jobs.indexOf("export async function stageTalabatDeltaImagePackage"));
  assert.match(stage, /if \(publishLeaseHeld\(prior, nowMs\)\) return errResult\("conflict", 409\)/);
  assert.equal(/\.remove\(|\.delete\(/.test(stage.slice(0, stage.indexOf("\nexport "))), false,
    "no destructive locking");
});

test("15. a finished or unusable publish offers no resume", () => {
  assert.equal(publishProgressOf(STATE({ confirmedOffset: IDENTITY.totalBytes }), IDENTITY)?.resumeAvailable,
    false, "a completed upload is not a resume");
  assert.equal(publishProgressOf(STATE({ confirmedOffset: 0 }), IDENTITY)?.resumeAvailable,
    false, "nothing uploaded yet is not a resume either");
  assert.equal(publishProgressOf(STATE({ jobId: "other" }), IDENTITY), null);
});

// ── wiring: the server persists it, and the screen shows it ─────────────────

test("16. the token is written BEFORE bytes are sent and advanced as they land", () => {
  const jobs = code(JOBS);
  const stage = jobs.slice(jobs.indexOf("export async function stageTalabatDeltaImagePackage"),
    jobs.indexOf("export async function readDeltaImagePublishProgress"));
  assert.match(stage, /resume: resumable \? \{ uploadUrl: resumable\.uploadUrl \} : null/);
  assert.match(stage, /await writePublishState\(\{ uploadUrl: p\.uploadUrl, confirmedOffset: p\.confirmedOffset \}\)/);
  // progress persistence is passed as the streamer's callback, so it runs per PATCH
  assert.ok(stage.indexOf("streamPartsToObject(") < stage.indexOf("async (p) =>"),
    "the callback belongs to the stream call");
  assert.match(stage, /publishStatePath\(jobId\)/);
  assert.equal(publishStatePath("abc"), "jobs/abc/publish.json");
});

test("17. the sidecar is written only after the upload verified its stored size", () => {
  const jobs = code(JOBS);
  const stage = jobs.slice(jobs.indexOf("export async function stageTalabatDeltaImagePackage"),
    jobs.indexOf("export async function readDeltaImagePublishProgress"));
  assert.ok(stage.indexOf("streamPartsToObject(") < stage.indexOf("putObject(DELTA_IMAGE_META_PATH"),
    "upload first");
  // and the engine only returns ok after statObject agreed with totalBytes
  const eng = code("lib/export/artifact-stream.ts");
  const tail = eng.slice(eng.indexOf("const stored = await ports.statObject"));
  assert.match(tail, /stored !== input\.totalBytes/);
  assert.ok(tail.indexOf("stored !== input.totalBytes") < tail.indexOf("sha256: hash.digest"));
});

test("18. publishing clears the token, so a finished upload is never offered as a resume", () => {
  const jobs = code(JOBS);
  const stage = jobs.slice(jobs.indexOf("export async function stageTalabatDeltaImagePackage"));
  const afterMeta = stage.slice(stage.indexOf("putObject(DELTA_IMAGE_META_PATH"));
  assert.match(afterMeta, /publishStatePath\(jobId\), json\(\{ cleared: true \}\)/);
});

test("19. the screen reports upload progress and offers to resume", () => {
  const wf = code(WORKFLOW);
  assert.match(wf, /publishProgress: \{/);
  assert.match(wf, /await readDeltaImagePublishProgress\(readyJob\.jobId, readyJob\.archiveBytes\)/);
  const ui = code(UI);
  assert.match(ui, /status\.publishProgress\?\.resumeAvailable \? "استئناف نشر الحزمة" : "نشر الحزمة الجاهزة"/);
  assert.match(ui, /status\.publishProgress\.percent/);
});

// ── the source package is reused, never rebuilt ─────────────────────────────

test("20. publishing reuses the existing job's parts — no fetch, no new job", () => {
  const jobs = code(JOBS);
  const stage = jobs.slice(jobs.indexOf("export async function stageTalabatDeltaImagePackage"),
    jobs.indexOf("export async function readDeltaImagePublishProgress"));
  for (const forbidden of ["fetch(", "planRowImages", "JSZip", "startTalabatDeltaImageJob",
    "downloadImage", "insert("]) {
    assert.equal(stage.includes(forbidden), false, `publishing must not ${forbidden}`);
  }
  assert.match(stage, /state\.parts\.map\(\(p\) => \(\{ path: p\.path, bytes: p\.bytes \}\)\)/,
    "the durable parts of the job already completed");
});

test("21. Rafeeq keeps its unchanged, non-resuming behaviour", () => {
  const rafeeq = code("lib/export/rafeeq/artifact-object.ts");
  assert.equal(rafeeq.includes("resume:"), false, "Rafeeq never asks for a resume");
  assert.match(rafeeq, /streamPartsToObject\(\s*\{ objectPath, parts: input\.parts, totalBytes: input\.totalBytes \},/);
});

test("22. nothing here sends mail, writes catalogue rows or deletes artifacts", () => {
  const jobs = code(JOBS);
  const stage = jobs.slice(jobs.indexOf("export async function stageTalabatDeltaImagePackage"),
    jobs.indexOf("export async function readDeltaImagePublishProgress"));
  for (const forbidden of ["sendMail", "smtp", 'from("products")', "lifecycle_state", ".remove("]) {
    assert.equal(stage.includes(forbidden), false, `publishing must not ${forbidden}`);
  }
});
