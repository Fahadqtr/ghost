// STEP 89 — the Talabat emails wear the company's clothes.
//
// Until now Talabat received plain text while Rafeeq received the house HTML
// with the approved signature. Two partners, two impressions of the same
// company. This step gives Talabat the SAME shell and the SAME signature.
//
// The danger in doing that is duplication: a second copy of the signature or
// the shell agrees with the original today and drifts from it in six months,
// and then the company has two letterheads. So the proofs below are as much
// about there being ONE source as about the new emails looking right.
//
// What this step must NOT have touched: baseline logic, delta computation,
// scope algorithms, artifacts, barcodes, signed-link security, the SMTP
// transport, recipient policy, the confirmation token, delivery_mode, or the
// official-send gate. Presentation only.
//
// node --conditions=react-server --experimental-strip-types --test lib/export/talabat/step89-professional-email.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildTalabatUpdateEmail, buildTalabatNewProductsEmail, buildTalabatBarcodeCorrectionEmail,
} from "./email-templates.ts";
import {
  presentForMode, testBodyHtml, TEST_SUBJECT_PREFIX, TEST_BODY_NOTICE,
  TEST_BANNER_TITLE, TEST_BANNER_DETAIL, OFFICIAL_SEND_ENABLED,
} from "./email-workflow.ts";
import {
  APPROVED_SIGNATURE_HTML, renderSignOffHtml, MALIKAS_SIGNATURE_IDENTITY,
} from "../../mail/malikas-signature.ts";
import { mailShellOpen, MAIL_SHELL_STYLE, mailShellPrepend } from "../../mail/mail-shell.ts";
import { buildRafeeqEmailDraft } from "../rafeeq/email-draft.ts";

const HERE = join(fileURLToPath(new URL(".", import.meta.url)));
const APP_ROOT = join(HERE, "../../..");
const raw = (rel: string): string => readFileSync(join(APP_ROOT, rel), "utf8");
// Scan CODE, not prose: this file's own explanations must never satisfy or
// break a guard that is supposed to be about the implementation.
const code = (rel: string): string =>
  raw(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const TEMPLATES = "lib/export/talabat/email-templates.ts";
const SHELL = "lib/mail/mail-shell.ts";
const SIGNATURE = "lib/mail/malikas-signature.ts";
const RAFEEQ = "lib/export/rafeeq/email-draft.ts";
const SERVER = "lib/talabat/email-workflow.server.ts";
const UI = "app/(v2)/v2/operations/channels/talabat-email/TalabatEmailWorkflow.tsx";

const LINK = { url: "https://storage.example.test/o/signed?token=abc", expiresAtIso: "2026-09-13T10:00:00.000Z" };

// ── 1. one company, one signature ────────────────────────────────────────────

test("1. the approved signature markup lives in exactly ONE module", () => {
  // The <table> that opens the approved artwork. If a second file carries it,
  // the company has two signatures that will drift.
  const marker = 'alt="Malika\'s Universe Trading"';
  const holders = [SIGNATURE, TEMPLATES, SHELL, RAFEEQ, SERVER]
    .filter((f) => raw(f).includes(marker));
  assert.deepEqual(holders, [SIGNATURE]);
});

test("2. Talabat gets the signature by IMPORT, never by copy", () => {
  const src = code(TEMPLATES);
  assert.match(src, /import \{[^}]*renderSignOffHtml[^}]*\} from "\.\.\/\.\.\/mail\/malikas-signature\.ts"/);
});

test("3. Rafeeq and Talabat resolve to the same signature function", () => {
  const rafeeqSrc = code(RAFEEQ);
  const talabatSrc = code(TEMPLATES);
  for (const src of [rafeeqSrc, talabatSrc]) {
    assert.ok(src.includes("renderSignOffHtml"), "both consume the shared renderer");
  }
  const signOff = renderSignOffHtml();
  assert.ok(signOff !== null);
  assert.ok(signOff.includes(APPROVED_SIGNATURE_HTML), "the renderer inlines the approved artwork verbatim");
});

// ── 2. Rafeeq is unchanged ───────────────────────────────────────────────────

