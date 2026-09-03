// STEP 53 — Rafeeq email template + approved Malikas sign-off. Owner proofs:
//   1–4  the approved signature renders verbatim and carries the approved
//        identity (name, contact email, phone);
//   5    the unsafe filename-based "Previous package: <name>" wording is gone —
//        several builds legitimately share one filename;
//   6–8  the secure link and its expiry render, and a draft with no signed URL
//        is NOT sendable (fail closed) — no placeholder is ever emitted;
//   9–10 the package fingerprint is rendered from the SELECTED package only and
//        is never hardcoded in source;
//   11   the FULL CATALOG REPLACEMENT instruction renders;
//   12   the plain-text fallback carries the approved signature;
//   13   the existing option/workbook explanations survive unchanged.
// node --conditions=react-server --experimental-strip-types --test lib/export/rafeeq/step53-email-template.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildRafeeqEmailDraft, type RafeeqEmailContext } from "./email-draft.ts";
import { planRafeeqEmailSend, type RafeeqEmailSendPlanInput } from "./email-send.ts";
import {
  MALIKAS_SIGNATURE_IDENTITY,
  APPROVED_SIGNATURE_HTML,
  renderSignOffHtml,
  renderSignOffText,
  signatureInstalled,
  SIGNOFF_CLOSING,
  SIGNOFF_REGARDS,
} from "../../mail/malikas-signature.ts";

const HERE = join(fileURLToPath(new URL(".", import.meta.url)));
const src = (rel: string): string => readFileSync(join(HERE, rel), "utf8");
/** collapse HTML source wrapping so a sentence assertion is not defeated by line breaks. */
const flat = (s: string): string => s.replace(/\s+/g, " ");
/** strip comments — "never references X" must be about CODE, not prose about X. */
const code = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/** A stand-in for the approved artwork, with the traits that must survive. */
const SAMPLE_SIGNATURE_HTML =
  '<table style="border-collapse:collapse"><tr><td style="padding:0 12px 0 0">' +
  '<img src="https://cdn.malikasuniverse.com/sig/logo.png" width="72" alt="Malika&#39;s Universe" /></td>' +
  '<td style="font-family:Arial,sans-serif;font-size:13px;color:#111">' +
  "<b>Fahad Abdulaziz Ali</b><br/>Founder &amp; Managing Director<br/>Malika&#39;s Universe Trading<br/>" +
  '<a href="mailto:fahad@malikasuniverse.com" style="color:#0f766e">fahad@malikasuniverse.com</a><br/>' +
  '<a href="tel:+97433315315" style="color:#0f766e">+974 3331 5315</a><br/>' +
  '<a href="https://malikasuniverse.com" style="color:#0f766e">malikasuniverse.com</a></td></tr></table>';

const ctx = (over: Partial<RafeeqEmailContext> = {}): RafeeqEmailContext => ({
  mode: "FULL",
  filename: "rafeeq-full-2026-09-03.zip",
  generatedAt: "2026-09-03T10:27:09.817Z",
  productCount: 1343,
  physicalRowCount: 1454,
  productsWithOptions: 51,
  optionCount: 162,
  imageCount: 1343,
  warningCount: 0,
  zipBytes: 369_281_422,
  packageFingerprint: "03a327da9235fb40",
  correction: true,
  downloadLink: { url: "https://storage.example/signed/abc?token=xyz", expiresAtIso: "2026-09-10T10:27:09.000Z" },
  samePriceExample: { parentSku: "mk9001", title: "Lip Set", options: [{ name: "Pink", price: 45 }, { name: "Red", price: 45 }] },
  differingPriceExample: { parentSku: "mk9002", title: "Serum", options: [{ name: "30ml", price: 90 }, { name: "50ml", price: 140 }] },
  ...over,
});

const sendInput = (over: Partial<RafeeqEmailSendPlanInput> = {}): RafeeqEmailSendPlanInput => ({
  configured: true,
  toRaw: "rafeeq@example.com",
  ccRaw: "",
  subject: "s",
  html: "<div>b</div>",
  text: "b",
  attachments: [{ filename: "rafeeq_catalog.xlsx", bytes: 250_000, contentType: "application/octet-stream" }],
  attachmentMaxBytes: 20 * 1024 * 1024,
  draftBlockers: [],
  ...over,
});

