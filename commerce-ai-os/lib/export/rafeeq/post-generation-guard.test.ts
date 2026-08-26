// RAFEEQ POST-GENERATION UX — architecture guard (source scan). Proves the
// owner's safety rules at the seams node:test cannot execute:
//   • 16: the download-last actions NEVER start a job or regenerate — they are
//     plain links to the existing streamed-download route of a finished job;
//   • 21: that route streams stored parts (re-asserted here for the new use);
//   • 22: the new server lookups are READ-ONLY — no insert/update/upsert/
//     delete/upload against package history, jobs, sent state or storage;
//   • 23: the email endpoint is GET-only, writer-gated, JSON-only, and NO
//     send path exists anywhere in the new modules;
//   • 14: the UI's fallback is clipboard copy (Gmail integration does not
//     exist and is stated as unavailable) and the HTML preview renders in a
//     fully sandboxed iframe via srcDoc — never dangerouslySetInnerHTML;
//   • 25: the no-completed-artifact state renders the exact required message.
// node --conditions=react-server --experimental-strip-types --test lib/export/rafeeq/post-generation-guard.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

const UI = "components/v2/export/RafeeqFullSync.tsx";
const SERVER = "lib/rafeeq/package-job.server.ts";
const EMAIL_ROUTE = "app/api/export/rafeeq/package/jobs/[jobId]/email/route.ts";
const DOWNLOAD_ROUTE = "app/api/export/rafeeq/package/jobs/[jobId]/download/route.ts";
const EMAIL_MODULE = "lib/export/rafeeq/email-draft.ts";
const SELECTION_MODULE = "lib/export/rafeeq/artifact-selection.ts";
const PAGE = "app/(v2)/v2/export/[destination]/page.tsx";

function slice(src: string, from: string, to?: string): string {
  const a = src.indexOf(from);
  assert.ok(a >= 0, `marker present: ${from}`);
  if (!to) return src.slice(a);
  const b = src.indexOf(to, a);
  assert.ok(b > a, `marker present: ${to}`);
  return src.slice(a, b);
}

test("16: DownloadLast is a plain link to the finished job's download route — it can never start a job or regenerate", () => {
  const ui = read(UI);
  const dl = slice(ui, "function DownloadLast", "function RafeeqEmailSection");
  assert.ok(dl.includes("rafeeqJobDownloadUrl(artifact.jobId)"), "href targets the existing streamed download of the COMPLETED job");
  assert.ok(dl.includes("download={artifact.filename}"), "browser download of the stored artifact");
  for (const bad of ["fetch(", "driveRafeeqPackageJob", 'method: "POST"', "package/jobs\"", "generate("]) {
    assert.ok(!dl.includes(bad), `DownloadLast performs no request and no job start (${bad})`);
  }
  // the server lookup feeding it is the read-only artifact getter, not a job starter
  const page = read(PAGE);
  assert.ok(page.includes("getLatestCompletedRafeeqArtifact"), "page wires the read-only lookup");
  assert.ok(!page.includes("startRafeeqPackageJob"), "the page never starts a job server-side");
});

test("21: the download route the links point at streams stored parts — no rebuild, no whole-archive buffer", () => {
  const s = read(DOWNLOAD_ROUTE);
  assert.ok(s.includes("new ReadableStream"), "streamed response");
  assert.ok(s.includes("readRafeeqPackagePart"), "served from the stored parts");
  assert.ok(!s.includes("advanceRafeeqPackageJob") && !s.includes("createRafeeqPackageJob"), "downloading never advances or creates a job");
});

test("22: the new server lookup + email sections are READ-ONLY — no writes to jobs, package history, sent state or storage", () => {
  const server = read(SERVER);
  const section = slice(server, "DOWNLOAD LAST COMPLETED PACKAGE");
  for (const bad of [".insert(", ".update(", ".upsert(", ".delete(", ".upload(", ".remove(", ".rpc("]) {
    assert.ok(!section.includes(bad), `read-only sections perform no write (${bad})`);
  }
  assert.ok(section.includes('.select("output_filename, superseded_at")'), "correction context is read, never written");
  assert.ok(!/\.(update|insert|upsert)\(\s*\{[\s\S]{0,200}?sent_at/.test(section), "sent_at is never written by these sections");
  assert.ok(section.includes("selectDownloadCandidates"), "selection semantics come from the tested pure module");
});

test("23: the email endpoint is GET-only, writer-gated, JSON-only — and no send path exists in any new module", () => {
  const route = read(EMAIL_ROUTE);
  assert.ok(route.includes("export async function GET"), "GET is the only handler");
  assert.ok(!/export async function (POST|PUT|PATCH|DELETE)/.test(route), "no mutating handler");
  assert.ok(route.includes("requireMalakWriter"), "writer boundary enforced");
  assert.ok(route.includes('"Content-Type": "application/json"'), "structured JSON only");
  const server = read(SERVER);
  for (const rel of [EMAIL_ROUTE, EMAIL_MODULE, SELECTION_MODULE, UI]) {
    const s = read(rel).toLowerCase();
    for (const bad of ["nodemailer", "sendgrid", "createtransport", "smtp", "mailto:", "gmail.send", "sendemail", "send_message"]) {
      assert.ok(!s.includes(bad), `${rel} contains no send path (${bad})`);
    }
  }
  assert.ok(!server.toLowerCase().includes("nodemailer") && !server.toLowerCase().includes("createtransport"), "server layer has no mailer");
});

test("14: clipboard copy is the stated fallback (no Gmail integration) and the preview iframe is fully sandboxed", () => {
  const ui = read(UI);
  assert.ok(ui.includes("navigator.clipboard.writeText"), "copy actions use the clipboard");
  const section = slice(ui, "function RafeeqEmailSection");
  assert.ok(section.includes("لن يُرسل أي إيميل تلقائياً"), "the no-auto-send statement is on screen");
  assert.ok(section.includes("إنشاء مسودة Gmail غير"), "Gmail-draft unavailability is stated, with copy as the fallback");
  assert.ok(section.includes('sandbox=""') && section.includes("srcDoc={draft.html}"), "HTML preview = sandboxed iframe via srcDoc");
  assert.ok(!ui.includes("dangerouslySetInnerHTML={"), "draft HTML is never injected into the page DOM");
});

test("25: the empty state renders the exact required disabled message", () => {
  const ui = read(UI);
  const dl = slice(ui, "function DownloadLast", "function RafeeqEmailSection");
  assert.ok(dl.includes("لا توجد حزمة مكتملة جاهزة للتنزيل"), "required Arabic message");
  assert.ok(dl.includes("disabled"), "the action is disabled, not hidden");
});
