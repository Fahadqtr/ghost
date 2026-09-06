// STEP 83 — the Talabat send path: shared transport, configured recipients,
// and a sender gate that cannot be talked around.
//
// The point of these tests is not that a send works — nothing sends here, and
// nothing can. It is that every way of NOT sending is the right way:
//
//   • a sender that is merely the registry default is refused;
//   • an unconfigured recipient is a distinct, reported state, never a guess;
//   • Email C cannot be named by any route, planner or log;
//   • a workbook and an image package that disagree block each other;
//   • generation never implies a send — the owner's confirm flag is required.
//
// node --conditions=react-server --experimental-strip-types --test lib/export/talabat/step83-talabat-send-path.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  planTalabatEmailSend, runTalabatEmailSend, checkSenderTransport, senderMismatchGuidance,
  isTalabatSendableKind, TALABAT_SENDABLE_KINDS, scopeConsistent, talabatSendErrorMessageAr,
  refusesBarcodeCorrections, type TalabatEmailSendPlanInput, type TalabatSendScope,
} from "./email-send.ts";
import {
  RECIPIENT_SETTING_KEYS, parseStoredRecipients, toStoredRecipients, isChannelConfigured,
  validateRecipientEdit, describeRecipients, BCC_SUPPORTED,
} from "../../mail/recipient-settings.ts";
import { DEFAULT_SENDER_IDENTITY, DEFAULT_SENDER_BY_CHANNEL, resolveSenderIdentity, chooseSender, resolveSenderIdentities }
  from "../../mail/sender-identity.ts";
import { readMailConfig } from "../../mail/config.ts";
import { TALABAT_SENDABLE_EMAIL_KINDS, buildTalabatBarcodeCorrectionEmail, buildTalabatUpdateEmail } from "./email-templates.ts";

