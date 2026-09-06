// STEP 86 — Email Settings is a V2 screen, and a recipient is never a
// commitment the system makes on its own.
//
// Two policies are under test.
//
//   1. V2 ONLY. New email UI lives at /v2/settings/email, reachable from the V2
//      sidebar, and the legacy page gains nothing. "Gains nothing" is checked
//      against the legacy file's actual content, not against intent.
//
//   2. NO HARD-CODED RECIPIENT. july.real@talabat.com is a saved convenience
//      value in a database row — it must not appear in any source file, and
//      every send must be able to go somewhere else.
//
// node --conditions=react-server --experimental-strip-types --test lib/v2/step86-email-settings.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { V2_NAV_LINKS, groupNavLinks, activeNavHref } from "./nav.ts";
import {
  resolveSendRecipients, parseStoredRecipients, isChannelConfigured,
  RECIPIENT_SETTING_KEYS, BCC_SUPPORTED, type ChannelRecipients,
} from "../mail/recipient-settings.ts";
import { DEFAULT_SENDER_IDENTITY, resolveSenderIdentity } from "../mail/sender-identity.ts";
import { readMailConfig } from "../mail/config.ts";
import { checkSenderTransport } from "../export/talabat/email-send.ts";

const HERE = join(fileURLToPath(new URL(".", import.meta.url)));
const APP_ROOT = join(HERE, "../..");
const raw = (rel: string): string => readFileSync(join(APP_ROOT, rel), "utf8");
const code = (rel: string): string =>
  raw(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const V2_PAGE = "app/(v2)/v2/settings/email/page.tsx";
const V2_EDITOR = "app/(v2)/v2/settings/email/RecipientEditor.tsx";
const LEGACY_PAGE = "app/(app)/settings/email/page.tsx";
const TARGET = "fahad@malikasuniverse.com";
const OLD = "fahad@gulfmedia.qa";

// ── 1. the V2 screen exists and follows V2 conventions ───────────────────────

test("1: Email Settings exists in V2 at /v2/settings/email", () => {
  const page = code(V2_PAGE);
  assert.ok(page.includes("export default async function"), "a V2 server component");
  assert.equal(page.includes('"use client"'), false, "the page itself is not a client component");
  assert.ok(page.includes('export const dynamic = "force-dynamic"'), "matches the V2 settings convention");
});

test("2: it is owner-gated the way every other V2 settings page is", () => {
  const page = code(V2_PAGE);
  assert.ok(page.includes("await isOwner()"), "owner check before any data is read");
  assert.ok(page.includes("OWNER_ONLY_DENIED"), "and the same constant denial");
  // the denial must come BEFORE the settings read, not after
  assert.ok(page.indexOf("isOwner()") < page.indexOf("getEmailSettings()"));
});

test("3: the V2 sidebar links to it under الإعدادات", () => {
  const link = V2_NAV_LINKS.find((l) => l.href === "/v2/settings/email");
  assert.ok(link, "the nav entry exists");
  assert.equal(link!.label, "البريد");
  assert.equal(link!.section, "الإعدادات");
  assert.equal(link!.external, undefined, "it is an in-shell V2 page, not a legacy link");
  // it groups with the other settings entries and highlights correctly
  const settings = groupNavLinks().find((s) => s.title === "الإعدادات");
  assert.ok(settings!.links.some((l) => l.href === "/v2/settings/email"));
  assert.equal(activeNavHref("/v2/settings/email"), "/v2/settings/email");
});

test("4: no duplicate nav entry, and no legacy sidebar link was added", () => {
  const hrefs = V2_NAV_LINKS.map((l) => l.href);
  assert.equal(hrefs.filter((h) => h === "/v2/settings/email").length, 1);
  assert.equal(hrefs.includes("/settings/email"), false, "the legacy route must not be surfaced in V2 nav");
});

// ── 2. the backend is reused, not rebuilt ────────────────────────────────────

test("5: the V2 page reuses the existing email backend and adds none of its own", () => {
  const page = code(V2_PAGE);
  assert.ok(page.includes("getEmailSettings"), "reads the same context the send path uses");
  for (const forbidden of ["nodemailer", "createTransport", "sendMailViaSmtp", "readMailConfig", "process.env", "createAdminClient"]) {
    assert.equal(page.includes(forbidden), false, `the V2 page must not contain ${forbidden}`);
  }
  const editor = code(V2_EDITOR);
  assert.ok(editor.includes("/api/settings/email"), "saving goes through the existing route");
  for (const forbidden of ["nodemailer", "supabase", "createClient", "/api/export/talabat/email"]) {
    assert.equal(editor.includes(forbidden), false, `the editor must not contain ${forbidden}`);
  }
});

test("6: there is still exactly ONE SMTP transport in the codebase", () => {
  const transport = code("lib/mail/smtp.server.ts");
  assert.ok(transport.includes("nodemailer"), "the one transport lives here");
  for (const rel of [V2_PAGE, V2_EDITOR, "lib/talabat/email-send.server.ts", "lib/mail/recipient-settings.ts"]) {
    assert.equal(code(rel).includes("createTransport"), false, `${rel} must not build a transport`);
  }
});

// ── 3. sender status is the REAL one ─────────────────────────────────────────

test("7: verified/unverified comes from the transport, not from being the default", () => {
  const env = (from: string) => ({ MAIL_HOST: "h", MAIL_USERNAME: "u", MAIL_PASSWORD: "p", MAIL_FROM_ADDRESS: from });
  const matched = resolveSenderIdentity(DEFAULT_SENDER_IDENTITY, readMailConfig(env(TARGET)));
  assert.equal(matched.verification, "verified");
  assert.equal(matched.selectable, true);
  assert.equal(checkSenderTransport(TARGET, TARGET).match, true);

  const mismatched = resolveSenderIdentity(DEFAULT_SENDER_IDENTITY, readMailConfig(env(OLD)));
  assert.equal(mismatched.verification, "unverified");
  assert.equal(mismatched.selectable, false, "being the registry default proves nothing");
  assert.equal(DEFAULT_SENDER_IDENTITY.isDefault, true, "…even though it IS the default");

  assert.equal(resolveSenderIdentity(DEFAULT_SENDER_IDENTITY, null).verification, "no_transport");
});

test("8: the page shows موثّق only for a real match, and blocks otherwise", () => {
  const page = raw(V2_PAGE);
  assert.ok(page.includes("موثّق لدى مزوّد البريد"), "the verified wording exists");
  assert.ok(page.includes("غير موثّق"), "and so does the unverified wording");
  assert.ok(page.includes("الإرسال متوقف"), "a mismatch says sending is blocked");
  // the blocked banner is driven by `selectable`, i.e. by the transport check
  assert.ok(code(V2_PAGE).includes("s.selectable"), "blocking reads the resolved selectability");
});

test("9: no credential reaches the V2 screen", () => {
  for (const rel of [V2_PAGE, V2_EDITOR]) {
    const src = raw(rel);
    for (const secret of ["MAIL_PASSWORD", "MAIL_USERNAME", "MAIL_HOST", "SERVICE_ROLE", "password"]) {
      assert.equal(src.includes(secret), false, `${rel} must not reference ${secret}`);
    }
  }
  // the diagnostic surfaces variable NAMES only
  assert.ok(code(V2_PAGE).includes("blockingEnvNames"));
});

// ── 4. recipients: saved default, editable per send ──────────────────────────

test("10: july.real@talabat.com is a stored value, never a literal in source", () => {
  const scanned = [
    V2_PAGE, V2_EDITOR, "lib/mail/recipient-settings.ts", "lib/talabat/email-send.server.ts",
    "lib/export/talabat/email-send.ts", "app/api/settings/email/route.ts",
    "app/api/export/talabat/email/[kind]/route.ts", "lib/v2/nav.ts",
  ];
  for (const rel of scanned) {
    assert.equal(raw(rel).includes("july.real"), false, `${rel} must not hard-code the Talabat recipient`);
    const hits = code(rel).split("\n").filter((l) => /[A-Za-z0-9._%-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(l));
    assert.deepEqual(hits, [], `${rel} must contain no literal email address`);
  }
  assert.equal(RECIPIENT_SETTING_KEYS.talabat, "talabat_email_recipient");
});

test("11: both channels are editable from the V2 screen", () => {
  const page = code(V2_PAGE);
  assert.ok(page.includes('key: "talabat"') && page.includes('key: "rafeeq"'), "both channels are rendered");
  assert.equal((page.match(/<RecipientEditor/g) ?? []).length, 1, "one editor component, rendered per channel");
  const editor = code(V2_EDITOR);
  assert.ok(editor.includes("setTo(") && editor.includes("setCc("), "To and CC are both editable");
  assert.ok(editor.includes('channel, to, cc'), "the save carries the channel and both fields");
});

test("12: a saved recipient prefills a send but never fixes it", () => {
  const saved: ChannelRecipients = { to: ["saved@talabat.test.qa"], cc: [] };
  // no override → the saved default is used, and its source is reported
  const def = resolveSendRecipients(saved, null);
  assert.equal(def.ok, true);
  if (def.ok) { assert.deepEqual(def.value.to, ["saved@talabat.test.qa"]); assert.equal(def.source, "saved"); }

  // an override wins for THIS send, without touching the saved value
  const over = resolveSendRecipients(saved, { toRaw: "someone.else@talabat.test.qa", ccRaw: "" });
  assert.equal(over.ok, true);
  if (over.ok) { assert.deepEqual(over.value.to, ["someone.else@talabat.test.qa"]); assert.equal(over.source, "override"); }
  assert.deepEqual(saved.to, ["saved@talabat.test.qa"], "the saved default is unchanged");
});

test("13: a blank field means 'use the default', not 'send to nobody'", () => {
  const saved: ChannelRecipients = { to: ["saved@talabat.test.qa"], cc: [] };
  const blank = resolveSendRecipients(saved, { toRaw: "  ", ccRaw: "" });
  assert.equal(blank.ok, true);
  if (blank.ok) assert.equal(blank.source, "saved", "an untouched prefill behaves as the prefill it shows");

  // a CC-only override keeps the saved To rather than dropping it
  const ccOnly = resolveSendRecipients(saved, { toRaw: "", ccRaw: "watcher@talabat.test.qa" });
  assert.equal(ccOnly.ok, true);
  if (ccOnly.ok) {
    assert.deepEqual(ccOnly.value.to, ["saved@talabat.test.qa"]);
    assert.deepEqual(ccOnly.value.cc, ["watcher@talabat.test.qa"]);
  }
});

test("14: a typo in the override is REFUSED, never quietly replaced by the default", () => {
  const saved: ChannelRecipients = { to: ["saved@talabat.test.qa"], cc: [] };
  const typo = resolveSendRecipients(saved, { toRaw: "orders@talabat", ccRaw: "" });
  assert.equal(typo.ok, false);
  if (!typo.ok) {
    assert.equal(typo.error, "invalid_override");
    assert.deepEqual(typo.invalid, ["orders@talabat"]);
  }
  // a placeholder domain is refused too — it is syntactically valid but undeliverable
  const placeholder = resolveSendRecipients(saved, { toRaw: "a@example.com", ccRaw: "" });
  assert.equal(placeholder.ok, false);
});

test("15: with nothing saved and nothing typed, the send is refused", () => {
  const empty: ChannelRecipients = { to: [], cc: [] };
  const none = resolveSendRecipients(empty, null);
  assert.equal(none.ok, false);
  if (!none.ok) assert.equal(none.error, "not_configured");
  // but a typed address alone is enough — a channel need not have a default
  const typed = resolveSendRecipients(empty, { toRaw: "one.off@talabat.test.qa", ccRaw: "" });
  assert.equal(typed.ok, true);
  if (typed.ok) assert.equal(typed.source, "override");
});

test("16: the send path actually honours the override", () => {
  const server = code("lib/talabat/email-send.server.ts");
  assert.ok(server.includes("resolveSendRecipients(saved, req.recipientOverride)"), "the send resolves per-send");
  assert.ok(server.includes("recipientOverrideAllowed: true"), "and the preflight says so");
  const route = code("app/api/export/talabat/email/[kind]/route.ts");
  assert.ok(route.includes("recipientOverride:"), "the route carries the owner's choice");
  assert.ok(route.includes("body.to") && route.includes("body.cc"));
});

// ── 5. the legacy page is untouched ──────────────────────────────────────────

test("17: the legacy page gained no new functionality", () => {
  const legacy = code(LEGACY_PAGE);
  for (const forbidden of [
    "resolveSendRecipients", "recipientOverride", "artifactPath", "runFingerprint",
    "generateSafeUpdateArtifact", "generateNewProductsArtifact",
    "/api/export/talabat/email", "confirm: true", "sendTalabatEmail",
  ]) {
    assert.equal(legacy.includes(forbidden), false, `legacy must not gain ${forbidden}`);
  }
  // it still does exactly what it did — read settings server-side and save
  // through its own client form, which is where its fetch lives.
  assert.ok(legacy.includes("getEmailSettings()"));
  assert.ok(code("app/(app)/settings/email/recipients-form.tsx").includes("/api/settings/email"));
});

test("18: new email UI work landed in V2, not in the legacy tree", () => {
  const legacy = raw(LEGACY_PAGE);
  const v2 = raw(V2_PAGE);
  // the per-send policy note is a STEP 86 addition and belongs only to V2
  assert.ok(v2.includes("قيم افتراضية"), "V2 states the saved-value-is-a-default rule");
  assert.equal(legacy.includes("قيم افتراضية"), false, "the legacy page was not rewritten to match");
});

// ── 6. nothing sends ─────────────────────────────────────────────────────────

test("19: no surface added here can transmit", () => {
  for (const rel of [V2_PAGE, V2_EDITOR, "lib/mail/recipient-settings.ts", "lib/v2/nav.ts"]) {
    const src = code(rel);
    for (const forbidden of ["sendMailViaSmtp", "nodemailer", "sendMail(", "transporter"]) {
      assert.equal(src.includes(forbidden), false, `${rel} must not be able to send`);
    }
  }
  assert.equal(BCC_SUPPORTED, false, "still honestly reported as unsupported");
});

test("20: the stored production shape reads back through the shared model", () => {
  // exactly the jsonb now in app_settings: { to, cc }
  const parsed = parseStoredRecipients({ to: "someone@talabat.test.qa", cc: "" });
  assert.deepEqual(parsed, { to: ["someone@talabat.test.qa"], cc: [] });
  assert.equal(isChannelConfigured(parsed), true);
  // and Rafeeq's older bare shape still reads, so its saved value is not stranded
  assert.equal(isChannelConfigured(parseStoredRecipients({ to: "amina@gorafeeq.test.qa" })), true);
});
