// STEP 57 — the Rafeeq email carries EXACTLY two MIME attachments. Owner proofs:
//   1  exactly 2: rafeeq_catalog.xlsx + Rafeeq-Options-Reading-Guide.png;
//   2  manifest.json is NOT attached to the email — and is NOT removed from
//      the package: it stays in the certified ZIP and reaches Rafeeq by link;
//   3  the ZIP itself remains secure-link-only;
//   4  the exclusion cannot be bypassed — both email paths share one loader;
//   5  the recipient stays MANUAL (no app_settings default is written) while
//      the placeholder / reserved-domain gates still block a bad address.
// node --conditions=react-server --experimental-strip-types --test lib/export/rafeeq/step57-two-attachments.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildRafeeqEmailDraft, RAFEEQ_GUIDE_PNG, type RafeeqEmailContext } from "./email-draft.ts";
import { planRafeeqEmailSend, extractLeadingZipEntries } from "./email-send.ts";
import { validateRecipients } from "../../mail/config.ts";
import { zipEntrySegment, zipDirectorySegment } from "../../net/zip.ts";

const HERE = join(fileURLToPath(new URL(".", import.meta.url)));
const APP_ROOT = join(HERE, "../../..");
const src = (rel: string): string => readFileSync(join(APP_ROOT, rel), "utf8");
const SEND_SERVER = src("lib/rafeeq/email-send.server.ts");
/** strip comments — "never writes X" must be about CODE, not prose about X. */
const code = (t: string): string => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const SEND_CODE = code(SEND_SERVER);

const GUIDE_BYTES = statSync(join(APP_ROOT, "public", RAFEEQ_GUIDE_PNG)).size;

const ctx = (over: Partial<RafeeqEmailContext> = {}): RafeeqEmailContext => ({
  mode: "FULL",
  filename: "rafeeq-full-2026-09-03.zip",
  generatedAt: "2026-09-03T10:51:10.188Z",
  productCount: 1343,
  physicalRowCount: 1454,
  productsWithOptions: 51,
  optionCount: 162,
  imageCount: 1343,
  warningCount: 0,
  zipBytes: 369_281_422,
  packageFingerprint: "03a327da9235fb40",
  correction: true,
  nowIso: "2026-09-03T16:00:00.000Z",
  downloadLink: {
    url: "https://storage.example/o/pkg?token=sig",
    expiresAtIso: "2026-09-10T16:00:00.000Z",
    filename: "rafeeq-full-2026-09-03.zip",
  },
  ...over,
});

