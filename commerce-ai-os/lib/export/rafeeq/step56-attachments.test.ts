// STEP 56 — the REAL MIME attachments on a Rafeeq direct send. Owner proofs:
//   1  rafeeq_catalog.xlsx is attached from the stored artifact;
//   2  Rafeeq-Options-Reading-Guide.png is attached as REAL bytes — the body
//      claims it, so the MIME part must exist (this was the defect);
//   3  the certified ZIP is NEVER attached — secure link only;
//   4  the attachment set reaches nodemailer verbatim;
//   5  the claim and the attachment stay in lockstep, and an unreadable guide
//      FAILS CLOSED rather than shipping an unfulfilled claim;
//   6  the size gate still applies and the guide fits it.
// node --conditions=react-server --experimental-strip-types --test lib/export/rafeeq/step56-attachments.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildRafeeqEmailDraft, RAFEEQ_GUIDE_PNG, type RafeeqEmailContext } from "./email-draft.ts";
import { planRafeeqEmailSend } from "./email-send.ts";
import { estimateEncodedBytes } from "../../mail/config.ts";

const HERE = join(fileURLToPath(new URL(".", import.meta.url)));
const APP_ROOT = join(HERE, "../../..");
const src = (rel: string): string => readFileSync(join(APP_ROOT, rel), "utf8");
const SEND_SERVER = src("lib/rafeeq/email-send.server.ts");

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

test("1: the workbook comes from the stored artifact, never rebuilt", () => {
  assert.ok(SEND_SERVER.includes("loadTailAttachments(artifact.value.parts)"), "sliced from the stored parts");
  // STEP 57 replaced the "exclude images/" filter with a positive allow-list:
  // only the .xlsx workbook is taken, so images AND manifest.json are both
  // excluded by construction rather than by enumeration.
  assert.ok(SEND_SERVER.includes('.filter((e) => e.filename.endsWith(".xlsx"))'), "only the workbook is taken");
  assert.ok(!SEND_SERVER.includes('startsWith("images/")'), "the old enumeration filter is gone");
  // FULL packages name the workbook rafeeq_catalog.xlsx
  assert.equal(src("lib/export/rafeeq/fullsync.ts").includes('"rafeeq_catalog.xlsx"'), true);
  const d = buildRafeeqEmailDraft(ctx());
  assert.ok(d.attachments.includes("rafeeq_catalog.xlsx"), "the workbook is in the set");
  // nothing here regenerates the package
  for (const bad of ["loadRafeeqPreview", "startRafeeqPackageJob", "advanceRafeeqPackageJob"]) {
    assert.ok(!SEND_SERVER.includes(bad), `send never regenerates (${bad})`);
  }
});

test("2: the reading guide is attached as REAL bytes, from the real asset", () => {
  // the asset actually exists and is non-empty
  const guidePath = join(APP_ROOT, "public", RAFEEQ_GUIDE_PNG);
  const st = statSync(guidePath);
  assert.ok(st.isFile() && st.size > 0, "the guide asset exists");
  const bytes = readFileSync(guidePath);
  // real PNG magic — we attach an actual image, not a placeholder
  assert.deepEqual([...bytes.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], "PNG signature");

  // the send path reads it and attaches it
  assert.ok(SEND_SERVER.includes("loadGuideAttachment"), "the loader exists");
  assert.ok(SEND_SERVER.includes('readFile(join(process.cwd(), "public", RAFEEQ_GUIDE_PNG))'), "reads the real asset");
  assert.ok(SEND_SERVER.includes('contentType: "image/png"'), "correct MIME type");
  assert.ok(SEND_SERVER.includes("const allAttachments = guide ? [...tailAttachments, guide] : tailAttachments"), "joined into the set");

  // and its bytes are traced into the send function's bundle
  const cfg = src("next.config.mjs");
  assert.ok(cfg.includes("outputFileTracingIncludes"), "tracing configured");
  assert.ok(cfg.includes("./public/Rafeeq-Options-Reading-Guide.png"), "the guide is traced");
  assert.ok(cfg.includes("/api/export/rafeeq/package/jobs/[jobId]/send"), "traced into the SEND route");
});

