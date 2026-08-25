// RAFEEQ NATIVE-OPTION RECONCILIATION PLAN (PURE).
//
// After the owner uploads the FULL/NEW package to Rafeeq, Rafeeq returns the
// native workbook (worksheet "data", 40 columns) with real numeric ids filled
// in. Rafeeq external identity is PARENT-PRODUCT grain: the returned product_id
// binds to ONE canonical parent product — an option product's repeated rows all
// carry the SAME product_id, and internal variants stay linked to the parent
// internally (no per-variant external_product_id is ever required). Returned
// group_id / option_id values are NOT stored — durable option identity would be
// a dedicated model, never an overload of the product-level ECL rows.
//
//   • matching evidence is the BARCODE column — the canonical PARENT SKU under
//     the approved template rule — corroborated by the product_image filename
//     base (our packaged files are parent-SKU-named). Titles are NEVER read and
//     NEVER matched — no fuzzy matching of any kind.
//   • repeated option rows of one product are COLLAPSED to one product entry;
//     rows of one product disagreeing about their product_id are refused.
//   • nothing is auto-resolved: duplicate returned ids, ids already bound to a
//     different product, and rows conflicting with an existing resolved mapping
//     are surfaced for the owner and EXCLUDED from the apply plan. A
//     needs_review conflict is retired ONLY by a clean exact match the owner
//     approves (resolve_needs_review).
//
// No I/O — node:test loads this directly.

import { RAFEEQ_NATIVE_HEADERS, NATIVE_COL } from "./native-template.ts";
import { normalizeBarcode } from "../../talabat/export.ts";
import { sanitizeSkuForFilename } from "../image-naming.ts";

// ── returned-sheet shape ──────────────────────────────────────────────────────

/** One PRODUCT reconstructed from the returned sheet (option rows collapsed). */
export interface ReturnedProduct {
  /** first 1-based spreadsheet row this product appeared on (header = 1). */
  rowNumber: number;
  /** BARCODE column = canonical parent SKU under the template rule. */
  barcode: string | null;
  /** product_image cell (our packaged parent-SKU filename on generated files). */
  imageName: string;
  /** returned Rafeeq product_id ("" when blank). */
  rafeeqId: string;
  /** physical rows this product occupied. */
  rowCount: number;
  /** true when repeated rows disagreed about the product_id — refused. */
  inconsistentId: boolean;
}

export interface ParsedReturnedSheet {
  ok: boolean;
  error: "empty" | "missing_columns" | null;
  products: ReturnedProduct[];
}

const HEADER_PRODUCT_ID = RAFEEQ_NATIVE_HEADERS[NATIVE_COL.productId];   // product_id
const HEADER_BARCODE = RAFEEQ_NATIVE_HEADERS[NATIVE_COL.barcode];        // barcode
const HEADER_IMAGE = RAFEEQ_NATIVE_HEADERS[NATIVE_COL.productImage];     // product_image

const cellText = (v: unknown): string => (v === null || v === undefined ? "" : String(v).trim());

/**
 * Locate the identity columns by HEADER NAME (case-insensitive) in the first
 * row, then project + COLLAPSE the data rows to products: consecutive-or-not
 * repeated rows sharing the same barcode (else the same product_id) are one
 * product. Column POSITIONS are not trusted — header names are the contract.
 */
