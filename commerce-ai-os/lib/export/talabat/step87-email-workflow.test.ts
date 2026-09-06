// STEP 87 — the V2 Talabat email workflow: Generate → Preview → Test Send.
//
// The interesting tests here are the ones about NOT sending:
//
//   • a confirmation is bound to one exact message, so editing the recipient
//     after confirming silently invalidates the confirmation;
//   • a test looks like a test in the two places a human reads;
//   • an oversize message is refused with numbers, never split or trimmed;
//   • the official send is a constant, not a setting, so nothing at runtime
//     can turn it on.
//
// node --conditions=react-server --experimental-strip-types --test lib/export/talabat/step87-email-workflow.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  TEST_SUBJECT_PREFIX, TEST_BODY_NOTICE, testSubject, testBody, presentForMode,
  attachmentSizeReport, oversizeGuidance, confirmationToken, checkConfirmation,
  evaluateWorkflowGate, OFFICIAL_SEND_ENABLED, OFFICIAL_SEND_DISABLED_AR, WORKFLOW_BLOCK_AR,
  type ConfirmationSubject, type WorkflowGateInput,
} from "./email-workflow.ts";
import { EMAIL_ATTACHMENT_MAX_BYTES_DEFAULT } from "../../mail/config.ts";
import { V2_NAV_LINKS, groupNavLinks } from "../../v2/nav.ts";
import { buildTalabatUpdateEmail } from "./email-templates.ts";
import { resolveSendRecipients, type ChannelRecipients } from "../../mail/recipient-settings.ts";