test("3: the certified ZIP is NEVER attached — secure link only", () => {
  assert.ok(SEND_SERVER.includes("The certified ZIP is NEVER attached"), "documented invariant");
  // the only ZIP-shaped thing in the send path is the LINK
  assert.ok(SEND_SERVER.includes("createRafeeqPackageSignedLink(jobId)"), "link is minted");
  assert.ok(SEND_SERVER.includes('return sendErr("package_link_unavailable"'), "no link ⇒ no send");
  // attachments come only from the tail slice + the guide; the full artifact
  // bytes are never read into the message
  assert.ok(!SEND_SERVER.includes("readRafeeqPackageParts("), "the whole artifact is never buffered for mail");
  const d = buildRafeeqEmailDraft(ctx());
  const zipEntry = d.attachments.find((a) => a.includes(".zip"));
  assert.ok(zipEntry?.includes("secure download link — not attached"), `ZIP is link-delivered: ${zipEntry}`);
  assert.ok(d.html.includes("instead of an email attachment"), "the body says so too");
});

test("4: the planned set reaches nodemailer verbatim", () => {
  assert.ok(
    SEND_SERVER.includes("attachments: p.attachments.map((a) => ({") &&
      SEND_SERVER.includes("content: Buffer.from(attachmentsBytes.get(a.filename) ?? new Uint8Array()),"),
    "every planned attachment is handed to the provider with its real bytes",
  );
  assert.ok(SEND_SERVER.includes("attachmentsBytes = new Map(allAttachments.map"), "the byte map covers the guide too");
});

test("5: the claim and the attachment stay in lockstep — unreadable guide FAILS CLOSED", () => {
  // the draft claims the guide only for FULL
  const full = buildRafeeqEmailDraft(ctx());
  assert.ok(full.attachments.includes(RAFEEQ_GUIDE_PNG), "FULL claims the guide");
  assert.ok(full.html.includes(`The attached <code>${RAFEEQ_GUIDE_PNG}</code>`), "FULL body claims it");

  const incremental = buildRafeeqEmailDraft(ctx({ mode: "NEW", newPackage: { hasSentBaseline: true, equalsWholeCatalog: false } }));
  assert.ok(!incremental.attachments.includes(RAFEEQ_GUIDE_PNG), "NEW does not claim the guide");
  assert.ok(!incremental.html.includes(RAFEEQ_GUIDE_PNG), "NEW body does not claim it");

  // the send path attaches off that SAME signal, and blocks when it cannot
  assert.ok(
    SEND_SERVER.includes("const guideClaimed = draft.value.attachments.includes(RAFEEQ_GUIDE_PNG)"),
    "attachment decision follows the draft's own claim",
  );
  assert.ok(SEND_SERVER.includes('if (guideClaimed && !guide) return sendErr("guide_unavailable", 409)'), "fails closed");
  // and the block has a fixed Arabic message
  const sendPure = src("lib/export/rafeeq/email-send.ts");
  assert.ok(sendPure.includes("guide_unavailable:"), "Arabic message exists");
  assert.ok(sendPure.includes("نص الإيميل يذكر أنه مرفق، فلن يُرسل بدونه"), "explains the fail-closed reason");
});

test("6: the size gate still applies, and the real attachment set fits it", () => {
  const guideBytes = statSync(join(APP_ROOT, "public", RAFEEQ_GUIDE_PNG)).size;
  const cap = 20 * 1024 * 1024;
  // the real set (STEP 57): workbook + guide ONLY — manifest.json stays in the ZIP
  const set = [
    { filename: "rafeeq_catalog.xlsx", bytes: 900_000, contentType: "x" },
    { filename: RAFEEQ_GUIDE_PNG, bytes: guideBytes, contentType: "image/png" },
  ];
  const ok = planRafeeqEmailSend({
    configured: true,
    toRaw: "orders@rafeeq.qa",
    ccRaw: "",
    subject: "s",
    html: "<p>b</p>",
    text: "b",
    attachments: set,
    attachmentMaxBytes: cap,
    draftBlockers: [],
  });
  assert.equal(ok.ok, true, "the real set plans within the cap");
  assert.equal(ok.ok && ok.plan.attachments.length, 2, "exactly the two parts survive planning");
  assert.ok(estimateEncodedBytes([guideBytes]) < estimateEncodedBytes([cap]), "the guide alone is far inside the cap");

  // an oversized set is still refused — never a silent partial set
  const tooBig = planRafeeqEmailSend({
    configured: true,
    toRaw: "orders@rafeeq.qa",
    ccRaw: "",
    subject: "s",
    html: "<p>b</p>",
    text: "b",
    attachments: [{ filename: "big.zip", bytes: 400 * 1024 * 1024, contentType: "application/zip" }],
    attachmentMaxBytes: cap,
    draftBlockers: [],
  });
  assert.deepEqual(tooBig, { ok: false, error: "attachments_too_large" });
});
