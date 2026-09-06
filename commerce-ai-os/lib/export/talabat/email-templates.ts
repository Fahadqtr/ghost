// TALABAT — the two SEPARATE partner emails (PURE, owner-authored copy).
//
// They must never merge. An "updates" email tells Talabat to change products
// they already list; a "new products" email tells them to add products they do
// not. Combining them invites Talabat to apply one instruction to the other
// set — the exact failure that re-sending the full 1454-row menu causes.
//
// The bodies below are the owner's wording, stored verbatim. Nothing here
// sends: these builders produce a DRAFT for owner review only.

import { MALIKAS_SIGNATURE_IDENTITY } from "../../mail/malikas-signature.ts";

export type TalabatEmailKind = "existing_updates" | "new_products" | "barcode_corrections";

export interface TalabatEmailDraft {
  kind: TalabatEmailKind;
  subject: string;
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

/** EMAIL A — updates to products Talabat already lists. */
export function buildTalabatUpdateEmail(updateWorkbookName: string): TalabatEmailDraft {
  return {
    kind: "existing_updates",
    subject: TALABAT_EMAIL_SUBJECTS.existing_updates,
    bodyText: [
      "Dear Talabat Team,",
      "",
      "Please find attached our latest product data update for Malika's Universe.",
      "",
      "The attached file contains only products that are already listed on Talabat",
      "and require data updates.",
      "",
      "Kindly update only the attached products while keeping all other existing",
      "products unchanged.",
      "",
      "Please let us know once the updates have been completed or if any additional",
      "information is required.",
      "",
      SIGNOFF,
    ].join("\n"),
    attachments: [updateWorkbookName],
    sendable: true,
  };
}

/**
 * EMAIL B — products Talabat does not list yet, with their images.
 *
 * STEP 80: `sendable` is a GATE, not a constant. Creating a product in a live
 * menu is not self-correcting the way a price update is, so the draft is only
 * dispatchable once every readiness condition holds — see
 * evaluateNewProductsReadiness. Callers that pass nothing get the safe answer.
 *
 * STEP 81: `categoryRequests` names Talabat categories that do not exist yet
 * and must be created for some of the attached products. It is a request the
 * email carries, not a reason to hold the attachment back — the owner decided
 * the products ship alongside the ask. Categories Talabat has excluded are
 * never mentioned here, because they are not in the attachment either.
 */
export function buildTalabatNewProductsEmail(
  newWorkbookName: string,
  imagesZipName: string,
  readiness: {
    sendable: boolean;
    categoryRequests?: readonly string[];
    /**
     * STEP 88 — the images travel as a time-limited signed download link, not
     * as an attachment. 332 MB of photographs is not an email, and silently
     * dropping them to make it one would ship a different package than the one
     * the owner reviewed. When a link is supplied the ZIP is NOT in
     * `attachments`, and the body says where the images actually are.
     */
    imagesLink?: { url: string; expiresAtIso: string } | null;
  } = { sendable: false },
): TalabatEmailDraft {
  const requests = readiness.categoryRequests ?? [];
  const link = readiness.imagesLink ?? null;
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
  return {
    kind: "new_products",
    subject: TALABAT_EMAIL_SUBJECTS.new_products,
    bodyText: [
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
      ...imagesSection,
      "Kindly add the attached products to our existing menu while keeping all",
      "currently listed products unchanged.",
      "",
      ...categoryAsk,
      "Please let us know once the additions have been completed or if any further",
      "information is required.",
      "",
      SIGNOFF,
    ].join("\n"),
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
