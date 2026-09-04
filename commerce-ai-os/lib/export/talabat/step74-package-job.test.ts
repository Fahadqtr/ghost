// STEP 74 — Talabat package generation as a chunked, resumable JOB.
//
// The single-shot route failed with FUNCTION_INVOCATION_TIMEOUT. Measured on
// the real catalogue (1454 rows / 2501 planned images): ~775 s of image fetch
// at concurrency 6 and ~1.6 GB peak buffered — two independent ceilings, so
// raising maxDuration could not fix it. These tests pin the new execution
// model and prove the certified package CONTRACT is unchanged.
//
// node --conditions=react-server --experimental-strip-types --test lib/export/talabat/step74-package-job.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createTalabatPackageJob,
  advanceTalabatPackageJob,
  jobProgress,
  jobPartPath,
  JOB_STEP_MAX_IMAGES,
  type TalabatPackageJobState,
  type TalabatPackageJobPlan,
  type TalabatJobAdvanceDeps,
} from "./package-job.ts";
import {
  formatDuration, formatBytes, estimateRemainingMs, readJobResponse,
  talabatJobDownloadUrl, jobErrorMessage, ETA_MIN_UNITS,
} from "./package-job-client.ts";
import { TALABAT_JOB_STAGES, TALABAT_JOB_STAGE_AR, TALABAT_JOB_ERROR_AR } from "./package-job-errors.ts";
import { buildTalabatPreview, type TalabatPreviewProduct } from "./preview.ts";

const HERE = join(fileURLToPath(new URL(".", import.meta.url)));
const APP_ROOT = join(HERE, "../../..");
const code = (rel: string): string =>
  readFileSync(join(APP_ROOT, rel), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const IMG = "https://x.test/a.jpg";
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, ...new Array(64).fill(7)]);

function product(n: number, over: Partial<TalabatPreviewProduct> = {}): TalabatPreviewProduct {
  const sku = `mk${1000 + n}`;
  return {
    id: `p${n}`, sku, barcode: `12345678${String(90000 + n)}`,
    nameEn: `EN ${sku}`, nameAr: `ع ${sku}`, price: 50, discountPrice: null, channelPrice: null,
    category: "Face Care", descriptionEn: "d", descriptionAr: "و",
    imageUrl: IMG, imageFilename: `${sku}.jpg`, galleryImageUrls: [`${IMG}?2`], imageCount: 2,
    approved: true, lifecycleState: "ACTIVE", variants: [], ...over,
  };
}
const previewRows = (n: number) =>
  buildTalabatPreview({ products: Array.from({ length: n }, (_, i) => product(i)) }).rows;

function makeJob(n = 3, mode: "ready" | "selected" = "ready") {
  const created = createTalabatPackageJob({
    jobId: "11111111-2222-3333-4444-555555555555", mode,
    previewRows: previewRows(n), actor: "t@t", nowIso: "2026-09-04T10:00:00.000Z",
  });
  assert.equal(created.ok, true, "the fixture must produce exportable rows");
  return created as { ok: true; plan: TalabatPackageJobPlan; state: TalabatPackageJobState };
}

function fakeDeps(over: Partial<TalabatJobAdvanceDeps> = {}) {
  const store = new Map<string, Uint8Array>();
  const calls = { fetches: 0, syncs: 0, audits: 0 };
  const deps: TalabatJobAdvanceDeps = {
    ports: {
      async fetchImage() { calls.fetches++; return { bytes: JPEG, ext: "jpg" }; },
      async putPart(path, bytes) { store.set(path, bytes); },
    },
    async syncMappings() { calls.syncs++; return { ok: true, inserted: 1, updated: 0, failed: 0 }; },
    async recordAudit() { calls.audits++; return true; },
    budget: { maxImages: 2 },
    ...over,
  };
  return { deps, store, calls };
}

async function runToEnd(state: TalabatPackageJobState, plan: TalabatPackageJobPlan, deps: TalabatJobAdvanceDeps) {
  let s = state; let steps = 0; const stages: string[] = [];
  while (s.status === "running" && steps < 200) { s = await advanceTalabatPackageJob(s, plan, deps); stages.push(s.stage); steps++; }
  return { state: s, steps, stages };
}

// ── 1: the start path is cheap — no image work ───────────────────────────────

