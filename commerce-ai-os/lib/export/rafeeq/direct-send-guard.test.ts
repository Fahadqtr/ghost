// RAFEEQ DIRECT SEND + MOBILE COPY — architecture guard (source scan).
// Proves the owner's safety rules at the seams node:test cannot execute:
//   • 3:  the HTML preview stays a RENDERED preview (sandboxed iframe srcDoc)
//         and the primary copy action is the MOBILE-SAFE text — the raw-HTML
//         copy is a clearly-labeled developer action under an advanced menu;
//   • 5:  the send path can never regenerate a package — no generation entry
//         point is reachable from the send server/route;
//   • 6:  sending requires the owner's explicit «إرسال الآن» confirmation in
//         a modal (the POST exists only behind it) and the route is
//         owner-gated on both GET and POST;
//   • 10: no credential of any kind exists in source — SMTP settings come
//         from environment variables only;
//   • 12: direct email send NEVER marks the Rafeeq SENT baseline — the send
//         layer cannot touch rafeeq_packages at all;
//   • the audit migration is additive-only.
// node --conditions=react-server --experimental-strip-types --test lib/export/rafeeq/direct-send-guard.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

const UI = "components/v2/export/RafeeqFullSync.tsx";
const SEND_SERVER = "lib/rafeeq/email-send.server.ts";
const SEND_ROUTE = "app/api/export/rafeeq/package/jobs/[jobId]/send/route.ts";
const SEND_ENGINE = "lib/export/rafeeq/email-send.ts";
const MAIL_CONFIG = "lib/mail/config.ts";
const SMTP = "lib/mail/smtp.server.ts";
const MIGRATION = "supabase/migrations/20260827000000_rafeeq_email_deliveries.sql";

function slice(src: string, from: string, to?: string): string {
  const a = src.indexOf(from);
  assert.ok(a >= 0, `marker present: ${from}`);
  if (!to) return src.slice(a);
  const b = src.indexOf(to, a);
  assert.ok(b > a, `marker present: ${to}`);
  return src.slice(a, b);
}

test("3: HTML preview stays rendered (sandboxed iframe) and «نسخ للإيميل» copies the mobile-safe text — raw HTML is a developer action only", () => {
  const ui = read(UI);
  const section = slice(ui, "function RafeeqEmailSection", "function RafeeqSendModal");
  assert.ok(section.includes('sandbox=""') && section.includes("srcDoc={draft.html}"), "preview = fully sandboxed iframe via srcDoc");
  assert.ok(!ui.includes("dangerouslySetInnerHTML={"), "draft HTML never injected into the page DOM");
  assert.ok(/copyBtn\("textEmail", draft\.textEmail, "نسخ للإيميل", true\)/.test(section), "«نسخ للإيميل» copies draft.textEmail (primary action)");
  assert.ok(section.includes('copyBtn("subject", draft.subject, "نسخ الموضوع")'), "separate «نسخ الموضوع»");
  assert.ok(section.includes("فتح المعاينة"), "«فتح المعاينة» toggle");
  assert.ok(section.includes("تنزيل الملفات"), "«تنزيل الملفات» action");
  const advanced = slice(section, "<details>", "</details>");
  assert.ok(advanced.includes("نسخ HTML للمطور"), "raw-HTML copy is hidden under the advanced menu and labeled for developers");
  assert.ok(!section.replace(advanced, "").includes("draft.html, \"نسخ HTML"), "no plain «نسخ HTML» outside the advanced menu");
});

test("5: the send path can never regenerate a package", () => {
  for (const rel of [SEND_SERVER, SEND_ROUTE, SEND_ENGINE]) {
    const s = read(rel);
    for (const bad of ["createRafeeqPackageJob", "advanceRafeeqPackageJob", "startRafeeqPackageJob", "stepRafeeqPackageJob", "generateRafeeq"]) {
      assert.ok(!s.includes(bad), `${rel} cannot reach generation (${bad})`);
    }
  }
  const s = read(SEND_SERVER);
  assert.ok(s.includes("getRafeeqPackageArtifact") && s.includes("readRafeeqPackagePart"), "attachments come from the SAME read-only stored-artifact references as download");
  assert.ok(!s.includes(".upload("), "the send layer writes nothing to storage");
});

