// TALABAT EMAIL B — the delta image package contract (PURE).
//
// Email B's images do not travel as an attachment; they travel as a signed link
// to a ZIP staged in the private artifact bucket. Something has to PUT that ZIP
// there, and until this module existed nothing did: the reader looked for
// `email-artifacts/new_products/source/images.zip`, no writer produced it, and
// every Email B generation ended in "تعذّر تجهيز حزمة الصور المطلوبة".
//
// This module owns the CONTRACT, not the packaging. The packaging is the
// certified job engine, driven over exactly the rows the Email B workbook
// contains — one image pipeline, one row-selection rule. What lives here:
//
//   • which rows the package must cover (delegated to the certified allowed
//     set, never re-derived);
//   • what the sidecar records, so a staged package can be proved to belong to
//     the run and the baseline it is about to be emailed with;
//   • the coverage audit, which FAILS CLOSED — a short package is refused, not
//     quietly sent with images missing.
//
// Nothing here fetches, zips, stores or sends.

import { previewRowKey, planRowImages } from "./package.ts";
import { allowedNewDeltaRows } from "./category-policy.ts";
import type { TalabatDeltaResult } from "./baseline-delta.ts";

/**
 * Where the staged package lives. A FIXED path, deliberately: it is the single
 * "current source images" slot, and the sidecar below is what proves whether
 * what sits in that slot is current. Versioning the path instead would leave
 * every superseded 130 MB package behind for ever.
 */
export const DELTA_IMAGE_SOURCE_PREFIX = "email-artifacts/new_products/source";
export const DELTA_IMAGE_ZIP_PATH = `${DELTA_IMAGE_SOURCE_PREFIX}/images.zip`;
export const DELTA_IMAGE_META_PATH = `${DELTA_IMAGE_SOURCE_PREFIX}/images.json`;

/**
 * The rows the image package must cover: EXACTLY the rows Email B's workbook
 * carries, expressed as certified preview-row keys so the job engine's own
 * "selected" mode can consume them.
 *
 * Delegated to allowedNewDeltaRows — the same function the workbook uses — so
 * the Electronics and ✨Toys exclusions, and every other category-policy rule,
 * apply here by construction rather than by a second copy of the rule that
 * could drift. Existing-product updates and barcode-review rows are not in that
 * set at all, so they cannot reach the package.
 */
export function deltaImageSelectionKeys(result: TalabatDeltaResult): string[] {
  return allowedNewDeltaRows(result).map((r) => previewRowKey(r.our));
}

/**
 * How many image FILES the package must contain.
 *
 * Not the row count: a simple product contributes its primary image plus up to
 * the gallery cap, so images outnumber rows. Computed with the certified
 * per-row planner — the same function the job engine loops over when it builds
 * the plan — so the number the screen promises and the number the job fetches
 * come from one rule. A row whose primary image is missing contributes nothing,
 * exactly as the engine drops it.
 */
export function deltaImagePlannedCount(result: TalabatDeltaResult): number {
  return allowedNewDeltaRows(result).reduce((n, r) => {
    const plan = planRowImages(r.our);
    return plan.primary ? n + 1 + plan.gallery.length : n;
  }, 0);
}

/**
 * STEP 85F — the CURRENT package scope, as one value.
 *
 * The three numbers the screen shows are the three a staged package has to
 * agree with, so they travel together rather than being recomputed by each
 * caller from a slightly different set of rows.
 */
export interface DeltaImageScope {
  expectedImages: number;
  scopeProducts: number;
  scopeRows: number;
}

/** The current scope, from the certified allowed set. One definition. */
export function deltaImageScope(result: TalabatDeltaResult): DeltaImageScope {
  const allowed = allowedNewDeltaRows(result);
  return {
    expectedImages: deltaImagePlannedCount(result),
    scopeProducts: new Set(allowed.map((r) => r.our.internalProductId)).size,
    scopeRows: allowed.length,
  };
}

/** What the staged ZIP is accompanied by. Every field is a binding or a count. */
export interface DeltaImageMeta {
  /** images actually packaged. */
  imageCount: number;
  /** images the plan called for. Equal to imageCount, or the package failed. */
  expectedImages: number;
  extensionAudit: { mismatches: number; renamed: number; collisions: number };
  /** the delta run this package was built for. */
  runFingerprint: string;
  /** the uploaded Talabat export that run was compared against. */
  baselineFingerprint: string | null;
  /** the certified job that produced it — the audit trail back to the fetches. */
  jobId: string;
  stagedAtIso: string;
  zipBytes: number;
  /**
   * STEP 90C — SHA-256 of exactly the bytes uploaded, computed while streaming.
   * null only for a sidecar written before streaming existed; the size check
   * still applies, so a null hash weakens nothing that was previously verified.
   */
  sha256: string | null;
  /**
   * STEP 85F — the scope this package was staged FOR, so a later comparison can
   * be checked against it directly instead of being inferred from the image
   * count alone. null on a sidecar written before this field existed; such a
   * package is still caught by the image-count check, which needs no history.
   */
  scopeProducts: number | null;
  scopeRows: number | null;
}

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : null;
const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