test("1: creating the job does NO image work and returns immediately", () => {
  const { plan, state } = makeJob(3);
  assert.equal(state.status, "running");
  assert.equal(state.cursor, 0, "nothing fetched yet");
  assert.equal(state.parts.length, 0, "no bytes written yet");
  assert.equal(state.artifact, null);
  // the plan already knows the REAL totals, so the UI has a denominator at once
  assert.equal(plan.rows.length, 3);
  assert.equal(plan.images.length, 6, "3 primaries + 3 gallery");
  const p = jobProgress(state, plan);
  assert.equal(p.progressTotal, 6);
  assert.equal(p.progressCurrent, 0);
  // the start route declares only a small budget — it never runs the package
  const startRoute = code("app/api/export/talabat/package/jobs/route.ts");
  assert.match(startRoute, /maxDuration = 60/);
  assert.equal(/safeFetchImage|buildZip|buildTalabatXlsxBuffer/.test(startRoute), false,
    "the start route performs no generation work");
});

// ── 2: duplicate click cannot create a second active job ─────────────────────

test("2: a live job is RESUMED, never duplicated", () => {
  const server = code("lib/talabat/package-job.server.ts");
  // the idempotent-start lookup, then an early return with the live job
  assert.match(server, /\.eq\("channel", CHANNEL\)/);
  assert.match(server, /\.in\("status", \["queued", "running"\]\)/);
  assert.match(server, /if \(st && pl\) return \{ ok: true, value: statusDTO\(st, pl, live\) \}/);
  // and the step claim is optimistic, so two drivers cannot run one step twice
  assert.match(server, /\.eq\("step", seen\.step\)/);
  // the client guards the double-click too
  const ui = code("components/v2/export/TalabatPackageControls.tsx");
  assert.match(ui, /if \(busy\) return;/);
  assert.match(ui, /disabled=\{busy \|\| plan\.rowsIncluded === 0\}/);
});

// ── 3 & 4: lifecycle and stages ──────────────────────────────────────────────

test("3: progress moves running → completed across many bounded steps", async () => {
  const { plan, state } = makeJob(3);
  const { deps } = fakeDeps();
  const run = await runToEnd(state, plan, deps);
  assert.equal(run.state.status, "completed");
  assert.ok(run.steps >= 4, `expected several bounded steps, got ${run.steps}`);
  const p = jobProgress(run.state, plan);
  assert.equal(p.progressPercent, 100);
  assert.equal(p.progressCurrent, p.progressTotal);
});

test("4: the stage advances through the real phases and ends COMPLETED", async () => {
  const { plan, state } = makeJob(3);
  const { deps } = fakeDeps();
  const run = await runToEnd(state, plan, deps);
  assert.equal(run.stages[0], "DOWNLOADING_IMAGES");
  assert.equal(run.state.stage, "COMPLETED");
  assert.ok(run.stages.includes("UPLOADING_ARTIFACT"), "the archive step is observable");
  assert.ok(run.stages.includes("SYNCING_MAPPINGS"), "the mapping step is observable");
  for (const st of run.stages) assert.ok(TALABAT_JOB_STAGES.includes(st as never), `${st} is a declared stage`);
  for (const st of TALABAT_JOB_STAGES) assert.ok(TALABAT_JOB_STAGE_AR[st], `${st} has an Arabic label`);
});

// ── 5: image batches increment progress ──────────────────────────────────────

test("5: each step fetches a BOUNDED batch and progress increments per batch", async () => {
  const { plan, state } = makeJob(6);
  const { deps, calls } = fakeDeps({ budget: { maxImages: 3 } });
  let s = state;
  const seen: number[] = [];
  s = await advanceTalabatPackageJob(s, plan, deps); seen.push(jobProgress(s, plan).progressCurrent);
  s = await advanceTalabatPackageJob(s, plan, deps); seen.push(jobProgress(s, plan).progressCurrent);
  assert.deepEqual(seen, [3, 6], "three images per step");
  assert.equal(calls.fetches, 6);
  // the default budget is bounded well under the plan
  assert.ok(JOB_STEP_MAX_IMAGES > 0 && JOB_STEP_MAX_IMAGES <= 100);
  // each step commits its own durable part
  assert.equal(s.parts.length, 2);
  assert.equal(s.parts[0].path, jobPartPath(plan.jobId, 0));
});

// ── 6 & 7: polling stops on both terminal states ─────────────────────────────

