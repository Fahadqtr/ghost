// TALABAT PACKAGE — package-local filename/content agreement (PURE).
//
// The certified planner names every image from its SOURCE URL, while the fetch
// port sniffs the bytes only to decide they are an image at all. Where a URL
// says .jpg over PNG bytes, the shipped package therefore carries a file whose
// name lies about its type — 133 such files in the current new-product scope.
//
// This module decides the PACKAGE-LOCAL correction. It deliberately does NOT:
//   • transcode anything — the bytes are already a valid image, just misnamed;
//   • touch the canonical catalog's image records — that is a separate,
//     separately-authorised change, and nothing here can reach them;
//   • rename when the two names mean the same format — ".jpeg" holding JPEG
//     bytes is not a mismatch, and renaming it would be churn, not a fix.

/** jpeg and jpg are the same format; everything else is its own name. */
export function canonicalImageExtension(ext: string): string {
  const e = ext.trim().toLowerCase().replace(/^\./, "");
  return e === "jpeg" ? "jpg" : e;
}

export function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot < 0 ? "" : filename.slice(dot + 1);
}

/** True when the NAME claims a different format than the BYTES actually are. */
export function isExtensionMismatch(filename: string, sniffedExt: string | null): boolean {
  if (sniffedExt === null || sniffedExt === "") return false;
  const named = canonicalImageExtension(extensionOf(filename));
  if (named === "") return true;
  return named !== canonicalImageExtension(sniffedExt);
}

/** The same stem with the sniffed format's extension. */
export function withSniffedExtension(filename: string, sniffedExt: string): string {
  const dot = filename.lastIndexOf(".");
  const stem = dot < 0 ? filename : filename.slice(0, dot);
  return `${stem}.${canonicalImageExtension(sniffedExt)}`;
}

export type ExtensionDecision =
  | { action: "keep"; name: string }
  | { action: "rename"; name: string; from: string }
  /**
   * The corrected name is already taken by a different file in this package.
   * Renaming would overwrite or duplicate, so the ORIGINAL name is kept and
   * the mismatch is reported UNFIXED — the preflight blocks on it rather than
   * shipping a silently wrong package. Fails closed by construction.
   */
  | { action: "collision"; name: string; wanted: string };

/**
 * Decide one image's packaged filename.
 *
 * `taken` is the set of names already committed to this package. Callers pass
 * their live set, so the decision is made against reality rather than against
 * the plan, which is what makes the collision branch reachable at all.
 */
export function decidePackagedName(
  planFilename: string,
  sniffedExt: string | null,
  taken: ReadonlySet<string>,
): ExtensionDecision {
  if (!isExtensionMismatch(planFilename, sniffedExt) || sniffedExt === null) {
    return { action: "keep", name: planFilename };
  }
  const wanted = withSniffedExtension(planFilename, sniffedExt);
  if (wanted === planFilename) return { action: "keep", name: planFilename };
  if (taken.has(wanted)) return { action: "collision", name: planFilename, wanted };
  return { action: "rename", name: wanted, from: planFilename };
}

export interface ExtensionAuditCounts {
  /** files whose name disagreed with their bytes. */
  mismatches: number;
  /** mismatches corrected package-locally. */
  renamed: number;
  /** mismatches left unfixed because the corrected name was taken. */
  collisions: number;
}

export function emptyExtensionAudit(): ExtensionAuditCounts {
  return { mismatches: 0, renamed: 0, collisions: 0 };
}