/** Read a sidecar back. Anything malformed is NOT a package — never a default. */
export function parseDeltaImageMeta(raw: unknown): DeltaImageMeta | null {
  if (raw === null || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const imageCount = num(o.imageCount);
  const expectedImages = num(o.expectedImages);
  const zipBytes = num(o.zipBytes);
  const runFingerprint = str(o.runFingerprint);
  const jobId = str(o.jobId);
  const stagedAtIso = str(o.stagedAtIso);
  const a = o.extensionAudit as Record<string, unknown> | undefined;
  if (imageCount === null || expectedImages === null || zipBytes === null) return null;
  if (runFingerprint === null || jobId === null || stagedAtIso === null || !a) return null;
  const mismatches = num(a.mismatches); const renamed = num(a.renamed); const collisions = num(a.collisions);
  if (mismatches === null || renamed === null || collisions === null) return null;
  return {
    imageCount, expectedImages, zipBytes, runFingerprint, jobId, stagedAtIso,
    baselineFingerprint: str(o.baselineFingerprint),
    sha256: str(o.sha256),
    extensionAudit: { mismatches, renamed, collisions },
    scopeProducts: num(o.scopeProducts),
    scopeRows: num(o.scopeRows),
  };
}

export type DeltaImageBlock =
  | "image_package_missing"
  | "image_package_stale_run"
  | "image_package_stale_baseline"
  | "image_package_incomplete"
  | "image_package_scope_mismatch"
  | "image_package_duplicate_names";

/**
 * Is the staged package the one THIS email may carry?
 *
 * A ZIP with no binding is the dangerous case: 632 photographs look equally
 * plausible whichever run produced them, so without this check a package built
 * against last week's baseline would be linked from today's email and nobody
 * would see it. Fail closed on every mismatch.
 *
 * STEP 85F — `currentScope` is REQUIRED, and it is the parameter this function
 * was missing. The old contract compared `meta.imageCount` against
 * `meta.expectedImages`: two numbers the SAME sidecar wrote about ITSELF, so a
 * package that finished cleanly always agreed with itself and passed. In
 * production a 632-image package staged on 2026-09-07 reported ready with no
 * blockers while the current comparison planned 622, because nothing compared
 * the package to the plan it now had to satisfy.
 *
 * The run fingerprint did not catch it either, and cannot: it is built from the
 * comparison COUNTS, and a Talabat-only channel policy (the authenticity hold)
 * changes which rows are ALLOWED without moving a single count. A scope change
 * is therefore invisible to the fingerprint by construction, which is exactly
 * why the scope has to be compared on its own terms.
 */
export function verifyDeltaImagePackage(
  meta: DeltaImageMeta | null,
  currentRunFingerprint: string,
  currentScope: DeltaImageScope,
  currentBaselineFingerprint?: string | null,
): DeltaImageBlock[] {
  if (meta === null) return ["image_package_missing"];
  const blocks: DeltaImageBlock[] = [];
  if (meta.zipBytes === 0 || meta.imageCount === 0) blocks.push("image_package_missing");
  if (meta.runFingerprint !== currentRunFingerprint) blocks.push("image_package_stale_run");
  // Only compared when BOTH sides know their baseline: a package staged before
  // the binding existed is stale-by-run anyway, and inventing a mismatch from a
  // missing value would block on nothing.
  if (currentBaselineFingerprint && meta.baselineFingerprint
    && meta.baselineFingerprint !== currentBaselineFingerprint) {
    blocks.push("image_package_stale_baseline");
  }
  // Did the package FINISH? Its own two numbers still answer that, and nothing
  // else does — a job that dropped an image records the shortfall right here.
  if (meta.imageCount !== meta.expectedImages) blocks.push("image_package_incomplete");
  // Does the package match the scope it must serve NOW? The image count is the
  // check that needs no stored history, so it also covers every sidecar written
  // before the scope fields existed. The row and product counts are compared
  // only when the sidecar recorded them: absent is unknown, never "equal".
  if (meta.imageCount !== currentScope.expectedImages
    || (meta.scopeRows !== null && meta.scopeRows !== currentScope.scopeRows)
    || (meta.scopeProducts !== null && meta.scopeProducts !== currentScope.scopeProducts)) {
    blocks.push("image_package_scope_mismatch");
  }
  if (meta.extensionAudit.collisions > 0) blocks.push("image_package_duplicate_names");
  return blocks;
}

export const DELTA_IMAGE_BLOCK_AR: Record<DeltaImageBlock, string> = {
  image_package_missing: "لم تُجهَّز حزمة صور المنتجات الجديدة بعد.",
  image_package_stale_run: "حزمة الصور بُنيت على مقارنة سابقة — أعد تجهيزها.",
  image_package_stale_baseline: "حزمة الصور بُنيت على ملف طلبات سابق — أعد تجهيزها.",
  image_package_incomplete: "حزمة الصور ناقصة — لم تُحمَّل كل الصور المطلوبة.",
  image_package_scope_mismatch: "حزمة الصور المحفوظة لا تطابق نطاق المقارنة الحالية — جهِّز حزمة جديدة أو انشر الحزمة الجاهزة.",
  image_package_duplicate_names: "تكرار في أسماء ملفات الصور — لم تُجهَّز الحزمة.",
};

export interface DeltaImageCoverage {
  expected: number;
  packaged: number;
  missing: number;
  extra: number;
  duplicateNames: number;
  complete: boolean;
}

/**
 * Audit one finished job against its own plan.
 *
 * `expected` is the plan's image count — derived from the current delta every
 * time, never a number written down anywhere. A short package is reported, not
 * rounded off: the owner asked for the exact missing references, and a partner
 * receiving 600 of 632 photographs with no warning is worse than receiving none.
 */
export function auditDeltaImageCoverage(input: {
  expected: number;
  packagedNames: readonly string[];
  droppedCount: number;
}): DeltaImageCoverage {
  const packaged = input.packagedNames.length;
  const unique = new Set(input.packagedNames).size;
  return {
    expected: input.expected,
    packaged,
    missing: Math.max(0, input.expected - packaged),
    extra: Math.max(0, packaged - input.expected),
    duplicateNames: packaged - unique,
    complete: packaged === input.expected && packaged === unique && input.droppedCount === 0,
  };
}