test("4. Rafeeq's rendered email still carries the approved signature and shell", () => {
  const draft = buildRafeeqEmailDraft({
    mode: "FULL",
    filename: "malikas-catalog-full.zip",
    generatedAt: "2026-09-06T09:00:00.000Z",
    productCount: 1530,
    physicalRowCount: 1454,
    productsWithOptions: 197,
    optionCount: 400,
    imageCount: 3000,
    zipBytes: 1024,
    nowIso: "2026-09-06T09:05:00.000Z",
    downloadLink: { url: LINK.url, expiresAtIso: "2026-09-13T09:00:00.000Z", filename: "malikas-catalog-full.zip" },
  });
  assert.ok(draft.html.includes(APPROVED_SIGNATURE_HTML), "signature intact");
  assert.ok(draft.html.startsWith(mailShellOpen()), "shell unchanged");
});

test("5. Rafeeq consumes the shared shell instead of its own copy of the styles", () => {
  const src = code(RAFEEQ);
  assert.match(src, /from "\.\.\/\.\.\/mail\/mail-shell\.ts"/);
  // the style string itself must not be re-typed in the Rafeeq module
  assert.ok(!src.includes(MAIL_SHELL_STYLE), "no duplicated shell style literal");
});

// ── 3. the Talabat emails ────────────────────────────────────────────────────

test("6. Email A renders in the shared shell with the approved signature", () => {
  const draft = buildTalabatUpdateEmail("talabat-updates.xlsx", { products: 12, rows: 34 });
  assert.ok(draft.bodyHtml !== null);
  assert.ok(draft.bodyHtml.startsWith(mailShellOpen()));
  assert.ok(draft.bodyHtml.includes(APPROVED_SIGNATURE_HTML));
  assert.ok(draft.bodyHtml.includes(MALIKAS_SIGNATURE_IDENTITY.email));
});

test("7. Email B renders in the shared shell with the approved signature", () => {
  const draft = buildTalabatNewProductsEmail("new.xlsx", "images.zip", {
    sendable: true, imagesLink: LINK, summary: { products: 5, rows: 6, images: 7 },
  });
  assert.ok(draft.bodyHtml !== null);
  assert.ok(draft.bodyHtml.startsWith(mailShellOpen()));
  assert.ok(draft.bodyHtml.includes(APPROVED_SIGNATURE_HTML));
});

test("8. the emails state the counts they are GIVEN, not counts baked into the code", () => {
  const a = buildTalabatUpdateEmail("u.xlsx", { products: 9, rows: 11 });
  assert.ok(a.bodyHtml !== null);
  assert.ok(a.bodyHtml.includes(">9<"), "the given product count appears");
  assert.ok(a.bodyHtml.includes(">11<"), "the given row count appears");

  const b = buildTalabatNewProductsEmail("n.xlsx", "i.zip", {
    sendable: true, imagesLink: LINK, summary: { products: 3, rows: 4, images: 5 },
  });
  assert.ok(b.bodyHtml !== null);
  for (const v of [">3<", ">4<", ">5<"]) assert.ok(b.bodyHtml.includes(v), `${v} rendered`);
});

test("9. no scope figure is hard-coded into the template or the UI", () => {
  // The approved scope at the time of writing was 147 / 408 / 517 / 632. Those
  // are results of an algorithm, not constants, and must never be typed in.
  for (const file of [TEMPLATES, SERVER, UI]) {
    const src = code(file);
    for (const n of ["147", "408", "517", "632"]) {
      assert.ok(!src.includes(n), `${file} must not hard-code ${n}`);
    }
    for (const n of ["١٤٧", "٤٠٨", "٥١٧", "٦٣٢"]) {
      assert.ok(!src.includes(n), `${file} must not hard-code ${n}`);
    }
  }
});

test("10. with no summary the card omits the figures rather than inventing them", () => {
  const a = buildTalabatUpdateEmail("u.xlsx");
  assert.ok(a.bodyHtml !== null);
  assert.ok(!a.bodyHtml.includes("Products</th>"), "no products row when nothing was measured");
  assert.ok(a.bodyHtml.includes("Update Type"), "the card still identifies the email");
});

// ── 4. the image link, unchanged in substance ────────────────────────────────

test("11. Email B offers the images as a download button and does NOT attach the ZIP", () => {
  const draft = buildTalabatNewProductsEmail("new.xlsx", "images.zip", {
    sendable: true, imagesLink: LINK, summary: { products: 1, rows: 1, images: 1 },
  });
  assert.deepEqual(draft.attachments, ["new.xlsx"], "the ZIP is not attached");
  assert.ok(draft.bodyHtml !== null);
  assert.ok(draft.bodyHtml.includes("Download Product Images"));
  assert.ok(draft.bodyHtml.includes(LINK.url), "the signed link is the button target");
  assert.ok(draft.bodyHtml.includes(LINK.expiresAtIso), "the expiry is stated");
});