test("6: sending requires explicit owner confirmation — POST only behind «إرسال الآن», owner gate on both methods", () => {
  const ui = read(UI);
  const modal = slice(ui, "function RafeeqSendModal");
  assert.ok(modal.includes("إرسال الآن"), "the confirm button exists");
  assert.ok(modal.includes("disabled={!canSend}"), "confirm is disabled until valid + configured");
  assert.ok(modal.includes('role="dialog"'), "a real confirmation modal");
  for (const shown of ["من", "الموضوع", "المرفقات", "إجمالي المرفقات"]) assert.ok(modal.includes(shown), `modal shows ${shown}`);
  const posts = ui.match(/method:\s*"POST"[\s\S]{0,120}?jobs\/\$\{jobId\}\/send/g) ?? ui.match(/jobs\/\$\{jobId\}\/send[\s\S]{0,200}?method:\s*"POST"/g) ?? [];
  assert.equal(posts.length, 1, "exactly ONE send POST in the UI — inside the modal's confirm handler");
  assert.ok(slice(modal, "async function confirmSend").includes('method: "POST"'), "and it lives in confirmSend");
  const route = read(SEND_ROUTE);
  assert.ok(/export async function GET[\s\S]*?requireOwner\(\)/.test(route), "GET is owner-gated");
  assert.ok(/export async function POST[\s\S]*?requireOwner\(\)/.test(route), "POST is owner-gated");
});