const HERE = join(fileURLToPath(new URL(".", import.meta.url)));
const APP_ROOT = join(HERE, "../../..");
const raw = (rel: string): string => readFileSync(join(APP_ROOT, rel), "utf8");
const code = (rel: string): string =>
  raw(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const TARGET = "fahad@malikasuniverse.com";
const OLD = "fahad@gulfmedia.qa";
const env = (from: string) => ({ MAIL_HOST: "h", MAIL_USERNAME: "u", MAIL_PASSWORD: "p", MAIL_FROM_ADDRESS: from });

const GOOD_SCOPE: TalabatSendScope = { workbookRows: 517, imageCount: 632, rowsMissingImage: 0, excludedCategoryRows: 0 };

function planInput(over: Partial<TalabatEmailSendPlanInput> = {}): TalabatEmailSendPlanInput {
  return {
    kind: "new_products",
    configured: true,
    sender: checkSenderTransport(TARGET, TARGET),
    toRaw: "orders@talabat.test.qa",
    ccRaw: "",
    subject: "s",
    text: "b",
    attachments: [{ filename: "w.xlsx", bytes: 1000, contentType: "x" }],
    attachmentMaxBytes: 20 * 1024 * 1024,
    scope: GOOD_SCOPE,
    draftBlockers: [],
    ownerConfirmed: true,
    ...over,
  };
}

// ── 1: one SMTP layer, not two ───────────────────────────────────────────────

test("1: the Talabat send path reuses the shared SMTP layer and defines no transport", () => {
  const server = code("lib/talabat/email-send.server.ts");
  assert.ok(server.includes('from "@/lib/mail/smtp.server"'), "sends through the shared transport");
  for (const forbidden of ["nodemailer", "createTransport", "smtps://", "MAIL_PASSWORD", "MAIL_USERNAME"]) {
    assert.equal(server.includes(forbidden), false, `must not contain ${forbidden}`);
  }
  const planner = code("lib/export/talabat/email-send.ts");
  assert.ok(planner.includes('from "../../mail/config.ts"'), "recipient/size rules are the shared ones");
  for (const forbidden of ["nodemailer", "createTransport", "fetch(", "supabase"]) {
    assert.equal(planner.includes(forbidden), false, `the pure planner must not contain ${forbidden}`);
  }
});

// ── 2: no hardcoded recipient, ever ──────────────────────────────────────────

test("2: no Talabat recipient is hardcoded anywhere in the send path", () => {
  for (const rel of [
    "lib/mail/recipient-settings.ts",
    "lib/export/talabat/email-send.ts",
    "lib/talabat/email-send.server.ts",
    "app/api/export/talabat/email/[kind]/route.ts",
    "app/api/settings/email/route.ts",
  ]) {
    const src = code(rel);
    // no literal address of any kind may appear in a code line
    const hits = src.split("\n").filter((l) => /[A-Za-z0-9._%-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(l));
    assert.deepEqual(hits, [], `${rel} must not contain a literal email address`);
  }
  assert.deepEqual(parseStoredRecipients(null), { to: [], cc: [] });
  assert.deepEqual(parseStoredRecipients(undefined), { to: [], cc: [] });
  assert.deepEqual(parseStoredRecipients({}), { to: [], cc: [] });
  assert.deepEqual(parseStoredRecipients("garbage"), { to: [], cc: [] });
  assert.equal(isChannelConfigured(parseStoredRecipients({})), false);
  assert.equal(describeRecipients({ to: [], cc: [] }), "—");
});

test("3: a placeholder or malformed stored address never counts as configured", () => {
  for (const bad of ["a@example.com", "x@test", "not-an-address", "y@localhost"]) {
    assert.equal(isChannelConfigured(parseStoredRecipients({ to: bad })), false, `${bad} must not configure a channel`);
  }
  // a real one does, and is normalised + deduped
  const r = parseStoredRecipients({ to: "A@Talabat.test.qa, a@talabat.test.qa", cc: ["b@talabat.test.qa"] });
  assert.deepEqual(r, { to: ["a@talabat.test.qa"], cc: ["b@talabat.test.qa"] });
  assert.equal(isChannelConfigured(r), true);
});

test("4: no send proceeds without a configured recipient", () => {
  const blank = planTalabatEmailSend(planInput({ toRaw: "" }));
  assert.equal(blank.ok, false);
  if (!blank.ok) assert.equal(blank.error, "recipient_not_configured");
  // an unconfigured channel and a MALFORMED one are different answers
  const bad = planTalabatEmailSend(planInput({ toRaw: "not-an-address" }));
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.equal(bad.error, "invalid_recipient");
  assert.notEqual(talabatSendErrorMessageAr("recipient_not_configured"), talabatSendErrorMessageAr("invalid_recipient"));
});

test("5: the Rafeeq recipient key is preserved, so its saved value is not stranded", () => {
  assert.equal(RECIPIENT_SETTING_KEYS.rafeeq, "rafeeq_email_recipient");
  assert.equal(RECIPIENT_SETTING_KEYS.talabat, "talabat_email_recipient");
  // Rafeeq's existing stored shape is { to: "<address>" } — it must still read
  assert.deepEqual(parseStoredRecipients({ to: "amina@gorafeeq.test.qa" }).to, ["amina@gorafeeq.test.qa"]);
});

// ── 3: the sender gate ───────────────────────────────────────────────────────

test("6: a registry default is NOT authentication", () => {
  assert.equal(DEFAULT_SENDER_BY_CHANNEL.talabat, TARGET);
  assert.equal(DEFAULT_SENDER_IDENTITY.address, TARGET);
  assert.equal(DEFAULT_SENDER_IDENTITY.isDefault, true);
  // …and yet, against the CURRENT transport, it is not selectable
  const cfg = readMailConfig(env(OLD));
  const resolved = resolveSenderIdentity(DEFAULT_SENDER_IDENTITY, cfg);
  assert.equal(resolved.verification, "unverified");
  assert.equal(resolved.selectable, false);
  assert.equal(checkSenderTransport(TARGET, OLD).match, false);
});

test("7: a sender/transport mismatch blocks the send and is never substituted", () => {
  const mismatched = planTalabatEmailSend(planInput({ sender: checkSenderTransport(TARGET, OLD) }));
  assert.equal(mismatched.ok, false);
  if (!mismatched.ok) assert.equal(mismatched.error, "sender_not_authenticated");
  // chooseSender refuses rather than falling back to the transport's own address
  const cfg = readMailConfig(env(OLD));
  const choice = chooseSender(resolveSenderIdentities([DEFAULT_SENDER_IDENTITY], cfg), null);
  assert.equal(choice.ok, false);
  if (!choice.ok) assert.equal(choice.code, "not_selectable");
  const server = code("lib/talabat/email-send.server.ts");
  assert.equal(/fromAddress\s*\|\|/.test(server), false, "no fallback to the transport address");
  assert.ok(server.includes("chooseSender("), "the send path goes through the refusing chooser");
});

test("8: a matching transport unblocks it — the gate is the mismatch, not the feature", () => {
  const cfg = readMailConfig(env(TARGET));
  assert.equal(resolveSenderIdentity(DEFAULT_SENDER_IDENTITY, cfg).selectable, true);
  const ok = planTalabatEmailSend(planInput());
  assert.equal(ok.ok, true);
  if (ok.ok) assert.equal(ok.plan.from, TARGET);
});

test("9: mismatch guidance names the variable and the addresses, never a secret", () => {
  const g = senderMismatchGuidance(checkSenderTransport(TARGET, OLD));
  assert.ok(g.some((l) => l.includes("MAIL_FROM_ADDRESS=" + TARGET)));
  assert.ok(g.some((l) => l.includes(OLD)));
  for (const line of g) {
    for (const secret of ["MAIL_PASSWORD", "MAIL_USERNAME", "password", "كلمة المرور"]) {
      assert.equal(line.includes(secret), false, `guidance must not mention ${secret}`);
    }
  }
  // no transport at all gets its own guidance, not the mismatch wording
  const none = senderMismatchGuidance(checkSenderTransport(TARGET, null));
  assert.ok(none.some((l) => l.includes("MAIL_HOST")));
  assert.deepEqual(senderMismatchGuidance(checkSenderTransport(TARGET, TARGET)), []);
});

// ── 4: Email C is unreachable ────────────────────────────────────────────────

test("10: Email C is rejected server-side by every layer", () => {
  assert.equal(isTalabatSendableKind("barcode_corrections"), false);
  assert.deepEqual([...TALABAT_SENDABLE_KINDS], ["existing_updates", "new_products"]);
  const refused = planTalabatEmailSend(planInput({ kind: "barcode_corrections" }));
  assert.equal(refused.ok, false);
  if (!refused.ok) assert.equal(refused.error, "email_kind_not_sendable");
  // refused FIRST — even with everything else broken, the kind is the answer
  const alsoBroken = planTalabatEmailSend(planInput({
    kind: "barcode_corrections", configured: false, toRaw: "", ownerConfirmed: false,
    sender: checkSenderTransport(TARGET, OLD),
  }));
  assert.equal(alsoBroken.ok, false);
  if (!alsoBroken.ok) assert.equal(alsoBroken.error, "email_kind_not_sendable");
  assert.equal(buildTalabatBarcodeCorrectionEmail("x.xlsx").sendable, false);
  assert.equal(TALABAT_SENDABLE_EMAIL_KINDS.includes("barcode_corrections"), false);
  assert.equal(refusesBarcodeCorrections("barcode_corrections"), true);
});

test("11: the delivery log cannot even record a barcode email", () => {
  const migration = raw("supabase/migrations/20260906000000_talabat_email_deliveries.sql");
  assert.match(migration, /email_kind in \('existing_updates', 'new_products'\)/);
  assert.equal(/check \([^)]*barcode_corrections/.test(migration), false);
});

// ── 5: scope agreement ───────────────────────────────────────────────────────

test("12: workbook and image scope must agree or nothing is sent", () => {
  assert.equal(scopeConsistent(GOOD_SCOPE), true);
  // Email A legitimately has no image package — null, not zero
  assert.equal(scopeConsistent({ ...GOOD_SCOPE, imageCount: null }), true);
  for (const bad of [
    { ...GOOD_SCOPE, rowsMissingImage: 1 },
    { ...GOOD_SCOPE, excludedCategoryRows: 1 },
    { ...GOOD_SCOPE, workbookRows: 0 },
    { ...GOOD_SCOPE, imageCount: 0 },
  ]) {
    assert.equal(scopeConsistent(bad), false, JSON.stringify(bad));
    const p = planTalabatEmailSend(planInput({ scope: bad }));
    assert.equal(p.ok, false);
    if (!p.ok) assert.equal(p.error, "attachment_scope_mismatch");
  }
});

test("13: a partial attachment bundle is a MISSING bundle, never a smaller email", () => {
  const server = code("lib/talabat/email-send.server.ts");
  assert.ok(server.includes("loaded.some((a) => a === null)"), "any unreadable attachment voids the bundle");
  assert.ok(server.includes("return null"), "and the bundle resolves to absent");
  const none = planTalabatEmailSend(planInput({ attachments: [] }));
  assert.equal(none.ok, false);
  if (!none.ok) assert.equal(none.error, "no_attachments");
});

// ── 6: owner confirmation ────────────────────────────────────────────────────

test("14: generation never implies a send — confirmation is required", () => {
  const unconfirmed = planTalabatEmailSend(planInput({ ownerConfirmed: false }));
  assert.equal(unconfirmed.ok, false);
  if (!unconfirmed.ok) assert.equal(unconfirmed.error, "not_confirmed");
  const route = code("app/api/export/talabat/email/[kind]/route.ts");
  assert.ok(route.includes("body.confirm === true"), "only a literal true confirms");
  assert.ok(route.includes("requireOwner"), "and only the owner may reach it");
  // the GET preflight must never send — scan the GET body ONLY, not a greedy
  // span that would run past it into POST and match there.
  const getBody = route.slice(route.indexOf("export async function GET"), route.indexOf("export async function POST"));
  assert.equal(getBody.includes("sendTalabatEmail"), false, "GET must not reach the send path");
  assert.ok(getBody.includes("getTalabatSendPreflight"));
});

test("15: preflight is read-only and reports every blocker without sending", () => {
  const server = code("lib/talabat/email-send.server.ts");
  const preflight = server.slice(server.indexOf("export async function getTalabatSendPreflight"));
  const body = preflight.slice(0, preflight.indexOf("function scopeOk"));
  for (const forbidden of ["sendMailViaSmtp", "insert(", "upsert(", "runTalabatEmailSend"]) {
    assert.equal(body.includes(forbidden), false, `preflight must not ${forbidden}`);
  }
});

// ── 7: Email A and B gated only by a passing preflight ───────────────────────

test("16: Email A is sendable only when every preflight condition holds", () => {
  const A = planInput({ kind: "existing_updates", scope: { workbookRows: 147, imageCount: null, rowsMissingImage: 0, excludedCategoryRows: 0 } });
  assert.equal(planTalabatEmailSend(A).ok, true);
  for (const [label, over] of [
    ["no transport", { configured: false }],
    ["sender mismatch", { sender: checkSenderTransport(TARGET, OLD) }],
    ["no recipient", { toRaw: "" }],
    ["no attachment", { attachments: [] }],
    ["unconfirmed", { ownerConfirmed: false }],
  ] as const) {
    assert.equal(planTalabatEmailSend({ ...A, ...over }).ok, false, `${label} must block Email A`);
  }
  // its content is untouched by this step
  const draft = buildTalabatUpdateEmail("talabat-safe-product-updates-2026-09-06.xlsx");
  assert.equal(draft.subject, "Malika's Universe — Talabat Product Data Update");
  assert.ok(draft.bodyText.includes("only products that are already listed on Talabat"));
});

test("17: Email B is sendable only when every preflight condition holds", () => {
  assert.equal(planTalabatEmailSend(planInput()).ok, true);
  for (const over of [
    { configured: false }, { sender: checkSenderTransport(TARGET, OLD) }, { toRaw: "" },
    { attachments: [] }, { ownerConfirmed: false }, { scope: { ...GOOD_SCOPE, excludedCategoryRows: 3 } },
  ]) {
    assert.equal(planTalabatEmailSend(planInput(over)).ok, false, JSON.stringify(over));
  }
});

// ── 8: the run engine ────────────────────────────────────────────────────────

test("18: audit is written only after the provider accepts; failure records nothing", async () => {
  const plan = planTalabatEmailSend(planInput());
  assert.equal(plan.ok, true);
  if (!plan.ok) return;

  const written: unknown[] = [];
  const failed = await runTalabatEmailSend(plan.plan, { sentAtIso: "t", createdBy: "owner@x" }, {
    send: async () => ({ ok: false, detail: "smtp said no" }),
    recordAudit: async (r) => { written.push(r); return true; },
  });
  assert.equal(failed.ok, false);
  assert.deepEqual(written, [], "a provider failure records NOTHING");

  const okRun = await runTalabatEmailSend(plan.plan, { sentAtIso: "t", createdBy: "owner@x" }, {
    send: async () => ({ ok: true, messageId: "mid" }),
    recordAudit: async (r) => { written.push(r); return true; },
  });
  assert.equal(okRun.ok, true);
  assert.equal(written.length, 1);
  const rec = written[0] as Record<string, unknown>;
  assert.equal(rec.emailKind, "new_products");
  assert.equal(rec.sender, TARGET);
  assert.equal(rec.createdBy, "owner@x");
  assert.equal(rec.providerMessageId, "mid");
  assert.equal(rec.status, "sent");
  assert.deepEqual(rec.attachmentFilenames, ["w.xlsx"]);
});

test("19: the delivery contract stores no credential and no raw provider text", () => {
  const planner = code("lib/export/talabat/email-send.ts");
  const record = planner.slice(planner.indexOf("export interface TalabatEmailAuditRecord"));
  for (const forbidden of ["password", "username", "host", "detail", "apiKey", "token"]) {
    assert.equal(record.slice(0, record.indexOf("}")).toLowerCase().includes(forbidden), false,
      `the audit record must not carry ${forbidden}`);
  }
  // scan SQL, not the comment that PROMISES no credential is stored
  const migrationSql = raw("supabase/migrations/20260906000000_talabat_email_deliveries.sql")
    .replace(/^\s*--.*$/gm, "").toLowerCase();
  for (const forbidden of ["password", "smtp_user", "credential", "api_key"]) {
    assert.equal(migrationSql.includes(forbidden), false, `the table must not hold ${forbidden}`);
  }
  const migrationRaw = raw("supabase/migrations/20260906000000_talabat_email_deliveries.sql");
  assert.match(migrationRaw, /error_reference\s+text null/);
  assert.ok(migrationRaw.includes("enable row level security"));
});

// ── 9: recipient editing ─────────────────────────────────────────────────────

test("20: recipient settings are editable, and a typo is reported not swallowed", () => {
  const good = validateRecipientEdit("Orders@Talabat.test.qa", "cc@talabat.test.qa");
  assert.equal(good.ok, true);
  if (good.ok) {
    assert.deepEqual(good.value, { to: ["orders@talabat.test.qa"], cc: ["cc@talabat.test.qa"] });
    assert.deepEqual(toStoredRecipients(good.value), { to: "orders@talabat.test.qa", cc: "cc@talabat.test.qa" });
  }
  const typo = validateRecipientEdit("orders@talabat", "");
  assert.equal(typo.ok, false);
  if (!typo.ok) assert.deepEqual(typo.invalid, ["orders@talabat"]);
  const empty = validateRecipientEdit("", "");
  assert.equal(empty.ok, false);
  if (!empty.ok) assert.equal(empty.emptyTo, true);
  // a CC that duplicates a To is dropped rather than sending twice
  const dup = validateRecipientEdit("a@talabat.test.qa", "a@talabat.test.qa");
  assert.equal(dup.ok, true);
  if (dup.ok) assert.deepEqual(dup.value.cc, []);
});

test("21: BCC is honestly reported as unsupported rather than silently dropped", () => {
  assert.equal(BCC_SUPPORTED, false);
  const transport = code("lib/mail/smtp.server.ts");
  assert.equal(transport.includes("bcc"), false, "the transport really has no bcc — the flag is not a lie");
});

// ── 10: Rafeeq is untouched ──────────────────────────────────────────────────

test("22: the Rafeeq send path is not modified by this step", () => {
  const rafeeq = code("lib/rafeeq/email-send.server.ts");
  assert.ok(rafeeq.includes("rafeeq_email_deliveries"), "still logs to its own table");
  assert.ok(rafeeq.includes("planRafeeqEmailSend"), "still uses its own planner");
  assert.equal(rafeeq.includes("talabat"), false, "no Talabat coupling leaked in");
  const rafeeqPlanner = code("lib/export/rafeeq/email-send.ts");
  assert.ok(rafeeqPlanner.includes("planRafeeqEmailSend"));
  assert.equal(rafeeqPlanner.includes("sender_not_authenticated"), false,
    "Rafeeq's own gate set is unchanged by the Talabat work");
});

// ── 11: nothing sends, anywhere in this suite ────────────────────────────────

test("23: no test here can transmit — the only transport call sites are guarded", () => {
  const server = code("lib/talabat/email-send.server.ts");
  const sendSites = (server.match(/sendMailViaSmtp\(/g) ?? []).length;
  assert.equal(sendSites, 1, "exactly one transport call site");
  const sendFn = server.slice(server.indexOf("export async function sendTalabatEmail"));
  assert.ok(sendFn.indexOf("planTalabatEmailSend(") < sendFn.indexOf("sendMailViaSmtp("),
    "planning happens before the transport is touched");
  assert.ok(sendFn.includes("if (!plan.ok)"), "and a failed plan returns before it");
});

test("24: credentials never reach any surface this step adds", () => {
  for (const rel of [
    "lib/talabat/email-send.server.ts",
    "app/api/settings/email/route.ts",
    "app/api/export/talabat/email/[kind]/route.ts",
    "app/(app)/settings/email/page.tsx",
  ]) {
    const src = raw(rel);
    for (const secret of ["MAIL_PASSWORD", "MAIL_USERNAME", "MAIL_HOST", "SERVICE_ROLE"]) {
      assert.equal(src.includes(secret), false, `${rel} must not reference ${secret}`);
    }
  }
  // the settings DTO carries only booleans + variable names for diagnostics
  const server = code("lib/talabat/email-send.server.ts");
  assert.ok(server.includes("blockingMailEnvNames"), "names only");
  assert.equal(server.includes("config.password"), false);
  assert.equal(server.includes("config.username"), false);
});

test("25: both API routes are owner-gated on every method", () => {
  for (const rel of ["app/api/export/talabat/email/[kind]/route.ts", "app/api/settings/email/route.ts"]) {
    const src = code(rel);
    const methods = (src.match(/export async function (GET|POST)/g) ?? []).length;
    const gates = (src.match(/await requireOwner\(\)/g) ?? []).length;
    assert.equal(gates, methods, `${rel}: every method must call requireOwner`);
    assert.ok(methods >= 2, `${rel} should expose GET and POST`);
  }
});

test("26: the settings screen reads on the SERVER behind the owner gate", () => {
  const page = code("app/(app)/settings/email/page.tsx");
  assert.equal(page.includes("'use client'"), false, "the page itself must not be a client component");
  assert.ok(page.includes("await requireOwner()"), "owner-gated before any data is read");
  assert.ok(page.includes("getEmailSettings()"), "reads the settings server-side, not over fetch");
  // the only client part is the editor, and it can save but never send
  const form = code("app/(app)/settings/email/recipients-form.tsx");
  assert.ok(form.includes("'use client'"));
  assert.ok(form.includes("/api/settings/email"));
  for (const forbidden of ["/api/export/talabat/email", "sendTalabatEmail", "confirm: true"]) {
    assert.equal(form.includes(forbidden), false, `the settings form must not ${forbidden}`);
  }
});
