// STEP 54 — the APPROVED Malikas signature is installed VERBATIM.
//
// The approved artwork is committed at lib/mail/approved/malikas-universe-signature_3.html
// as the provenance record. This suite proves APPROVED_SIGNATURE_HTML is that
// file's own delimited fragment byte-for-byte — so "installed verbatim" is a
// continuously checked fact, not a claim in a commit message. If someone
// restyles, reflows or minifies the constant, or edits the identity inside it,
// these tests fail.
// node --conditions=react-server --experimental-strip-types --test lib/export/rafeeq/step54-signature.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { APPROVED_SIGNATURE_HTML, signatureInstalled, renderSignOffHtml, renderSignOffText } from "../../mail/malikas-signature.ts";
import { buildRafeeqEmailDraft, type RafeeqEmailContext } from "./email-draft.ts";
import { planRafeeqEmailSend } from "./email-send.ts";

const HERE = join(fileURLToPath(new URL(".", import.meta.url)));
const APPROVED_FILE = join(HERE, "../../mail/approved/malikas-universe-signature_3.html");

/** The fragment the approved file itself delimits for copying. */
function approvedFragment(): string {
  const s = readFileSync(APPROVED_FILE, "utf8");
  const open = "<!-- ===== COPY FROM HERE ===== -->";
  const close = "<!-- ===== COPY TO HERE ===== -->";
  const a = s.indexOf(open);
  const b = s.indexOf(close);
  assert.ok(a >= 0 && b > a, "the approved file still carries its COPY FROM/TO markers");
  return s.slice(a + open.length, b).replace(/^\n+|\n+$/g, "");
}

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
  packageFingerprint: "aaaabbbbccccdddd",
  correction: true,
  downloadLink: { url: "https://storage.example/signed/pkg?token=t", expiresAtIso: "2026-09-10T10:51:10.000Z" },
  ...over,
});

test("54.1: APPROVED_SIGNATURE_HTML is the approved file's fragment, byte-for-byte", () => {
  const frag = approvedFragment();
  assert.equal(APPROVED_SIGNATURE_HTML, frag, "installed markup differs from the approved file — it must be verbatim");
  assert.equal(Buffer.byteLength(APPROVED_SIGNATURE_HTML), Buffer.byteLength(frag));
  assert.equal(signatureInstalled(), true, "signature_not_installed = false");
});

test("54.2: only the document wrapper is excluded — nothing inside the table is dropped", () => {
  // A <!DOCTYPE>/<html>/<head>/<body> wrapper cannot nest inside an email body;
  // that exclusion is the ONLY permitted difference from the supplied file.
  for (const wrapper of ["<!DOCTYPE", "<html", "<head", "<body", "</html>", "</body>", "<title>"]) {
    assert.ok(!APPROVED_SIGNATURE_HTML.includes(wrapper), `wrapper ${wrapper} excluded`);
  }
  assert.ok(APPROVED_SIGNATURE_HTML.startsWith("<table"), "starts at the table");
  assert.ok(APPROVED_SIGNATURE_HTML.endsWith("</table>"), "ends at the table");
  // and the file contains nothing between the markers other than that table
  const file = readFileSync(APPROVED_FILE, "utf8");
  const inner = file.slice(file.indexOf("<body"), file.indexOf("</body>"));
  const strippedOfSig = inner.replace(APPROVED_SIGNATURE_HTML, "");
  assert.ok(!strippedOfSig.includes("<table"), "no second table in the approved file's body was left behind");
});

test("54.3: every approved asset URL, link and inline style survives", () => {
  const required = [
    // images — exact CDN URLs including their version query strings
    "https://cdn.shopify.com/s/files/1/0745/6151/9854/files/mu-sig-logo-v2.png?v=1788371700",
    "https://cdn.shopify.com/s/files/1/0745/6151/9854/files/mu-ic-mail.png?v=1788371524",
    "https://cdn.shopify.com/s/files/1/0745/6151/9854/files/mu-ic-phone.png?v=1788371525",
    "https://cdn.shopify.com/s/files/1/0745/6151/9854/files/mu-ic-web.png?v=1788371525",
    "https://cdn.shopify.com/s/files/1/0745/6151/9854/files/mu-sig-line-v2.gif?v=1788371393",
    // links
    'href="mailto:fahad@malikasuniverse.com"',
    'href="tel:+97433315315"',
    'href="https://malikasuniverse.com" target="_blank"',
    // identity, exactly as written in the artwork
    "Fahad Abdulaziz Ali",
    "Founder &amp; Managing Director",
    "Malika's Universe Trading",
    "fahad@malikasuniverse.com",
    "+974 3331 5315",
    "malikasuniverse.com",
    "MALIKA'S&nbsp;UNIVERSE&nbsp;TRADING",
    // structural styling that must not be "tidied"
    'width="600" style="width:600px;border-collapse:collapse',
    "border-right:1px solid #e3e3e3;",
    "letter-spacing:-0.2px;",
    "letter-spacing:3.5px;",
    'role="presentation"',
  ];
  for (const needle of required) {
    assert.ok(APPROVED_SIGNATURE_HTML.includes(needle), `preserved: ${needle}`);
  }
  // 5 images and 3 contact links, no more, no fewer
  assert.equal((APPROVED_SIGNATURE_HTML.match(/<img /g) ?? []).length, 5, "all five approved images");
  assert.equal((APPROVED_SIGNATURE_HTML.match(/<a href=/g) ?? []).length, 4, "logo + three contact links");
});