test("10: no credentials in source — environment variables only, and secrets never leave the server", () => {
  for (const rel of [MAIL_CONFIG, SMTP, SEND_SERVER, SEND_ROUTE, SEND_ENGINE]) {
    const s = read(rel);
    assert.ok(!/(smtp|mail)\.[a-z0-9-]+\.(com|net|qa|io)/i.test(s), `${rel} hardcodes no SMTP host`);
    assert.ok(!/password\s*[:=]\s*["'][^"']+["']/i.test(s), `${rel} hardcodes no password`);
    assert.ok(!/(api[_-]?key|token)\s*[:=]\s*["'][A-Za-z0-9]/i.test(s), `${rel} hardcodes no API key/token`);
  }
  const cfg = read(MAIL_CONFIG);
  for (const key of ["MAIL_HOST", "MAIL_PORT", "MAIL_SECURE", "MAIL_USERNAME", "MAIL_PASSWORD", "MAIL_FROM_NAME", "MAIL_FROM_ADDRESS", "EMAIL_ATTACHMENT_MAX_BYTES"]) {
    assert.ok(cfg.includes(`env.${key}`), `${key} is read from the environment`);
  }
  const smtp = read(SMTP);
  assert.ok(smtp.includes("process.env"), "server config comes from process.env");
  const server = read(SEND_SERVER);
  assert.ok(!server.includes("config.password") && !server.includes("username"), "orchestration never touches raw credentials");
  const preflight = slice(server, "getRafeeqEmailSendPreflight", "export interface RafeeqSendRequest");
  assert.ok(!preflight.includes("password"), "preflight DTO exposes no secret");
});

test("12: direct email send NEVER marks the Rafeeq SENT baseline — the send layer cannot touch rafeeq_packages", () => {
  const s = read(SEND_SERVER);
  assert.ok(!s.includes('from("rafeeq_packages")'), "no read/write of rafeeq_packages at all");
  assert.ok(!s.includes("markRafeeqPackageSent"), "the explicit owner mark-as-sent is unreachable from sending");
  assert.ok(!/\.(update|upsert)\(\s*\{[\s\S]{0,300}?sent_at/.test(s), "sent_at is never updated anywhere in the send layer");
  const inserts = s.match(/\.insert\(/g) ?? [];
  assert.equal(inserts.length, 1, "the ONLY insert is the delivery audit row");
  assert.ok(slice(s, "recordAudit").includes('from("rafeeq_email_deliveries")'), "and it targets rafeeq_email_deliveries");
  const ui = read(UI);
  assert.ok(slice(ui, "function RafeeqSendModal").includes("لا يغيّر حالة «تم الإرسال إلى رفيق»"), "the UI states the separation explicitly");
});

test("the runtime mail diagnostic lives ONLY behind the owner-gated preflight and carries booleans + variable NAMES, never values", () => {
  const server = read(SEND_SERVER);
  assert.ok(server.includes("diagnoseMailEnv(process.env"), "diagnostic reads the real runtime env");
  assert.ok(server.includes("blockingMailEnvNames"), "blocking variable NAMES are derived, not values");
  const preflight = slice(server, "getRafeeqEmailSendPreflight", "export interface RafeeqSendRequest");
  assert.ok(preflight.includes("diagnostic"), "diagnostic ships in the preflight DTO (owner-gated route)");
  for (const leak of ["config.host", "config.username", "config.password", "MAIL_PASSWORD"]) {
    assert.ok(!preflight.includes(leak), `preflight never touches ${leak}`);
  }
  const cfg = read(MAIL_CONFIG);
  const diag = slice(cfg, "export function diagnoseMailEnv");
  assert.ok(!/:\s*env\./.test(diag.split("mailConfigResolved")[0]), "no env value is ever assigned into the diagnostic output");
  const ui = read(UI);
  const modal = slice(ui, "function RafeeqSendModal");
  assert.ok(modal.includes("pf.blockingEnvNames") && modal.includes("pf.diagnostic"), "the modal shows names + booleans");
  assert.ok(!modal.includes("MAIL_PASSWORD"), "the UI hardcodes no secret-bearing lookups");
});

const LINK_SERVER = "lib/rafeeq/artifact-object.server.ts";
const LINK_ROUTE = "app/api/export/rafeeq/package/jobs/[jobId]/link/route.ts";

test("FAST LINK: the certified ZIP is NEVER attached to SMTP — delivery is the signed direct link, and a failed link blocks the send", () => {
  const s = read(SEND_SERVER);
  assert.ok(!s.includes("includeZip"), "the ZIP-attach pathway no longer exists");
  assert.ok(!s.includes('"application/zip"'), "no zip attachment part is ever constructed for SMTP");
  const send = slice(s, "export async function sendRafeeqPackageEmail");
  const linkAt = send.indexOf("createRafeeqPackageSignedLink");
  assert.ok(linkAt >= 0, "sending requires the signed link");
  assert.ok(linkAt < send.indexOf("buildRafeeqEmailDraftForJob"), "link is secured BEFORE the draft is built");
  assert.ok(linkAt < send.indexOf("runRafeeqEmailSend"), "…and before anything is transmitted");
  assert.ok(send.includes('sendErr("package_link_unavailable"'), "a missing/unverified stored object blocks the email outright");
  assert.ok(send.includes("downloadLink: { url: link.value.url"), "the sent email carries the signed URL");
});

test("FAST LINK: link generation is owner-only, reuses the certified stored artifact, and can never regenerate", () => {
  const route = read(LINK_ROUTE);
  assert.ok(/export async function POST[\s\S]*?requireOwner\(\)/.test(route), "the link route is OWNER-gated — non-owners cannot generate links");
  assert.ok(!/export async function (GET|PUT|PATCH|DELETE)/.test(route), "one deliberate endpoint");
  for (const rel of [LINK_SERVER, LINK_ROUTE]) {
    const s = read(rel);
    for (const bad of ["createRafeeqPackageJob", "advanceRafeeqPackageJob", "startRafeeqPackageJob", "stepRafeeqPackageJob", "generateRafeeq", "buildRafeeqPreview"]) {
      assert.ok(!s.includes(bad), `${rel} cannot reach generation (${bad})`);
    }
  }
  const server = read(LINK_SERVER);
  assert.ok(server.includes("readRafeeqPackagePart") && server.includes("getRafeeqPackageArtifact"), "assembly reads the SAME certified stored parts the download route serves");
  assert.ok(server.includes("createSignedUrl") && !server.includes("getPublicUrl"), "scoped SIGNED urls only — the private bucket is never exposed publicly");
  assert.ok(server.includes("download: meta.filename"), "Content-Disposition carries the certified filename");
  assert.ok(!server.includes('from("rafeeq_packages")') && !server.includes("sent_at"), "the link layer never touches package history / sent state");
  assert.ok(server.includes("artifactMetaMatches") && server.includes("statObject"), "existing metadata is reused only after size verification (idempotent, refresh-safe)");
});

test("FAST LINK: the direct download bypasses Vercel — the UI opens the signed storage URL, the streamed route stays for compatibility", () => {
  const ui = read(UI);
  assert.ok(ui.includes('window.open(body.url, "_blank", "noopener")'), "«تنزيل الحزمة» opens the signed URL straight from object storage");
  assert.ok(ui.includes("rafeeqJobDownloadUrl"), "the existing streamed download stays untouched for compatibility");
  for (const label of ["نسخ الرابط", "تحديث الرابط", "تنزيل الحزمة"]) assert.ok(ui.includes(label), `history action ${label}`);
  const modal = slice(ui, "function RafeeqSendModal");
  assert.ok(modal.includes("يُرسل عبر رابط تنزيل آمن"), "modal states the ZIP is link-delivered");
  assert.ok(modal.includes("pf.zipLink.sha256") && modal.includes("صلاحية رابط التنزيل"), "modal shows SHA-256 + link expiry");
  assert.ok(modal.includes("!!pf.zipLink"), "sending is disabled without a verified link");
});

test("the audit migration is additive-only and audits exactly one table", () => {
  const m = read(MIGRATION).replace(/--[^\n]*/g, "").toLowerCase();
  assert.ok(m.includes("create table if not exists public.rafeeq_email_deliveries"));
  assert.ok(!m.includes("drop table") && !/alter table (?!public\.rafeeq_email_deliveries)/.test(m), "nothing else is touched");
  assert.ok(!m.includes("rafeeq_packages"), "the audit table has no trigger/write into package history");
});
