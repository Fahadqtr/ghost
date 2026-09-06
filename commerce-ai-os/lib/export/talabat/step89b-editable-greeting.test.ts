// STEP 89B — the greeting belongs to the owner, not to the template.
//
// "Dear Talabat Team," was welded into four places in the template module. It
// is the right opening for a broadcast to a desk and the wrong one for a note
// to a named person, and a partner email that addresses the wrong party reads
// as a form letter however careful the rest of it is.
//
// So the greeting is now written per send. Three things have to hold for that
// to be trustworthy:
//
//   • ONE source — the string the owner typed reaches the HTML, the plain text
//     and the transport, with no second greeting anywhere;
//   • BOUND — it is inside the confirmation token, so editing it after ticking
//     the box invalidates the confirmation, exactly as editing To does;
//   • NEVER SUBSTITUTED — a cleared field blocks the send. Quietly restoring
//     the default would send an opening the owner had deliberately removed.
//
// node --conditions=react-server --experimental-strip-types --test lib/export/talabat/step89b-editable-greeting.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_TALABAT_GREETING, normalizeGreeting,
  buildTalabatUpdateEmail, buildTalabatNewProductsEmail, buildTalabatBarcodeCorrectionEmail,
} from "./email-templates.ts";
import {
  confirmationToken, checkConfirmation, evaluateWorkflowGate, presentForMode,
  WORKFLOW_BLOCK_AR, OFFICIAL_SEND_ENABLED,
  type ConfirmationSubject, type WorkflowGateInput,
} from "./email-workflow.ts";

