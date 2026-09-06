// TALABAT EMAIL ARTIFACTS — generation and storage (SERVER-ONLY).
//
// Turns a verified comparison run into the exact files the STEP 83 preflight
// looks for, and records the sidecar that lets the preflight tell a current
// bundle from a stale one.
//
// What this file deliberately does NOT do:
//   • recompute the delta. It takes a TalabatDeltaResult that the certified
//     comparison produced. Rebuilding that logic here would create a second
//     answer to "what changed", which is the failure the whole delta module
//     exists to prevent;
//   • build a second image pipeline. The ZIP comes from the certified job
//     engine driven over the allowed new rows, with the STEP 84 extension
//     correction switched on;
//   • touch the canonical catalog, any marketplace, or the full 538 MB
//     package. It writes to the email-artifacts prefix and nowhere else;
//   • send anything. There is no transport import here at all.

import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import { buildTalabatDeltaXlsxBuffer } from "@/lib/talabat/package-xlsx";
import {
  buildTalabatSafeUpdateAoa, buildTalabatNewProductsAoa, safeUpdateRows,
  deltaWorkbookName, newProductsImagesZipName, newProductPreviewRows, newProductImageScope,
} from "@/lib/export/talabat/delta-workbooks";
import { TALABAT_BASELINE_COLUMNS, type TalabatDeltaResult } from "@/lib/export/talabat/baseline-delta";
import { policyExcludedNewDeltaRows } from "@/lib/export/talabat/category-policy";
import {
  artifactPath, runFingerprint, SCOPE_SIDECAR_FILENAME,
  type ArtifactFileRecord, type TalabatArtifactScope,
} from "@/lib/export/talabat/email-artifacts";
import type { TalabatSendKind } from "@/lib/export/talabat/email-send";
import { crc32 } from "@/lib/net/zip";

const BUCKET = "talabat-packages";
const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const ZIP_MIME = "application/zip";
const JSON_MIME = "application/json";

/**
 * One serializer call site for both workbooks, so the text/numeric column
 * discipline cannot drift between Email A and Email B.
 */
function deltaXlsx(aoa: readonly (readonly (string | number)[])[]): Uint8Array {
  const idx = (name: string) => (TALABAT_BASELINE_COLUMNS as readonly string[]).indexOf(name);
  return buildTalabatDeltaXlsxBuffer(aoa, {
    // sku and every barcode column MUST stay text — a 13-digit barcode read as
    // a number loses its leading zero and arrives at Talabat as a different code.
    textColumns: [idx("sku"), idx("barcode 1"), idx("barcode 2"), idx("barcode 3")],
    numericColumns: [idx("price")],
    sheetName: "Products",
  });
}

async function put(path: string, bytes: Uint8Array, contentType: string): Promise<boolean> {
  try {
    const admin = createAdminClient();
    const { error } = await admin.storage.from(BUCKET).upload(path, bytes, { contentType, upsert: true });
    return !error;
  } catch {
    return false;
  }
}

function fileRecord(filename: string, bytes: Uint8Array, contentType: string): ArtifactFileRecord {
  return { filename, bytes: bytes.length, contentType, crc32: crc32(bytes) };
}

// ── EMAIL A — the safe existing-product updates ──────────────────────────────

export interface SafeUpdateArtifactResult {
  ok: boolean;
  filename: string;
  scope: TalabatArtifactScope;
}

/**
 * Build and store the safe-update workbook.
 *
 * The row set is safeUpdateRows() — NAME and PRICE differences only, each
 * product once even when both differ. Barcode, active and category are blank
 * by construction in buildTalabatSafeUpdateAoa; the sidecar counts them anyway
 * so the preflight verifies the file rather than trusting the builder.
 */