const HERE = join(fileURLToPath(new URL(".", import.meta.url)));
const APP_ROOT = join(HERE, "../../..");
const raw = (rel: string): string => readFileSync(join(APP_ROOT, rel), "utf8");
const code = (rel: string): string =>
  raw(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const ROUTE = "app/(v2)/v2/operations/channels/talabat-email";
const PAGE = `${ROUTE}/page.tsx`;
const CLIENT = `${ROUTE}/TalabatEmailWorkflow.tsx`;
const SERVER = "lib/talabat/email-workflow.server.ts";
const API = "app/api/export/talabat/email/workflow/[kind]/route.ts";
const GEN_API = "app/api/export/talabat/email/generate/[kind]/route.ts";

const LIMIT = EMAIL_ATTACHMENT_MAX_BYTES_DEFAULT;

function subject(over: Partial<ConfirmationSubject> = {}): ConfirmationSubject {
  return {
    kind: "existing_updates", mode: "test", from: "sender@malikas.test.qa",
    to: ["a@talabat.test.qa"], cc: [], subject: "[TEST] s",
    attachmentFilenames: ["w.xlsx"], runFingerprint: "r1.x", ...over,
  };
}
function gate(over: Partial<WorkflowGateInput> = {}): WorkflowGateInput {
  return {
    mode: "test", senderVerified: true, artifactPresent: true, artifactFresh: true,
    recipientPresent: true, recipientValid: true, sizeWithinLimit: true,
    confirmation: { ok: true }, deliveryLogReady: true, ...over,
  };
}

// ── 1. V2 only ───────────────────────────────────────────────────────────────

test("1: the workflow route exists in V2 and follows the V2 page conventions", () => {
  const page = code(PAGE);
  assert.equal(page.includes('"use client"'), false, "the page is a server component");
  assert.ok(page.includes("await isOwner()"), "owner-gated");
  assert.ok(page.includes("OWNER_ONLY_DENIED"));
  assert.ok(page.includes('export const dynamic = "force-dynamic"'));
  assert.ok(raw(PAGE).includes("إرسال تحديثات طلبات"), "Arabic title");
});

test("2: it is reachable from V2 navigation and nothing legacy changed", () => {
  const link = V2_NAV_LINKS.find((l) => l.href === "/v2/operations/channels/talabat-email");
  assert.ok(link, "nav entry exists");
  assert.equal(link!.label, "إرسال تحديثات طلبات");
  assert.equal(link!.external, undefined, "in-shell V2 page");
  assert.ok(groupNavLinks().some((s) => s.links.some((l) => l.href === link!.href)));

  // the legacy email page gained nothing from this step
  const legacy = code("app/(app)/settings/email/page.tsx");
  for (const forbidden of ["talabat-email", "confirmationToken", "testSubject", "sendTalabatTestEmail", "workflow"]) {
    assert.equal(legacy.includes(forbidden), false, `legacy must not gain ${forbidden}`);
  }
});

// ── 2. generation reuses STEP 84 ─────────────────────────────────────────────

test("3: generation calls the STEP 84 generator — no second engine", () => {
  const server = code(SERVER);
  assert.ok(server.includes("generateSafeUpdateArtifact"), "Email A uses the existing generator");
  assert.ok(server.includes("generateNewProductsArtifact"), "Email B uses the existing generator");
  for (const forbidden of ["buildTalabatSafeUpdateAoa", "buildTalabatNewProductsAoa", "zipEntrySegment", "aoa_to_sheet"]) {
    assert.equal(server.includes(forbidden), false, `${forbidden} would be a second generation path`);
  }
});

test("4: the full 538 MB package is never rebuilt to make Email B", () => {
  const server = code(SERVER);
  assert.equal(server.includes("startTalabatPackageJob"), false, "no full-package job is started");
  assert.equal(server.includes("createTalabatPackageJob"), false);
  // the delta image ZIP is READ from storage, not produced here
  assert.ok(server.includes("readCompletedDeltaImageZip"));
  assert.ok(server.includes("DELTA_IMAGE_ZIP_OBJECT"));
});

test("5: generation refuses rather than inventing a baseline", () => {
  const server = code(SERVER);
  assert.ok(server.includes("baseline_missing"), "an absent baseline is an explicit refusal");
  assert.ok(server.includes("TALABAT_BASELINE_OBJECT"), "…read from one known location");
  // and the delta comes from the certified comparison, not a local reimplementation
  assert.ok(server.includes("compareTalabatBaseline"));
  assert.ok(server.includes("loadTalabatPreview"));
});

// ── 3. test presentation ─────────────────────────────────────────────────────

test("6: a test subject is prefixed [TEST], exactly once", () => {
  assert.equal(TEST_SUBJECT_PREFIX, "[TEST] ");
  const s = buildTalabatUpdateEmail("w.xlsx").subject;
  assert.equal(testSubject(s), `[TEST] ${s}`);
  assert.equal(testSubject(testSubject(s)), `[TEST] ${s}`, "re-wrapping must not stack prefixes");
  assert.equal(presentForMode("official", s, "b").subject, s, "an official message is untouched");
});

test("7: the test notice is the FIRST thing in the body", () => {
  assert.equal(TEST_BODY_NOTICE, "INTERNAL TEST — NOT SENT TO TALABAT");
  const body = "Dear Talabat Team,\n\n…";
  const out = testBody(body);
  assert.ok(out.startsWith(TEST_BODY_NOTICE), "a notice below the greeting is a notice nobody reads");
  assert.ok(out.includes(body));
  assert.equal(testBody(out), out, "idempotent");
  assert.equal(presentForMode("official", "s", body).bodyText, body);
});

// ── 4. size ──────────────────────────────────────────────────────────────────

test("8: attachment size is measured against the CONFIGURED cap", () => {
  assert.equal(LIMIT, 20 * 1024 * 1024);
  const small = attachmentSizeReport([{ filename: "a.xlsx", bytes: 78_240 }], 700, LIMIT);
  assert.equal(small.withinLimit, true);
  assert.equal(small.rawAttachmentBytes, 78_240);
  assert.ok(small.estimatedMessageBytes > small.rawAttachmentBytes, "base64 inflation is accounted for");
  assert.equal(small.overBy, 0);
  assert.deepEqual(oversizeGuidance(small), []);
});

test("9: the REAL Email B attachment set is refused, with numbers", () => {
  // the actual STEP 84 artifacts: 347,537,469-byte ZIP + a ~302 KB workbook
  const big = attachmentSizeReport(
    [{ filename: "new-products.xlsx", bytes: 301_871 }, { filename: "images.zip", bytes: 347_537_469 }], 900, LIMIT);
  assert.equal(big.withinLimit, false);
  assert.equal(big.rawAttachmentBytes, 347_839_340);
  assert.ok(big.estimatedMessageBytes > 400_000_000, "the encoded message is larger still");
  assert.ok(big.overBy > 300_000_000);
  const guidance = oversizeGuidance(big);
  assert.ok(guidance.length >= 3);
  // never split, never trimmed — and the alternative named is one we already have
  assert.ok(guidance.some((g) => g.includes("لن يتم تقسيم الرسالة")));
  assert.ok(guidance.some((g) => g.includes("رابط تنزيل موقّع")));
});

test("10: an oversize message blocks the send outright", () => {
  const blocks = evaluateWorkflowGate(gate({ sizeWithinLimit: false }));
  assert.deepEqual(blocks, ["attachments_too_large"]);
  // the code contains no splitting or image-dropping path
  const server = code(SERVER);
  for (const forbidden of ["slice(0,", "splitMessage", "dropImages", "omitAttachment"]) {
    assert.equal(server.includes(forbidden), false, `${forbidden} would silently change what was reviewed`);
  }
});

// ── 5. confirmation binding ──────────────────────────────────────────────────

test("11: a confirmation is bound to ONE exact message", () => {
  const base = subject();
  assert.equal(checkConfirmation(confirmationToken(base), base).ok, true);
  const missing = checkConfirmation(null, base);
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.reason, "missing");
  const blank = checkConfirmation("   ", base);
  assert.equal(blank.ok, false);
});