const HERE = join(fileURLToPath(new URL(".", import.meta.url)));
const APP_ROOT = join(HERE, "../../..");
const raw = (rel: string): string => readFileSync(join(APP_ROOT, rel), "utf8");
// Scan CODE, not prose: the greeting string appears all over this file's own
// explanations, and none of that should satisfy or trip a guard.
const code = (rel: string): string =>
  raw(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const TEMPLATES = "lib/export/talabat/email-templates.ts";
const GATE = "lib/export/talabat/email-workflow.ts";
const SERVER = "lib/talabat/email-workflow.server.ts";
const ROUTE = "app/api/export/talabat/email/workflow/[kind]/route.ts";
const UI = "app/(v2)/v2/operations/channels/talabat-email/TalabatEmailWorkflow.tsx";

const CUSTOM = "Dear Ms. July,";
const LINK = { url: "https://storage.example.test/o/signed?t=1", expiresAtIso: "2026-09-14T10:00:00.000Z" };

const subject = (over: Partial<ConfirmationSubject> = {}): ConfirmationSubject => ({
  kind: "existing_updates", mode: "test", from: "sender@malikas.test.qa",
  to: ["a@talabat.test.qa"], cc: [], subject: "[TEST] s",
  greeting: DEFAULT_TALABAT_GREETING,
  attachmentFilenames: ["w.xlsx"], runFingerprint: "r1.x", ...over,
});
const gate = (over: Partial<WorkflowGateInput> = {}): WorkflowGateInput => ({
  mode: "test", senderVerified: true, artifactPresent: true, artifactFresh: true,
  recipientPresent: true, recipientValid: true, greetingPresent: true, sizeWithinLimit: true,
  confirmation: { ok: true }, deliveryLogReady: true, ...over,
});

// ── 1. the default is a prefill ──────────────────────────────────────────────

test("1. the default greeting is exactly the approved one", () => {
  assert.equal(DEFAULT_TALABAT_GREETING, "Dear Talabat Team,");
});

test("2. omitting the greeting uses the default, in both bodies", () => {
  const a = buildTalabatUpdateEmail("u.xlsx", { products: 1, rows: 1 });
  assert.ok(a.bodyText.startsWith(DEFAULT_TALABAT_GREETING));
  assert.ok(a.bodyHtml !== null && a.bodyHtml.includes(`<p>${DEFAULT_TALABAT_GREETING}</p>`));

  const b = buildTalabatNewProductsEmail("n.xlsx", "i.zip", { sendable: true });
  assert.ok(b.bodyText.startsWith(DEFAULT_TALABAT_GREETING));
  assert.ok(b.bodyHtml !== null && b.bodyHtml.includes(`<p>${DEFAULT_TALABAT_GREETING}</p>`));
});

test("3. the UI offers the default as a PREFILL, not as a literal in the template", () => {
  // exactly two occurrences of the phrase in the template module's CODE: the
  // constant's own definition, and Email C's use of that constant is by NAME —
  // so any second literal is a greeting that escaped the constant.
  const literals = (code(TEMPLATES).match(/Dear Talabat Team,/g) ?? []).length;
  assert.equal(literals, 1, "the phrase is written once, as the constant");
  assert.match(code(UI), /useState\(DEFAULT_TALABAT_GREETING\)/);
});

// ── 2. the owner's greeting is the one that ships ────────────────────────────

test("4. a custom greeting replaces the default in Email A — HTML and text", () => {
  const a = buildTalabatUpdateEmail("u.xlsx", { products: 3, rows: 4 }, CUSTOM);
  assert.ok(a.bodyText.startsWith(CUSTOM));
  assert.ok(!a.bodyText.includes(DEFAULT_TALABAT_GREETING));
  assert.ok(a.bodyHtml !== null);
  assert.ok(a.bodyHtml.includes(`<p>${CUSTOM}</p>`));
  assert.ok(!a.bodyHtml.includes(DEFAULT_TALABAT_GREETING));
});

test("5. a custom greeting replaces the default in Email B — HTML and text", () => {
  const b = buildTalabatNewProductsEmail("n.xlsx", "i.zip", {
    sendable: true, imagesLink: LINK, summary: { products: 2, rows: 2, images: 5 },
  }, CUSTOM);
  assert.ok(b.bodyText.startsWith(CUSTOM));
  assert.ok(!b.bodyText.includes(DEFAULT_TALABAT_GREETING));
  assert.ok(b.bodyHtml !== null);
  assert.ok(b.bodyHtml.includes(`<p>${CUSTOM}</p>`));
  assert.ok(!b.bodyHtml.includes(DEFAULT_TALABAT_GREETING));
});

test("6. every example the owner gave renders verbatim", () => {
  for (const g of ["Dear Talabat Team,", "Dear July,", "Dear Ms. July,", "Dear Talabat Content Team,"]) {
    const a = buildTalabatUpdateEmail("u.xlsx", undefined, g);
    assert.ok(a.bodyText.startsWith(g), g);
    assert.ok(a.bodyHtml !== null && a.bodyHtml.includes(`<p>${g}</p>`), g);
  }
});

test("7. the greeting is HTML-escaped, like every other interpolated value", () => {
  const a = buildTalabatUpdateEmail("u.xlsx", undefined, 'Dear <b>July</b> & co,');
  assert.ok(a.bodyHtml !== null);
  assert.ok(a.bodyHtml.includes("Dear &lt;b&gt;July&lt;/b&gt; &amp; co,"));
  assert.ok(!a.bodyHtml.includes("<b>July</b>"));
});

test("8. there is no second greeting anywhere in the body", () => {
  const b = buildTalabatNewProductsEmail("n.xlsx", "i.zip", {
    sendable: true, imagesLink: LINK, categoryRequests: ["All Summer And Camping Supplies"],
  }, CUSTOM);
  assert.ok(b.bodyHtml !== null);
  assert.equal((b.bodyHtml.match(/Dear /g) ?? []).length, 1);
  assert.equal((b.bodyText.match(/Dear /g) ?? []).length, 1);
});

test("9. preview and transport read the SAME rendered strings", () => {
  const src = code(SERVER);
  // one resolution, used by the renderer, the token and the gate
  assert.match(src, /const greeting = normalizeGreeting\(input\.greetingRaw\);/);
  assert.match(src, /const greetingForBody = greeting \?\? DEFAULT_TALABAT_GREETING;/);
  // the builders receive it…
  assert.equal((src.match(/\}, greetingForBody\)/g) ?? []).length, 2, "both builders");
  // …the token carries it…
  assert.match(src, /greeting: greetingForBody, attachmentFilenames: files,/);
  // …and the transport sends the preview's own body, not a re-render
  assert.match(src, /html: p\.bodyHtml \?\? undefined,/);
  assert.match(src, /text: p\.bodyText,/);
  // the send re-checks against the greeting the preview reported
  assert.match(src, /subject: p\.subject, greeting: p\.greeting,/);
});

test("10. test mode does not disturb the greeting", () => {
  const a = buildTalabatUpdateEmail("u.xlsx", undefined, CUSTOM);
  const p = presentForMode("test", a.subject, a.bodyText, a.bodyHtml);
  assert.ok(p.bodyText.includes(CUSTOM));
  assert.ok(p.bodyHtml !== null && p.bodyHtml.includes(`<p>${CUSTOM}</p>`));
  // the notice goes ABOVE the greeting, not in place of it
  assert.ok(p.bodyHtml.indexOf("INTERNAL TEST") < p.bodyHtml.indexOf(CUSTOM));
});

// ── 3. bound to the confirmation ─────────────────────────────────────────────

test("11. changing the greeting invalidates a held confirmation", () => {
  const token = confirmationToken(subject());
  const check = checkConfirmation(token, subject({ greeting: CUSTOM }));
  assert.equal(check.ok, false);
  if (!check.ok) assert.equal(check.reason, "stale");
});

test("12. an unchanged greeting keeps the confirmation valid", () => {
  const token = confirmationToken(subject({ greeting: CUSTOM }));
  assert.deepEqual(checkConfirmation(token, subject({ greeting: CUSTOM })), { ok: true });
});

