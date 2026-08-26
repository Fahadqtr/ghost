// RAFEEQ.PKGJOB — architecture guard (source scan). Proves the generation
// failure fix holds at the seams node:test cannot execute (routes/UI/server):
//   • the legacy package route can never buffer the FULL/NEW archive again;
//   • the job routes are writer-gated and answer structured JSON only;
//   • the download route STREAMS stored parts (no whole-archive buffer);
//   • the job server layer performs no catalog/ECL/sent writes and records
//     package history only through the one sanctioned recorder;
//   • the UI never renders a raw response body (HTML error pages), shows the
//     fixed Arabic failure state with a reference id and a retry button;
//   • the migration is additive and does not auto-create package-history rows.
// node --conditions=react-server --experimental-strip-types --test lib/export/rafeeq/package-job-guard.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

const LEGACY_ROUTE = "app/api/export/rafeeq/package/route.ts";
const JOBS_ROUTE = "app/api/export/rafeeq/package/jobs/route.ts";
const JOB_ROUTE = "app/api/export/rafeeq/package/jobs/[jobId]/route.ts";
const DOWNLOAD_ROUTE = "app/api/export/rafeeq/package/jobs/[jobId]/download/route.ts";
const SERVER = "lib/rafeeq/package-job.server.ts";
const ENGINE = "lib/export/rafeeq/package-job.ts";
const UI = "components/v2/export/RafeeqFullSync.tsx";
const UI_LEGACY = "components/v2/export/RafeeqExport.tsx";
const MIGRATION = "supabase/migrations/20260826010000_rafeeq_package_jobs.sql";

test("the legacy route can never buffer the FULL/NEW archive again", () => {
  const s = read(LEGACY_ROUTE);
  assert.ok(!s.includes("generateRafeeqFullSyncPackage"), "the in-memory fullsync generator is unreachable from the route");
  assert.ok(s.includes('"use_jobs"'), "fullsync modes answer a structured JSON pointer to the job flow");
  assert.ok(s.includes("jobs_endpoint"), "the pointer names the jobs endpoint");
});

test("job routes are writer-gated and speak structured JSON only", () => {
  for (const rel of [JOBS_ROUTE, JOB_ROUTE, DOWNLOAD_ROUTE]) {
    const s = read(rel);
    assert.ok(s.includes("requireMalakWriter"), `${rel} enforces the writer boundary`);
    assert.ok(s.includes('"Content-Type": "application/json"'), `${rel} answers JSON errors`);
    assert.ok(!s.includes("res.text()"), `${rel} never forwards raw upstream text`);
  }
  const jobs = read(JOBS_ROUTE);
  assert.ok(jobs.includes("rafeeqJobErrorMessageAr"), "error codes map to the fixed Arabic messages");
});

