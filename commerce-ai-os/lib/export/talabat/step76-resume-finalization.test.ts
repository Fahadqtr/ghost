// STEP 76 — resume the finalization tail instead of re-downloading 2501 images.
//
// PRODUCTION FORENSICS (job f70f7dd5-0307-4558-bcc0-18779eaab6fc):
//   progress 2501/2501 · bytes_done 564,161,170 · artifact_filename SET ·
//   artifact_bytes 564,161,170 · manifest_fingerprint SET ·
//   error_code = 'stale_abandoned' (written by the STEP 75 reaper, NOT by the
//   engine) · parts remaining in storage: 0.
//
// The artifact upload SUCCEEDED — `state.artifact` is only assigned after the
// tail putPart is awaited. The job then stalled in the finalization tail, was
// reaped as stale 10 minutes later, and its 66 durable parts (538 MB) were
// deleted. These tests pin the two fixes: the tail is now bounded so it cannot
// stall, and durable work is never discarded.
//
// node --conditions=react-server --experimental-strip-types --test lib/export/talabat/step76-resume-finalization.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createTalabatPackageJob, advanceTalabatPackageJob, jobProgress, mappingComplete,
  type TalabatPackageJobPlan, type TalabatPackageJobState, type TalabatJobAdvanceDeps,
} from "./package-job.ts";
import { buildTalabatPreview, type TalabatPreviewProduct } from "./preview.ts";
import { isRecoverableTalabatJobError, TALABAT_JOB_ERROR_AR } from "./package-job-errors.ts";

const HERE = join(fileURLToPath(new URL(".", import.meta.url)));
const APP_ROOT = join(HERE, "../../..");
const raw = (rel: string): string => readFileSync(join(APP_ROOT, rel), "utf8");
const code = (rel: string): string =>
  raw(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const SERVER = "lib/talabat/package-job.server.ts";
const UI = "components/v2/export/TalabatPackageControls.tsx";

const IMG = "https://x.test/a.jpg";
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, ...new Array(64).fill(7)]);

function product(n: number): TalabatPreviewProduct {
  const sku = `mk${1000 + n}`;
  return {
    id: `p${n}`, sku, barcode: `12345678${String(90000 + n)}`,
    nameEn: `EN ${sku}`, nameAr: `ع ${sku}`, price: 50, discountPrice: null, channelPrice: null,
    category: "Face Care", descriptionEn: "d", descriptionAr: "و",
    imageUrl: IMG, imageFilename: `${sku}.jpg`, galleryImageUrls: [], imageCount: 1,
    approved: true, lifecycleState: "ACTIVE", variants: [],
  };
}
function makeJob(n = 4) {
  const rows = buildTalabatPreview({ products: Array.from({ length: n }, (_, i) => product(i)) }).rows;
  const c = createTalabatPackageJob({
    jobId: "f70f7dd5-0307-4558-bcc0-18779eaab6fc", mode: "ready",
    previewRows: rows, actor: "t@t", nowIso: "2026-09-04T20:16:46.000Z",
  });
  assert.equal(c.ok, true);
  return c as { ok: true; plan: TalabatPackageJobPlan; state: TalabatPackageJobState };
}

interface Ctl { failSync: boolean; syncCalls: number; fetches: number; total: number; batch: number }
function depsWith(ctl: Ctl, store: Map<string, Uint8Array>): TalabatJobAdvanceDeps {
  return {
    ports: {
      async fetchImage() { ctl.fetches++; return { bytes: JPEG, ext: "jpg" }; },
      async putPart(path, bytes) { store.set(path, bytes); },
    },
    async syncMappings(_actor, offset) {
      ctl.syncCalls++;
      if (ctl.failSync) throw new Error("mapping sync timed out");
      const next = Math.min(ctl.total, offset + ctl.batch);
      return { ok: true, inserted: next - offset, updated: 0, failed: 0, totalCandidates: ctl.total, nextOffset: next };
    },
    async recordAudit() { return true; },
    budget: { maxImages: 2 },
  };
}
/** Drive until the images are done and the archive is durable. */
async function toArchived(ctl: Ctl, store: Map<string, Uint8Array>) {
  const { plan, state } = makeJob();
  const deps = depsWith(ctl, store);
  let s = state;
  while (s.status === "running" && s.artifact === null) s = await advanceTalabatPackageJob(s, plan, deps);
  assert.notEqual(s.artifact, null, "the archive is durable");
  return { plan, state: s, deps };
}

// ── 1, 2, 6: a finalization failure preserves everything ─────────────────────

test("1: upload/finalization failure does NOT reset the image cursor", async () => {
  const ctl: Ctl = { failSync: true, syncCalls: 0, fetches: 0, total: 1454, batch: 200 };
  const store = new Map<string, Uint8Array>();
  const { plan, state } = await toArchived(ctl, store);
  const imagesFetched = ctl.fetches;
  const cursorBefore = state.cursor;

  const failed = await advanceTalabatPackageJob(state, plan, depsWith(ctl, store));
  assert.equal(failed.status, "failed");
  assert.equal(failed.cursor, cursorBefore, "the image cursor is untouched");
  assert.equal(failed.cursor, plan.images.length, "still 2501/2501 in production terms");
  assert.equal(ctl.fetches, imagesFetched, "no image was re-fetched");
  assert.notEqual(failed.artifact, null, "the artifact record survives");
});

