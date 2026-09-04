// STEP 75 — hardening the Talabat package job before the migration is applied.
//
// STEP 74B found two operational defects in code I wrote:
//   1. the "one active job" guard was APP-ONLY — a SELECT-then-INSERT whose
//      race window spans a full catalogue read, so two concurrent starts could
//      both insert (⇒ two artifacts, two mapping syncs, two audit rows);
//   2. failed and stale jobs orphaned their ZIP parts forever (~800 MB each),
//      and stale rows stayed `running` permanently.
//
// These tests pin both fixes. The DB guard is asserted against the migration
// DDL and the violation-handling path; cleanup scope and the exactly-once
// effects are asserted behaviourally.
//
// node --conditions=react-server --experimental-strip-types --test lib/export/talabat/step75-job-hardening.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createTalabatPackageJob, advanceTalabatPackageJob,
  type TalabatPackageJobPlan, type TalabatPackageJobState, type TalabatJobAdvanceDeps,
} from "./package-job.ts";
import { buildTalabatPreview, type TalabatPreviewProduct } from "./preview.ts";
import { TALABAT_JOB_ERROR_AR, talabatJobErrorMessageAr } from "./package-job-errors.ts";

const HERE = join(fileURLToPath(new URL(".", import.meta.url)));
const APP_ROOT = join(HERE, "../../..");
const raw = (rel: string): string => readFileSync(join(APP_ROOT, rel), "utf8");
const code = (rel: string): string =>
  raw(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const MIGRATION = "supabase/migrations/20260904170000_talabat_package_jobs.sql";
const SERVER = "lib/talabat/package-job.server.ts";

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
function makeJob(jobId: string, n = 3) {
  const rows = buildTalabatPreview({ products: Array.from({ length: n }, (_, i) => product(i)) }).rows;
  const c = createTalabatPackageJob({ jobId, mode: "ready", previewRows: rows, actor: "t@t", nowIso: "2026-09-04T10:00:00.000Z" });
  assert.equal(c.ok, true);
  return c as { ok: true; plan: TalabatPackageJobPlan; state: TalabatPackageJobState };
}

/** A fake bucket that records EVERY path written and removed. */
function fakeBucket() {
  const objects = new Map<string, Uint8Array>();
  const removed: string[] = [];
  return {
    objects, removed,
    /** mirrors the server's cleanup contract: parts + plan, scoped to a prefix. */
    cleanup(jobId: string) {
      const prefix = `jobs/${jobId}`;
      const doomed = [...objects.keys()]
        .filter((k) => k.startsWith(`${prefix}/`))
        .filter((k) => { const n = k.slice(prefix.length + 1); return n.startsWith("part-") || n === "plan.json"; });
      for (const d of doomed) { objects.delete(d); removed.push(d); }
      return doomed.length;
    },
  };
}
function depsFor(bucket: ReturnType<typeof fakeBucket>, over: Partial<TalabatJobAdvanceDeps> = {}) {
  const calls = { syncs: 0, audits: 0 };
  const deps: TalabatJobAdvanceDeps = {
    ports: {
      async fetchImage() { return { bytes: JPEG, ext: "jpg" }; },
      async putPart(path, bytes) { bucket.objects.set(path, bytes); },
    },
    async syncMappings() { calls.syncs++; return { ok: true, inserted: 1, updated: 0, failed: 0 }; },
    async recordAudit() { calls.audits++; return true; },
    budget: { maxImages: 2 },
    ...over,
  };
  return { deps, calls };
}
async function runToEnd(s0: TalabatPackageJobState, plan: TalabatPackageJobPlan, deps: TalabatJobAdvanceDeps) {
  let s = s0; let n = 0;
  while (s.status === "running" && n < 200) { s = await advanceTalabatPackageJob(s, plan, deps); n++; }
  return s;
}

// ── 1 & 2: the DB is the final authority on one active job ───────────────────

test("1: a PARTIAL UNIQUE index enforces one active job per channel", () => {
  const m = MIGRATION_SQL();
  assert.match(m, /create unique index if not exists talabat_package_jobs_one_active_idx/);
  assert.match(m, /on public\.talabat_package_jobs \(channel\)/);
  assert.match(m, /where status in \('queued', 'running'\)/);
  // terminal rows stay OUTSIDE the predicate, so history is unbounded and a
  // replacement can always start
  assert.equal(/where status in \([^)]*'completed'/.test(m), false);
  assert.equal(/where status in \([^)]*'failed'/.test(m), false);
});

test("2: the race loser is served the ACTIVE job, never a raw DB error", () => {
  const s = code(SERVER);
  assert.match(s, /const UNIQUE_VIOLATION = "23505"/);
  assert.match(s, /if \(pgCode === UNIQUE_VIOLATION\)/);
  // it re-reads the winner and returns its status
  assert.match(s, /const winner = await admin[\s\S]{0,200}\.in\("status", \["queued", "running"\]\)/);
  assert.match(s, /if \(st && pl\) return \{ ok: true, value: statusDTO\(st, pl, row\) \}/);
  // the only fallback is a mapped, friendly code
  assert.match(s, /return errResult\("conflict", 409\)/);
  assert.ok(TALABAT_JOB_ERROR_AR.conflict.length > 0);
  // and no raw postgres text can reach the caller
  assert.equal(/inserted\.error\.message|String\(inserted\.error\)/.test(s), false);
});

// ── 3 & 4: failed-job cleanup is scoped ──────────────────────────────────────

test("3: a FAILED job's temporary parts are deleted", async () => {
  const bucket = fakeBucket();
  const { plan, state } = makeJob("11111111-1111-4111-8111-111111111111");
  bucket.objects.set(`jobs/${plan.jobId}/plan.json`, new Uint8Array([1]));
  bucket.objects.set(`jobs/${plan.jobId}/state.json`, new Uint8Array([2]));
  // two good steps, then a hard failure
  let s = state;
  const { deps } = depsFor(bucket);
  s = await advanceTalabatPackageJob(s, plan, deps);
  assert.ok(s.parts.length >= 1, "parts exist before the failure");
  const boom = depsFor(bucket, {
    ports: { async fetchImage() { throw new Error("boom"); }, async putPart() {} },
  }).deps;
  s = await advanceTalabatPackageJob(s, plan, boom);
  assert.equal(s.status, "failed");

  const before = [...bucket.objects.keys()].filter((k) => k.includes("/part-")).length;
  assert.ok(before >= 1);
  bucket.cleanup(plan.jobId);
  assert.equal([...bucket.objects.keys()].filter((k) => k.includes("/part-")).length, 0, "parts gone");
  assert.equal(bucket.objects.has(`jobs/${plan.jobId}/plan.json`), false, "the dead plan is gone too");
  assert.equal(bucket.objects.has(`jobs/${plan.jobId}/state.json`), true, "state.json KEPT for diagnostics");
  // and the server wires exactly this on failure
  assert.match(code(SERVER), /if \(next\.status === "failed"\) await cleanupJobArtifacts\(jobId\)/);
});

test("4: cleanup can never touch another job's parts", async () => {
  const bucket = fakeBucket();
  const a = makeJob("aaaaaaaa-1111-4111-8111-111111111111");
  const b = makeJob("bbbbbbbb-2222-4222-8222-222222222222");
  await runToEnd(a.state, a.plan, depsFor(bucket).deps);
  await runToEnd(b.state, b.plan, depsFor(bucket).deps);
  const bBefore = [...bucket.objects.keys()].filter((k) => k.startsWith(`jobs/${b.plan.jobId}/`)).length;
  assert.ok(bBefore > 0);

  bucket.cleanup(a.plan.jobId);
  assert.equal([...bucket.objects.keys()].filter((k) => k.startsWith(`jobs/${a.plan.jobId}/`)).length, 0);
  assert.equal([...bucket.objects.keys()].filter((k) => k.startsWith(`jobs/${b.plan.jobId}/`)).length, bBefore,
    "job B is untouched");
  for (const r of bucket.removed) assert.ok(r.startsWith(`jobs/${a.plan.jobId}/`), `${r} is inside A's prefix`);

  // the real implementation is prefix + UUID guarded, and lists an explicit set
  const s = code(SERVER);
  assert.match(s, /const UUID_RE = /);
  assert.match(s, /if \(!UUID_RE\.test\(jobId\)\) return \{ ok: false, removed: 0 \}/);
  assert.match(s, /export const jobPrefix = \(jobId: string\) => `jobs\/\$\{jobId\}`/);
  assert.match(s, /\.remove\(doomed\)/, "an explicit path list, never a prefix-wide delete");
  assert.equal(/\.remove\(\[\s*prefix\s*\]\)|emptyBucket|deleteBucket/.test(s), false);
});

// ── 5, 6 & 7: stale recovery ─────────────────────────────────────────────────

test("5: a stale job is transitioned OUT of the active set atomically", () => {
  const s = code(SERVER);
  assert.match(s, /async function reapStaleJob/);
  assert.match(s, /status: "failed",\s*\n\s*error_code: STALE_ERROR_CODE/);
  // the status guard IS the arbitration point — only one racer reaps
  assert.match(s, /\.eq\("id", jobId\)\s*\n\s*\.in\("status", \["queued", "running"\]\)/);
  // and start() reaps instead of silently ignoring the row
  assert.match(s, /\} else \{[\s\S]{0,600}await reapStaleJob\(live\.id\)/);
  assert.equal(/if \(live && Date\.now\(\) - new Date\(live\.updated_at\)\.getTime\(\) < STALE_MS\) \{[\s\S]{0,200}\}\s*\n\s*const preview/.test(s), false,
    "the old ignore-and-continue shape is gone");
});

test("6: the reaped job's parts are cleaned", () => {
  const s = code(SERVER);
  // cleanup happens only for the racer that actually won the transition
  assert.match(s, /if \(won\) await cleanupJobArtifacts\(jobId\)/);
});

test("7: a replacement job can start once the stale one is retired", () => {
  const s = code(SERVER);
  // reap happens BEFORE the insert, so the partial unique index is satisfied
  const reapAt = s.indexOf("await reapStaleJob(live.id)");
  const insertAt = s.indexOf('.from("talabat_package_jobs")\n    .insert(');
  assert.ok(reapAt > 0 && insertAt > reapAt, "the stale row leaves the active set before the insert");
  // a fresh id per job
  assert.match(s, /const jobId = randomUUID\(\)/);
});

// ── 8: a COMPLETED artifact is never deleted ────────────────────────────────

test("8: failed-job cleanup never runs against a completed job", async () => {
  const bucket = fakeBucket();
  const j = makeJob("cccccccc-3333-4333-8333-333333333333");
  const { deps } = depsFor(bucket);
  const done = await runToEnd(j.state, j.plan, deps);
  assert.equal(done.status, "completed");
  const parts = [...bucket.objects.keys()].filter((k) => k.includes("/part-")).length;
  assert.ok(parts > 0, "a completed artifact IS its parts");
  // the server only cleans on the failed transition and on the stale reap —
  // there is no cleanup call on the completed path
  const s = code(SERVER);
  assert.equal((s.match(/cleanupJobArtifacts\(/g) ?? []).length, 3,
    "declaration + failed-step + stale-reap only");
  assert.equal(/next\.status === "completed"[\s\S]{0,80}cleanupJobArtifacts/.test(s), false);
});

// ── 9: retry semantics ──────────────────────────────────────────────────────

test("9: retry after failure yields ONE new job and keeps the old as history", () => {
  const s = code(SERVER);
  // a failed row is NOT in the resume set, so retry creates a fresh job…
  assert.match(s, /\.in\("status", \["queued", "running"\]\)/);
  // …and the failed row is never deleted, only its temporary parts
  assert.equal(/\.from\("talabat_package_jobs"\)[\s\S]{0,80}\.delete\(/.test(s), false,
    "job rows are history and are never deleted");
  // completed jobs are likewise outside the active set, so they are never
  // treated as resumable
  const active = s.match(/\.in\("status", \["queued", "running"\]\)/g) ?? [];
  assert.ok(active.length >= 2, "both the start lookup and the race re-read use the active set");
});

// ── 10 & 11: exactly-once side effects ──────────────────────────────────────

test("10 & 11: mapping sync and audit run exactly once per completed job", async () => {
  const bucket = fakeBucket();
  const j = makeJob("dddddddd-4444-4444-8444-444444444444");
  const { deps, calls } = depsFor(bucket);
  const done = await runToEnd(j.state, j.plan, deps);
  assert.equal(done.status, "completed");
  assert.equal(calls.syncs, 1, "one mapping sync");
  assert.equal(calls.audits, 1, "one audit row");
  // extra advances are no-ops
  await advanceTalabatPackageJob(done, j.plan, deps);
  await advanceTalabatPackageJob(done, j.plan, deps);
  assert.equal(calls.syncs, 1);
  assert.equal(calls.audits, 1);
  // and with the DB guard, only ONE active job can ever reach these stages
  assert.match(MIGRATION_SQL(), /create unique index if not exists talabat_package_jobs_one_active_idx/);
});

// ── 12: Rafeeq untouched ────────────────────────────────────────────────────

test("12: no Rafeeq table, bucket or row is touched", () => {
  const m = MIGRATION_SQL();
  // rafeeq appears only in explanatory comments, never in DDL
  for (const line of raw(MIGRATION).split("\n")) {
    if (/rafeeq/i.test(line)) assert.match(line.trim(), /^--/, `rafeeq referenced outside a comment: ${line}`);
  }
  assert.equal(/rafeeq/i.test(m), false, "no rafeeq identifier in executable DDL");
  const s = code(SERVER);
  assert.equal(/rafeeq/i.test(s), false, "the Talabat server layer never names a Rafeeq resource");
  assert.match(s, /const BUCKET = "talabat-packages"/);
  assert.match(s, /\.from\("talabat_package_jobs"\)/);
});

// ── informational (STEP 74B §8) ─────────────────────────────────────────────

test("13: the error_code + error_ref design is kept; no raw message is stored", () => {
  const m = MIGRATION_SQL();
  assert.match(m, /error_code\s+text/);
  assert.match(m, /error_ref\s+text/);
  assert.equal(/error_message/.test(m), false, "no error_message column — by design");
  assert.equal(talabatJobErrorMessageAr("stale_abandoned"), TALABAT_JOB_ERROR_AR.stale_abandoned);
  // an unknown code still degrades to a safe fixed string
  assert.equal(talabatJobErrorMessageAr("something-unmapped"), TALABAT_JOB_ERROR_AR.network);
});

/** The migration with comments stripped — only executable DDL. */
function MIGRATION_SQL(): string {
  return raw(MIGRATION).split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
}