test("1: the approved HTML signature renders VERBATIM — structure, inline styles, image URLs and links preserved", () => {
  const out = renderSignOffHtml(SAMPLE_SIGNATURE_HTML);
  assert.ok(out !== null, "renders when the approved markup is installed");
  assert.ok(out.includes(SAMPLE_SIGNATURE_HTML), "the approved markup is embedded byte-for-byte, never re-generated");
  assert.ok(out.includes('src="https://cdn.malikasuniverse.com/sig/logo.png"'), "image URL preserved");
  assert.ok(out.includes('href="mailto:fahad@malikasuniverse.com"'), "mailto link preserved");
  assert.ok(out.includes('href="https://malikasuniverse.com"'), "website link preserved");
  assert.ok(out.includes('style="border-collapse:collapse"'), "inline styles preserved");
  assert.ok(out.includes(SIGNOFF_CLOSING) && out.includes(SIGNOFF_REGARDS), "approved closing lines precede the signature");
  // The renderer never rewrites the markup it was given.
  assert.equal(renderSignOffHtml(SAMPLE_SIGNATURE_HTML), out, "deterministic — no per-call mutation");
});

test("2: the approved sign-off carries Fahad Abdulaziz Ali", () => {
  assert.equal(MALIKAS_SIGNATURE_IDENTITY.name, "Fahad Abdulaziz Ali");
  assert.equal(MALIKAS_SIGNATURE_IDENTITY.title, "Founder & Managing Director");
  assert.equal(MALIKAS_SIGNATURE_IDENTITY.company, "Malika's Universe Trading");
  assert.ok(renderSignOffText().includes("Fahad Abdulaziz Ali"), "plain text");
  assert.ok(renderSignOffHtml(SAMPLE_SIGNATURE_HTML)!.includes("Fahad Abdulaziz Ali"), "html");
});

test("3: fahad@malikasuniverse.com is the signature contact address", () => {
  assert.equal(MALIKAS_SIGNATURE_IDENTITY.email, "fahad@malikasuniverse.com");
  assert.ok(renderSignOffText().includes("fahad@malikasuniverse.com"));
  assert.ok(renderSignOffHtml(SAMPLE_SIGNATURE_HTML)!.includes("fahad@malikasuniverse.com"));
  // CONTENT ONLY: the signature must never touch the SMTP envelope.
  const sig = code(src("../../mail/malikas-signature.ts"));
  for (const env of ["MAIL_FROM_ADDRESS", "MAIL_USERNAME", "MAIL_PASSWORD", "MAIL_HOST", "process.env"]) {
    assert.ok(!sig.includes(env), `signature module code never references ${env}`);
  }
});

test("4: +974 3331 5315 is the signature phone number", () => {
  assert.equal(MALIKAS_SIGNATURE_IDENTITY.phone, "+974 3331 5315");
  assert.equal(MALIKAS_SIGNATURE_IDENTITY.website, "malikasuniverse.com");
  assert.ok(renderSignOffText().includes("+974 3331 5315"));
  assert.ok(renderSignOffHtml(SAMPLE_SIGNATURE_HTML)!.includes("+974 3331 5315"));
});

test("5: the unsafe filename-based previous-package wording is GONE", () => {
  const d = buildRafeeqEmailDraft(ctx());
  for (const body of [d.html, d.textEmail]) {
    assert.ok(!body.includes("Previous package:"), "no filename-based previous-package line");
    assert.ok(!body.includes("use this corrected package instead"), "old wording removed");
  }
  // The superseded package is identified by the LINK, not by a name.
  assert.ok(flat(d.html).includes("Please disregard any earlier catalog package shared by us and use <b>ONLY</b> the package provided through the secure download link in this email."), "approved HTML wording");
  assert.ok(
    d.textEmail.includes(
      "Please disregard any earlier catalog package shared by us and use ONLY the package provided through the secure download link in this email.",
    ),
    "approved plain-text wording",
  );
  assert.ok(d.html.includes("latest and authoritative version"), "authoritative sentence present");
  // and the previous FILENAME is not even an input any more.
  const draftSrc = src("./email-draft.ts");
  assert.ok(!draftSrc.includes("previousFilename"), "previousFilename is not part of the context type");
  const serverSrc = src("../../rafeeq/package-job.server.ts");
  assert.ok(!serverSrc.includes("previousFilename"), "the server no longer looks up a superseded filename");
});

