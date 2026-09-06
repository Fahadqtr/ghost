// STEP 90C — publishing 330 MB from a serverless function, and recovering the
// work that was already done.
//
// STEP 90's staging read every archive part into an array and then allocated a
// second contiguous copy of the whole thing. On a 346,244,336-byte archive that
// is ≥660 MB resident, and production answered with "instance was killed
// because it ran out of available memory" — twice, each time one second after a
// job had successfully downloaded all 632 images. The images were never the
// problem; publishing them was.
//
// The repository already owned the answer. The Rafeeq artifact engine has
// assembled its certified package over TUS since STEP 68 and states its own
// contract: at most one part plus a carry buffer is ever in memory. STEP 90C
// extracts that engine, points Rafeeq and Talabat at the one copy, and makes
// publishing an already-completed job a first-class action so no image is
// fetched twice.
//
// The proofs below are in four groups: MEMORY (the archive is never whole in
// application memory, and byte order survives), RECOVERY (a completed job
// publishes without re-downloading, idempotently), REAPING (the dead-row rule
// that blocked every retry), and UNCHANGED (scope, bindings, and everything
// this step must not have touched).
//
// node --conditions=react-server --experimental-strip-types --test lib/export/talabat/step90c-streaming-stage.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  streamPartsToObject, TUS_CHUNK_BYTES, TUS_MAX_PATCH_BYTES,
  type StreamedAssemblyPorts,
} from "../artifact-stream.ts";
import { assembleRafeeqArtifactObject } from "../rafeeq/artifact-object.ts";
import {
  parseDeltaImageMeta, verifyDeltaImagePackage, auditDeltaImageCoverage,
  deltaImageSelectionKeys, deltaImagePlannedCount,
  DELTA_IMAGE_ZIP_PATH, DELTA_IMAGE_META_PATH, type DeltaImageMeta,
} from "./delta-image-package.ts";
import { parseTalabatBaseline, compareTalabatBaseline, newDeltaRows, TALABAT_BASELINE_COLUMNS } from "./baseline-delta.ts";
import { allowedNewDeltaRows } from "./category-policy.ts";
import { safeUpdateRows } from "./delta-workbooks.ts";
import { buildTalabatPreview, type TalabatPreviewProduct } from "./preview.ts";
import { previewRowKey } from "./package.ts";
import { OFFICIAL_SEND_ENABLED } from "./email-workflow.ts";
import { RAFEEQ_LINK_TTL_SECONDS } from "../rafeeq/artifact-object.ts";

