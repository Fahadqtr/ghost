// STEP 91 — the download link stops shouting.
//
// Email B carried its signed URL twice: once behind the button, and once
// printed in full as the fallback. A Supabase signed URL is a couple of hundred
// characters of opaque token, so that second copy wrapped three lines of noise
// through the middle of a letter to a partner and made the whole message read
// as machine output rather than something a person sent.
//
// The fallback is now a short "click here" carrying the same URL. Nothing about
// the link itself changes — same object, same signature, same 7-day expiry,
// same private bucket, same run and baseline binding. This is presentation.
//
// The plain-text alternative KEEPS the full address, and that is not an
// oversight: a text-only client has no anchor to click, so there the address is
// the only route to the file.
//
// node --conditions=react-server --experimental-strip-types --test lib/export/talabat/step91-clean-download-link.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildTalabatNewProductsEmail, buildTalabatUpdateEmail, DEFAULT_TALABAT_GREETING,
} from "./email-templates.ts";
import { mailCtaButton, MAIL_ACCENT } from "../../mail/mail-shell.ts";
import { OFFICIAL_SEND_ENABLED, presentForMode } from "./email-workflow.ts";
import { APPROVED_SIGNATURE_HTML } from "../../mail/malikas-signature.ts";

const HERE = join(fileURLToPath(new URL(".", import.meta.url)));
const APP_ROOT = join(HERE, "../../..");
const raw = (rel: string): string => readFileSync(join(APP_ROOT, rel), "utf8");
const code = (rel: string): string =>
  raw(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const SHELL = "lib/mail/mail-shell.ts";
const WORKFLOW = "lib/talabat/email-workflow.server.ts";

// A realistically long signed URL — the whole point is that this must not be
// readable in the body.
const SIGNED = "https://vqstcmattiarhblqshvb.supabase.co/storage/v1/object/sign/talabat-packages/"
  + "email-artifacts/new_products/source/images.zip?token=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9."
  + "eyJ1cmwiOiJ0YWxhYmF0LXBhY2thZ2VzL2VtYWlsLWFydGlmYWN0cyIsImlhdCI6MTc2MDAwMDAwMH0.EXAMPLE-SIG";
const LINK = { url: SIGNED, expiresAtIso: "2026-09-14T01:14:00.000Z" };

const emailB = (over: Record<string, unknown> = {}) => buildTalabatNewProductsEmail(
  "talabat-new-products-2026-09-07.xlsx", "talabat-new-products-images-2026-09-07.zip",
  { sendable: true, imagesLink: LINK, summary: { products: 408, rows: 517, images: 632 }, ...over },
);

/**
 * The body with every href attribute VALUE removed.
 *
 * What remains is what a reader actually sees, so a URL surviving this strip is
 * a URL printed in the letter. Asserting on the raw HTML instead would be
 * meaningless — the href must contain the URL, that is the whole point of it.
 */
const visibleText = (html: string) => html.replace(/href="[^"]*"/g, 'href=""');

// ── 1. the button is untouched ──────────────────────────────────────────────

test("1. the Download Product Images button still exists", () => {
  const html = emailB().bodyHtml;
  assert.ok(html !== null);
  assert.ok(html.includes(">Download Product Images</a>"));
  assert.ok(html.includes(`background-color:${MAIL_ACCENT}`), "still the house button");
});

test("2. the button href is the exact current signed URL", () => {
  const html = emailB().bodyHtml;
  assert.ok(html !== null);
  const button = html.slice(html.indexOf("background-color:" + MAIL_ACCENT));
  assert.ok(button.includes(`href="${SIGNED}"`), "verbatim, not rewritten or shortened");
});

// ── 2. the URL is no longer printed ─────────────────────────────────────────

test("3. the full signed URL is never VISIBLE in the HTML", () => {
  const html = emailB().bodyHtml;
  assert.ok(html !== null);
  assert.ok(html.includes(SIGNED), "it is still in the document — inside the hrefs");
  assert.equal(visibleText(html).includes(SIGNED), false, "…and nowhere a reader can see it");
  // not even the token fragment on its own
  assert.equal(visibleText(html).includes("eyJhbGciOiJIUzI1NiIs"), false);
  // and the old "copy this address" phrasing is gone
  assert.equal(html.includes("copy this address into your browser"), false);
});

test("4. the fallback sentence reads as the owner asked", () => {
  const html = emailB().bodyHtml;
  assert.ok(html !== null);
  assert.ok(html.includes("If the button does not work, "));
  assert.ok(html.includes(">click here</a> to download the product images."));
});

test("5. click here carries the SAME URL as the button", () => {
  const html = emailB().bodyHtml;
  assert.ok(html !== null);
  const hrefs = [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);
  const signed = hrefs.filter((h) => h === SIGNED);
  assert.equal(signed.length, 2, "exactly two: the button and the fallback");
  // both sit inside the images section, and nothing else links to the object
  assert.equal(hrefs.filter((h) => h.includes("/object/sign/")).length, 2);
});

test("6. only the words click here are the link, not the address", () => {
  const html = emailB().bodyHtml;
  assert.ok(html !== null);
  const anchor = /<a href="[^"]*" style="color:#0f766e">([^<]*)<\/a>/.exec(html);
  assert.ok(anchor, "the fallback anchor exists");
  assert.equal(anchor![1], "click here", "its text is the words, never the URL");
});