test("13. surrounding whitespace is not a different message", () => {
  const token = confirmationToken(subject({ greeting: CUSTOM }));
  assert.deepEqual(checkConfirmation(token, subject({ greeting: `  ${CUSTOM}  ` })), { ok: true });
});

test("14. the token shape was versioned when the greeting joined it", () => {
  assert.ok(confirmationToken(subject()).startsWith("c2|"),
    "an older token can never accidentally match the new shape");
  assert.ok(confirmationToken(subject()).includes(DEFAULT_TALABAT_GREETING));
});

// ── 4. empty is a refusal, never a default ───────────────────────────────────

test("15. normalizeGreeting trims, and rejects anything blank", () => {
  assert.equal(normalizeGreeting("  Dear July,  "), "Dear July,");
  assert.equal(normalizeGreeting(""), null);
  assert.equal(normalizeGreeting("   "), null);
  assert.equal(normalizeGreeting("\t\n "), null);
  assert.equal(normalizeGreeting(null), null);
  assert.equal(normalizeGreeting(undefined), null);
});

test("16. a missing greeting blocks the send", () => {
  const blocks = evaluateWorkflowGate(gate({ greetingPresent: false }));
  assert.ok(blocks.includes("greeting_missing"));
  assert.ok(WORKFLOW_BLOCK_AR.greeting_missing.length > 0);
  // and it does not block when present
  assert.equal(evaluateWorkflowGate(gate()).includes("greeting_missing"), false);
});

test("17. a blank greeting is NEVER silently replaced with the default", () => {
  const src = code(SERVER);
  // presence is decided from the normalized value, not from the body string
  assert.match(src, /const greetingPresent = greeting !== null;/);
  assert.match(src, /greetingPresent,/);
  // the route forwards a missing parameter as BLANK, not as the default
  const route = code(ROUTE);
  assert.match(route, /greetingRaw: url\.searchParams\.get\("greeting"\) \?\? "",/);
  assert.match(route, /greetingRaw: str\(body\.greeting\),/);
  assert.ok(!route.includes("DEFAULT_TALABAT_GREETING"), "the route never supplies a greeting");
});

test("18. the send path re-evaluates presence rather than trusting the form", () => {
  const src = code(SERVER);
  const send = src.slice(src.indexOf("export async function sendTalabatTestEmail"));
  assert.match(send, /greetingPresent: p\.greetingPresent,/);
  // the preview it re-derives is built from the same input, in test mode
  assert.match(send, /buildWorkflowPreview\(\{ \.\.\.input, mode: "test" \}\)/);
});

// ── 5. the screen, and what did not change ───────────────────────────────────

test("19. the V2 form has the greeting field, labelled in both languages", () => {
  const ui = raw(UI);
  assert.ok(ui.includes("التحية"), "Arabic label");
  assert.ok(ui.includes("Greeting"), "English label");
  assert.match(ui, /value=\{greeting\} onChange=\{\(e\) => edit\(setGreeting\)\(e\.target\.value\)\}/);
});

test("20. editing the greeting clears the held confirmation in the UI too", () => {
  const ui = code(UI);
  // `edit` is the helper that drops the token and the stale preview
  assert.match(ui, /function edit\(setter: \(v: string\) => void\) \{\s*\n?\s*return \(v: string\) => \{ setter\(v\); setConfirmedToken\(null\); setPreview\(null\); \};/);
  assert.match(ui, /edit\(setGreeting\)/);
});

test("21. the greeting reaches both the preview request and the send request", () => {
  const ui = code(UI);
  assert.match(ui, /new URLSearchParams\(\{ mode: "test", to, cc, greeting,/);
  assert.match(ui, /JSON\.stringify\(\{ to, cc, greeting, run, confirmationToken: confirmedToken \}\)/);
});

test("22. Email C is untouched — review-only, so there is no send to greet for", () => {
  const c = buildTalabatBarcodeCorrectionEmail("review.xlsx");
  assert.equal(c.sendable, false);
  assert.equal(c.bodyHtml, null);
  assert.ok(c.bodyText.includes(DEFAULT_TALABAT_GREETING));
});

test("23. nothing about recipients, sender or the send gate moved", () => {
  const src = code(SERVER);
  for (const kept of [
    "resolveSendRecipients(saved,", "validateRecipients(", "readSenderStatus()",
    "confirmationToken(", "checkConfirmation(", "signImagesLink", "verifyArtifactScope(",
  ]) {
    assert.ok(src.includes(kept), `${kept} still present`);
  }
  assert.ok(!/@talabat\.com/.test(src), "no hard-coded recipient");
  assert.equal(OFFICIAL_SEND_ENABLED, false);
});

test("24. no mail is sent by anything this step touched", () => {
  for (const file of [TEMPLATES, GATE, UI]) {
    const src = code(file);
    for (const f of ["sendMailViaSmtp", "nodemailer"]) {
      assert.ok(!src.includes(f), `${file} must not reach the transport (${f})`);
    }
  }
});
