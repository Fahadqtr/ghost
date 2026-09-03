// RAFEEQ DIRECT SEND — engine tests (owner proofs 5–9, 11, 14–15).
// Pure: planning gates (provider/recipients/size), send-then-audit ordering,
// provider-failure isolation, and exact stored-artifact entry extraction.
// node --conditions=react-server --experimental-strip-types --test lib/export/rafeeq/email-send.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import {
  planRafeeqEmailSend,
  runRafeeqEmailSend,
  extractLeadingZipEntries,
  rafeeqSendErrorMessageAr,
  type RafeeqEmailSendPlanInput,
  type RafeeqEmailAuditRecord,
} from "./email-send.ts";
import { readMailConfig, validateRecipients, estimateEncodedBytes } from "../../mail/config.ts";
import { zipEntrySegment, zipDirectorySegment } from "../../net/zip.ts";

function input(over: Partial<RafeeqEmailSendPlanInput> = {}): RafeeqEmailSendPlanInput {
  return {
    configured: true,
    toRaw: "rafeeq@example.com",
    ccRaw: "",
    subject: "Malikas Universe — Full Catalog Package (137 products) — rafeeq-full.zip",
    html: "<div>body</div>",
    text: "body",
    attachments: [
      { filename: "rafeeq_catalog.xlsx", bytes: 250_000, contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
      { filename: "manifest.json", bytes: 4_000, contentType: "application/json" },
    ],
    attachmentMaxBytes: 20 * 1024 * 1024,
    draftBlockers: [],
    ...over,
  };
}

test("9: no send is even PLANNABLE without a configured provider", () => {
  const r = planRafeeqEmailSend(input({ configured: false }));
  assert.deepEqual(r, { ok: false, error: "mail_not_configured" });
  assert.equal(readMailConfig({}), null, "empty env → not configured");
  assert.equal(readMailConfig({ MAIL_HOST: "smtp.example", MAIL_USERNAME: "u" }), null, "partial env → not configured (never guessed)");
  const full = readMailConfig({
    MAIL_HOST: "smtp.example",
    MAIL_USERNAME: "u",
    MAIL_PASSWORD: "p",
    MAIL_FROM_ADDRESS: "from@example.com",
  });
  assert.ok(full && full.port === 465 && full.secure, "full env configures (defaults: implicit TLS 465)");
});

test("7: invalid or missing recipients block the send", () => {
  assert.equal(planRafeeqEmailSend(input({ toRaw: "" })).ok, false, "empty To blocked");
  const bad = planRafeeqEmailSend(input({ toRaw: "not-an-email" }));
  assert.ok(!bad.ok && bad.error === "invalid_recipient");
  const badCc = planRafeeqEmailSend(input({ ccRaw: "broken@@x" }));
  assert.ok(!badCc.ok && badCc.error === "invalid_recipient", "invalid CC blocks too");
  const multi = validateRecipients("a@example.com, b@example.com; c@example.com", "d@example.com");
  assert.ok(multi.ok && multi.to.length === 3 && multi.cc.length === 1, "comma/semicolon-separated recipients parse");
  assert.equal(planRafeeqEmailSend(input()).ok, true, "valid recipients pass");
});

test("8: an attachment set over the configured cap blocks the send — never a silent partial set", () => {
  const over = planRafeeqEmailSend(input({
    attachments: [{ filename: "rafeeq-full.zip", bytes: 30 * 1024 * 1024, contentType: "application/zip" }],
  }));
  assert.ok(!over.ok && over.error === "attachments_too_large");
  assert.equal(rafeeqSendErrorMessageAr("attachments_too_large"), "الحزمة أكبر من الحد المسموح للإرسال عبر البريد.");
  const under = planRafeeqEmailSend(input());
  assert.ok(under.ok && under.plan.totalAttachmentBytes === 254_000, "small set passes with exact totals");
  assert.ok(under.ok && under.plan.encodedEstimateBytes > under.plan.totalAttachmentBytes, "encoded estimate accounts for base64 inflation");
  assert.ok(estimateEncodedBytes([57]) >= 78, "base64 line inflation modeled");
  assert.equal(planRafeeqEmailSend(input({ attachments: [] })).ok, false, "no attachments → blocked");
});

test("14: the audit record is written ONLY AFTER a successful provider response, with the exact send facts", async () => {
  const planned = planRafeeqEmailSend(input({ ccRaw: "cc@example.com" }));
  assert.ok(planned.ok);
  const calls: string[] = [];
  let audit: RafeeqEmailAuditRecord | null = null;
  const result = await runRafeeqEmailSend(
    planned.plan,
    { jobId: "job-1", packageId: "pkg-1", sender: "from@example.com", sentAtIso: "2026-08-26T12:00:00.000Z" },
    {
      send: async () => { calls.push("send"); return { ok: true, messageId: "<mid@smtp>" }; },
      recordAudit: async (r) => { calls.push("audit"); audit = r; return true; },
    },
  );
  assert.deepEqual(calls, ["send", "audit"], "provider FIRST, audit second");
  assert.ok(result.ok && result.messageId === "<mid@smtp>" && result.auditRecorded);
  const a = audit!;
  assert.equal(a.jobId, "job-1");
  assert.equal(a.packageId, "pkg-1");
  assert.deepEqual(a.recipients, ["rafeeq@example.com"]);
  assert.deepEqual(a.cc, ["cc@example.com"]);
  assert.equal(a.providerMessageId, "<mid@smtp>");
  assert.deepEqual(a.attachmentFilenames, ["rafeeq_catalog.xlsx", "manifest.json"]);
  assert.equal(a.status, "sent");
});

test("15: a provider failure records NOTHING and reports honestly", async () => {
  const planned = planRafeeqEmailSend(input());
  assert.ok(planned.ok);
  let auditCalls = 0;
  const result = await runRafeeqEmailSend(
    planned.plan,
    { jobId: "job-1", packageId: null, sender: "from@example.com", sentAtIso: "2026-08-26T12:00:00.000Z" },
    {
      send: async () => ({ ok: false, detail: "connection refused" }),
      recordAudit: async () => { auditCalls++; return true; },
    },
  );
  assert.deepEqual(result, { ok: false, error: "send_failed", detail: "connection refused" });
  assert.equal(auditCalls, 0, "no audit row on provider failure — state unchanged");
});

test("11: workbook + manifest are extracted EXACTLY from the stored tail part — no rebuild, byte-identical", () => {
  // simulate the job finalize tail: xlsx entry + manifest entry + directory.
  const xlsxBytes = new Uint8Array(1200).map((_, i) => (i * 13) % 256);
  const manifestBytes = new TextEncoder().encode(JSON.stringify({ package_fingerprint: "abc" }));
  const xlsxSeg = zipEntrySegment("rafeeq_catalog.xlsx", xlsxBytes);
  const manifestSeg = zipEntrySegment("manifest.json", manifestBytes);
  const directory = zipDirectorySegment([
    { name: "rafeeq_catalog.xlsx", crc: xlsxSeg.crc, size: xlsxSeg.size, offset: 0 },
    { name: "manifest.json", crc: manifestSeg.crc, size: manifestSeg.size, offset: xlsxSeg.bytes.length },
  ]);
  const tail = new Uint8Array(xlsxSeg.bytes.length + manifestSeg.bytes.length + directory.length);
  tail.set(xlsxSeg.bytes, 0);
  tail.set(manifestSeg.bytes, xlsxSeg.bytes.length);
  tail.set(directory, xlsxSeg.bytes.length + manifestSeg.bytes.length);

  const entries = extractLeadingZipEntries(tail);
  assert.deepEqual(entries.map((e) => e.filename), ["rafeeq_catalog.xlsx", "manifest.json"], "exactly the two tail entries, stopping at the directory");
  assert.deepEqual(entries[0].bytes, xlsxBytes, "workbook bytes are byte-identical to what was packaged");
  assert.deepEqual(entries[1].bytes, manifestBytes, "manifest bytes are byte-identical");
  assert.deepEqual(extractLeadingZipEntries(new Uint8Array([1, 2, 3])), [], "garbage input yields nothing — never fabricated");
});