test("2: the failure is classified RECOVERABLE and keeps its parts", async () => {
  const ctl: Ctl = { failSync: true, syncCalls: 0, fetches: 0, total: 1454, batch: 200 };
  const store = new Map<string, Uint8Array>();
  const { plan, state } = await toArchived(ctl, store);
  const partsBefore = state.parts.length;

  const failed = await advanceTalabatPackageJob(state, plan, depsWith(ctl, store));
  assert.equal(failed.error?.code, "upload_incomplete");
  assert.equal(isRecoverableTalabatJobError(failed.error?.code), true);
  assert.equal(failed.parts.length, partsBefore, "every part is still recorded");
  assert.equal([...store.keys()].filter((k) => k.includes("/part-")).length, partsBefore, "parts still in storage");
  // and the server only cleans an UNRECOVERABLE failure
  assert.match(code(SERVER), /if \(next\.status === "failed" && !isRecoverableTalabatJobError\(next\.error\?\.code\)\)/);
});

test("6: progress stays at the end, never back to 1%", async () => {
  const ctl: Ctl = { failSync: true, syncCalls: 0, fetches: 0, total: 1454, batch: 200 };
  const store = new Map<string, Uint8Array>();
  const { plan, state } = await toArchived(ctl, store);
  const failed = await advanceTalabatPackageJob(state, plan, depsWith(ctl, store));
  const p = jobProgress(failed, plan);
  assert.equal(p.progressCurrent, p.progressTotal, "all images still counted");
  assert.equal(p.progressPercent, 99, "held at the finalization tail, not reset");
});

// ── 3, 4, 5: retry resumes the SAME job at finalization ─────────────────────

test("3 & 4: the same job resumes at finalization and completes", async () => {
  const ctl: Ctl = { failSync: true, syncCalls: 0, fetches: 0, total: 400, batch: 200 };
  const store = new Map<string, Uint8Array>();
  const { plan, state } = await toArchived(ctl, store);
  const failed = await advanceTalabatPackageJob(state, plan, depsWith(ctl, store));
  assert.equal(failed.status, "failed");

  // resume: same jobId, same state object lineage, sync now works
  ctl.failSync = false;
  const resumed: TalabatPackageJobState = { ...failed, status: "running", error: null };
  assert.equal(resumed.jobId, plan.jobId, "SAME job id");
  let s = resumed;
  while (s.status === "running") s = await advanceTalabatPackageJob(s, plan, depsWith(ctl, store));
  assert.equal(s.status, "completed");
  assert.equal(s.jobId, "f70f7dd5-0307-4558-bcc0-18779eaab6fc");
  assert.equal(mappingComplete(s), true);
  assert.equal(s.auditRecorded, true);
});

test("5: resuming fetches ZERO source images", async () => {
  const ctl: Ctl = { failSync: true, syncCalls: 0, fetches: 0, total: 400, batch: 200 };
  const store = new Map<string, Uint8Array>();
  const { plan, state } = await toArchived(ctl, store);
  const failed = await advanceTalabatPackageJob(state, plan, depsWith(ctl, store));
  const afterFail = ctl.fetches;

  ctl.failSync = false;
  let s: TalabatPackageJobState = { ...failed, status: "running", error: null };
  while (s.status === "running") s = await advanceTalabatPackageJob(s, plan, depsWith(ctl, store));
  assert.equal(s.status, "completed");
  assert.equal(ctl.fetches, afterFail, "not one image re-downloaded during resume");
});

// ── the bounded mapping sync — the measured root cause ──────────────────────

test("7a: the mapping sync runs in BOUNDED slices, resumed by a cursor", async () => {
  const ctl: Ctl = { failSync: false, syncCalls: 0, fetches: 0, total: 1454, batch: 200 };
  const store = new Map<string, Uint8Array>();
  const { plan, state, } = await toArchived(ctl, store);
  let s = state;
  while (s.status === "running") s = await advanceTalabatPackageJob(s, plan, depsWith(ctl, store));
  assert.equal(s.status, "completed");
  // 1454 candidates / 200 per step = 8 slices — never one 2,908-round-trip call
  assert.equal(ctl.syncCalls, Math.ceil(1454 / 200));
  assert.equal(s.mappingCursor, 1454);
  assert.equal(s.mappingTotal, 1454);
  assert.equal(s.mappingSync?.inserted, 1454, "every candidate persisted exactly once");
  // the bound exists in the sync module itself
  assert.match(code("lib/talabat/mapping-sync/catalog-sync.server.ts"), /export const MAPPING_SYNC_BATCH = \d+/);
  assert.match(code("lib/talabat/mapping-sync/catalog-sync.server.ts"), /allCandidates\.slice\(start, start \+ Math\.max\(1, limit\)\)/);
});

