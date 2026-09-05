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

export type TalabatEmailKind = "existing_updates" | "new_products";

export interface TalabatEmailDraft {
  kind: TalabatEmailKind;
  subject: string;
  bodyText: string;
  /** filenames the owner is expected to attach — never fabricated content. */
  attachments: string[];
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
};

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
  };
}

/** EMAIL B — products Talabat does not list yet, with their images. */
export function buildTalabatNewProductsEmail(newWorkbookName: string, imagesZipName: string): TalabatEmailDraft {
  return {
    kind: "new_products",
    subject: TALABAT_EMAIL_SUBJECTS.new_products,
    bodyText: [
      "Dear Talabat Team,",
      "",
      "Please find attached our latest new-product additions for Malika's Universe.",
      "",
      "The attached Excel contains only products that are not currently listed in",
      "our Talabat catalog, together with the required product images.",
      "",
      "Kindly add the attached products to our existing menu while keeping all",
      "currently listed products unchanged.",
      "",
      "Please let us know once the additions have been completed or if any further",
      "information is required.",
      "",
      SIGNOFF,
    ].join("\n"),
    attachments: [newWorkbookName, imagesZipName],
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
}): { updates: TalabatEmailDraft; newProducts: TalabatEmailDraft } {
  return {
    updates: buildTalabatUpdateEmail(input.updateWorkbookName),
    newProducts: buildTalabatNewProductsEmail(input.newWorkbookName, input.imagesZipName),
  };
}