test("6: the secure package link renders when available", () => {
  const d = buildRafeeqEmailDraft(ctx());
  assert.ok(d.html.includes("<h2>Package download</h2>"), "HTML section header");
  assert.ok(d.html.includes(">Download Full Catalog Package</a>"), "HTML button label");
  assert.ok(d.html.includes("https://storage.example/signed/abc?token=xyz"), "the real signed URL");
  assert.ok(d.textEmail.includes("PACKAGE DOWNLOAD"), "plain-text section header");
  assert.ok(d.textEmail.includes("Download Full Catalog Package"), "plain-text button label");
  assert.ok(d.textEmail.includes("https://storage.example/signed/abc?token=xyz"), "raw URL in plain text");
});

test("7: the link expiry renders in both bodies", () => {
  const d = buildRafeeqEmailDraft(ctx());
  assert.ok(d.html.includes("valid until <b>2026-09-10T10:27:09.000Z</b>"), "HTML expiry");
  assert.ok(d.textEmail.includes("Link valid until: 2026-09-10T10:27:09.000Z"), "plain-text expiry");
  const other = buildRafeeqEmailDraft(ctx({ downloadLink: { url: "https://s/x", expiresAtIso: "2027-01-01T00:00:00.000Z" } }));
  assert.ok(other.html.includes("2027-01-01T00:00:00.000Z"), "expiry is the ACTUAL link's, not a constant");
});

test("8: a missing signed link makes the draft UNSENDABLE — and no placeholder is ever emitted", () => {
  const d = buildRafeeqEmailDraft(ctx({ downloadLink: null }));
  assert.equal(d.sendable, false, "fails closed");
  assert.ok(d.blockers.includes("missing_download_link"), "the reason is named");
  for (const body of [d.html, d.textEmail]) {
    assert.ok(!body.includes("[INSERT"), "no placeholder token");
    assert.ok(!body.includes("INSERT CURRENT SECURE DOWNLOAD LINK HERE"), "no placeholder sentence");
  }
  // the send planner refuses it outright, before recipients/attachments
  const blocked = planRafeeqEmailSend(sendInput({ draftBlockers: d.blockers }));
  assert.deepEqual(blocked, { ok: false, error: "draft_not_sendable" });
  assert.equal(planRafeeqEmailSend(sendInput({ draftBlockers: [], toRaw: "" })).ok, false, "other gates still apply");
  // the real server passes the draft's blockers through
  assert.ok(src("../../rafeeq/email-send.server.ts").includes("draftBlockers: draft.value.blockers"), "server wires the gate");
});