export async function generateSafeUpdateArtifact(
  result: TalabatDeltaResult, nowIso: string,
): Promise<SafeUpdateArtifactResult> {
  const aoa = buildTalabatSafeUpdateAoa(result);
  const body = aoa.slice(1);
  const bytes = deltaXlsx(aoa);
  const filename = deltaWorkbookName("safe-product-updates", nowIso);

  const idx = (name: string) => (TALABAT_BASELINE_COLUMNS as readonly string[]).indexOf(name);
  const nonEmpty = (col: number) => body.filter((r) => String(r[col] ?? "") !== "").length;

  const scope: TalabatArtifactScope = {
    kind: "existing_updates",
    runFingerprint: runFingerprint(result),
    generatedAtIso: nowIso,
    files: [fileRecord(filename, bytes, XLSX_MIME)],
    workbookRows: body.length,
    workbookProducts: new Set(body.map((r) => String(r[0]))).size,
    imageCount: null,
    rowsMissingImage: 0,
    excludedCategoryRows: 0,
    barcodeValueRows: nonEmpty(idx("barcode 1")) + nonEmpty(idx("barcode 2")) + nonEmpty(idx("barcode 3")),
    activeValueRows: nonEmpty(idx("active")),
    categoryValueRows: nonEmpty(idx("category 1")),
    extensionAudit: null,
  };

  const wrote = await put(artifactPath("existing_updates", filename), bytes, XLSX_MIME)
    && await putScope("existing_updates", scope);
  return { ok: wrote, filename, scope };
}

/** Row counts the owner report quotes, derived from the SAME row set. */
export function safeUpdateComposition(result: TalabatDeltaResult): {
  products: number; rows: number; nameRows: number; priceRows: number; bothRows: number;
} {
  const rows = safeUpdateRows(result);
  const has = (r: (typeof rows)[number], f: string) => r.diffs.some((d) => d.field === f);
  const nameRows = rows.filter((r) => has(r, "NAME_DIFF")).length;
  const priceRows = rows.filter((r) => has(r, "PRICE_DIFF")).length;
  return {
    products: new Set(rows.map((r) => r.our.sku)).size,
    rows: rows.length,
    nameRows,
    priceRows,
    bothRows: rows.filter((r) => has(r, "NAME_DIFF") && has(r, "PRICE_DIFF")).length,
  };
}

// ── EMAIL B — new products + their images ────────────────────────────────────

export interface NewProductsArtifactInput {
  result: TalabatDeltaResult;
  nowIso: string;
  /** the assembled image ZIP bytes, produced by the CERTIFIED job engine. */
  imageZipBytes: Uint8Array;
  imageCount: number;
  extensionAudit: { mismatches: number; renamed: number; collisions: number };
}

export async function generateNewProductsArtifact(
  input: NewProductsArtifactInput,
): Promise<{ ok: boolean; filenames: string[]; scope: TalabatArtifactScope }> {
  const { result, nowIso } = input;
  const aoa = buildTalabatNewProductsAoa(result);
  const body = aoa.slice(1);
  const workbookBytes = deltaXlsx(aoa);
  const workbookName = deltaWorkbookName("new-products", nowIso);
  const zipName = newProductsImagesZipName(nowIso);
  const imgScope = newProductImageScope(result);

  const scope: TalabatArtifactScope = {
    kind: "new_products",
    runFingerprint: runFingerprint(result),
    generatedAtIso: nowIso,
    files: [
      fileRecord(workbookName, workbookBytes, XLSX_MIME),
      fileRecord(zipName, input.imageZipBytes, ZIP_MIME),
    ],
    workbookRows: body.length,
    workbookProducts: new Set(newProductPreviewRows(result).map((r) => r.internalProductId)).size,
    imageCount: input.imageCount,
    rowsMissingImage: imgScope.rowsMissingImage,
    // Rows the Talabat category policy withholds must never be IN the file;
    // this counts what actually reached the workbook, not what was filtered.
    excludedCategoryRows: countExcludedInWorkbook(result, body),
    barcodeValueRows: 0,
    activeValueRows: 0,
    categoryValueRows: 0,
    extensionAudit: input.extensionAudit,
  };

  const wrote = await put(artifactPath("new_products", workbookName), workbookBytes, XLSX_MIME)
    && await put(artifactPath("new_products", zipName), input.imageZipBytes, ZIP_MIME)
    && await putScope("new_products", scope);
  return { ok: wrote, filenames: [workbookName, zipName], scope };
}

/** How many workbook rows belong to a SKU the category policy excludes. */
function countExcludedInWorkbook(result: TalabatDeltaResult, body: readonly (string | number)[][]): number {
  const excluded = new Set(policyExcludedNewDeltaRows(result).map((r) => r.our.sku));
  return body.filter((r) => excluded.has(String(r[0]))).length;
}

async function putScope(kind: TalabatSendKind, scope: TalabatArtifactScope): Promise<boolean> {
  const bytes = new TextEncoder().encode(JSON.stringify(scope, null, 2));
  return put(artifactPath(kind, SCOPE_SIDECAR_FILENAME), bytes, JSON_MIME);
}

/** The fingerprint a caller passes to the preflight for THIS run. */
export { runFingerprint };