export function parseReturnedSheet(aoa: readonly (readonly unknown[])[]): ParsedReturnedSheet {
  if (!Array.isArray(aoa) || aoa.length === 0) return { ok: false, error: "empty", products: [] };
  const header = (aoa[0] ?? []).map((c: unknown) => cellText(c).toLowerCase());
  const idCol = header.indexOf(HEADER_PRODUCT_ID);
  const barcodeCol = header.indexOf(HEADER_BARCODE);
  const imageCol = header.indexOf(HEADER_IMAGE);
  if (idCol < 0 || barcodeCol < 0) return { ok: false, error: "missing_columns", products: [] };

  const byKey = new Map<string, ReturnedProduct>();
  const products: ReturnedProduct[] = [];
  for (let i = 1; i < aoa.length; i++) {
    const raw = aoa[i] ?? [];
    const barcode = cellText(raw[barcodeCol]);
    const rafeeqId = cellText(raw[idCol]);
    const imageName = imageCol >= 0 ? cellText(raw[imageCol]) : "";
    if (barcode === "" && rafeeqId === "" && imageName === "") continue; // blank row
    // Grouping key: the barcode (parent SKU) when present, else the product_id,
    // else the physical row itself (unmatchable later, but still surfaced).
    const key = barcode !== "" ? `b:${barcode.toLowerCase()}` : rafeeqId !== "" ? `i:${rafeeqId}` : `r:${i}`;
    const existing = byKey.get(key);
    if (!existing) {
      const p: ReturnedProduct = { rowNumber: i + 1, barcode: barcode === "" ? null : barcode, imageName, rafeeqId, rowCount: 1, inconsistentId: false };
      byKey.set(key, p);
      products.push(p);
    } else {
      existing.rowCount++;
      if (existing.rafeeqId !== rafeeqId) existing.inconsistentId = true;
      if (existing.imageName === "" && imageName !== "") existing.imageName = imageName;
    }
  }
  return { ok: true, error: null, products };
}

/** Derive the sanitized SKU token from a packaged image filename (`<sku>.<ext>`). */
export function skuTokenFromImageName(imageName: string): string | null {
  const raw = cellText(imageName);
  if (raw === "" || raw.startsWith("{")) return null; // Rafeeq asset JSON ⇒ no token
  const clean = raw.split(/[\\/]/).pop() ?? "";
  if (clean === "") return null;
  const dot = clean.lastIndexOf(".");
  const base = dot > 0 ? clean.slice(0, dot) : clean;
  return base === "" ? null : base;
}

// A safe returned id: bounded token, no whitespace, no spreadsheet-formula
// lead-in. Anything else is surfaced as invalid — never written to ECL.
const RETURNED_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

// ── catalog + mapping evidence (inputs) — PARENT-PRODUCT grain ────────────────

export interface ReconcileCatalogProduct {
  productId: string;
  /** canonical parent product SKU — the exported BARCODE value. */
  sku: string;
  /** legacy real EAN (internal only — corroboration for pre-rule sheets). */
  barcode: string | null;
}

/** Current storefront-scoped Rafeeq mapping evidence for one PARENT product. */
export interface ReconcileMappingEvidence {
  productId: string | null;
  sku: string;
  externalId: string | null;
  status: "resolved" | "needs_review";
}

export interface ReconcileInput {
  returned: readonly ReturnedProduct[];
  catalog: readonly ReconcileCatalogProduct[];
  /** Rafeeq (rafeeq:malikas) PRODUCT-grain mappings — active + needs_review. */
  mappings: readonly ReconcileMappingEvidence[];
}

// ── classification ────────────────────────────────────────────────────────────

export type ReconcileEntryStatus =
  | "matched_insert"           // clean match, no mapping row yet → INSERT
  | "matched_update"           // clean match, mapping row without an id → UPDATE
  | "resolve_needs_review"     // clean match retiring a contested mapping → UPDATE
  | "already_mapped"           // mapping already carries this exact id → no-op
  | "missing_id"               // no returned id
  | "invalid_id"               // returned id fails the safe-token format
  | "inconsistent_rows"        // repeated option rows disagree about the id
  | "unmatchable"              // no barcode and no image-derived sku token
  | "unknown_sku"              // parent sku not in the canonical catalog
  | "ambiguous_sku"            // more than one catalog product carries this sku
  | "barcode_mismatch"         // matched but the corroborating evidence disagrees
  | "duplicate_external_id"    // the same returned id appears on multiple products
  | "conflict_external_id"     // returned id already bound to a DIFFERENT product
  | "conflict_existing_mapping"; // product already resolved to a DIFFERENT id

