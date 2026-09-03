// MALIKAS UNIVERSE EMAIL SIGNATURE (PURE) — the single source of the sign-off
// used by outbound Malikas emails (currently the Rafeeq catalog emails).
//
// Owner rules baked in:
//   • the APPROVED HTML signature is stored verbatim in APPROVED_SIGNATURE_HTML
//     below — it is never regenerated, restyled or "improved" from the identity
//     fields, because the approved artwork carries its own inline styles, image
//     URLs and links that must survive untouched;
//   • the identity constants exist so the PLAIN-TEXT fallback (which has no
//     markup to preserve) can be rendered deterministically, and so tests can
//     assert the signature actually carries the approved contact details;
//   • the signature is CONTENT ONLY. It never implies, reads or changes the
//     SMTP envelope: MAIL_FROM_ADDRESS / MAIL_USERNAME / transport config are
//     deployment secrets and are not referenced anywhere in this file.
//
// FAIL-CLOSED: while APPROVED_SIGNATURE_HTML is empty, HTML mail that requires
// the approved signature is NOT sendable (see signatureInstalled below). We do
// not substitute a look-alike — an unapproved signature going to a partner is
// worse than a blocked send.

/** Approved sign-off identity. Used to render the plain-text fallback. */
export const MALIKAS_SIGNATURE_IDENTITY = {
  name: "Fahad Abdulaziz Ali",
  title: "Founder & Managing Director",
  company: "Malika's Universe Trading",
  email: "fahad@malikasuniverse.com",
  phone: "+974 3331 5315",
  website: "malikasuniverse.com",
} as const;

/**
 * The approved HTML signature, stored EXACTLY as supplied in
 * `malikas-universe-signature_3.html` — structure, inline styles, image URLs
 * and links preserved byte-for-byte.
 *
 * EMPTY until that file is provided. Do NOT hand-author a replacement here:
 * paste the approved file's markup in verbatim. While this is empty every
 * consumer that needs the HTML signature fails closed rather than sending an
 * unapproved sign-off.
 */
export const APPROVED_SIGNATURE_HTML = "";

/** True once the approved signature markup has actually been installed above. */
export function signatureInstalled(html: string = APPROVED_SIGNATURE_HTML): boolean {
  return html.trim().length > 0;
}

/** Approved closing line, shared by both the HTML and plain-text bodies. */
export const SIGNOFF_CLOSING = "Thank you for your support.";
export const SIGNOFF_REGARDS = "Best regards,";

/**
 * Plain-text sign-off — the approved closing, "Best regards," and the approved
 * identity block. Fully determined by the constants above, so it is always
 * available even while the HTML artwork is not.
 */
export function renderSignOffText(): string {
  const id = MALIKAS_SIGNATURE_IDENTITY;
  return [
    SIGNOFF_CLOSING,
    "",
    SIGNOFF_REGARDS,
    "",
    id.name,
    id.title,
    id.company,
    id.email,
    id.phone,
    id.website,
  ].join("\n");
}

/**
 * HTML sign-off — the approved closing plus the approved signature markup,
 * inserted verbatim. Returns null when the approved markup is not installed,
 * so callers must decide explicitly (they fail closed) instead of silently
 * emitting a body with no signature.
 */
export function renderSignOffHtml(html: string = APPROVED_SIGNATURE_HTML): string | null {
  if (!signatureInstalled(html)) return null;
  return `<p>${SIGNOFF_CLOSING}</p>\n  <p>${SIGNOFF_REGARDS}</p>\n  ${html}`;
}
