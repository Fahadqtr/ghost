// TALABAT EMAIL ARTIFACTS — what a generated attachment set IS (PURE).
//
// STEP 83 built the send gate but nothing produced the files it looks for.
// This module defines the contract between the generator and the preflight:
// where an artifact lives, what its sidecar records, and — the part that
// matters — how the preflight knows the files on disk belong to the SAME
// comparison run the owner is about to act on.
//
// Without that last check the flow has a real failure mode: generate on
// Monday's baseline, re-run the comparison on Tuesday, then send Monday's
// workbook believing it is Tuesday's. A run fingerprint makes those two states
// distinguishable, so a stale bundle blocks instead of shipping.

import type { TalabatDeltaResult } from "./baseline-delta.ts";
import type { TalabatSendKind } from "./email-send.ts";

/**
 * Storage layout under the Talabat package bucket.
 *
 * The kind ids are the ones STEP 83 shipped and the delivery table's CHECK
 * constraint already names. Keeping them means the migration under review, the
 * email templates and this layout all agree on one vocabulary.
 */
export const TALABAT_EMAIL_ARTIFACT_PREFIX = "email-artifacts";
export const SCOPE_SIDECAR_FILENAME = "scope.json";

export function artifactPath(kind: TalabatSendKind, filename: string): string {
  return `${TALABAT_EMAIL_ARTIFACT_PREFIX}/${kind}/${filename}`;
}

// ── run binding ──────────────────────────────────────────────────────────────

/**
 * A stable fingerprint of the comparison run an artifact was generated from.
 *
 * Deliberately built from the delta's own COUNTS rather than from a timestamp
 * or a random id: two runs over identical inputs produce the same fingerprint
 * (so regenerating without any data change does not spuriously invalidate a
 * bundle), and any change to what we would send changes it.
 *
 * It is a cheap consistency check, not a cryptographic commitment — it detects
 * drift, and is not relied on to detect tampering, which the private bucket
 * and the owner gate handle.
 */
export function runFingerprint(result: TalabatDeltaResult): string {
  const c = result.counts;
  const parts = [
    c.ourRows, c.baselineRows, c.matched, c.matchedBySku, c.matchedByBarcode,
    c.ambiguous, c.noChange, c.needsUpdate, c.newRows, c.unmatchedBaseline,
    c.nameDiffs, c.priceDiffs, c.activeStatusDiffs, c.barcodeDiffs, c.categoryDiffs,
  ];
  return `r1.${parts.join(".")}`;
}

// ── the sidecar ──────────────────────────────────────────────────────────────

export interface ArtifactFileRecord {
  filename: string;
  bytes: number;
  contentType: string;
  /** CRC-32 of the stored bytes — cheap corruption detection on read-back. */
  crc32: number;
}

export interface TalabatArtifactScope {
  kind: TalabatSendKind;
  runFingerprint: string;
  generatedAtIso: string;
  files: ArtifactFileRecord[];
  /** rows in the workbook the owner is sending. */
  workbookRows: number;
  /** distinct products behind those rows. */
  workbookProducts: number;
  /** null for Email A, which carries no image package. */
  imageCount: number | null;
  rowsMissingImage: number;
  excludedCategoryRows: number;
  /** rows carrying a barcode value. MUST be 0 for the safe update artifact. */
  barcodeValueRows: number;
  activeValueRows: number;
  categoryValueRows: number;
  /** STEP 84 image-extension audit; null when there is no image package. */
  extensionAudit: { mismatches: number; renamed: number; collisions: number } | null;
}

/** Names the preflight reads back. Kept separate so a caller cannot mistype. */
export function scopeFilenames(scope: TalabatArtifactScope): string[] {
  return scope.files.map((f) => f.filename);
}

export type ScopeParseResult =
  | { ok: true; value: TalabatArtifactScope }
  | { ok: false; reason: "unreadable" | "wrong_kind" };

/**
 * Parse a stored sidecar. Anything unrecognised is "unreadable", which the
 * preflight treats as "no bundle" — never as a partially-trusted one.
 */