test("6 & 7: the driver loop stops on completed AND on failed", () => {
  const client = code("lib/export/talabat/package-job-client.ts");
  assert.match(client, /while \(status\.status === "running" \|\| status\.status === "queued"\)/,
    "the loop runs only while the job is live — completed/failed exit it");
  assert.match(client, /if \(status\.status === "failed"\)/, "failure returns an error result");
  // no unconditional interval that could keep polling after the end
  assert.equal(/setInterval\(/.test(client), false, "the driver has no free-running timer");
});

// ── 8: failure copy is user-safe ─────────────────────────────────────────────

test("8: a failure shows fixed Arabic copy, never a raw platform error", async () => {
  const { plan, state } = makeJob(3);
  const { deps } = fakeDeps({
    ports: {
      async fetchImage() { throw new Error("boom: https://internal.host/secret?token=abc"); },
      async putPart() { /* unused */ },
    },
  });
  const s = await advanceTalabatPackageJob(state, plan, deps);
  assert.equal(s.status, "failed");
  assert.equal(s.error?.code, "generation_failed");
  assert.ok(s.error?.refId, "a short reference id is kept for diagnostics");
  // the message the UI renders is a fixed string, and never the thrown text
  const msg = jobErrorMessage(s.error?.code);
  assert.equal(msg, TALABAT_JOB_ERROR_AR.generation_failed);
  assert.equal(msg.includes("internal.host"), false);
  assert.equal(msg.includes("token"), false);
  // the client never interprets a non-JSON body
  const html = new Response("<html>FUNCTION_INVOCATION_TIMEOUT</html>", { headers: { "content-type": "text/html" } });
  const read = await readJobResponse(html);
  assert.equal(read.ok, false);
  assert.equal(read.ok === false && read.code, "network");
  // the UI renders only mapped messages + the stage
  const ui = code("components/v2/export/TalabatPackageControls.tsx");
  assert.match(ui, /فشل توليد الحزمة/);
  assert.match(ui, /jobErrorMessage\(res\.code\)/);
  assert.match(ui, /إعادة المحاولة/);
});

// ── 9: retry is safe — resume, and effects happen exactly once ───────────────

test("9: a transient image failure retries, then the job still completes once", async () => {
  const { plan, state } = makeJob(3);
  let fail = true;
  const { deps, calls } = fakeDeps({
    ports: {
      async fetchImage() {
        if (fail) { fail = false; return null; }   // one transient miss
        return { bytes: JPEG, ext: "jpg" };
      },
      async putPart() { /* durable enough for this assertion */ },
    },
  });
  const run = await runToEnd(state, plan, deps);
  assert.equal(run.state.status, "completed");
  // the ONE-TIME effects ran exactly once despite the retry
  assert.equal(calls.syncs, 1, "mapping sync exactly once");
  assert.equal(calls.audits, 1, "audit row exactly once");
  assert.equal(run.state.auditRecorded, true);
  // advancing a finished job is a no-op (idempotent)
  const again = await advanceTalabatPackageJob(run.state, plan, deps);
  assert.equal(again, run.state, "a completed job is returned untouched");
  assert.equal(calls.syncs, 1);
  assert.equal(calls.audits, 1);
});

// ── 10: the certified package contract is unchanged ──────────────────────────

test("10: the finished archive carries the certified contents", async () => {
  const { plan, state } = makeJob(3);
  const { deps, store } = fakeDeps();
  const run = await runToEnd(state, plan, deps);
  const s = run.state;
  assert.ok(s.artifact, "an artifact is recorded");
  assert.match(s.artifact!.filename, /^talabat-package-\d{4}-\d{2}-\d{2}\.zip$/);
  assert.equal(s.summary?.destination, "talabat:malikas");
  assert.equal(s.summary?.sellableRowCount, 3);
  assert.equal(s.summary?.integrityOk, true);
  assert.ok(s.artifact!.manifestFingerprint.length === 64, "a real sha256 content digest");
  // entry names are the certified ones
  const names = s.entries.map((e) => e.name);
  assert.ok(names.includes("Talabat/talabat-products.xlsx"), "the certified workbook path");
  assert.ok(names.includes("manifest.json"));
  assert.ok(names.some((n) => n.startsWith("Talabat/images/")), "images under the certified folder");
  // the concatenated parts equal the recorded artifact size
  const total = s.parts.reduce((n, p) => n + p.bytes, 0);
  assert.equal(total, s.artifact!.totalBytes);
  assert.equal(store.size >= 1, true);
});

// ── 11: no pricing / category / barcode regression ───────────────────────────

test("11: the job engine re-derives NO pricing, category or barcode rule", () => {
  const engine = code("lib/export/talabat/package-job.ts");
  for (const forbidden of [
    "resolveTalabatSellingPrice", "resolveTalabatCategory", "resolveTalabatBarcode",
    "discountPrice", "channelPrice", "TALABAT_NATIVE_CATEGORIES",
  ]) {
    assert.equal(engine.includes(forbidden), false, `${forbidden} must not appear in the job engine`);
  }
  // it consumes the certified helpers instead
  assert.match(engine, /resolveGenerationSet/);
  assert.match(engine, /planRowImages/);
  assert.match(engine, /toPackageRow/);
  assert.match(engine, /checkReferentialIntegrity/);
  // and the rules themselves are untouched upstream
  const pv = code("lib/export/talabat/preview.ts");
  assert.match(pv, /resolveTalabatSellingPrice\(\{/);
  assert.match(pv, /const talabatBarcode = bcRes\.ok \? bcRes\.barcode : null/);
  assert.match(pv, /const talabatCategory = catRes\.ok \? catRes\.category : null/);
});

// ── 12: nothing is published or emailed ──────────────────────────────────────

test("12: the job never publishes to Talabat and never sends email", () => {
  for (const f of [
    "lib/export/talabat/package-job.ts",
    "lib/talabat/package-job.server.ts",
    "app/api/export/talabat/package/jobs/route.ts",
    "app/api/export/talabat/package/jobs/[jobId]/route.ts",
    "components/v2/export/TalabatPackageControls.tsx",
  ]) {
    const c = code(f);
    for (const forbidden of ["sendMail", "sendEmail", "nodemailer", "smtp", "publishTo", "markAsSent", "sent_at"]) {
      assert.equal(c.toLowerCase().includes(forbidden.toLowerCase()), false, `${f} must not reference ${forbidden}`);
    }
  }
  // the publish button is still explicitly unavailable
  const ui = code("components/v2/export/TalabatPackageControls.tsx");
  assert.match(ui, /نشر إلى طلبات \(غير متاح\)/);
  // the only durable writes are the job row, storage, ONE sync and ONE audit
  const server = code("lib/talabat/package-job.server.ts");
  assert.match(server, /insertAuditRow/);
  assert.match(server, /syncTalabatMappingsFromCatalog/);
  assert.equal(/\.from\("products"\)\s*\.\s*update|\.from\("product_variants"\)/.test(server), false,
    "no catalog mutation");
});

// ── progress formatting helpers ──────────────────────────────────────────────

test("13: elapsed/ETA/byte formatting, and no ETA before it is meaningful", () => {
  assert.equal(formatDuration(0), "0:00");
  assert.equal(formatDuration(222_000), "3:42");
  assert.equal(formatDuration(3_661_000), "1:01:01");
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(838_860_800), "800 MB");
  // too little progress → no estimate at all
  assert.equal(estimateRemainingMs({ elapsedMs: 5_000, current: 1, total: 2501 }), null);
  assert.equal(estimateRemainingMs({ elapsedMs: 5_000, current: ETA_MIN_UNITS - 1, total: 2501 }), null);
  assert.equal(estimateRemainingMs({ elapsedMs: 60_000, current: 60, total: 2501 }), null, "under 5% → still null");
  // enough progress → a sane estimate
  const eta = estimateRemainingMs({ elapsedMs: 100_000, current: 500, total: 2501 });
  assert.equal(eta, Math.round((100_000 / 500) * 2001));
  // finished → nothing remaining
  assert.equal(estimateRemainingMs({ elapsedMs: 10, current: 10, total: 10 }), null);
  assert.equal(talabatJobDownloadUrl("abc"), "/api/export/talabat/package/jobs/abc/download");
});

// ── the long-running work really did leave the request ───────────────────────

test("14: the old single-shot generator is no longer what the UI calls", () => {
  const ui = code("components/v2/export/TalabatPackageControls.tsx");
  assert.match(ui, /driveTalabatPackageJob\(/, "the UI drives the job");
  assert.equal(/fetch\("\/api\/export\/talabat\/package"/.test(ui), false,
    "the buffered single-shot endpoint is unreachable from the UI");
  // the step route is the only place a long budget lives, and it does ONE step
  const step = code("app/api/export/talabat/package/jobs/[jobId]/route.ts");
  assert.match(step, /stepTalabatPackageJob\(jobId\)/);
  assert.equal(/for \(|while \(/.test(step), false, "the step route loops over nothing");
});