test("54.4: HTML_EMAIL_SIGNATURE_READY — the Rafeeq email carries the approved signature", () => {
  const signOff = renderSignOffHtml();
  assert.ok(signOff !== null, "the HTML sign-off renders");
  assert.ok(signOff.includes(APPROVED_SIGNATURE_HTML), "embedded verbatim");
  assert.ok(signOff.includes("Thank you for your support."), "approved closing");
  assert.ok(signOff.includes("Best regards,"), "approved regards line");

  const d = buildRafeeqEmailDraft(ctx());
  assert.ok(d.html.includes(APPROVED_SIGNATURE_HTML), "the built email body carries it verbatim");
  assert.ok(!d.blockers.includes("signature_not_installed"), "signature is no longer a blocker");
  assert.equal(d.sendable, true, "with a signed link AND the signature, the draft is sendable");
  assert.equal(
    planRafeeqEmailSend({
      configured: true,
      toRaw: "orders@rafeeq.qa", // a reserved domain would be blocked by STEP 55
      ccRaw: "",
      subject: d.subject,
      html: d.html,
      text: d.textEmail,
      attachments: [{ filename: "rafeeq_catalog.xlsx", bytes: 250_000, contentType: "application/octet-stream" }],
      attachmentMaxBytes: 20 * 1024 * 1024,
      draftBlockers: d.blockers,
    }).ok,
    true,
    "the send planner accepts it",
  );
});

test("54.5: the PR #706 plain-text sign-off is untouched", () => {
  assert.equal(
    renderSignOffText(),
    [
      "Thank you for your support.",
      "",
      "Best regards,",
      "",
      "Fahad Abdulaziz Ali",
      "Founder & Managing Director",
      "Malika's Universe Trading",
      "fahad@malikasuniverse.com",
      "+974 3331 5315",
      "malikasuniverse.com",
    ].join("\n"),
    "plain-text fallback unchanged",
  );
  const d = buildRafeeqEmailDraft(ctx());
  assert.ok(d.textEmail.trimEnd().endsWith("malikasuniverse.com"), "plain text still ends with the signature");
  // the plain text stays PLAIN — the artwork must never leak into it
  assert.ok(!d.textEmail.includes("<table"), "no markup in the plain-text body");
  assert.ok(!d.textEmail.includes("cdn.shopify.com"), "no image URLs in the plain-text body");
  assert.ok(!d.textEmail.includes("&nbsp;"), "no HTML entities in the plain-text body");
});

test("54.6: the fail-closed seam still works if the signature is ever emptied", () => {
  assert.equal(renderSignOffHtml(""), null, "empty ⇒ no HTML sign-off");
  assert.equal(signatureInstalled(""), false);
  assert.equal(signatureInstalled("   "), false);
  // and a missing link still blocks even now that the signature is installed
  const noLink = buildRafeeqEmailDraft(ctx({ downloadLink: null }));
  assert.equal(noLink.sendable, false, "no signed link ⇒ still unsendable");
  assert.deepEqual(noLink.blockers, ["missing_download_link"], "signature is not a blocker any more; the link still is");
  assert.ok(!noLink.html.includes("[INSERT"), "never a placeholder");
});

test("54.7: still ONE signature system, and it stays content-only", () => {
  const sig = readFileSync(join(HERE, "../../mail/malikas-signature.ts"), "utf8");
  const codeOnly = sig.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  for (const env of ["MAIL_FROM_ADDRESS", "MAIL_USERNAME", "MAIL_PASSWORD", "MAIL_HOST", "process.env"]) {
    assert.ok(!codeOnly.includes(env), `signature module code never references ${env}`);
  }
  // exactly one approved-signature constant, one HTML renderer, one text renderer
  assert.equal((sig.match(/export const APPROVED_SIGNATURE_HTML/g) ?? []).length, 1, "one approved-signature constant");
  assert.equal((sig.match(/export function renderSignOffHtml/g) ?? []).length, 1);
  assert.equal((sig.match(/export function renderSignOffText/g) ?? []).length, 1);
  // the Rafeeq draft is the only consumer, and it imports rather than re-declaring
  const draft = readFileSync(join(HERE, "./email-draft.ts"), "utf8");
  assert.ok(draft.includes('from "../../mail/malikas-signature.ts"'), "draft imports the shared signature");
  assert.ok(!draft.includes("<table role=\"presentation\""), "the draft does not carry its own copy of the artwork");
});
