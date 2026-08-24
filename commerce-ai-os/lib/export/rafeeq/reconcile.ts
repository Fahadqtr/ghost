// RAFEEQ.FULLSYNC.1 — returned-file ID reconciliation PLAN (PURE).
//
// After the owner uploads the FULL/NEW package to Rafeeq, Rafeeq returns the
// same spreadsheet with real Rafeeq IDs filled into the RAFEEQ ID column. This
// module turns that returned sheet (as an AoA — parsing lives in the server
// module) into a PREVIEW + APPLY PLAN:
//
//   • matching is by certified SKU (derived from the IMAGE NAME column — the
//     packaged filename IS the sanitized SKU, `<sku>.<ext>`) with the BARCODE
//     column as corroboration, and by unique barcode as the only fallback.
//     Titles are NEVER read and NEVER matched — no fuzzy matching of any kind.
//   • nothing is auto-resolved: duplicate returned ids, ids already bound to a
//     different product, and rows conflicting with an existing resolved mapping
//     are surfaced for the owner and EXCLUDED from the apply plan.
//   • the apply plan only ever targets the storefront-scoped Rafeeq identity
//     (external_channel_listings, rafeeq:malikas) — executed elsewhere, only
//     after explicit owner approval. This is how needs_review conflicts are
//     retired: an exact SKU match with a clean returned id becomes a
//     "resolve_needs_review" update (see the classification below) that the
//     owner confirms.
//
// No I/O — node:test loads this directly.

import { RAFEEQ_HEADERS } from "../../exporters.ts";
import { normalizeBarcode } from "../../talabat/export.ts";
import { sanitizeSkuForFilename } from "../image-naming.ts";
import { RAFEEQ_NEW_MARKER } from "./package.ts";

// ── returned-sheet shape ──────────────────────────────────────────────────────

/** One data row from the returned sheet (only the identity-bearing columns). */
export interface ReturnedRow {
  rowNumber: number; // 1-based spreadsheet row (header = 1)
  imageName: string;
  barcode: string | null;
  rafeeqId: string;
}

export interface ParsedReturnedSheet {
  ok: boolean;
  error: "empty" | "missing_columns" | null;
  rows: ReturnedRow[];
}

const HEADER_IMAGE = RAFEEQ_HEADERS[7]; // "IMAGE NAME"
const HEADER_BARCODE = RAFEEQ_HEADERS[8]; // "BARCODE"
const HEADER_ID = RAFEEQ_HEADERS[9]; // "RAFEEQ ID"

const cellText = (v: unknown): string => (v === null || v === undefined ? "" : String(v).trim());

/**
 * Locate the identity columns by HEADER NAME (case-insensitive) in the first
 * row, then project the data rows. Column POSITIONS are not trusted — Rafeeq
 * may return extra/reordered columns; the header names are the contract.
 */
export function parseReturnedSheet(aoa: readonly (readonly unknown[])[]): ParsedReturnedSheet {
  if (!Array.isArray(aoa) || aoa.length === 0) return { ok: false, error: "empty", rows: [] };
  const header = (aoa[0] ?? []).map((c: unknown) => cellText(c).toUpperCase());
  const imageCol = header.indexOf(HEADER_IMAGE.toUpperCase());
  const barcodeCol = header.indexOf(HEADER_BARCODE.toUpperCase());
  const idCol = header.indexOf(HEADER_ID.toUpperCase());
  if (imageCol < 0 || idCol < 0) return { ok: false, error: "missing_columns", rows: [] };

  const rows: ReturnedRow[] = [];
  for (let i = 1; i < aoa.length; i++) {
    const raw = aoa[i] ?? [];
    const imageName = cellText(raw[imageCol]);
    const rafeeqId = cellText(raw[idCol]);
    const barcode = barcodeCol >= 0 ? cellText(raw[barcodeCol]) : "";
    if (imageName === "" && rafeeqId === "" && barcode === "") continue; // blank row
    rows.push({ rowNumber: i + 1, imageName, barcode: barcode === "" ? null : barcode, rafeeqId });
  }
  return { ok: true, error: null, rows };
}

/** Derive the sanitized SKU token from a packaged image filename (`<sku>.<ext>`). */
export function skuTokenFromImageName(imageName: string): string | null {
  const clean = cellText(imageName).split(/[\\/]/).pop() ?? "";
  if (clean === "") return null;
  const dot = clean.lastIndexOf(".");
  const base = dot > 0 ? clean.slice(0, dot) : clean;
  return base === "" ? null : base;
}

// A safe returned id: bounded token, no whitespace, no spreadsheet-formula
// lead-in. Anything else is surfaced as invalid — never written to ECL.
const RETURNED_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

// ── catalog + mapping evidence (inputs) ───────────────────────────────────────