/** The real email set the server now builds: workbook (from the ZIP) + guide. */
const REAL_SET = [
  { filename: "rafeeq_catalog.xlsx", bytes: 912_345, contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
  { filename: RAFEEQ_GUIDE_PNG, bytes: GUIDE_BYTES, contentType: "image/png" },
];

test("1: EXACTLY two attachments — the workbook and the reading guide", () => {
  const plan = planRafeeqEmailSend({
    configured: true,
    toRaw: "orders@rafeeq.qa",
    ccRaw: "",
    subject: "s",
    html: "<p>b</p>",
    text: "b",
    attachments: REAL_SET,
    attachmentMaxBytes: 20 * 1024 * 1024,
    draftBlockers: [],
  });
  assert.ok(plan.ok, "the two-part set plans");
  assert.equal(plan.plan.attachments.length, 2, "ACTUAL_MIME_ATTACHMENTS = 2");
  assert.deepEqual(
    plan.plan.attachments.map((a) => a.filename),
    ["rafeeq_catalog.xlsx", RAFEEQ_GUIDE_PNG],
    "exactly the two approved filenames, in order",
  );
  // and the audit will record exactly those two
  assert.deepEqual(plan.plan.attachments.map((a) => a.filename).filter((f) => f.endsWith(".json")), [], "no JSON part");
});

test("2: manifest.json is excluded from the EMAIL but NOT from the package", () => {
  // the email loader keeps only the workbook out of the tail entries
  assert.ok(SEND_SERVER.includes('.filter((e) => e.filename.endsWith(".xlsx"))'), "only the workbook is taken for email");
  assert.ok(!SEND_SERVER.includes('"application/json"'), "no JSON attachment is constructed any more");
  assert.ok(SEND_SERVER.includes("manifest.json` is deliberately NOT"), "the exclusion is documented as deliberate");
  assert.ok(SEND_SERVER.includes("remains inside"), "documented: the manifest stays in the ZIP");

  // the PACKAGE is untouched: the ZIP still contains manifest.json, and the
  // low-level extractor still sees it — we simply do not attach it.
  const xlsx = new TextEncoder().encode("workbook");
  const manifest = new TextEncoder().encode('{"ok":true}');
  const xlsxSeg = zipEntrySegment("rafeeq_catalog.xlsx", xlsx);
  const manifestSeg = zipEntrySegment("manifest.json", manifest);
  const dir = zipDirectorySegment([
    { name: "rafeeq_catalog.xlsx", crc: xlsxSeg.crc, size: xlsxSeg.size, offset: 0 },
    { name: "manifest.json", crc: manifestSeg.crc, size: manifestSeg.size, offset: xlsxSeg.bytes.length },
  ]);
  const tail = new Uint8Array([...xlsxSeg.bytes, ...manifestSeg.bytes, ...dir]);
  const entries = extractLeadingZipEntries(tail).map((e) => e.filename);
  assert.deepEqual(entries, ["rafeeq_catalog.xlsx", "manifest.json"], "the package still carries the manifest");

  // nothing in the send path deletes or rewrites stored package objects
  for (const bad of [".remove(", ".upload(", "recordRafeeqPackage"]) {
    assert.ok(!SEND_CODE.includes(bad), `the send path never mutates package storage (${bad})`);
  }
  // and it never marks the Rafeeq SENT baseline: the only sent_at written is
  // the DELIVERY AUDIT row's own column, not rafeeq_packages.sent_at.
  assert.ok(!SEND_CODE.includes('from("rafeeq_packages")'), "rafeeq_packages is never written by the send");
  const sentAtLine = SEND_CODE.split("\n").filter((l) => l.includes("sent_at"));
  assert.equal(sentAtLine.length, 1, "exactly one sent_at write");
  assert.ok(sentAtLine[0].includes("record.sentAtIso"), "it is the audit record's timestamp");
  assert.ok(SEND_CODE.includes('from("rafeeq_email_deliveries").insert('), "written into the delivery audit table");
});

test("3: the ZIP is still secure-link-only", () => {
  const d = buildRafeeqEmailDraft(ctx());
  const zipEntry = d.attachments.find((a) => a.includes(".zip"));
  assert.ok(zipEntry?.includes("secure download link — not attached"), `ZIP link-delivered: ${zipEntry}`);
  assert.ok(!REAL_SET.some((a) => a.filename.endsWith(".zip")), "no ZIP part in the real set");
  assert.ok(SEND_SERVER.includes("The certified ZIP is NEVER attached"), "invariant documented");
  assert.ok(SEND_SERVER.includes('return sendErr("package_link_unavailable"'), "no link ⇒ no send");
  assert.equal(d.blockers.includes("missing_download_link"), false, "a valid link clears the blocker");
});

test("4: the exclusion cannot be bypassed — both email paths share one loader", () => {
  const calls = (SEND_SERVER.match(/loadTailAttachments\(artifact\.value\.parts\)/g) ?? []).length;
  assert.equal(calls, 2, "the preflight and the send both go through the same loader");
  assert.equal((SEND_SERVER.match(/^async function loadTailAttachments/gm) ?? []).length, 1, "exactly one loader");
  // the preflight reports what actually ships
  assert.ok(SEND_SERVER.includes('kind: "xlsx" as const'), "tail entries are all workbook now");
  assert.ok(SEND_SERVER.includes('kind: "guide" as const'), "the guide is shown in the preflight");
  assert.ok(!SEND_SERVER.includes('"manifest" as const'), "no manifest kind is produced");
  // the client VM matches the server contract
  assert.ok(
    src("components/v2/export/RafeeqFullSync.tsx").includes('kind: "xlsx" | "guide"'),
    "the UI type matches the server DTO",
  );
});

test("5: the recipient stays MANUAL, with the placeholder gates intact", () => {
  // STEP 57 writes NO recipient default. The one app_settings write that
  // exists is the pre-existing opt-in "save this recipient" checkbox: it is
  // gated on the owner's explicit req.saveRecipient and only runs AFTER a
  // successful send — never a silent or automatic default.
  const upserts = (SEND_CODE.match(/\.upsert\(/g) ?? []).length;
  assert.equal(upserts, 1, "exactly one app_settings write path");
  assert.ok(SEND_CODE.includes("if (req.saveRecipient) {"), "and it is gated on the explicit owner choice");
  const afterGate = SEND_CODE.slice(SEND_CODE.indexOf("if (req.saveRecipient) {"));
  assert.ok(afterGate.includes(".upsert("), "the upsert lives INSIDE that gate");
  // the saved-recipient read stays a READ that tolerates 'unset'
  assert.ok(SEND_CODE.includes('return "";'), "unset recipient resolves to empty, never guessed");
  assert.ok(SEND_SERVER.includes("NEVER guessed"), "documented");

  // and the reserved-domain gate still blocks a placeholder left in the box
  for (const bad of ["rafeeq@example.com", "a@test", "a@localhost", "a@mail.example.com"]) {
    const r = validateRecipients(bad, "");
    assert.ok(!r.ok && r.invalid.includes(bad), `${bad} still blocked`);
  }
  assert.equal(validateRecipients("", "").ok, false, "an empty recipient still blocks");
  assert.ok(validateRecipients("orders@rafeeq.qa", "").ok, "a real address still passes");

  // a manually-typed real recipient plans the two-attachment send fine
  const plan = planRafeeqEmailSend({
    configured: true,
    toRaw: "orders@rafeeq.qa",
    ccRaw: "",
    subject: "s",
    html: "<p>b</p>",
    text: "b",
    attachments: REAL_SET,
    attachmentMaxBytes: 20 * 1024 * 1024,
    draftBlockers: [],
  });
  assert.ok(plan.ok && plan.plan.attachments.length === 2, "manual recipient + 2 attachments plans");
});