// ── 7 & 8: unrecoverable + stale still clean ────────────────────────────────

test("7b: an UNRECOVERABLE failure (before the artifact) still cleans parts", async () => {
  const { plan, state } = makeJob();
  const boom: TalabatJobAdvanceDeps = {
    ports: { async fetchImage() { throw new Error("boom"); }, async putPart() {} },
    budget: { maxImages: 2 },
  };
  const failed = await advanceTalabatPackageJob(state, plan, boom);
  assert.equal(failed.status, "failed");
  assert.equal(failed.artifact, null, "no artifact was ever built");
  assert.equal(failed.error?.code, "generation_failed");
  assert.equal(isRecoverableTalabatJobError(failed.error?.code), false, "eligible for cleanup");
});

test("8: a stale job WITHOUT a durable artifact is still reaped and cleaned", () => {
  const s = code(SERVER);
  assert.match(s, /if \(!fresh && !hasDurableArtifact\) \{/);
  assert.match(s, /await reapStaleJob\(live\.id\)/);
  assert.match(s, /if \(won\) await cleanupJobArtifacts\(jobId\)/);
  // …but a stale job WITH one is resumed, never reaped — the production bug
  assert.match(s, /const hasDurableArtifact = st0\?\.artifact != null && st0\.status !== "completed"/);
  assert.match(s, /if \(fresh \|\| hasDurableArtifact\)/);
  assert.match(s, /if \(!fresh && hasDurableArtifact\) await touchJob\(live\.id\)/);
});

// ── 9: the DB guard is untouched ────────────────────────────────────────────

test("9: the DB-backed one-active-job guard is intact", () => {
  const m = raw("supabase/migrations/20260904170000_talabat_package_jobs.sql")
    .split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
  assert.match(m, /create unique index if not exists talabat_package_jobs_one_active_idx/);
  assert.match(m, /where status in \('queued', 'running'\)/);
  const s = code(SERVER);
  assert.match(s, /const UNIQUE_VIOLATION = "23505"/);
  assert.match(s, /if \(pgCode === UNIQUE_VIOLATION\)/);
  // reviving a recoverable job only flips a FAILED row, so it can never create
  // a second active row
  assert.match(s, /\.eq\("id", cand\.id\)\.eq\("status", "failed"\)/);
});

// ── 10 & 11: the package itself is unchanged ────────────────────────────────

test("10 & 11: the finished archive is still a valid, unchanged package", async () => {
  const ctl: Ctl = { failSync: false, syncCalls: 0, fetches: 0, total: 10, batch: 200 };
  const store = new Map<string, Uint8Array>();
  const { plan, state } = await toArchived(ctl, store);
  let s = state;
  while (s.status === "running") s = await advanceTalabatPackageJob(s, plan, depsWith(ctl, store));
  assert.equal(s.status, "completed");
  const names = s.entries.map((e) => e.name);
  assert.ok(names.includes("Talabat/talabat-products.xlsx"));
  assert.ok(names.includes("manifest.json"));
  assert.ok(names.some((n) => n.startsWith("Talabat/images/")));
  assert.equal(s.parts.reduce((n, p) => n + p.bytes, 0), s.artifact!.totalBytes);
  assert.equal(s.summary?.destination, "talabat:malikas");
  // no content rule re-derived here
  const engine = code("lib/export/talabat/package-job.ts");
  for (const f of ["resolveTalabatSellingPrice", "resolveTalabatCategory", "resolveTalabatBarcode"]) {
    assert.equal(engine.includes(f), false, `${f} must not appear in the job engine`);
  }
});

// ── 12: no marketplace / email ──────────────────────────────────────────────

test("12: nothing is published or emailed on any path", () => {
  for (const f of ["lib/export/talabat/package-job.ts", SERVER, UI]) {
    const c = code(f);
    for (const bad of ["sendMail", "sendEmail", "nodemailer", "publishTo", "markAsSent"]) {
      assert.equal(c.toLowerCase().includes(bad.toLowerCase()), false, `${f} must not reference ${bad}`);
    }
  }
  assert.match(code(UI), /نشر إلى طلبات \(غير متاح\)/);
});

// ── the retry UX ────────────────────────────────────────────────────────────

test("13: the UI offers CONTINUE, not restart, for a recoverable failure", () => {
  const ui = code(UI);
  assert.match(ui, /متابعة رفع الحزمة/);
  assert.match(ui, /فشل رفع الحزمة النهائية/);
  assert.match(ui, /الصور محفوظة ولن تحتاج إلى إعادة تجهيزها/);
  assert.match(ui, /resumable \? "متابعة رفع الحزمة" : "إعادة المحاولة"/);
  assert.match(ui, /setResumable\(lastStatus\?\.resumable === true \|\| res\.code === "upload_incomplete"\)/);
  // and the message itself is the fixed Arabic string
  assert.match(TALABAT_JOB_ERROR_AR.upload_incomplete, /الصور محفوظة/);
});