export function parseArtifactScope(raw: unknown, expectedKind: TalabatSendKind): ScopeParseResult {
  if (raw === null || typeof raw !== "object") return { ok: false, reason: "unreadable" };
  const o = raw as Record<string, unknown>;
  const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

  if (o.kind !== expectedKind) return { ok: false, reason: "wrong_kind" };
  const fingerprint = str(o.runFingerprint);
  const generatedAtIso = str(o.generatedAtIso);
  const workbookRows = num(o.workbookRows);
  const workbookProducts = num(o.workbookProducts);
  const rowsMissingImage = num(o.rowsMissingImage);
  const excludedCategoryRows = num(o.excludedCategoryRows);
  const barcodeValueRows = num(o.barcodeValueRows);
  const activeValueRows = num(o.activeValueRows);
  const categoryValueRows = num(o.categoryValueRows);
  if (fingerprint === null || generatedAtIso === null) return { ok: false, reason: "unreadable" };
  for (const n of [workbookRows, workbookProducts, rowsMissingImage, excludedCategoryRows,
    barcodeValueRows, activeValueRows, categoryValueRows]) {
    if (n === null) return { ok: false, reason: "unreadable" };
  }
  const files: ArtifactFileRecord[] = [];
  if (!Array.isArray(o.files)) return { ok: false, reason: "unreadable" };
  for (const f of o.files) {
    if (f === null || typeof f !== "object") return { ok: false, reason: "unreadable" };
    const r = f as Record<string, unknown>;
    const filename = str(r.filename); const bytes = num(r.bytes);
    const contentType = str(r.contentType); const crc32 = num(r.crc32);
    if (filename === null || bytes === null || contentType === null || crc32 === null) {
      return { ok: false, reason: "unreadable" };
    }
    files.push({ filename, bytes, contentType, crc32 });
  }
  if (files.length === 0) return { ok: false, reason: "unreadable" };

  const audit = o.extensionAudit;
  let extensionAudit: TalabatArtifactScope["extensionAudit"] = null;
  if (audit !== null && typeof audit === "object") {
    const a = audit as Record<string, unknown>;
    const m = num(a.mismatches); const r2 = num(a.renamed); const c2 = num(a.collisions);
    if (m !== null && r2 !== null && c2 !== null) extensionAudit = { mismatches: m, renamed: r2, collisions: c2 };
  }
  return {
    ok: true,
    value: {
      kind: expectedKind,
      runFingerprint: fingerprint,
      generatedAtIso,
      files,
      workbookRows: workbookRows as number,
      workbookProducts: workbookProducts as number,
      imageCount: num(o.imageCount),
      rowsMissingImage: rowsMissingImage as number,
      excludedCategoryRows: excludedCategoryRows as number,
      barcodeValueRows: barcodeValueRows as number,
      activeValueRows: activeValueRows as number,
      categoryValueRows: categoryValueRows as number,
      extensionAudit,
    },
  };
}

// ── what makes a bundle sendable ─────────────────────────────────────────────

export type ArtifactBlock =
  | "artifact_missing"
  | "artifact_stale"
  | "artifact_empty"
  | "barcode_values_present"
  | "active_values_present"
  | "category_values_present"
  | "rows_missing_image"
  | "excluded_category_rows"
  | "extension_mismatch_unfixed";

/**
 * Verify a stored bundle against the CURRENT comparison run.
 *
 * Every check answers a question the owner would otherwise have to trust:
 * is this the run I am looking at, does the safe-update file really carry no
 * barcode/active/category value, does every row have its image, and did the
 * extension correction actually finish. Returns ALL failures, because fixing
 * them one round-trip at a time is worse than seeing the list.
 */
export function verifyArtifactScope(
  scope: TalabatArtifactScope | null,
  currentFingerprint: string,
): ArtifactBlock[] {
  if (scope === null) return ["artifact_missing"];
  const blocks: ArtifactBlock[] = [];
  if (scope.runFingerprint !== currentFingerprint) blocks.push("artifact_stale");
  if (scope.workbookRows <= 0 || scope.files.length === 0) blocks.push("artifact_empty");
  if (scope.kind === "existing_updates") {
    // The safe-update workbook's whole point: name and price, nothing else.
    if (scope.barcodeValueRows !== 0) blocks.push("barcode_values_present");
    if (scope.activeValueRows !== 0) blocks.push("active_values_present");
    if (scope.categoryValueRows !== 0) blocks.push("category_values_present");
  }
  if (scope.rowsMissingImage !== 0) blocks.push("rows_missing_image");
  if (scope.excludedCategoryRows !== 0) blocks.push("excluded_category_rows");
  if (scope.extensionAudit !== null && scope.extensionAudit.collisions !== 0) {
    blocks.push("extension_mismatch_unfixed");
  }
  return blocks;
}

export const ARTIFACT_BLOCK_AR: Record<ArtifactBlock, string> = {
  artifact_missing: "لم يتم توليد ملفات هذه الرسالة بعد.",
  artifact_stale: "الملفات المولّدة تعود لمقارنة سابقة — أعد التوليد قبل الإرسال.",
  artifact_empty: "الملفات المولّدة فارغة.",
  barcode_values_present: "ملف التحديثات الآمنة يحتوي قيم باركود — ممنوع الإرسال.",
  active_values_present: "ملف التحديثات الآمنة يحتوي قيم توفّر — ممنوع الإرسال.",
  category_values_present: "ملف التحديثات الآمنة يحتوي قيم تصنيف — ممنوع الإرسال.",
  rows_missing_image: "توجد صفوف بلا صورة في الحزمة.",
  excluded_category_rows: "توجد صفوف من تصنيفات مستبعدة عن طلبات.",
  extension_mismatch_unfixed: "توجد صور امتدادها لا يطابق محتواها ولم يُصحَّح.",
};