test("12: changing To, CC, subject, attachments or the run invalidates it", () => {
  const base = subject();
  const token = confirmationToken(base);
  for (const [what, changed] of [
    ["To", subject({ to: ["other@talabat.test.qa"] })],
    ["CC", subject({ cc: ["watch@talabat.test.qa"] })],
    ["subject", subject({ subject: "[TEST] different" })],
    ["attachments", subject({ attachmentFilenames: ["w.xlsx", "extra.zip"] })],
    ["run", subject({ runFingerprint: "r1.y" })],
    ["mode", subject({ mode: "official" })],
  ] as const) {
    const check = checkConfirmation(token, changed);
    assert.equal(check.ok, false, `changing ${what} must invalidate the confirmation`);
    if (!check.ok) assert.equal(check.reason, "stale");
  }
  // recipient ORDER and case are not a difference
  assert.equal(checkConfirmation(
    confirmationToken(subject({ to: ["a@x.test.qa", "b@x.test.qa"] })),
    subject({ to: ["B@X.test.qa", "A@x.test.qa"] }),
  ).ok, true);
});

test("13: the UI clears a held confirmation on any edit, matching the server", () => {
  const client = code(CLIENT);
  assert.ok(client.includes("setConfirmedToken(null)"), "an edit drops the held token");
  assert.ok(client.includes("confirmedToken !== preview.confirmationToken"), "the button compares tokens");
  const server = code(SERVER);
  assert.ok(server.includes("checkConfirmation("), "and the server checks again itself");
});

test("14: an unconfirmed or stale send is refused, with different reasons", () => {
  assert.deepEqual(evaluateWorkflowGate(gate({ confirmation: { ok: false, reason: "missing" } })), ["not_confirmed"]);
  assert.deepEqual(evaluateWorkflowGate(gate({ confirmation: { ok: false, reason: "stale" } })), ["confirmation_stale"]);
  assert.notEqual(WORKFLOW_BLOCK_AR.not_confirmed, WORKFLOW_BLOCK_AR.confirmation_stale);
});

// ── 6. recipients ────────────────────────────────────────────────────────────