test("12. without a link the ZIP goes back to being an attachment and no button is drawn", () => {
  const draft = buildTalabatNewProductsEmail("new.xlsx", "images.zip", { sendable: true });
  assert.deepEqual(draft.attachments, ["new.xlsx", "images.zip"]);
  assert.ok(draft.bodyHtml !== null);
  assert.ok(!draft.bodyHtml.includes("Download Product Images"));
});

test("13. the email never exposes a raw storage path", () => {
  const draft = buildTalabatNewProductsEmail("new.xlsx", "images.zip", {
    sendable: true, imagesLink: LINK, summary: { products: 1, rows: 1, images: 1 },
  });
  assert.ok(draft.bodyHtml !== null);
  for (const path of ["email-artifacts/", "supabase", "service_role", "storage/v1/object/sign"]) {
    assert.ok(!draft.bodyHtml.includes(path), `no ${path} in the body`);
  }
});

test("14. a new-category request is asked for explicitly when one exists", () => {
  const draft = buildTalabatNewProductsEmail("new.xlsx", "images.zip", {
    sendable: true, categoryRequests: ["All Summer And Camping Supplies"], imagesLink: LINK,
  });
  assert.ok(draft.bodyHtml !== null);
  assert.ok(draft.bodyHtml.includes("New category required"));
  assert.ok(draft.bodyHtml.includes("All Summer And Camping Supplies"));

  const none = buildTalabatNewProductsEmail("new.xlsx", "images.zip", { sendable: true, imagesLink: LINK });
  assert.ok(none.bodyHtml !== null);
  assert.ok(!none.bodyHtml.includes("New category required"));
});

// ── 5. email-safe markup ─────────────────────────────────────────────────────

const RENDERED = [
  buildTalabatUpdateEmail("u.xlsx", { products: 2, rows: 3 }).bodyHtml,
  buildTalabatNewProductsEmail("n.xlsx", "i.zip", {
    sendable: true, categoryRequests: ["All Toys"], imagesLink: LINK,
    summary: { products: 2, rows: 3, images: 4 },
  }).bodyHtml,
].filter((h): h is string => h !== null);

