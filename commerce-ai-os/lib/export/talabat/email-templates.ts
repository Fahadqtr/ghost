// TALABAT — the two SEPARATE partner emails (PURE, owner-authored copy).
//
// They must never merge. An "updates" email tells Talabat to change products
// they already list; a "new products" email tells them to add products they do
// not. Combining them invites Talabat to apply one instruction to the other
// set — the exact failure that re-sending the full 1454-row menu causes.
//
// The bodies below are the owner's wording, stored verbatim. Nothing here
// sends: these builders produce a DRAFT for owner review only.

import { MALIKAS_SIGNATURE_IDENTITY, renderSignOffHtml } from "../../mail/malikas-signature.ts";
import {
  mailShell, mailHeading, mailSummaryTable, mailCtaButton,
  escapeMailHtml, formatMailNumber, type MailSummaryRow,
} from "../../mail/mail-shell.ts";

export type TalabatEmailKind = "existing_updates" | "new_products" | "barcode_corrections";

export interface TalabatEmailDraft {
  kind: TalabatEmailKind;
  subject: string;
  /**
   * STEP 89 — the professional HTML body, in the shared Malikas shell with the
   * approved signature. This is the PRIMARY format; the preview screen and the
   * transport both render this exact string, so what the owner reviews is what
   * Talabat receives.
   *
   * null only when the approved signature artwork is not installed — we never
   * send house-styled HTML with a missing or substituted sign-off.
   */
  bodyHtml: string | null;
  /** plain-text alternative for clients that do not render HTML. */
  bodyText: string;
  /** filenames the owner is expected to attach — never fabricated content. */
  attachments: string[];
  /**
   * STEP 79B — false means this flow is REVIEW-ONLY and must never reach a
   * transport, whatever the UI or a caller asks for. Barcode corrections are
   * gated this way until barcode correctness is resolved: 126 of the 270
   * differences would replace a valid manufacturer barcode with a synthetic
   * one, so the draft exists to be read, not sent.
   */
  sendable: boolean;
}

const SIGNOFF = [
  "Best regards,",
  MALIKAS_SIGNATURE_IDENTITY.name,
  MALIKAS_SIGNATURE_IDENTITY.title,
  MALIKAS_SIGNATURE_IDENTITY.company,
  MALIKAS_SIGNATURE_IDENTITY.email,
  MALIKAS_SIGNATURE_IDENTITY.phone,
  MALIKAS_SIGNATURE_IDENTITY.website,
].join("\n");

/**
 * One renderer for both Talabat emails.
 *
 * Composes the shared shell, the summary card and the approved signature.
 * Returns null when the approved signature artwork is not installed: house-
 * styled HTML that quietly drops the sign-off would look like an unsigned
 * letter from the company, so we fall back to plain text instead of shipping it.
 */
function renderTalabatHtml(input: {
  title: string;
  intro: readonly string[];
  summaryRows: readonly MailSummaryRow[];
  instruction: string;
  closing: string;
  /** an optional block (the images CTA) inserted after the summary. */
  extra?: string;
}): string | null {
  const signOff = renderSignOffHtml();
  if (signOff === null) return null;
  return mailShell([
    `  <p style="font-size:12px;letter-spacing:2px;color:#9a9a9a;margin:0 0 4px 0">MALIKA'S UNIVERSE</p>`,
    `  <h1 style="font-size:20px;line-height:1.3;margin:0 0 16px 0;color:#111111">${escapeMailHtml(input.title)}</h1>`,
    `  <p>Dear Talabat Team,</p>`,
    ...input.intro.map((p) => `  <p>${escapeMailHtml(p)}</p>`),
    mailHeading("Summary"),
    mailSummaryTable(input.summaryRows),
    input.extra ?? "",
    `  <p>${escapeMailHtml(input.instruction)}</p>`,
    `  <p>${escapeMailHtml(input.closing)}</p>`,
    `  ${signOff}`,
  ].filter((l) => l !== "").join("\n"));
}

export const TALABAT_EMAIL_SUBJECTS: Record<TalabatEmailKind, string> = {
  existing_updates: "Malika's Universe — Talabat Product Data Update",
  new_products: "Malika's Universe — New Products for Talabat",
  barcode_corrections: "Malika's Universe — Talabat Barcode Corrections (REVIEW ONLY — DO NOT SEND)",
};

/** Flows the owner has authorised for sending. Barcode corrections are not. */
export const TALABAT_SENDABLE_EMAIL_KINDS: readonly TalabatEmailKind[] = ["existing_updates", "new_products"];

export function isTalabatEmailSendable(kind: TalabatEmailKind): boolean {
  return TALABAT_SENDABLE_EMAIL_KINDS.includes(kind);
}