export interface ReconcileCatalogProduct {
  productId: string;
  sku: string;
  barcode: string | null;
}

/** Current storefront-scoped Rafeeq mapping evidence for one product/SKU. */
export interface ReconcileMappingEvidence {
  productId: string | null;
  sku: string;
  externalId: string | null;
  status: "resolved" | "needs_review";
}

export interface ReconcileInput {
  returned: readonly ReturnedRow[];
  catalog: readonly ReconcileCatalogProduct[];
  /** Rafeeq (rafeeq:malikas) mappings only — active + needs_review. */
  mappings: readonly ReconcileMappingEvidence[];
}

// ── classification ────────────────────────────────────────────────────────────

export type ReconcileEntryStatus =
  | "matched_insert"           // clean match, no mapping row yet → INSERT
  | "matched_update"           // clean match, mapping row without an id → UPDATE
  | "resolve_needs_review"     // clean match retiring a contested mapping → UPDATE
  | "already_mapped"           // mapping already carries this exact id → no-op
  | "missing_id"               // no returned id (or still the "new product" marker)
  | "invalid_id"               // returned id fails the safe-token format
  | "unmatchable"              // no SKU derivable and no unique barcode match
  | "unknown_sku"              // SKU not in the canonical catalog
  | "ambiguous_sku"            // more than one catalog product carries this SKU
  | "barcode_mismatch"         // SKU matched but the barcodes disagree
  | "duplicate_external_id"    // the same returned id appears on multiple rows
  | "conflict_external_id"     // returned id already bound to a DIFFERENT product
  | "conflict_existing_mapping"; // product already resolved to a DIFFERENT id

export interface ReconcileEntry {
  rowNumber: number;
  imageName: string;
  skuToken: string | null;
  returnedId: string | null;
  status: ReconcileEntryStatus;
  productId: string | null;
  matchedSku: string | null;
  matchedBy: "sku" | "barcode" | null;
  detail: string | null;
}

export interface ReconcileApplyAction {
  action: "insert" | "update" | "resolve_needs_review";
  productId: string;
  sku: string;
  barcode: string | null;
  externalId: string;
}

export interface ReconcilePlan {
  entries: ReconcileEntry[];
  apply: ReconcileApplyAction[];
  counts: {
    returnedRows: number;
    applicable: number;
    inserts: number;
    updates: number;
    needsReviewResolved: number;
    alreadyMapped: number;
    missingId: number;
    unknownSku: number;
    duplicates: number;
    conflicts: number;
    invalid: number;
  };
}

const APPLY_STATUS: Record<ReconcileEntryStatus, ReconcileApplyAction["action"] | null> = {
  matched_insert: "insert",
  matched_update: "update",
  resolve_needs_review: "resolve_needs_review",
  already_mapped: null,
  missing_id: null,
  invalid_id: null,
  unmatchable: null,
  unknown_sku: null,
  ambiguous_sku: null,
  barcode_mismatch: null,
  duplicate_external_id: null,
  conflict_external_id: null,
  conflict_existing_mapping: null,
};

/**
 * Build the reconciliation preview + apply plan. Deterministic; consumes only
 * SKU/barcode/id evidence (titles are not even part of the input shape).
 */