export interface ReconcileEntry {
  rowNumber: number;
  barcode: string | null;
  skuToken: string | null;
  returnedId: string | null;
  status: ReconcileEntryStatus;
  productId: string | null;
  matchedSku: string | null;
  matchedBy: "barcode" | "image_sku" | null;
  detail: string | null;
}

export interface ReconcileApplyAction {
  action: "insert" | "update" | "resolve_needs_review";
  productId: string;
  /** parent-product grain — always null (variants are options, not identities). */
  variantId: null;
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
  inconsistent_rows: null,
  unmatchable: null,
  unknown_sku: null,
  ambiguous_sku: null,
  barcode_mismatch: null,
  duplicate_external_id: null,
  conflict_external_id: null,
  conflict_existing_mapping: null,
};

/**
 * Build the reconciliation preview + apply plan at PARENT-PRODUCT grain.
 * Deterministic; consumes only barcode(parent-SKU)/image-filename/id evidence
 * (titles are not even part of the input shape).
 */
export function buildReconcilePlan(input: ReconcileInput): ReconcilePlan {
  const catalog = Array.isArray(input?.catalog) ? input.catalog : [];
  const mappings = Array.isArray(input?.mappings) ? input.mappings : [];
  const returned = Array.isArray(input?.returned) ? input.returned : [];

  // Catalog lookups: parent SKU (exact, lowercased) + the sanitized filename
  // token of the parent SKU (our packaged image names) + the legacy real EAN.
  const byParentSku = new Map<string, ReconcileCatalogProduct[]>();
  const bySkuToken = new Map<string, ReconcileCatalogProduct[]>();
  const byLegacyEan = new Map<string, ReconcileCatalogProduct[]>();
  for (const p of catalog) {
    const sku = String(p.sku ?? "").trim().toLowerCase();
    if (sku !== "") {
      const list = byParentSku.get(sku) ?? [];
      list.push(p);
      byParentSku.set(sku, list);
    }
    const token = sanitizeSkuForFilename(p.sku).toLowerCase();
    if (token !== "") {
      const list = bySkuToken.get(token) ?? [];
      list.push(p);
      bySkuToken.set(token, list);
    }
    const ean = normalizeBarcode(p.barcode);
    if (ean !== null) {
      const list = byLegacyEan.get(ean) ?? [];
      list.push(p);
      byLegacyEan.set(ean, list);
    }
  }

  // Mapping lookups (product grain) + existing external id → owning product.
  const mappingByProduct = new Map<string, ReconcileMappingEvidence>();
  const ownerByExternalId = new Map<string, string>();
  for (const m of mappings) {
    if (m.productId) mappingByProduct.set(m.productId, m);
    if (m.externalId && m.productId && m.status === "resolved") {
      ownerByExternalId.set(m.externalId, m.productId);
    }
  }

  // Duplicate returned ids across the sheet (counting only usable ids).
  const idOccurrences = new Map<string, number>();
  for (const r of returned) {
    const id = cellText(r.rafeeqId);
    if (id === "") continue;
    idOccurrences.set(id, (idOccurrences.get(id) ?? 0) + 1);
  }

  const entries: ReconcileEntry[] = returned.map((r) => {
    const skuToken = skuTokenFromImageName(r.imageName);
    const returnedIdRaw = cellText(r.rafeeqId);
    const returnedId = returnedIdRaw === "" ? null : returnedIdRaw;

    const base = {
      rowNumber: r.rowNumber,
      barcode: r.barcode,
      skuToken,
      returnedId,
      productId: null as string | null,
      matchedSku: null as string | null,
      matchedBy: null as ReconcileEntry["matchedBy"],
      detail: null as string | null,
    };

    if (r.inconsistentId) {
      return { ...base, status: "inconsistent_rows" as const, detail: "صفوف الخيارات المتكررة تحمل مُعرّفات مختلفة." };
    }
    if (returnedId === null) return { ...base, status: "missing_id" as const };
    if (!RETURNED_ID_RE.test(returnedId)) return { ...base, status: "invalid_id" as const };
    if ((idOccurrences.get(returnedId) ?? 0) > 1) {
      return { ...base, status: "duplicate_external_id" as const, detail: "المُعرّف مكرّر داخل الملف المرتجع." };
    }

    // Primary match: the BARCODE column = the canonical PARENT SKU.
    let matched: ReconcileCatalogProduct | null = null;
    let matchedBy: ReconcileEntry["matchedBy"] = null;
    const bc = normalizeBarcode(r.barcode);
    if (bc !== null) {
      const candidates = byParentSku.get(bc.toLowerCase()) ?? [];
      if (candidates.length > 1) return { ...base, status: "ambiguous_sku" as const };
      if (candidates.length === 1) {
        matched = candidates[0];
        matchedBy = "barcode";
      }
    }
    // Fallback: the parent-SKU token derived from our packaged image filename.
    if (!matched && skuToken) {
      const candidates = bySkuToken.get(skuToken.toLowerCase()) ?? [];
      if (candidates.length > 1) return { ...base, status: "ambiguous_sku" as const };
      if (candidates.length === 1) {
        matched = candidates[0];
        matchedBy = "image_sku";
      }
    }
    if (!matched) {
      return { ...base, status: bc !== null || skuToken ? ("unknown_sku" as const) : ("unmatchable" as const) };
    }

    const matchedBase = { ...base, productId: matched.productId, matchedSku: matched.sku, matchedBy };

    // Corroboration: when BOTH evidences exist they must agree on the product;
    // a barcode that matches neither the parent SKU nor the legacy EAN of the
    // image-matched product is a refused mismatch.
    if (matchedBy === "image_sku" && bc !== null) {
      const parent = String(matched.sku ?? "").trim().toLowerCase();
      const legacy = normalizeBarcode(matched.barcode);
      const agrees = bc.toLowerCase() === parent || (legacy !== null && bc === legacy);
      if (!agrees) return { ...matchedBase, status: "barcode_mismatch" as const };
    }
    if (matchedBy === "barcode" && skuToken) {
      const tokenOfMatched = sanitizeSkuForFilename(matched.sku).toLowerCase();
      if (skuToken.toLowerCase() !== tokenOfMatched) {
        return { ...matchedBase, status: "barcode_mismatch" as const };
      }
    }

    // The returned id must not already belong to a DIFFERENT product.
    const owner = ownerByExternalId.get(returnedId);
    if (owner && owner !== matched.productId) {
      return { ...matchedBase, status: "conflict_external_id" as const };
    }

    const existing = mappingByProduct.get(matched.productId) ?? null;
    let status: ReconcileEntryStatus;
    if (!existing) status = "matched_insert";
    else if (existing.status === "needs_review") status = "resolve_needs_review";
    else if (existing.externalId === null) status = "matched_update";
    else if (existing.externalId === returnedId) status = "already_mapped";
    else status = "conflict_existing_mapping";

    return { ...matchedBase, status };
  });

  const apply: ReconcileApplyAction[] = [];
  for (const e of entries) {
    const action = APPLY_STATUS[e.status];
    if (!action || !e.productId || !e.returnedId || !e.matchedSku) continue;
    const entry = catalog.find((p) => p.productId === e.productId) ?? null;
    apply.push({
      action,
      productId: e.productId,
      variantId: null, // parent-product grain — options are never separate identities
      sku: e.matchedSku,
      barcode: entry ? normalizeBarcode(entry.barcode) : null,
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
      conflicts: count("conflict_external_id") + count("conflict_existing_mapping") + count("barcode_mismatch") + count("inconsistent_rows"),
      invalid: count("invalid_id"),
    },
  };
}