/**
 * What the summary card shows. Every figure comes from the generated artifact,
 * so the email cannot claim a count the file does not contain.
 */
export interface UpdateEmailSummary {
  products: number;
  rows: number;
  changes?: string;
}

/** EMAIL A — updates to products Talabat already lists. */
export function buildTalabatUpdateEmail(
  updateWorkbookName: string,
  summary?: UpdateEmailSummary,
): TalabatEmailDraft {
  const bodyText = [
    "Dear Talabat Team,",
    "",
    "Please find attached our latest product data update for Malika's Universe.",
    "",
    "The attached file contains only products that are already listed on Talabat",
    "and require data updates.",
    "",
    ...(summary ? [
      `Update type: Existing Product Updates`,
      `Products: ${formatMailNumber(summary.products)}`,
      `Rows: ${formatMailNumber(summary.rows)}`,
      `Changes: ${summary.changes ?? "Product Name & Price"}`,
      `Attachment: ${updateWorkbookName}`,
      "",
    ] : []),
    "Kindly update only the attached products while keeping all other existing",
    "products unchanged.",
    "",
    "Please let us know once the updates have been completed or if any additional",
    "information is required.",
    "",
    SIGNOFF,
  ].join("\n");

  const rows: MailSummaryRow[] = [
    { label: "Update Type", value: "Existing Product Updates" },
    ...(summary ? [
      { label: "Products", value: formatMailNumber(summary.products) },
      { label: "Rows", value: formatMailNumber(summary.rows) },
    ] : []),
    { label: "Changes", value: summary?.changes ?? "Product Name & Price" },
    { label: "Attachment", value: `<code>${escapeMailHtml(updateWorkbookName)}</code>`, raw: true },
  ];

  return {
    kind: "existing_updates",
    subject: TALABAT_EMAIL_SUBJECTS.existing_updates,
    bodyHtml: renderTalabatHtml({
      title: "Talabat Product Data Update",
      intro: [
        "Please find attached our latest product data update for Malika's Universe.",
        "The attached file contains only products that are already listed on Talabat and require data updates.",
      ],
      summaryRows: rows,
      instruction: "Please update only the products included in the attached file while keeping all other existing products unchanged.",
      closing: "Please let us know once the update has been completed or if any additional information is required.",
    }),
    bodyText,
    attachments: [updateWorkbookName],
    sendable: true,
  };
}

export interface NewProductsEmailSummary {
  products: number;
  rows: number;
  images: number;
}

/**
 * EMAIL B — products Talabat does not list yet, with their images.
 *
 * STEP 80: `sendable` is a GATE, not a constant — see evaluateNewProductsReadiness.
 * STEP 88: the images travel as a time-limited signed link, never as an
 * attachment; 332 MB of photographs is not an email.
 * STEP 89: rendered in the shared house shell with a real download button.
 */
