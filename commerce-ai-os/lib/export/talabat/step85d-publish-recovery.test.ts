// STEP 85D — a FAILED publish must not hide the package that is ready to publish.
//
// The Email B image job for the current comparison finished: 622 images were
// fetched and written to durable parts. Publishing them (streaming the parts
// into the email-artifact path) then failed with `upload_incomplete` — a
// RECOVERABLE error whose whole point is that the images survive.
//
// The server agreed: `stageTalabatDeltaImagePackage` never writes job state, so
// `findStageableDeltaImageJob` kept offering the job. The SCREEN did not. Its
// "تجهيز حزمة الصور" handler returned on the stage failure without re-reading
// the card, so the status still held the snapshot taken on mount — from BEFORE
// the job existed — where `readyJob` was null and the "نشر الحزمة الجاهزة"
// button therefore did not exist. A resumable failure looked like a dead end,
// and the only visible button offered to download 622 photographs again.
//
// The fix is one rule: re-read the card after EVERY attempt, including a failed
// one, without ever overwriting the failure message the owner needs to read.
//
// Rendering is asserted by source scan: the runner uses --conditions=react-server,
// under which react-dom/server refuses to load, so a client component cannot be
// rendered to markup here (the STEP 71/73 idiom).
//
// node --conditions=react-server --experimental-strip-types --test lib/export/talabat/step85d-publish-recovery.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = join(fileURLToPath(new URL(".", import.meta.url)));
const APP_ROOT = join(HERE, "../../..");
const raw = (rel: string): string => readFileSync(join(APP_ROOT, rel), "utf8");
const code = (rel: string): string =>
  raw(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const UI = "app/(v2)/v2/operations/channels/talabat-email/ImagePackage.tsx";
const JOBS = "lib/talabat/package-job.server.ts";
const WORKFLOW = "lib/talabat/email-workflow.server.ts";

/** The body of one arrow-function handler, from its name to the closing `};`. */
const handler = (src: string, name: string): string => {
  const at = src.indexOf(`const ${name} =`);
  assert.notEqual(at, -1, `${name} exists`);
  const end = src.indexOf("\n  };", at);
  assert.notEqual(end, -1, `${name} is a complete handler`);
  return src.slice(at, end);
};

// ── the screen: refresh after every attempt ─────────────────────────────────

test("1: a quiet refresh exists that reads status and never sets an error", () => {
  const ui = code(UI);
  const at = ui.indexOf("const refreshStatusQuietly");
  assert.notEqual(at, -1, "the quiet refresh exists");
  const body = ui.slice(at, ui.indexOf("}, [fetchStatus]);", at));
  assert.match(body, /setStatus\(got\.value\)/, "it applies the fresh status");
  assert.equal(/setError/.test(body), false,
    "it never touches the error — the stage failure stays on screen");
});

test("2: publishReady refreshes in `finally`, so a failed publish still re-reads", () => {
  const body = handler(code(UI), "publishReady");
  const fin = body.slice(body.indexOf("} finally {"));
  assert.match(fin, /await refreshStatusQuietly\(\)/, "refreshed on every path");
});

test("3: run() refreshes in `finally` too — this is the case that hid the button", () => {
  const body = handler(code(UI), "run");
  const fin = body.slice(body.indexOf("} finally {"));
  assert.match(fin, /await refreshStatusQuietly\(\)/, "refreshed on every path");
});

test("4: neither handler refreshes ONLY on the success path any more", () => {
  const ui = code(UI);
  for (const name of ["publishReady", "run"]) {
    const body = handler(ui, name);
    const tryPart = body.slice(0, body.indexOf("} finally {"));
    assert.equal(/await loadStatus\(\)/.test(tryPart), false,
      `${name} no longer refreshes only when the stage succeeded`);
  }
});

test("5: every early return in the stage-failure path now still hits the refresh", () => {
  const ui = code(UI);
  for (const name of ["publishReady", "run"]) {
    const body = handler(ui, name);
    // the failure branch returns…
    assert.match(body, /if \(!staged\.ok\) \{[\s\S]*?return;\s*\}/, `${name} returns on a failed stage`);
    // …and `finally` runs regardless, which is exactly why the refresh lives there.
    const fin = body.slice(body.indexOf("} finally {"));
    assert.match(fin, /refreshStatusQuietly/, `${name} refreshes despite the early return`);
  }
});

test("6: the manual refresh button still uses loadStatus (errors stay visible there)", () => {
  const ui = code(UI);
  assert.match(ui, /onClick=\{\(\) => void loadStatus\(\)\}/, "the refresh button is unchanged");
});

// ── the recovery affordance itself is unchanged ─────────────────────────────

test("7: the ready-job banner and publish button still render from status.readyJob", () => {
  const ui = code(UI);
  assert.match(ui, /status\?\.readyJob \? \(/, "the banner is gated on readyJob");
  assert.match(ui, /onClick=\{\(\) => void publishReady\(status\.readyJob!\.jobId\)\}/,
    "the publish button publishes the discovered job");
  assert.match(ui, /نشر الحزمة الجاهزة/, "the owner-facing label is unchanged");
});

test("8: publishing stays the primary action and re-preparing becomes secondary", () => {
  const ui = code(UI);
  const publishAt = ui.indexOf("publishReady(status.readyJob!.jobId)");
  const rerunAt = ui.indexOf("void run()");
  assert.ok(publishAt !== -1 && rerunAt !== -1 && publishAt < rerunAt,
    "publish is rendered BEFORE the button that would re-download the images");
  assert.match(ui, /status\?\.readyJob \? "border border-slate-300" : "bg-emerald-700 text-white"/,
    "re-preparing loses the primary styling while a ready package exists");
});

test("9: nothing here auto-publishes — the button remains the owner's action", () => {
  const ui = code(UI);
  const mount = ui.slice(ui.indexOf("useEffect("), ui.indexOf("const post ="));
  assert.equal(/publishReady|action: "stage"/.test(mount), false,
    "mount only reads status; it never stages");
});

// ── the server never made the job un-publishable ────────────────────────────

test("10: staging never writes job state, so a failed publish leaves the job stageable", () => {
  const jobs = code(JOBS);
  const at = jobs.indexOf("export async function stageTalabatDeltaImagePackage");
  assert.notEqual(at, -1);
  const body = jobs.slice(at, jobs.indexOf("\nexport async function findStageableDeltaImageJob"));
  assert.equal(/putObject\(statePath\(/.test(body), false,
    "the stage path never rewrites state.json");
  assert.equal(/\.delete\(|remove\(/.test(body), false, "it never deletes the parts either");
});

test("11: upload_incomplete is declared RECOVERABLE", () => {
  const errs = code("lib/export/talabat/package-job-errors.ts");
  assert.match(errs, /TALABAT_RECOVERABLE_ERROR_CODES[^=]*=\s*\[\s*"upload_incomplete"\s*\]/,
    "the code the owner saw is the recoverable one");
});

test("12: discovery is bound to the run fingerprint only — not to publish success", () => {
  const jobs = code(JOBS);
  const at = jobs.indexOf("export async function findStageableDeltaImageJob");
  const body = jobs.slice(at);
  assert.match(body, /binding\.runFingerprint !== runFingerprint/,
    "only a job built for THIS comparison is offered");
  assert.match(body, /st\.status !== "completed" \|\| !st\.artifact/,
    "the archive must exist");
  assert.equal(/staged|published|sidecar/i.test(body.slice(0, body.indexOf("\n}"))), false,
    "no publish-attempt marker can suppress the offer");
});

test("13: the card looks for a recoverable job whenever the published one is unusable", () => {
  const wf = code(WORKFLOW);
  assert.match(wf, /const readyJob = ready \? null : await findStageableDeltaImageJob\(delta\.fingerprint, imagePlan\)/,
    "a stale published package does not mask the current ready job");
});

// ── blast radius ────────────────────────────────────────────────────────────

test("14: this change sends no mail and writes no catalog data", () => {
  const ui = code(UI);
  for (const forbidden of ["sendMail", "smtp", "official", "lifecycle_state", "from(\"products\")"]) {
    assert.equal(ui.includes(forbidden), false, `the screen never mentions ${forbidden}`);
  }
});

test("15: the authenticity hold is untouched by this step", () => {
  const policy = code("lib/export/talabat/category-policy.ts");
  const list = policy.slice(policy.indexOf("TALABAT_AUTHENTICITY_HOLD:"),
    policy.indexOf("TALABAT_AUTHENTICITY_HOLD_REASON"));
  for (const sku of ["mk1127", "mk1128", "mk1111", "mk1129", "mk922", "mk923", "mk2321",
    "mk924", "mk2088", "mk2086", "mk1999", "mk2000", "mk2001"]) {
    assert.ok(list.includes(`"${sku}"`), `${sku} still held`);
  }
  assert.equal((list.match(/"mk\d+"/g) ?? []).length, 13, "still exactly 13 SKUs");
});