test("9: the package fingerprint renders DYNAMICALLY from the selected package", () => {
  const d = buildRafeeqEmailDraft(ctx());
  assert.ok(d.html.includes("<code>03a327da9235fb40</code>"), "HTML fingerprint");
  assert.ok(d.textEmail.includes("Package fingerprint: 03a327da9235fb40"), "plain-text fingerprint");
  for (const body of [d.html, d.textEmail]) {
    assert.ok(flat(body).includes("Please verify that this fingerprint matches the package you import."), "verify sentence");
    assert.ok(flat(body).includes("Any earlier package with the same filename should be discarded."), "discard sentence");
  }
  // a DIFFERENT package renders ITS fingerprint
  // STEP 49: the VALUE appears exactly once in the HTML — the summary table
  // row. The paragraph below the table is the explanation only; repeating the
  // value there read as a duplicate in the delivered email.
  assert.equal(
    (d.html.match(/03a327da9235fb40/g) ?? []).length,
    1,
    "the fingerprint value is rendered exactly once in the HTML body",
  );
  assert.equal((d.textEmail.match(/03a327da9235fb40/g) ?? []).length, 1, "and exactly once in the plain text");
  assert.ok(
    d.html.includes("<th align=\"left\">Package fingerprint</th><td><code>03a327da9235fb40</code></td>"),
    "the one occurrence is the summary table row",
  );
  assert.ok(!d.html.includes("<b>Package fingerprint:</b>"), "no standalone fingerprint line below the table");

  const other = buildRafeeqEmailDraft(ctx({ packageFingerprint: "a2402a4d8d0a55fd" }));
  assert.ok(other.html.includes("a2402a4d8d0a55fd") && !other.html.includes("03a327da9235fb40"), "follows the package");
  // and a package without one renders NO fingerprint block rather than inventing one
  for (const missing of [null, undefined, "", "   "]) {
    const none = buildRafeeqEmailDraft(ctx({ packageFingerprint: missing }));
    assert.ok(!none.html.includes("Package fingerprint") && !none.textEmail.includes("Package fingerprint"), `absent for ${JSON.stringify(missing)}`);
  }
  assert.ok(src("../../rafeeq/package-job.server.ts").includes("packageFingerprint: state.artifact.manifestFingerprint"), "server feeds the real value");
});