export function buildReconcilePlan(input: ReconcileInput): ReconcilePlan {
  const catalog = Array.isArray(input?.catalog) ? input.catalog : [];
  const mappings = Array.isArray(input?.mappings) ? input.mappings : [];
  const returned = Array.isArray(input?.returned) ? input.returned : [];

  // Catalog lookups: sanitized-SKU token (the packaged filename base) + barcode.
  const bySkuToken = new Map<string, ReconcileCatalogProduct[]>();
  const byBarcode = new Map<string, ReconcileCatalogProduct[]>();
  for (const p of catalog) {
    const token = sanitizeSkuForFilename(p.sku).toLowerCase();
    if (token !== "") {
      const list = bySkuToken.get(token) ?? [];
      list.push(p);
      bySkuToken.set(token, list);
    }
    const bc = normalizeBarcode(p.barcode);
    if (bc !== null) {
      const list = byBarcode.get(bc) ?? [];
      list.push(p);
      byBarcode.set(bc, list);
    }
  }

  // Mapping lookups: by product id, and existing external id → owning product.
  const mappingByProduct = new Map<string, ReconcileMappingEvidence>();
  const productByExternalId = new Map<string, string>();
  for (const m of mappings) {
    if (m.productId) mappingByProduct.set(m.productId, m);
    if (m.externalId && m.productId && m.status === "resolved") {
      productByExternalId.set(m.externalId, m.productId);
    }
  }

  // Duplicate returned ids across the sheet (counting only usable ids).
  const idOccurrences = new Map<string, number>();
  for (const r of returned) {
    const id = cellText(r.rafeeqId);
    if (id === "" || id.toLowerCase() === RAFEEQ_NEW_MARKER) continue;
    idOccurrences.set(id, (idOccurrences.get(id) ?? 0) + 1);
  }

  const entries: ReconcileEntry[] = returned.map((r) => {
    const skuToken = skuTokenFromImageName(r.imageName);
    const returnedIdRaw = cellText(r.rafeeqId);
    const isMarker = returnedIdRaw.toLowerCase() === RAFEEQ_NEW_MARKER;
    const returnedId = returnedIdRaw === "" || isMarker ? null : returnedIdRaw;

    const base = {
      rowNumber: r.rowNumber,
      imageName: r.imageName,
      skuToken,
      returnedId,
      productId: null as string | null,
      matchedSku: null as string | null,
      matchedBy: null as ReconcileEntry["matchedBy"],
      detail: null as string | null,
    };

    if (returnedId === null) return { ...base, status: "missing_id" as const };
    if (!RETURNED_ID_RE.test(returnedId)) return { ...base, status: "invalid_id" as const };
    if ((idOccurrences.get(returnedId) ?? 0) > 1) {
      return { ...base, status: "duplicate_external_id" as const, detail: "المُعرّف مكرّر داخل الملف المرتجع." };
    }

    // Primary match: sanitized SKU token from the IMAGE NAME column.
    let matched: ReconcileCatalogProduct | null = null;
    let matchedBy: ReconcileEntry["matchedBy"] = null;
    if (skuToken) {
      const candidates = bySkuToken.get(skuToken.toLowerCase()) ?? [];
      if (candidates.length > 1) return { ...base, status: "ambiguous_sku" as const };
      if (candidates.length === 1) {
        matched = candidates[0];
        matchedBy = "sku";
      }
    }
    // Only fallback: a barcode that uniquely identifies one catalog product.
    if (!matched) {
      const bc = normalizeBarcode(r.barcode);
      const candidates = bc !== null ? byBarcode.get(bc) ?? [] : [];
      if (candidates.length === 1) {
        matched = candidates[0];
        matchedBy = "barcode";
      } else if (skuToken) {
        return { ...base, status: "unknown_sku" as const };
      } else {
        return { ...base, status: "unmatchable" as const };
      }
    }

    // Corroboration: when BOTH sides carry a barcode, they must agree.
    const rowBarcode = normalizeBarcode(r.barcode);
    const productBarcode = normalizeBarcode(matched.barcode);
    if (matchedBy === "sku" && rowBarcode !== null && productBarcode !== null && rowBarcode !== productBarcode) {
      return { ...base, productId: matched.productId, matchedSku: matched.sku, matchedBy, status: "barcode_mismatch" as const };
    }

    // The returned id must not already belong to a DIFFERENT product.
    const owner = productByExternalId.get(returnedId);
    if (owner && owner !== matched.productId) {
      return { ...base, productId: matched.productId, matchedSku: matched.sku, matchedBy, status: "conflict_external_id" as const };
    }

    const existing = mappingByProduct.get(matched.productId) ?? null;
    let status: ReconcileEntryStatus;
    if (!existing) status = "matched_insert";
    else if (existing.status === "needs_review") status = "resolve_needs_review";
    else if (existing.externalId === null) status = "matched_update";
    else if (existing.externalId === returnedId) status = "already_mapped";
    else status = "conflict_existing_mapping";

    return { ...base, productId: matched.productId, matchedSku: matched.sku, matchedBy, status };
  });

  const apply: ReconcileApplyAction[] = [];
  for (const e of entries) {
    const action = APPLY_STATUS[e.status];
    if (!action || !e.productId || !e.returnedId || !e.matchedSku) continue;
    const product = catalog.find((p) => p.productId === e.productId) ?? null;
    apply.push({
      action,
      productId: e.productId,
      sku: e.matchedSku,
      barcode: product ? normalizeBarcode(product.barcode) : null,
      externalId: e.returnedId,
    });
  }

  const count = (s: ReconcileEntryStatus) => entries.filter((e) => e.status === s).length;
  return {
    entries,
    apply,
    counts: {
      returnedRows: returned.length,
      applicable: apply.length,
      inserts: count("matched_insert"),
      updates: count("matched_update"),
      needsReviewResolved: count("resolve_needs_review"),
      alreadyMapped: count("already_mapped"),
      missingId: count("missing_id"),
      unknownSku: count("unknown_sku") + count("unmatchable") + count("ambiguous_sku"),
      duplicates: count("duplicate_external_id"),
      conflicts: count("conflict_external_id") + count("conflict_existing_mapping") + count("barcode_mismatch"),
      invalid: count("invalid_id"),
    },
  };
}
