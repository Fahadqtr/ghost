// STEP 77 — legacy job state must survive a build that added fields.
//
// PRODUCTION FORENSICS (job ad8aa4db-05e6-46be-8392-7bf8ac4738a5):
//   started 20:44 (pre-STEP-76 build) · resumed 21:13 (post-STEP-76 build) ·
//   progress 2501/2501 · artifact_bytes 564,161,170 · 64 parts intact ·
//   step climbed 65 -> 80+ over ~30 min · stage never left SYNCING_MAPPINGS ·
//   channel_variant_mappings: exactly 200 rows touched, then flat for ~30 min.
//
// Its state.json was written before mappingCursor/mappingTotal existed, so the
// post-STEP-76 build read both as `undefined`. `undefined` poisons every
// comparison it reaches:
//
//     next > undefined              -> false  => the cursor NEVER advanced
//     undefined >= undefined        -> false  => the stage NEVER completed
//
// so the job re-synced candidates [0, 200) on every step, for ever. The images
// and the archive were never at risk — the job simply could not finish.
//
// The fix normalises state ONCE at the read boundary, so no consumer downstream
// can meet an `undefined`. These tests pin that.
//
// node --conditions=react-server --experimental-strip-types --test lib/export/talabat/step77-legacy-state.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createTalabatPackageJob, advanceTalabatPackageJob, jobProgress,
  mappingComplete, normalizeTalabatPackageJobState, counter,
  type TalabatPackageJobPlan, type TalabatPackageJobState, type TalabatJobAdvanceDeps,
} from "./package-job.ts";
import { buildTalabatPreview, type TalabatPreviewProduct } from "./preview.ts";

const HERE = join(fileURLToPath(new URL(".", import.meta.url)));
const APP_ROOT = join(HERE, "../../..");
const raw = (rel: string): string => readFileSync(join(APP_ROOT, rel), "utf8");
const code = (rel: string): string =>
  raw(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const SERVER = "lib/talabat/package-job.server.ts";
const LIVE_JOB = "ad8aa4db-05e6-46be-8392-7bf8ac4738a5";

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
    jobId: LIVE_JOB, mode: "ready", previewRows: rows,
    actor: "t@t", nowIso: "2026-09-04T20:44:31.000Z",
  });
  assert.equal(c.ok, true);
  return c as { ok: true; plan: TalabatPackageJobPlan; state: TalabatPackageJobState };
}