test("15: the recipient is typed per send; the saved value is only a suggestion", () => {
  const saved: ChannelRecipients = { to: ["saved@talabat.test.qa"], cc: [] };
  const typed = resolveSendRecipients(saved, { toRaw: "elsewhere@talabat.test.qa", ccRaw: "" });
  assert.equal(typed.ok, true);
  if (typed.ok) assert.deepEqual(typed.value.to, ["elsewhere@talabat.test.qa"]);
  // no address is hard-coded on the workflow path
  for (const rel of [PAGE, CLIENT, SERVER, API, GEN_API, "lib/export/talabat/email-workflow.ts"]) {
    assert.equal(raw(rel).includes("july.real"), false, `${rel} must not hard-code the recipient`);
    const hits = code(rel).split("\n").filter((l) => /[A-Za-z0-9._%-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(l));
    assert.deepEqual(hits, [], `${rel} must contain no literal email address`);
  }
});

test("16: a missing or invalid recipient blocks, and they are different answers", () => {
  assert.deepEqual(evaluateWorkflowGate(gate({ recipientPresent: false })), ["recipient_missing"]);
  assert.deepEqual(evaluateWorkflowGate(gate({ recipientValid: false })), ["recipient_invalid"]);
  assert.notEqual(WORKFLOW_BLOCK_AR.recipient_missing, WORKFLOW_BLOCK_AR.recipient_invalid);
  // the test recipient is chosen by the owner — the client seeds from the saved
  // suggestion and lets it be replaced
  assert.ok(code(CLIENT).includes("useState(savedTo)"));
});

// ── 7. the official send is off ──────────────────────────────────────────────

test("17: official send is a CONSTANT, unreachable at runtime", () => {
  assert.equal(OFFICIAL_SEND_ENABLED, false);
  const blocks = evaluateWorkflowGate(gate({ mode: "official" }));
  assert.ok(blocks.includes("official_send_disabled"));
  assert.equal(blocks[0], "official_send_disabled", "refused before anything else is examined");
  // even with everything else perfect
  assert.deepEqual(evaluateWorkflowGate(gate({ mode: "official" })), ["official_send_disabled"]);
  assert.equal(OFFICIAL_SEND_DISABLED_AR, "اختبر البريد أولاً قبل الإرسال الرسمي");
  // there is no env/flag path that flips it
  const pure = code("lib/export/talabat/email-workflow.ts");
  assert.equal(pure.includes("process.env"), false, "not a setting");
  assert.match(pure, /export const OFFICIAL_SEND_ENABLED = false/);
});

test("18: the send route can only ever carry a TEST", () => {
  const route = code(API);
  assert.ok(route.includes('mode: "test"'), "the POST pins the mode");
  const post = route.slice(route.indexOf("export async function POST"));
  assert.equal(post.includes('"official"'), false, "no official path exists in the route");
  const server = code(SERVER);
  assert.ok(server.includes('if (input.mode !== "test") return fail("official_send_disabled", 403)'));
  // the UI shows the future action, disabled, with the reason
  assert.ok(code(CLIENT).includes("officialSendDisabledReason"));
  assert.ok(raw(CLIENT).includes("الإرسال الرسمي (معطّل)"));
});

// ── 8. artifacts, sender, delivery log ───────────────────────────────────────

test("19: a stale or missing artifact blocks the send", () => {
  assert.deepEqual(evaluateWorkflowGate(gate({ artifactPresent: false })), ["artifact_missing"]);
  assert.deepEqual(evaluateWorkflowGate(gate({ artifactFresh: false })), ["artifact_stale"]);
  const server = code(SERVER);
  assert.ok(server.includes("verifyArtifactScope"), "freshness is the STEP 84 run binding");
});

test("20: an unverified sender blocks the send", () => {
  assert.deepEqual(evaluateWorkflowGate(gate({ senderVerified: false })), ["sender_not_verified"]);
  const server = code(SERVER);
  assert.ok(server.includes("senderVerified: sender.match"), "verification is the transport comparison");
});

test("21: a test send is refused until the log can record it AS a test", () => {
  assert.deepEqual(evaluateWorkflowGate(gate({ deliveryLogReady: false })), ["delivery_log_not_ready"]);
  const server = code(SERVER);
  assert.ok(server.includes('delivery_mode: "test"'), "the row says test");
  assert.ok(server.includes("deliveryLogSupportsMode"), "…and the column is checked before relying on it");
  const migration = raw("supabase/migrations/20260907000000_talabat_email_delivery_mode.sql");
  assert.match(migration, /add column if not exists delivery_mode/);
  assert.match(migration, /check \(delivery_mode in \('official', 'test'\)\)/);
  assert.match(migration, /default 'official'/, "existing rows keep their meaning");
  // additive only
  for (const forbidden of ["drop table", "delete from", "update public", "alter column"]) {
    assert.equal(migration.toLowerCase().includes(forbidden), false, `migration must not ${forbidden}`);
  }
});

test("22: the audit row is written only after the provider accepts, and holds no secret", () => {
  const server = code(SERVER);
  const send = server.slice(server.indexOf("export async function sendTalabatTestEmail"));
  assert.ok(send.indexOf("sendMailViaSmtp") < send.indexOf("talabat_email_deliveries"),
    "the provider is called before anything is logged");
  assert.ok(send.includes('if (!sent.ok) return fail("send_failed", 502)'), "a failure logs nothing");
  for (const secret of ["config.password", "config.username", "MAIL_PASSWORD", "detail"]) {
    assert.equal(send.includes(secret), false, `the log must not carry ${secret}`);
  }
});

// ── 9. boundaries ────────────────────────────────────────────────────────────

test("23: one SMTP transport, no marketplace write, no catalog write", () => {
  const server = code(SERVER);
  assert.ok(server.includes('from "@/lib/mail/smtp.server"'), "the shared transport");
  assert.equal(server.includes("nodemailer"), false);
  assert.equal(server.includes("createTransport"), false);
  assert.equal((server.match(/sendMailViaSmtp\(/g) ?? []).length, 1, "exactly one transport call site");
  // the only table it writes is its own delivery log
  const inserts = server.split("\n").filter((l) => l.includes(".insert("));
  assert.equal(inserts.length, 1, "one insert");
  assert.ok(server.includes('from("talabat_email_deliveries")'));
  for (const forbidden of ['from("products")', 'from("product_variants")', 'from("channel_', "snoonu", "shopify"]) {
    assert.equal(server.includes(forbidden), false, `must not touch ${forbidden}`);
  }
});

test("24: barcode rows are outside both emails and the barcode email stays unsendable", () => {
  // the workflow only ever names the two sendable kinds
  const client = code(CLIENT);
  assert.ok(client.includes('kind: "existing_updates"') && client.includes('kind: "new_products"'));
  assert.equal(client.includes("barcode_corrections"), false, "the barcode email has no card");
  const server = code(SERVER);
  assert.ok(server.includes("isTalabatSendableKind"), "the kind is gated by the sendable set");
  assert.equal(server.includes("buildTalabatBarcodeCorrectionEmail"), false);
  // and the page shows it read-only, on hold
  assert.ok(raw(PAGE).includes("مراجعة الباركود"));
});

test("25: every workflow surface is owner-gated on every method", () => {
  for (const rel of [API, GEN_API]) {
    const src = code(rel);
    const methods = (src.match(/export async function (GET|POST)/g) ?? []).length;
    const gates = (src.match(/await requireOwner\(\)/g) ?? []).length;
    assert.equal(gates, methods, `${rel}: every method must call requireOwner`);
    assert.ok(methods >= 1);
  }
  assert.ok(code(PAGE).includes("await isOwner()"));
});

test("26: nothing in this suite can transmit — the pure layer has no transport", () => {
  const pure = code("lib/export/talabat/email-workflow.ts");
  for (const forbidden of ["nodemailer", "createTransport", "sendMailViaSmtp", "fetch(", "supabase", "process.env"]) {
    assert.equal(pure.includes(forbidden), false, `the pure workflow must not contain ${forbidden}`);
  }
  // and the generation route sends nothing
  assert.equal(code(GEN_API).includes("sendTalabatTestEmail"), false);
});