// ── 3. plain text still works ───────────────────────────────────────────────

test("7. the plain-text body keeps a usable address", () => {
  const draft = emailB();
  assert.ok(draft.bodyText.includes(SIGNED), "a text client has no anchor to click");
  assert.ok(draft.bodyText.includes("secure download link"));
  assert.ok(draft.bodyText.includes("This link expires on 2026-09-14T01:14:00.000Z."));
  // the text part is NOT the place for the click-here wording
  assert.equal(draft.bodyText.includes("click here"), false);
});

test("8. with no link at all, nothing pretends there is one", () => {
  const draft = buildTalabatNewProductsEmail("n.xlsx", "i.zip", { sendable: true });
  assert.ok(draft.bodyHtml !== null);
  assert.equal(draft.bodyHtml.includes("click here"), false);
  assert.equal(draft.bodyHtml.includes("Download Product Images"), false);
  assert.deepEqual(draft.attachments, ["n.xlsx", "i.zip"], "the ZIP is attached instead");
});

// ── 4. nothing else moved ───────────────────────────────────────────────────

test("9. Email A is untouched", () => {
  const a = buildTalabatUpdateEmail("u.xlsx", { products: 147, rows: 147 });
  assert.ok(a.bodyHtml !== null);
  assert.equal(a.bodyHtml.includes("click here"), false, "Email A has no download link at all");
  assert.equal(a.bodyHtml.includes("Download Product Images"), false);
  assert.ok(a.bodyHtml.includes(APPROVED_SIGNATURE_HTML), "same signature");
  assert.ok(a.bodyText.startsWith(DEFAULT_TALABAT_GREETING));
  assert.deepEqual(a.attachments, ["u.xlsx"]);
});

test("10. the CTA helper's default wording is unchanged for any other caller", () => {
  const generic = mailCtaButton({ url: "https://x.test/f", label: "Get it" });
  assert.ok(generic.includes(">click here</a> to download the file."));
  assert.equal(generic.includes('>https://x.test/f</a>'), false, "no printed address anywhere");
  // Rafeeq does not use this helper, so its email is untouched by this step
  assert.equal(code("lib/export/rafeeq/email-draft.ts").includes("mailCtaButton"), false);
});

test("11. preview and SMTP still render the same string", () => {
  const draft = emailB();
  const p = presentForMode("test", draft.subject, draft.bodyText, draft.bodyHtml);
  assert.ok(p.bodyHtml !== null);
  assert.ok(p.bodyHtml.includes(">click here</a> to download the product images."));
  assert.equal(visibleText(p.bodyHtml).includes(SIGNED), false, "still hidden in test mode");
  const src = code(WORKFLOW);
  assert.match(src, /bodyHtml: presented\.bodyHtml,/);
  assert.match(src, /html: p\.bodyHtml \?\? undefined,/);
});

test("12. the link's security and binding are untouched by this step", () => {
  const src = code(WORKFLOW);
  assert.match(src, /createSignedUrl\(ref\.objectPath, TALABAT_LINK_TTL_SECONDS, \{ download: ref\.filename \}\)/);
  assert.match(src, /TALABAT_LINK_TTL_SECONDS = RAFEEQ_LINK_TTL_SECONDS/);
  assert.equal(src.includes("getPublicUrl"), false);
  // the shell change is presentation only — it touches no URL construction
  const shell = code(SHELL);
  assert.equal(shell.includes("createSignedUrl"), false);
  assert.equal(shell.includes("supabase"), false);
});

test("13. no mail is sent, and the official send is still disabled", () => {
  for (const f of [SHELL, "lib/export/talabat/email-templates.ts"]) {
    const src = code(f);
    for (const forbidden of ["sendMailViaSmtp", "nodemailer", "createTransport"]) {
      assert.equal(src.includes(forbidden), false, `${f} must not reach the transport`);
    }
  }
  assert.equal(OFFICIAL_SEND_ENABLED, false);
});

test("14. the body is still email-safe markup", () => {
  const html = emailB().bodyHtml;
  assert.ok(html !== null);
  assert.equal(/<script/i.test(html), false);
  assert.equal(/\son[a-z]+=/i.test(html), false);
  assert.equal(/class="/.test(html), false);
  assert.equal(/display:\s*(flex|grid)/.test(html), false);
  assert.ok(html.includes("Arial"));
});