export function buildTalabatNewProductsEmail(
  newWorkbookName: string,
  imagesZipName: string,
  readiness: {
    sendable: boolean;
    categoryRequests?: readonly string[];
    imagesLink?: { url: string; expiresAtIso: string } | null;
    summary?: NewProductsEmailSummary;
  } = { sendable: false },
): TalabatEmailDraft {
  const requests = readiness.categoryRequests ?? [];
  const link = readiness.imagesLink ?? null;
  const summary = readiness.summary ?? null;

  const imagesSection = link === null ? [] : [
    "The product images are provided as a secure download link rather than an",
    "email attachment, because of their size:",
    "",
    link.url,
    "",
    `This link expires on ${link.expiresAtIso}.`,
    "",
  ];
  const categoryAsk = requests.length === 0 ? [] : [
    "Please note that some of the attached products belong to a new category that",
    "is not currently available in our Talabat menu:",
    "",
    ...requests,
    "",
    "Kindly create this category and add the relevant attached products under it.",
    "",
  ];

  const bodyText = [
    "Dear Talabat Team,",
    "",
    "Please find attached our latest new-product additions for Malika's Universe.",
    "",
    link === null
      ? "The attached Excel contains only products that are not currently listed in"
      : "The attached Excel contains only products that are not currently listed in",
    link === null
      ? "our Talabat catalog, together with the required product images."
      : "our Talabat catalog. The product images are linked below.",
    "",
    ...(summary ? [
      `New products: ${formatMailNumber(summary.products)}`,
      `Rows: ${formatMailNumber(summary.rows)}`,
      `Images: ${formatMailNumber(summary.images)}`,
      `Excel: ${newWorkbookName}`,
      "",
    ] : []),
    ...imagesSection,
    "Kindly add the attached products to our existing menu while keeping all",
    "currently listed products unchanged.",
    "",
    ...categoryAsk,
    "Please let us know once the additions have been completed or if any further",
    "information is required.",
    "",
    SIGNOFF,
  ].join("\n");

  const rows: MailSummaryRow[] = [
    { label: "Update Type", value: "New Product Additions" },
    ...(summary ? [
      { label: "New Products", value: formatMailNumber(summary.products) },
      { label: "Rows", value: formatMailNumber(summary.rows) },
      { label: "Images", value: formatMailNumber(summary.images) },
    ] : []),
    { label: "Excel", value: `<code>${escapeMailHtml(newWorkbookName)}</code>`, raw: true },
    {
      label: "Product Images",
      value: link === null ? `<code>${escapeMailHtml(imagesZipName)}</code>` : "Secure download link (below)",
      raw: link === null,
    },
  ];

  const extra = link === null ? "" : [
    mailHeading("Product Images"),
    mailCtaButton({
      url: link.url,
      label: "Download Product Images",
      note: `The images are delivered through this secure direct-download link instead of an email attachment, because of their size. The link is valid until <b>${escapeMailHtml(link.expiresAtIso)}</b>.`,
    }),
  ].join("\n");

  const categoryHtml = requests.length === 0 ? "" : [
    mailHeading("New category required"),
    `  <p>Some of the attached products belong to a category that is not currently available in our Talabat menu:</p>`,
    `  <ul>${requests.map((r) => `<li><b>${escapeMailHtml(r)}</b></li>`).join("")}</ul>`,
    `  <p>Kindly create this category and add the relevant attached products under it.</p>`,
  ].join("\n");

  return {
    kind: "new_products",
    subject: TALABAT_EMAIL_SUBJECTS.new_products,
    bodyHtml: renderTalabatHtml({
      title: "New Products for Talabat",
      intro: [
        "Please find attached our latest new-product additions for Malika's Universe.",
        link === null
          ? "The attached Excel contains only products that are not currently listed in our Talabat catalog, together with the required product images."
          : "The attached Excel contains only products that are not currently listed in our Talabat catalog. The product images are linked below.",
      ],
      summaryRows: rows,
      extra: [extra, categoryHtml].filter((x) => x !== "").join("\n"),
      instruction: "Kindly add the attached products to our existing menu while keeping all currently listed products unchanged.",
      closing: "Please let us know once the additions have been completed or if any further information is required.",
    }),
    bodyText,
    // The ZIP is listed as an attachment ONLY when there is no link for it —
    // the attachment list is what the sender actually attaches, so it must not
    // claim a file that is being delivered another way.
    attachments: link === null ? [newWorkbookName, imagesZipName] : [newWorkbookName],
    sendable: readiness.sendable,
  };
}

/**
 * The two drafts are always produced as a PAIR of separate emails, never as one
 * combined message. A helper that returned a merged draft would make the mistake
 * possible, so none exists.
 */
export function buildTalabatEmailPair(input: {
  updateWorkbookName: string;
  newWorkbookName: string;
  imagesZipName: string;
  /** Email B's gate — omitted means NOT sendable (see the builder above). */
  newProductsReadiness?: { sendable: boolean; categoryRequests?: readonly string[] };
}): { updates: TalabatEmailDraft; newProducts: TalabatEmailDraft } {
  return {
    updates: buildTalabatUpdateEmail(input.updateWorkbookName),
    newProducts: buildTalabatNewProductsEmail(
      input.newWorkbookName, input.imagesZipName, input.newProductsReadiness ?? { sendable: false }),
  };
}

/**
 * EMAIL C — barcode corrections. REVIEW ONLY.
 *
 * Built so the owner can read exactly what would be proposed, and marked
 * `sendable: false` so no caller can dispatch it. It is not part of
 * buildTalabatEmailPair for the same reason: the pair is the sendable set.
 */
export function buildTalabatBarcodeCorrectionEmail(barcodeReviewWorkbookName: string): TalabatEmailDraft {
  return {
    kind: "barcode_corrections",
    subject: TALABAT_EMAIL_SUBJECTS.barcode_corrections,
    // STEP 89 — no HTML body ON PURPOSE. Email C is review-only and can never
    // reach a transport, so dressing it in the company shell with the official
    // signature would produce a letter that LOOKS ready to send. The plain text
    // below is what the owner reads on screen; nothing renders it as mail.
    bodyHtml: null,
    bodyText: [
      "REVIEW ONLY — this draft is not approved for sending.",
      "",
      "Dear Talabat Team,",
      "",
      "Please find attached a list of products where our records and the current",
      "Talabat catalog hold different barcodes.",
      "",
      "We are verifying these internally before requesting any change. No action is",
      "required from your side yet.",
      "",
      SIGNOFF,
    ].join("\n"),
    attachments: [barcodeReviewWorkbookName],
    sendable: false,
  };
}