interface Ctl { syncCalls: number; fetches: number; total: number; batch: number; offsets: number[] }
function depsWith(ctl: Ctl, store: Map<string, Uint8Array>): TalabatJobAdvanceDeps {
  return {
    ports: {
      async fetchImage() { ctl.fetches++; return { bytes: JPEG, ext: "jpg" }; },
      async putPart(path, bytes) { store.set(path, bytes); },
    },
    async syncMappings(_actor, offset) {
      ctl.syncCalls++;
      ctl.offsets.push(offset);
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
/** Exactly what a PRE-STEP-76 build persisted: the two fields simply absent. */
function asLegacyState(s: TalabatPackageJobState): TalabatPackageJobState {
  const round = JSON.parse(JSON.stringify(s)) as Record<string, unknown>;
  delete round.mappingCursor;
  delete round.mappingTotal;
  assert.equal("mappingCursor" in round, false, "the legacy fixture really lacks the field");
  assert.equal("mappingTotal" in round, false, "the legacy fixture really lacks the field");
  return round as unknown as TalabatPackageJobState;
}
const ctl = (over: Partial<Ctl> = {}): Ctl =>
  ({ syncCalls: 0, fetches: 0, total: 1454, batch: 200, offsets: [], ...over });

// ── 1: the poisoned comparison, and immunity at BOTH layers ─────────────────

test("1: the undefined-comparison hazard is real (why the job looped)", () => {
  // These are the two comparisons the pre-fix code performed against a field
  // that a legacy state.json simply did not carry. Both are false, silently:
  // the cursor never advanced and the stage never completed, so the job
  // re-synced candidates [0, 200) on every step for ~30 minutes.
  const missing = undefined as unknown as number;
  assert.equal(200 > missing, false, "a cursor can never advance past undefined");
  assert.equal(missing >= missing, false, "and the stage can never report complete");
  assert.equal(missing === null, false, "so a `=== null` guard does not catch it either");
});

test("1b: defence in depth — even an UNNORMALIZED legacy state terminates", async () => {
  const c = ctl();
  const store = new Map<string, Uint8Array>();
  const { plan, state } = await toArchived(c, store);

  // Deliberately skip normalizeTalabatPackageJobState: the engine must not be
  // able to loop even if a state ever reaches it unnormalised.
  let s = asLegacyState(state);
  let steps = 0;
  while (s.status === "running" && steps < 200) { s = await advanceTalabatPackageJob(s, plan, depsWith(c, store)); steps++; }

  assert.equal(s.status, "completed", "it terminates rather than spinning");
  assert.equal(new Set(c.offsets).size, c.offsets.length,
    "no slice is ever re-requested — the production symptom cannot recur");
  assert.notDeepEqual(new Set(c.offsets), new Set([0]), "it does not sit on offset 0");
});

test("2: NORMALIZED, the same legacy state advances and terminates", async () => {
  const c = ctl();
  const store = new Map<string, Uint8Array>();
  const { plan, state } = await toArchived(c, store);
  const legacy = normalizeTalabatPackageJobState(asLegacyState(state));
  assert.notEqual(legacy, null);

  let s = legacy as TalabatPackageJobState;
  let steps = 0;
  while (s.status === "running" && steps < 200) { s = await advanceTalabatPackageJob(s, plan, depsWith(c, store)); steps++; }

  assert.equal(s.status, "completed", "the job finishes");
  assert.equal(s.stage, "COMPLETED");
  assert.equal(s.mappingCursor, 1454, "every candidate persisted exactly once");
  assert.equal(mappingComplete(s), true);
  assert.equal(s.auditRecorded, true, "FINALIZING ran");
  // the first slice starts at 0, and each next slice resumes from the new cursor
  assert.deepEqual(c.offsets.slice(0, 4), [0, 200, 400, 600], "the cursor advances, never repeats");
  assert.equal(new Set(c.offsets).size, c.offsets.length, "no slice is ever re-requested");
});

// ── 3: the live job resumes IN PLACE ─────────────────────────────────────────

test("3: the live job resumes in place — same id, same parts, no re-download", async () => {
  const c = ctl();
  const store = new Map<string, Uint8Array>();
  const { plan, state } = await toArchived(c, store);
  const imagesFetched = c.fetches;
  const partsBefore = state.parts.length;
  const bytesBefore = state.artifact?.totalBytes;

  let s = normalizeTalabatPackageJobState(asLegacyState(state)) as TalabatPackageJobState;
  let steps = 0;
  while (s.status === "running" && steps < 200) { s = await advanceTalabatPackageJob(s, plan, depsWith(c, store)); steps++; }

  assert.equal(s.jobId, LIVE_JOB, "same job id");
  assert.equal(s.parts.length, partsBefore, "same parts");
  assert.equal(s.artifact?.totalBytes, bytesBefore, "same artifact bytes");
  assert.equal(c.fetches, imagesFetched, "IMAGES_REDOWNLOADED = NO");
  assert.equal(s.cursor, plan.images.length, "still N/N images — never back to 1%");
  assert.equal([...store.keys()].filter((k) => k.includes("/part-")).length, partsBefore, "parts still in storage");
  assert.equal(jobProgress(s, plan).progressPercent, 100);
});

// ── 4: normalization contract — A / B / C ────────────────────────────────────

test("4a: PRE-STEP-76 state → cursor 0, total null, everything else preserved", () => {
  const { state } = makeJob();
  const legacy = asLegacyState({ ...state, cursor: 7, attempts: 2, offset: 99 });
  const n = normalizeTalabatPackageJobState(legacy) as TalabatPackageJobState;
  assert.equal(n.mappingCursor, 0, "MAPPING_CURSOR_DEFAULT = 0");
  assert.equal(n.mappingTotal, null, "MAPPING_TOTAL_DEFAULT = null");
  assert.equal(n.cursor, 7, "unrelated state is untouched");
  assert.equal(n.attempts, 2);
  assert.equal(n.offset, 99);
  assert.equal(n.jobId, LIVE_JOB);
});

test("4b: CURRENT-format state passes through unchanged", () => {
  const { state } = makeJob();
  const current = { ...state, mappingCursor: 800, mappingTotal: 1454 };
  const n = normalizeTalabatPackageJobState(current) as TalabatPackageJobState;
  assert.equal(n.mappingCursor, 800, "a valid cursor is preserved");
  assert.equal(n.mappingTotal, 1454, "a valid total is preserved");
  assert.deepEqual(n, current, "nothing else is rewritten");
  // and an explicit null total (mapping not yet started) stays null
  const fresh = normalizeTalabatPackageJobState({ ...state, mappingCursor: 0, mappingTotal: null }) as TalabatPackageJobState;
  assert.equal(fresh.mappingTotal, null);
});

test("4c: MALFORMED values fail safe, never to a smaller/absurd number", () => {
  const { state } = makeJob();
  const bad = (over: Record<string, unknown>) =>
    normalizeTalabatPackageJobState({ ...state, ...over }) as TalabatPackageJobState;

  assert.equal(bad({ mappingCursor: NaN }).mappingCursor, 0, "NaN cursor → 0");
  assert.equal(bad({ mappingCursor: -5 }).mappingCursor, 0, "negative cursor → 0");
  assert.equal(bad({ mappingCursor: "200" }).mappingCursor, 0, "string cursor → 0");
  assert.equal(bad({ mappingCursor: Infinity }).mappingCursor, 0, "Infinity cursor → 0");
  assert.equal(bad({ mappingCursor: 12.7 }).mappingCursor, 12, "fractional cursor floors");

  assert.equal(bad({ mappingTotal: NaN }).mappingTotal, null, "NaN total → null");
  assert.equal(bad({ mappingTotal: -1 }).mappingTotal, null, "negative total → null");
  assert.equal(bad({ mappingTotal: "1454" }).mappingTotal, null, "string total → null");
  // a total BELOW the cursor would declare the stage complete early
  assert.equal(bad({ mappingCursor: 900, mappingTotal: 400 }).mappingTotal, null,
    "total < cursor degrades to unknown, never to a smaller number");
  assert.equal(bad({ mappingCursor: 900, mappingTotal: 900 }).mappingTotal, 900, "total === cursor is legitimate");

  // non-states are rejected rather than half-built
  assert.equal(normalizeTalabatPackageJobState(null), null);
  assert.equal(normalizeTalabatPackageJobState("nope"), null);
  assert.equal(normalizeTalabatPackageJobState({}), null, "no jobId → not a state");
  assert.equal(normalizeTalabatPackageJobState({ jobId: "" }), null);
});

// ── 5: no infinite loop is reachable, whatever the sync returns ──────────────

test("5: the stage always terminates — no [0,200) for ever, for any sync result", async () => {
  const store = new Map<string, Uint8Array>();
  const base = ctl();
  const { plan, state } = await toArchived(base, store);
  const legacy = () => normalizeTalabatPackageJobState(asLegacyState(state)) as TalabatPackageJobState;

  const stuck: TalabatJobAdvanceDeps = {
    ports: { async fetchImage() { return { bytes: JPEG, ext: "jpg" }; }, async putPart() {} },
    // a sync that never advances: the exact shape that looped in production
    async syncMappings() { return { ok: true, inserted: 0, updated: 0, failed: 0, totalCandidates: 1454, nextOffset: 0 }; },
    async recordAudit() { return true; },
    budget: { maxImages: 2 },
  };
  let s = legacy();
  let steps = 0;
  while (s.status === "running" && steps < 50) { s = await advanceTalabatPackageJob(s, plan, stuck); steps++; }
  assert.equal(s.status, "completed", "a non-advancing sync ENDS the stage instead of spinning");
  assert.ok(steps <= 3, `terminated promptly, took ${steps} steps`);

  // and a sync returning garbage totals also terminates
  const garbage: TalabatJobAdvanceDeps = {
    ...stuck,
    async syncMappings() {
      return { ok: true, inserted: 0, updated: 0, failed: 0 } as unknown as Awaited<ReturnType<NonNullable<TalabatJobAdvanceDeps["syncMappings"]>>>;
    },
  };
  let g = legacy();
  steps = 0;
  while (g.status === "running" && steps < 50) { g = await advanceTalabatPackageJob(g, plan, garbage); steps++; }
  assert.equal(g.status, "completed", "an unbounded/legacy sync result ends the stage too");
});

test("6: new jobs are unaffected — createInitialState still yields real numbers", () => {
  const { state } = makeJob();
  assert.equal(state.mappingCursor, 0);
  assert.equal(state.mappingTotal, null);
  assert.equal(mappingComplete(state), false, "a fresh job has mapping work to do");
  assert.deepEqual(normalizeTalabatPackageJobState(state), state, "normalization is a no-op for a fresh state");
});

// ── 7: the read boundary is the ONLY place state is loaded ──────────────────

test("7: every server state read is normalized — none bypasses the boundary", () => {
  const server = code(SERVER);
  assert.match(server, /async function readState\(jobId: string\)/);
  assert.match(server, /normalizeTalabatPackageJobState\(await getJson<unknown>\(statePath\(jobId\)\)\)/);
  // no raw typed read of state.json survives anywhere
  assert.equal(/getJson<TalabatPackageJobState>/.test(server), false,
    "no state read bypasses normalizeTalabatPackageJobState");
  assert.ok(server.split("await readState(").length - 1 >= 6,
    "all state read sites go through readState");
});

test("8: counter() is the one coercion helper and is exported for reuse", () => {
  assert.equal(counter(5), 5);
  assert.equal(counter(0), 0);
  assert.equal(counter(-1), null);
  assert.equal(counter(NaN), null);
  assert.equal(counter(Infinity), null);
  assert.equal(counter("5"), null);
  assert.equal(counter(undefined), null);
  assert.equal(counter(null), null);
  assert.equal(counter(9.9), 9);
});

// ── 9: nothing else changed ──────────────────────────────────────────────────

test("9: no schema change, no migration, no marketplace write, no email", () => {
  const server = code(SERVER);
  assert.equal(/talabat_package_jobs\s*\(/.test(server), false, "no DDL in the server layer");
  assert.equal(/sendMail|nodemailer|smtp/i.test(server), false, "nothing is emailed");
  assert.equal(/from\("products"\)[\s\S]{0,80}\.(update|insert|upsert|delete)\(/.test(server), false,
    "no canonical product write");
  const engine = code("lib/export/talabat/package-job.ts");
  assert.equal(/resolveTalabatSellingPrice|resolveTalabatCategory|resolveTalabatBarcode/.test(engine), false,
    "the engine still re-derives no pricing/category/barcode rule");
});
