// MALIKAS OUTBOUND MAIL — the shared professional shell (PURE).
//
// The visual language every Malikas partner email uses: one wrapper, one
// summary-table style, one call-to-action button, one notice banner. Extracted
// VERBATIM from the Rafeeq renderer that has been in production since STEP 53 —
// this module is not a redesign, it is the same markup with one home.
//
// Why extract rather than copy: the alternative is two signatures and two
// shells that agree today and drift in six months, so a partner receives two
// different-looking emails from the same company. The approved signature was
// already shared (lib/mail/malikas-signature.ts); this brings the rest with it.
//
// EMAIL-SAFE HTML ONLY. Tables for layout, inline styles, no classes, no
// JavaScript, no flexbox/grid — Outlook renders none of those. Every style here
// is one an email client from 2010 would understand.

/** HTML-escape a value for interpolation into email markup. */
export const escapeMailHtml = (v: string | number | null | undefined): string =>
  String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Thousands-separated integer, matching the Rafeeq renderer's formatting. */
export const formatMailNumber = (v: number): string => v.toLocaleString("en-US");

/**
 * The outer wrapper. Byte-identical to the one Rafeeq has been sending:
 * a centred 640px column, Arial stack, 14px/1.55, near-black on white.
 */
export const MAIL_SHELL_STYLE =
  "font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.55;color:#111111;max-width:640px;margin:0 auto;padding:0 8px";

export const mailShellOpen = (): string => `<div style="${MAIL_SHELL_STYLE}">`;
export const mailShellClose = (): string => `</div>`;

/** Wrap a body fragment in the shell. */
export function mailShell(inner: string): string {
  return `${mailShellOpen()}\n${inner}\n${mailShellClose()}`;
}

/** The brand accent, used by the CTA button. */
export const MAIL_ACCENT = "#0f766e";

export interface MailSummaryRow {
  label: string;
  /** already-escaped when `raw`, escaped for you otherwise. */
  value: string | number;
  /** true when `value` is trusted markup (e.g. a <code> wrapper). */
  raw?: boolean;
}

/**
 * The label/value summary table. Same bordered, 6px-padded table Rafeeq uses
 * for its package summary, so the two emails read as one house style.
 */
export function mailSummaryTable(rows: readonly MailSummaryRow[]): string {
  const body = rows
    .map((r) => `    <tr><th align="left">${escapeMailHtml(r.label)}</th><td>${
      r.raw ? String(r.value) : escapeMailHtml(r.value)}</td></tr>`)
    .join("\n");
  return `  <table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse">\n${body}\n  </table>`;
}

/**
 * A download call-to-action.
 *
 * The plain-text address is repeated underneath on purpose: a button is an
 * anchor, and corporate mail clients strip or fail to render anchors often
 * enough that a link with no visible fallback is a link some recipients simply
 * cannot use.
 */
export function mailCtaButton(input: { url: string; label: string; note?: string }): string {
  const url = escapeMailHtml(input.url);
  return [
    `  <table border="0" cellpadding="0" cellspacing="0" style="margin:12px 0"><tr><td style="background-color:${MAIL_ACCENT};border-radius:8px">`,
    `    <a href="${url}" style="display:inline-block;padding:14px 28px;font-size:16px;font-weight:bold;color:#ffffff;text-decoration:none">${escapeMailHtml(input.label)}</a>`,
    `  </td></tr></table>`,
    input.note ? `  <p>${input.note}</p>` : "",
    `  <p>If the button does not work, copy this address into your browser:<br/><a href="${url}" style="word-break:break-all">${url}</a></p>`,
  ].filter((l) => l !== "").join("\n");
}

/** A section heading, matching the Rafeeq renderer. */
export const mailHeading = (text: string): string => `  <h2>${escapeMailHtml(text)}</h2>`;

/**
 * A tasteful warning banner — used for the INTERNAL TEST notice.
 *
 * Amber on a pale ground with a left rule: visible at a glance, but the message
 * beneath it still reads as the real email it is a rehearsal of. A test that
 * looks like a debug dump is a test nobody can judge the real thing by.
 */
export function mailNoticeBanner(title: string, detail: string): string {
  return [
    `  <table border="0" cellpadding="0" cellspacing="0" width="100%" style="width:100%;border-collapse:collapse;margin:0 0 16px 0">`,
    `    <tr><td style="background-color:#fffbeb;border-left:4px solid #d97706;padding:12px 16px">`,
    `      <div style="font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:1.5;color:#92400e">`,
    `        <b style="font-size:14px">${escapeMailHtml(title)}</b><br/>${escapeMailHtml(detail)}`,
    `      </div>`,
    `    </td></tr>`,
    `  </table>`,
  ].join("\n");
}

/**
 * Insert a block at the TOP of an already-wrapped shell, inside the wrapper.
 *
 * Used for the test-mode notice: putting the banner before the wrapper would
 * render it in the client's default font, outside the styled column, which is
 * exactly the "debug email" look the banner is meant to avoid.
 */
export function mailShellPrepend(shellHtml: string, block: string): string {
  const open = mailShellOpen();
  return shellHtml.startsWith(open)
    ? `${open}\n${block}${shellHtml.slice(open.length)}`
    : `${block}\n${shellHtml}`;
}