test("10: NO package fingerprint is hardcoded in the template source", () => {
  for (const rel of ["./email-draft.ts", "../../mail/malikas-signature.ts", "./email-send.ts"]) {
    const s = src(rel);
    assert.ok(!s.includes("03a327da9235fb40"), `${rel} does not carry a specific fingerprint`);
    assert.ok(!s.includes("a2402a4d8d0a55fd"), `${rel} does not carry the superseded fingerprint`);
    const hex16 = s.match(/["'`][0-9a-f]{16}["'`]/g) ?? [];
    assert.deepEqual(hex16, [], `${rel} contains no 16-hex-digit literal that could be a fingerprint`);
  }
});

test("11: the FULL CATALOG REPLACEMENT instruction renders before the download section", () => {
  const d = buildRafeeqEmailDraft(ctx());
  const required = [
    "This package represents our complete current Rafeeq catalog.",
    "Please use it to fully update and align our Rafeeq catalog.",
    "Products not represented in this full catalog should no longer remain part of our active current catalog.",
  ];
  for (const line of required) {
    assert.ok(d.textEmail.includes(line), `plain text: ${line}`);
  }
  assert.ok(d.textEmail.includes("FULL CATALOG REPLACEMENT"), "plain-text header");
  assert.ok(d.html.includes("<h2>Full catalog replacement</h2>"), "HTML header");
  assert.ok(d.html.includes("complete current Rafeeq catalog"), "HTML replacement sentence");
  for (const body of [d.html, d.textEmail]) {
    assert.ok(body.includes("intentionally blank in this full replacement submission"), "blank product_id explained");
    assert.ok(body.includes("reconcile the newly assigned Rafeeq product IDs"), "reconciliation follow-up");
  }
  assert.ok(
    d.textEmail.indexOf("FULL CATALOG REPLACEMENT") < d.textEmail.indexOf("PACKAGE DOWNLOAD"),
    "replacement section comes BEFORE package download",
  );
  assert.ok(d.html.indexOf("<h2>Full catalog replacement</h2>") < d.html.indexOf("<h2>Package download</h2>"), "same order in HTML");
  // NEW-mode packages are not full replacements.
  const incremental = buildRafeeqEmailDraft(ctx({ mode: "NEW", newPackage: { hasSentBaseline: true, equalsWholeCatalog: false } }));
  assert.ok(!incremental.textEmail.includes("FULL CATALOG REPLACEMENT"), "absent for incremental packages");
});

test("12: the plain-text fallback ends with the approved signature", () => {
  const d = buildRafeeqEmailDraft(ctx());
  const expected = [
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
  ].join("\n");
  assert.equal(renderSignOffText(), expected, "exact approved plain-text block");
  assert.ok(d.textEmail.trimEnd().endsWith(expected), "the email ends with it");
  assert.ok(!d.textEmail.includes("Regards,\nMalikas Universe"), "old plain-text ending removed");
  assert.ok(!d.textEmail.includes("Thank you,\nMalikas Universe"), "old ending removed");
  assert.ok(!d.html.includes("<p>Thank you,<br/>Malikas Universe</p>"), "old HTML ending removed");
});

test("13: the existing option / workbook / image explanations are intact", () => {
  const d = buildRafeeqEmailDraft(ctx());
  assert.ok(flat(d.html).includes("One canonical product = <b>one</b> Rafeeq product identity."), "HTML keeps the one-identity rule");
  assert.ok(d.textEmail.includes("One canonical product = one Rafeeq product identity."), "plain text keeps the one-identity rule");
  assert.ok(d.html.includes("PRICE ON SELECTION") && d.textEmail.includes("PRICE ON SELECTION"), "both keep PRICE ON SELECTION");
  assert.ok(
    flat(d.html).includes("These repeated rows represent ONE product with multiple options — not separate products."),
    "HTML keeps the repeated-rows rule",
  );
  assert.ok(d.html.includes("<h2>How to read the workbook (3 sheets)</h2>"), "3-sheet section");
  assert.ok(d.html.includes("<b>data</b>") && d.html.includes("<b>Malikas Reference</b>") && d.html.includes("<b>Options Overview</b>"), "all three sheets named");
  assert.ok(d.html.includes("Example A — options with the SAME price"), "example A");
  assert.ok(d.html.includes("Example B — options with DIFFERENT prices"), "example B");
  assert.ok(d.html.includes("<h2>Option pricing</h2>") && d.html.includes("<h2>Images</h2>"), "pricing + images sections");
  assert.ok(d.textEmail.includes("EXAMPLE A — OPTIONS WITH THE SAME PRICE"), "plain-text example A");
  assert.ok(d.textEmail.includes("EXAMPLE B — OPTIONS WITH DIFFERENT PRICES"), "plain-text example B");
  assert.ok(d.textEmail.includes("option_price is never a surcharge/delta on top of another price."), "no-surcharge rule kept");
  assert.ok(d.textEmail.includes("never resized, recompressed or re-encoded"), "original-quality image rule kept");
  // counts still come from the package, never constants
  assert.ok(d.html.includes("1,343") && d.html.includes("1,454") && d.textEmail.includes("Products with options: 51"), "dynamic counts");
});

test("STEP 53 seam: while the approved signature is NOT installed the HTML mail fails closed", () => {
  // The approved artwork ships in APPROVED_SIGNATURE_HTML. Until it is present
  // we refuse to send rather than substitute a look-alike.
  assert.equal(signatureInstalled(""), false, "empty ⇒ not installed");
  assert.equal(signatureInstalled("   "), false, "blank ⇒ not installed");
  assert.equal(signatureInstalled(SAMPLE_SIGNATURE_HTML), true, "real markup ⇒ installed");
  assert.equal(renderSignOffHtml(""), null, "no signature ⇒ no HTML sign-off, and no invented one");

  const d = buildRafeeqEmailDraft(ctx());
  if (signatureInstalled(APPROVED_SIGNATURE_HTML)) {
    assert.ok(d.html.includes(APPROVED_SIGNATURE_HTML), "installed ⇒ embedded verbatim");
    assert.ok(!d.blockers.includes("signature_not_installed"), "installed ⇒ not a blocker");
  } else {
    assert.equal(d.sendable, false, "not installed ⇒ draft is not sendable");
    assert.ok(d.blockers.includes("signature_not_installed"), "the reason is named");
    assert.deepEqual(planRafeeqEmailSend(sendInput({ draftBlockers: d.blockers })), { ok: false, error: "draft_not_sendable" });
  }
  // the plain-text signature is always available — it has no artwork to await
  assert.ok(d.textEmail.includes("Fahad Abdulaziz Ali"), "plain-text signature is unconditional");
});