const HERE = join(fileURLToPath(new URL(".", import.meta.url)));
const APP_ROOT = join(HERE, "../../..");
const raw = (rel: string): string => readFileSync(join(APP_ROOT, rel), "utf8");
// Scan CODE, not prose — this file's explanations name the very things the
// guards forbid, and none of that should count.
const code = (rel: string): string =>
  raw(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const STREAM = "lib/export/artifact-stream.ts";
const RAFEEQ_OBJ = "lib/export/rafeeq/artifact-object.ts";
const RAFEEQ_SRV = "lib/rafeeq/artifact-object.server.ts";
const TUS = "lib/storage/tus.server.ts";
const JOBS = "lib/talabat/package-job.server.ts";
const WORKFLOW = "lib/talabat/email-workflow.server.ts";
const UI = "app/(v2)/v2/operations/channels/talabat-email/ImagePackage.tsx";
const ROUTE = "app/api/export/talabat/email/images/route.ts";

// ── a fake TUS transport that records what it was asked to hold ─────────────

function fakeTransport(parts: Uint8Array[]) {
  const stored: number[] = [];
  const patchSizes: number[] = [];
  let peakChunk = 0;
  const ports: StreamedAssemblyPorts = {
    readPart: async (path) => parts[Number(path.split("-")[1])] ?? null,
    tusCreate: async () => "https://upload.test/1",
    tusPatch: async (_url, offset, chunk) => {
      patchSizes.push(chunk.length);
      peakChunk = Math.max(peakChunk, chunk.length);
      for (const b of chunk) stored.push(b);
      return offset + chunk.length;
    },
    statObject: async () => stored.length,
  };
  return { ports, stored: () => Uint8Array.from(stored), patchSizes, peak: () => peakChunk };
}

const partList = (parts: Uint8Array[]) =>
  parts.map((p, i) => ({ path: `part-${i}`, bytes: p.length }));
const totalOf = (parts: Uint8Array[]) => parts.reduce((n, p) => n + p.length, 0);
/** deterministic bytes, so a reordering is detectable. */
const chunk = (seed: number, size: number) =>
  Uint8Array.from({ length: size }, (_, i) => (seed * 31 + i) % 251);

// ── 1. memory: the archive is never whole in application memory ─────────────

test("1. no PATCH ever carries more than the bounded chunk, whatever the archive size", async () => {
  // 5 parts × 9 MiB = 45 MiB — far larger than one PATCH is allowed to be.
  const parts = [0, 1, 2, 3, 4].map((i) => chunk(i + 1, 9 * 1024 * 1024));
  const t = fakeTransport(parts);
  const res = await streamPartsToObject(
    { objectPath: "o/images.zip", parts: partList(parts), totalBytes: totalOf(parts) }, t.ports);
  assert.equal(res.ok, true);
  assert.ok(t.peak() <= TUS_MAX_PATCH_BYTES,
    `peak PATCH ${t.peak()} must stay within ${TUS_MAX_PATCH_BYTES}`);
  assert.ok(t.peak() < totalOf(parts), "the whole archive is never in one request");
  for (const size of t.patchSizes.slice(0, -1)) {
    assert.equal(size % TUS_CHUNK_BYTES, 0, "every non-final PATCH is a 6 MiB multiple");
  }
});

test("2. exact byte order and content survive the streaming", async () => {
  const parts = [chunk(7, 5_000_000), chunk(9, 7_000_000), chunk(11, 1_234_567)];
  const t = fakeTransport(parts);
  const res = await streamPartsToObject(
    { objectPath: "o/images.zip", parts: partList(parts), totalBytes: totalOf(parts) }, t.ports);
  assert.equal(res.ok, true);
  const expected = new Uint8Array(totalOf(parts));
  let at = 0;
  for (const p of parts) { expected.set(p, at); at += p.length; }
  assert.deepEqual(t.stored(), expected, "byte-for-byte, in order");
  if (res.ok) {
    assert.equal(res.sha256, createHash("sha256").update(expected).digest("hex"),
      "the hash is of exactly the bytes uploaded");
  }
});

test("3. a short or missing part fails closed — no partial archive is accepted", async () => {
  const parts = [chunk(1, 1000), chunk(2, 1000)];
  const t = fakeTransport(parts);
  const wrong = await streamPartsToObject(
    // claims a size the part does not have
    { objectPath: "o/z", parts: [{ path: "part-0", bytes: 999 }], totalBytes: 999 }, t.ports);
  assert.deepEqual(wrong, { ok: false, error: "part_missing" });

  const missing = await streamPartsToObject(
    { objectPath: "o/z", parts: [{ path: "part-9", bytes: 10 }], totalBytes: 10 }, t.ports);
  assert.deepEqual(missing, { ok: false, error: "part_missing" });
});

test("4. a stored size that disagrees with the plan is refused", async () => {
  const parts = [chunk(3, 2048)];
  const t = fakeTransport(parts);
  const lying: StreamedAssemblyPorts = { ...t.ports, statObject: async () => 1 };
  const res = await streamPartsToObject(
    { objectPath: "o/z", parts: partList(parts), totalBytes: 2048 }, lying);
  assert.deepEqual(res, { ok: false, error: "size_mismatch" });
});

test("5. the staging code never concatenates the whole archive", () => {
  const src = code(JOBS);
  const stage = src.slice(src.indexOf("export async function stageTalabatDeltaImagePackage"));
  assert.match(stage, /streamPartsToObject\(/);
  // the buffering shapes that caused the OOM are gone
  assert.ok(!/new Uint8Array\(total\)/.test(stage), "no contiguous whole-archive allocation");
  assert.ok(!/chunks\.push\(/.test(stage), "no array of every part");
  assert.ok(!stage.includes("DELTA_STAGE_MAX_BYTES"), "the ceiling that measured the wrong thing is gone");
});

// ── 2. one uploader, not two ────────────────────────────────────────────────

test("6. Rafeeq and Talabat share ONE streaming implementation", () => {
  // the loop lives in exactly one module
  for (const f of [RAFEEQ_OBJ, JOBS]) {
    assert.ok(!code(f).includes("tus-resumable"), `${f} must not re-implement the protocol`);
  }
  assert.ok(code(STREAM).includes("TUS_CHUNK_BYTES"));
  assert.match(code(RAFEEQ_OBJ), /streamPartsToObject\(/);
  assert.match(code(JOBS), /streamPartsToObject\(/);
  // and one transport, parameterised by bucket rather than copied
  assert.equal((code(TUS).match(/tus-resumable/g) ?? []).length, 2, "create + patch, once each");
  assert.match(code(RAFEEQ_SRV), /makeTusPorts\(RAFEEQ_JOB_BUCKET\)/);
  assert.match(code(JOBS), /makeTusPorts\(BUCKET\)/);
});

test("7. Rafeeq's assembly still produces its exact metadata record", async () => {
  const parts = [chunk(4, 3000), chunk(5, 4000)];
  const t = fakeTransport(parts);
  const written: unknown[] = [];
  const res = await assembleRafeeqArtifactObject(
    { jobId: "job-1", filename: "pkg.zip", parts: partList(parts), totalBytes: 7000, nowIso: "2026-09-06T00:00:00.000Z" },
    { ...t.ports, writeMeta: async (m) => { written.push(m); return true; } },
  );
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.meta.objectPath, "artifacts/job-1/pkg.zip");
  assert.equal(res.meta.bytes, 7000);
  assert.equal(res.meta.partCount, 2);
  assert.match(res.meta.sha256, /^[0-9a-f]{64}$/);
  assert.equal(written.length, 1);
});

// ── 3. recovery: publish what is already downloaded ─────────────────────────

test("8. a completed job can be published without fetching any image", () => {
  const src = code(JOBS);
  const stage = src.slice(src.indexOf("export async function stageTalabatDeltaImagePackage"));
  // it reads the job's DURABLE PARTS; there is no fetch in this path
  assert.match(stage, /parts: state\.parts\.map\(/);
  assert.match(stage, /readPart: readTalabatPackagePart/);
  assert.ok(!stage.includes("fetchImage"), "no image is fetched while publishing");
  assert.ok(!stage.includes("createTalabatPackageJob"), "publishing never starts a job");
  // and it refuses anything not already complete
  assert.match(stage, /state\.status !== "completed" \|\| !state\.artifact/);
});

test("9. the screen offers the recovery action instead of another download", () => {
  const ui = raw(UI);
  assert.ok(ui.includes("نشر الحزمة الجاهزة"), "Arabic: Publish Ready Package");
  assert.match(code(UI), /publishReady\(status\.readyJob!\.jobId\)/);
  const publish = code(UI).slice(code(UI).indexOf("const publishReady"));
  assert.match(publish.slice(0, publish.indexOf("const run =")), /action: "stage", jobId/);
  assert.ok(!publish.slice(0, publish.indexOf("const run =")).includes('action: "start"'),
    "the recovery path never starts a fetch job");
  // the server only offers it when the published package is unusable
  assert.match(code(WORKFLOW), /const readyJob = ready \? null : await findStageableDeltaImageJob/);
});

test("10. only a job built for the CURRENT comparison is offered for recovery", () => {
  const src = code(JOBS);
  const find = src.slice(src.indexOf("export async function findStageableDeltaImageJob"));
  assert.match(find, /binding\.runFingerprint !== runFingerprint\) continue;/);
  assert.match(find, /\.eq\("mode", "selected"\)\.eq\("status", "completed"\)/);
  assert.match(find, /st\.status !== "completed" \|\| !st\.artifact\) continue;/);
});

test("11. publishing the identical package again rewrites nothing", () => {
  const src = code(JOBS);
  const stage = src.slice(src.indexOf("export async function stageTalabatDeltaImagePackage"));
  const idem = stage.indexOf("const existing = parseDeltaImageMeta");
  assert.ok(idem > 0, "the published sidecar is read first");
  assert.ok(idem < stage.indexOf("streamPartsToObject("), "…before any upload");
  assert.match(stage, /existing\.jobId === jobId/);
  assert.match(stage, /existing\.runFingerprint === meta\.runFingerprint/);
  assert.match(stage, /existing\.zipBytes === meta\.zipBytes/);
  // and it only short-circuits when the object is really there at that size
  assert.match(stage, /stored === existing\.zipBytes/);
  assert.match(stage, /republished: false/);
});

// ── 4. the dead-row rule that blocked every retry ───────────────────────────

test("12. a FRESH job is never reaped, whoever owns it", () => {
  const start = startSrc();
  assert.match(start, /if \(fresh\) return errResult\("conflict", 409\);/);
  assert.ok(start.indexOf("if (fresh) return errResult") < start.indexOf("reapStaleJob"),
    "freshness is checked before any reap");
});

test("13. durable work is never destroyed", () => {
  const start = startSrc();
  assert.match(start, /if \(st\?\.artifact != null && st\.status !== "completed"\) return errResult\("conflict", 409\);/);
  assert.ok(start.indexOf('st?.artifact != null') < start.indexOf("reapStaleJob"));
});

test("14. a stale job that died BEFORE writing state is reapable", () => {
  // This is the production defect: c2e53b7a had plan.json and nothing else, so
  // the old `!binding` guard made it a permanent block.
  const start = startSrc();
  assert.match(start, /if \(!st \|\| binding\) \{\s*\n\s*await reapStaleJob\(live\.id\);/);
  assert.ok(!/if \(!binding \|\| fresh/.test(start), "the old always-conflict guard is gone");
});

test("15. a stale job with state that is NOT ours is left alone", () => {
  const start = startSrc();
  const tail = start.slice(start.indexOf("if (!st || binding)"));
  assert.match(tail, /\} else \{[\s\S]*?return errResult\("conflict", 409\);/);
});

test("16. a job with a conflicting binding is never hijacked", () => {
  const start = startSrc();
  // resume requires the run to MATCH; anything else falls through to the rules
  assert.match(start, /if \(binding && binding\.runFingerprint === input\.runFingerprint && st && pl\)/);
});

test("17. a completed job is never treated as stale running work", () => {
  const start = startSrc();
  assert.match(start, /\.in\("status", \["queued", "running"\]\)/,
    "only queued/running rows are considered at all");
});

test("18. cleanup stays scoped to the one job", () => {
  const src = code(JOBS);
  assert.match(src, /if \(!UUID_RE\.test\(jobId\)\) return \{ ok: false, removed: 0 \};/);
  assert.match(src, /name\.startsWith\("part-"\) \|\| name === "plan\.json"/);
});

test("19. the binding is written FIRST, so a killed start still leaves an identifiable job", () => {
  const start = startSrc();
  const b = start.indexOf("putObject(deltaBindingPath(jobId)");
  const p = start.indexOf("putObject(planPath(jobId)");
  const st = start.indexOf("putObject(statePath(jobId)");
  assert.ok(b > 0 && p > 0 && st > 0);
  assert.ok(b < p && p < st, "binding, then plan, then state");
});

// ── 5. one catalogue load ───────────────────────────────────────────────────

test("20. the delta start does NOT load the catalogue a second time", () => {
  const src = code(JOBS);
  const start = startSrc();
  assert.ok(!start.includes("loadTalabatPreview"), "the rows come from the caller");
  assert.match(start, /previewRows: input\.previewRows/);
  // exactly one catalogue load remains in the file — the certified export's
  assert.equal((src.match(/await loadTalabatPreview\(\)/g) ?? []).length, 1);
  // and the caller hands over the rows it already used
  assert.match(code(WORKFLOW), /previewRows: delta\.previewRows,/);
  assert.match(code(WORKFLOW), /previewRows: preview\.rows,/);
});

// ── 6. scope, bindings and coverage are unchanged ───────────────────────────

function fixture() {
  const product = (n: number, category: string, over: Partial<TalabatPreviewProduct> = {}): TalabatPreviewProduct => ({
    id: `p${n}`, sku: `mk${1000 + n}`, barcode: `12345678${String(90000 + n)}`,
    nameEn: `EN mk${1000 + n}`, nameAr: `ع mk${1000 + n}`, price: 50,
    discountPrice: null, channelPrice: null, category, descriptionEn: "d", descriptionAr: "و",
    imageUrl: `https://x.test/mk${1000 + n}.jpg`, imageFilename: `mk${1000 + n}.jpg`,
    galleryImageUrls: [], imageCount: 1, approved: true, lifecycleState: "ACTIVE", variants: [], ...over,
  });
  const products = [
    product(0, "Face Care", { nameEn: "CHANGED" }),
    product(2, "Electronics"), product(4, "✨Toys"),
    product(5, "Hair Care", { galleryImageUrls: ["https://x.test/g1.jpg", "https://x.test/g2.jpg"], imageCount: 3 }),
    product(6, "Makeup"),
  ];
  const preview = buildTalabatPreview({ products });
  const baseline = parseTalabatBaseline([TALABAT_BASELINE_COLUMNS.slice(),
    ["mk1000", "EN mk1000", "50", true, null, false, null, null, null, "01234567800000", null, null, "All Face Care"]],
    "Products").rows;
  return compareTalabatBaseline(preview.rows, baseline);
}

test("21. the selection scope is unchanged by this step", () => {
  const result = fixture();
  const keys = new Set(deltaImageSelectionKeys(result));
  assert.deepEqual([...keys].sort(), allowedNewDeltaRows(result).map((r) => previewRowKey(r.our)).sort());
  for (const r of newDeltaRows(result).filter((x) => x.our.talabatCategory === "Electronics")) {
    assert.equal(keys.has(previewRowKey(r.our)), false, "Electronics still excluded");
  }
  for (const r of newDeltaRows(result).filter((x) => x.our.talabatCategory === "✨Toys")) {
    assert.equal(keys.has(previewRowKey(r.our)), false, "✨Toys still excluded");
  }
  for (const r of safeUpdateRows(result)) {
    assert.equal(keys.has(previewRowKey(r.our)), false, "update rows still excluded");
  }
});

test("22. galleries are still counted as images, not rows", () => {
  const result = fixture();
  const images = deltaImagePlannedCount(result);
  const rows = allowedNewDeltaRows(result).length;
  assert.ok(images > rows, `images (${images}) must exceed rows (${rows})`);
});

test("23. a coverage mismatch blocks the publish", () => {
  const short = auditDeltaImageCoverage({ expected: 632, packagedNames: nm(631), droppedCount: 1 });
  assert.equal(short.complete, false);
  assert.equal(short.missing, 1);
  const dup = auditDeltaImageCoverage({ expected: 3, packagedNames: [...nm(2), "i-0"], droppedCount: 0 });
  assert.equal(dup.complete, false);
  assert.equal(dup.duplicateNames, 1);
  assert.equal(auditDeltaImageCoverage({ expected: 3, packagedNames: nm(3), droppedCount: 0 }).complete, true);
});

test("24. the sidecar binds the source job, the baseline and the run", () => {
  const meta = parseDeltaImageMeta({
    imageCount: 632, expectedImages: 632, zipBytes: 346244336,
    extensionAudit: { mismatches: 0, renamed: 0, collisions: 0 },
    runFingerprint: "run-A", baselineFingerprint: "base-A",
    jobId: "38b410f9-c04d-4efa-8de8-220212c65d20",
    stagedAtIso: "2026-09-06T23:00:00.000Z", sha256: "b".repeat(64),
  });
  assert.ok(meta !== null);
  assert.equal(meta.jobId, "38b410f9-c04d-4efa-8de8-220212c65d20");
  assert.equal(meta.sha256, "b".repeat(64));
  assert.deepEqual(verifyDeltaImagePackage(meta, "run-A", "base-A"), []);
  // and the staging record carries every one of them
  const stage = code(JOBS).slice(code(JOBS).indexOf("export async function stageTalabatDeltaImagePackage"));
  for (const field of ["runFingerprint:", "baselineFingerprint:", "jobId,", "zipBytes:", "stagedAtIso:", "sha256"]) {
    assert.ok(stage.includes(field), `sidecar records ${field}`);
  }
});

test("25. a stale published package is still rejected at read time", () => {
  const meta = (over: Partial<DeltaImageMeta> = {}): DeltaImageMeta => ({
    imageCount: 632, expectedImages: 632, zipBytes: 1, sha256: null,
    extensionAudit: { mismatches: 0, renamed: 0, collisions: 0 },
    runFingerprint: "run-A", baselineFingerprint: "base-A",
    jobId: "j", stagedAtIso: "t", ...over,
  });
  assert.deepEqual(verifyDeltaImagePackage(meta(), "run-B", "base-A"), ["image_package_stale_run"]);
  assert.deepEqual(verifyDeltaImagePackage(meta(), "run-A", "base-B"), ["image_package_stale_baseline"]);
  assert.match(code(WORKFLOW), /verifyDeltaImagePackage\(parsed, currentRunFingerprint, currentBaselineFingerprint\)/);
});

test("26. the signed link still targets the published ZIP on the 7-day policy", () => {
  assert.equal(RAFEEQ_LINK_TTL_SECONDS, 7 * 24 * 3600);
  const src = code(WORKFLOW);
  assert.match(src, /TALABAT_LINK_TTL_SECONDS = RAFEEQ_LINK_TTL_SECONDS/);
  assert.match(src, /createSignedUrl\(/);
  assert.equal(DELTA_IMAGE_ZIP_PATH, "email-artifacts/new_products/source/images.zip");
  assert.equal(DELTA_IMAGE_META_PATH, "email-artifacts/new_products/source/images.json");
});

// ── 7. what must not have happened ──────────────────────────────────────────

test("27. no SMTP call exists anywhere in this flow", () => {
  for (const f of [STREAM, TUS, JOBS, ROUTE, UI]) {
    const src = code(f);
    for (const forbidden of ["sendMailViaSmtp", "nodemailer", "sendTalabatTestEmail"]) {
      assert.ok(!src.includes(forbidden), `${f} must not reach the transport (${forbidden})`);
    }
  }
  assert.equal(OFFICIAL_SEND_ENABLED, false);
});

test("28. no canonical or marketplace write happens in this flow", () => {
  const src = code(JOBS);
  // Anchor on CODE, not a comment: code() strips comments, so a comment marker
  // would slice from -1 and quietly assert against nothing.
  const delta = src.slice(src.indexOf("interface DeltaImageJobBinding"));
  assert.ok(delta.length > 0, "the delta section was found");
  // Table ACCESS, not the bare word — `products_total` is a legitimate column
  // on the job row and matching it would be this guard tripping over prose.
  for (const forbidden of [
    "syncTalabatMappingsFromCatalog", "insertAuditRow",
    '.from("products")', '.from("product_variants")', '.from("talabat_channel_mappings")',
  ]) {
    assert.ok(!delta.includes(forbidden), `${forbidden} must not appear in the delta image flow`);
  }
  // the only table it writes is its own bookkeeping
  const tables = [...delta.matchAll(/\.from\("([a-z_]+)"\)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(tables)], ["talabat_package_jobs"]);
});

test("29. nothing deletes an orphaned package without an explicit request", () => {
  const src = code(JOBS);
  const stage = src.slice(src.indexOf("export async function stageTalabatDeltaImagePackage"));
  assert.ok(!stage.includes("cleanupJobArtifacts"), "publishing never cleans another job");
  assert.ok(!stage.includes(".remove("), "publishing deletes nothing");
  // the recovery lookup is read-only too
  const find = src.slice(src.indexOf("export async function findStageableDeltaImageJob"));
  assert.ok(!find.includes(".remove(") && !find.includes(".delete("), "the lookup deletes nothing");
});

function startSrc(): string {
  const src = code(JOBS);
  const from = src.indexOf("export async function startTalabatDeltaImageJob");
  return src.slice(from, src.indexOf("export async function stepTalabatDeltaImageJob"));
}
function nm(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `i-${i}`);
}