test("15. the bodies use only markup an old mail client can render", () => {
  assert.equal(RENDERED.length, 2);
  for (const html of RENDERED) {
    assert.ok(!/<script/i.test(html), "no scripts");
    assert.ok(!/\son[a-z]+=/i.test(html), "no event handlers");
    assert.ok(!/class="/.test(html), "no CSS classes — email clients have no stylesheet");
    assert.ok(!/display:\s*(flex|grid)/.test(html), "no flexbox or grid");
    assert.ok(!/position:\s*(absolute|fixed|sticky)/.test(html), "no positioning");
    assert.ok(!/<link/i.test(html) && !/<style/i.test(html), "no external or embedded stylesheets");
    assert.ok(html.includes("Arial"), "a real fallback font stack is inline");
  }
});

test("16. interpolated values are escaped", () => {
  const draft = buildTalabatUpdateEmail('ev<il>"&.xlsx', { products: 1, rows: 1 });
  assert.ok(draft.bodyHtml !== null);
  assert.ok(draft.bodyHtml.includes("ev&lt;il&gt;&quot;&amp;.xlsx"));
  assert.ok(!draft.bodyHtml.includes("ev<il>"));
});

// ── 6. the test presentation ─────────────────────────────────────────────────

test("17. the test banner sits INSIDE the shell, at the very top", () => {
  const body = buildTalabatUpdateEmail("u.xlsx", { products: 1, rows: 1 }).bodyHtml;
  assert.ok(body !== null);
  const marked = testBodyHtml(body);
  assert.ok(marked.startsWith(mailShellOpen()), "the wrapper is still the first thing");
  assert.ok(marked.indexOf(TEST_BANNER_DETAIL) < marked.indexOf("Dear Talabat Team"),
    "the warning is read before the greeting");
  assert.ok(marked.includes(TEST_BANNER_TITLE));
  assert.ok(marked.includes(APPROVED_SIGNATURE_HTML), "the rest of the email is untouched");
});

test("18. the test email still LOOKS like the real email", () => {
  const body = buildTalabatUpdateEmail("u.xlsx", { products: 1, rows: 1 }).bodyHtml;
  assert.ok(body !== null);
  const marked = testBodyHtml(body);
  // everything the real body said is still there, in the same order
  const real = body.slice(mailShellOpen().length);
  assert.ok(marked.endsWith(real), "the real body follows the banner verbatim");
});

test("19. marking a body as a test twice does not stack banners", () => {
  const body = buildTalabatUpdateEmail("u.xlsx").bodyHtml;
  assert.ok(body !== null);
  const once = testBodyHtml(body);
  assert.equal(testBodyHtml(once), once);
});

test("20. test mode marks the subject, the text and the HTML together", () => {
  const draft = buildTalabatUpdateEmail("u.xlsx", { products: 1, rows: 1 });
  const p = presentForMode("test", draft.subject, draft.bodyText, draft.bodyHtml);
  assert.ok(p.subject.startsWith(TEST_SUBJECT_PREFIX));
  assert.ok(p.bodyText.startsWith(TEST_BODY_NOTICE));
  assert.ok(p.bodyHtml !== null && p.bodyHtml.includes(TEST_BANNER_DETAIL));
});

test("21. official mode adds nothing at all", () => {
  const draft = buildTalabatUpdateEmail("u.xlsx", { products: 1, rows: 1 });
  const p = presentForMode("official", draft.subject, draft.bodyText, draft.bodyHtml);
  assert.equal(p.subject, draft.subject);
  assert.equal(p.bodyText, draft.bodyText);
  assert.equal(p.bodyHtml, draft.bodyHtml);
});

test("22. mailShellPrepend refuses to lose content it cannot place inside", () => {
  const out = mailShellPrepend("<p>not a shell</p>", "<b>notice</b>");
  assert.ok(out.includes("<b>notice</b>") && out.includes("<p>not a shell</p>"));
});

// ── 7. fail-closed and the untouched gates ───────────────────────────────────

test("23. Email C has no HTML body and is still unsendable", () => {
  const draft = buildTalabatBarcodeCorrectionEmail("barcode-review.xlsx");
  assert.equal(draft.bodyHtml, null);
  assert.equal(draft.sendable, false);
  assert.ok(draft.bodyText.includes("REVIEW ONLY"));
});

test("24. a missing approved signature blocks the HTML rather than substituting one", () => {
  assert.equal(renderSignOffHtml(""), null);
  const src = code(TEMPLATES);
  assert.match(src, /const signOff = renderSignOffHtml\(\);\s*\n\s*if \(signOff === null\) return null;/);
});

test("25. the official send is still disabled", () => {
  assert.equal(OFFICIAL_SEND_ENABLED, false);
});

// ── 8. preview and send are the same string ──────────────────────────────────

test("26. the transport sends the preview's HTML — not a re-render of the text", () => {
  const src = code(SERVER);
  assert.match(src, /html: p\.bodyHtml \?\? undefined,/);
  assert.ok(!src.includes("<pre style="), "the plain-text-in-a-<pre> stand-in is gone");
  assert.ok(!src.includes("function escapeHtml"), "and its escaper with it");
});

test("27. the preview DTO carries the same rendered HTML", () => {
  const src = code(SERVER);
  assert.match(src, /bodyHtml: presented\.bodyHtml,/);
  assert.match(src, /presentForMode\(input\.mode, draft\.subject, draft\.bodyText, draft\.bodyHtml\)/);
});

test("28. the figures in the email come from the artifact scope", () => {
  const src = code(SERVER);
  assert.match(src, /scope\.workbookProducts/);
  assert.match(src, /scope\.workbookRows/);
  assert.match(src, /scope\.imageCount/);
});

test("29. the V2 screen renders the real HTML, sandboxed", () => {
  const src = raw(UI);
  assert.match(src, /srcDoc=\{bodyHtml/);
  assert.match(src, /sandbox=""/);
  assert.ok(!src.includes("dangerouslySetInnerHTML"), "the email is not injected into the app DOM");
});

// ── 9. nothing else moved ────────────────────────────────────────────────────

test("30. the untouched machinery is still referenced exactly where it was", () => {
  const src = code(SERVER);
  for (const kept of [
    "confirmationToken(", "checkConfirmation(", "evaluateWorkflowGate(",
    "verifyArtifactScope(", "readActiveBaselineBytes", "signImagesLink",
    'delivery_mode: "test"', "validateRecipients(",
  ]) {
    assert.ok(src.includes(kept), `${kept} still present`);
  }
  // and no recipient was smuggled in
  assert.ok(!/@talabat\.com/.test(src), "no hard-coded recipient");
  assert.ok(!/@talabat\.com/.test(code(TEMPLATES)), "no hard-coded recipient in the templates");
});