test("the download route streams stored parts — never a whole-archive buffer", () => {
  const s = read(DOWNLOAD_ROUTE);
  assert.ok(s.includes("new ReadableStream"), "response body is a stream");
  assert.ok(s.includes("readRafeeqPackagePart"), "parts are fetched one at a time");
  assert.ok(s.includes('"Content-Length"'), "exact length from the job state");
  assert.ok(!s.includes("buildZip"), "no ZIP is built in the request");
  assert.ok(!/new Uint8Array\(\s*total/i.test(s), "parts are never concatenated into one buffer");
});

test("the engine step is bounded and the finalize records history exactly once", () => {
  const e = read(ENGINE);
  assert.ok(e.includes("JOB_STEP_MAX_PRODUCTS"), "bounded products per step");
  assert.ok(e.includes("JOB_STEP_MAX_PART_BYTES"), "bounded bytes per part");
  assert.ok(e.includes("state.packageRecorded === null"), "the history record is guarded to at most once per job");
  assert.ok(e.includes('if (stateIn.status !== "running") return stateIn;'), "complete/failed jobs are idempotent no-ops");
});

test("the job server layer performs no catalog/ECL/sent writes", () => {
  const s = read(SERVER);
  assert.ok(!s.includes('from("products")'), "never touches the products table");
  assert.ok(!s.includes("external_channel_listings"), "never touches ECL");
  // the post-generation lookups READ sent_at (download-last metadata display)
  // but nothing in the job layer ever WRITES it.
  assert.ok(!/\.(update|insert|upsert)\(\s*\{[\s\S]{0,300}?sent_at/.test(s), "never marks anything sent");
  assert.ok(!s.includes("markRafeeqPackageSent"), "the explicit owner mark-as-sent lives outside the job layer");
  assert.ok(s.includes("recordRafeeqPackage"), "history goes through the one sanctioned recorder");
  const inserts = s.match(/\.insert\(/g) ?? [];
  assert.equal(inserts.length, 1, "the only direct insert is the job bookkeeping row");
  assert.ok(s.includes('.eq("step", seen.step)'), "steps are claimed optimistically — concurrent drivers cannot double-advance");
});

test("the UI renders only fixed Arabic errors + refId + retry — never a raw body", () => {
  const s = read(UI);
  assert.ok(s.includes("driveRafeeqPackageJob"), "responses go through the shared client's safe JSON reader");
  assert.ok(s.includes("rafeeqJobErrorMessageAr"), "messages come from the fixed Arabic map");
  assert.ok(!/setError\([^)]*res\.text\(\)/.test(s), "a raw response body never reaches the error state");
  // the email preview renders in a fully sandboxed iframe via srcDoc — the
  // draft HTML is never injected into the page DOM.
  assert.ok(!s.includes("dangerouslySetInnerHTML={"), "nothing injects HTML");
  assert.ok(s.includes("إعادة المحاولة"), "a retry button is offered on failure");
  assert.ok(s.includes("errorRef"), "the short reference id is shown for log correlation");
  assert.ok(s.includes("package-job-client"), "generation drives the job flow via the shared client");
  const legacy = read(UI_LEGACY);
  assert.ok(!/setError\(\(await res\.text\(\)/.test(legacy), "the legacy export surface no longer echoes raw bodies either");
});

test("the migration is additive and never fabricates package history", () => {
  const m = read(MIGRATION);
  assert.ok(m.includes("create table if not exists public.rafeeq_package_jobs"));
  assert.ok(!m.toLowerCase().includes("drop table"), "up migration drops nothing");
  assert.ok(!/alter table (?!public\.rafeeq_package_jobs)/.test(m), "no existing table is altered");
  assert.ok(m.includes("insert into storage.buckets"), "the private artifact bucket is declared");
  assert.ok(m.includes("'rafeeq-packages', false"), "the bucket is private");
  assert.ok(!m.includes("rafeeq_packages ("), "package-history tables are untouched");
});

// ── owner rule: the Rafeeq page exposes EXACTLY TWO generation actions ───────
// (both on the FullSync card, both job-based; the INT.2D surface is
// preview/review-only and the legacy "توليد الحزمة" button no longer exists).

const CLIENT = "lib/export/rafeeq/package-job-client.ts";

test("the Rafeeq page exposes exactly TWO visible generation actions, both on the FullSync card", () => {
  const fullsync = read(UI);
  assert.ok(fullsync.includes("توليد كتالوج رفيق الكامل"), "action 1: the FULL catalog job");
  assert.ok(fullsync.includes("تحميل ملف المنتجات الجديدة"), "action 2: the NEW/pending products file");
  const generateCalls = fullsync.match(/generate\("(full|new)"\)/g) ?? [];
  assert.deepEqual([...new Set(generateCalls)].sort(), ['generate("full")', 'generate("new")'],
    "the FullSync card drives exactly the two generation kinds");
});

test("the legacy INT.2D surface is preview/review-only — no generate button, no generation fetch", () => {
  const s = read(UI_LEGACY);
  assert.ok(!s.includes("توليد الحزمة ("), "the legacy generate button is gone");
  assert.ok(!s.includes("fetch("), "the surface performs NO generation request at all");
  assert.ok(!s.includes("driveRafeeqPackageJob"), "no duplicate FULL-generation entry point");
  assert.ok(!s.includes("/api/export/rafeeq/package"), "no reference to any generation route");
  assert.ok(s.includes("خطة التصدير"), "the read-only export-plan overview remains");
  assert.ok(s.includes("REASON_LABEL"), "the blocked-reason review chips remain");
});

test("the legacy route refuses mode all toward the job flow (buffered full-catalog path unreachable)", () => {
  const s = read(LEGACY_ROUTE);
  assert.ok(/if \(mode === "all"\) \{/.test(s), "mode all (also the bodyless default) is refused");
  assert.ok((s.match(/"use_jobs"/g) ?? []).length >= 2, "fullsync modes AND mode all both answer use_jobs");
});

test("generation drives ONE shared job client — no duplicated job-driving logic", () => {
  const fullsync = read(UI);
  assert.ok(fullsync.includes('from "@/lib/export/rafeeq/package-job-client"'), "the FullSync card imports the shared client");
  assert.ok(!/async function readJobResponse/.test(fullsync), "no per-surface response reader");
  assert.ok(!/while \(status\.status === "running"\)/.test(fullsync), "no per-surface step loop");
  const client = read(CLIENT);
  assert.ok(/while \(status\.status === "running"\)/.test(client), "the step loop lives only in the shared client");
  assert.ok(/\/api\/export\/rafeeq\/package\/jobs/.test(client), "the client drives the job endpoints");
});
