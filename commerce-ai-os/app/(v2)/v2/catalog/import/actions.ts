"use server";

// Catalog Excel import actions (Phase UI.6).
//
// Three steps, all stateless on the server: the FILE travels with every call
// (preview AND apply re-parse it), so no plan computed in the browser is ever
// trusted — apply re-runs mapping validation, normalization, matching,
// validation, duplicate detection and a concurrency check before touching a
// row. NOTHING is written at upload or preview time.
//
// Database writes use the SESSION client (RLS). No admin client, no RPC call
// outside the existing save cores, no SQL. Updates write ONLY allowlisted
// columns of explicitly selected fields; creates go through createProductCore
// and variant appends go through syncProductVariants with the FULL current
// list plus the new row — never a partial list that could read as deletion.
//
// Every user-facing failure is a fixed Arabic message — no parser text, no
// Supabase error, no database codes, no constraint name, no stack.

import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { makeInventoryInitializer } from "@/lib/products/inventory-initializer";
import { isSignedIn } from "@/lib/auth/requireUser";
import { CATEGORIES } from "@/lib/constants";
import { loadIdentitySnapshot } from "@/lib/products/catalog-identity-read";
import { findDuplicates, type IdentityRow } from "@/lib/products/duplicate-detect";
import {
  loadSimilarProductCards,
  type SimilarProductCard,
} from "@/lib/products/similar-products-read";
import { nextMkSku } from "@/lib/products/sku-generate";
import { generateUniqueEan13Batch, isValidEan13 } from "@/lib/products/barcode-ean13";
import {
  syncProductVariants,
  toProductRow,
  type ProductInput,
  type VariantInput,
} from "@/lib/products/product-save";
import { createProductCore, projectVariantInsertRows } from "@/lib/products/product-create";
import { loadProductForEdit } from "@/lib/products/product-edit-read";
import {
  buildIdentityIndexes,
  buildRowUpdatePlan,
  CATALOG_FIELD_DEFS,
  detectCatalogColumns,
  detectNewCatalogRecord,
  fieldColumn,
  findFileDuplicates,
  fingerprintRecord,
  groupNewProductRows,
  mappingByField,
  matchCatalogRow,
  NEW_CLASS_LABELS,
  normalizeCatalogExcelRow,
  validateCatalogMapping,
  type CatalogImportField,
  type ColumnMapping,
  type MatchStatus,
  type NewRowClassification,
  type NormalizedRow,
  type RowUpdatePlan,
} from "@/lib/products/excel-import/core";
import {
  extractSheetRows,
  inspectWorkbook,
  looksLikeXlsx,
  MAX_IMPORT_BYTES,
} from "@/lib/products/excel-import/parse";
import type { ImportRecordResult } from "@/lib/products/excel-import/report";

// IMPORT_MESSAGES lives in lib/products/excel-import/messages.ts — a "use
// server" file may only export async functions, so the constants module
// stays outside and is imported here.
import { IMPORT_MESSAGES } from "@/lib/products/excel-import/messages";

// ── shared plumbing ──────────────────────────────────────────────────────────

type FileCheck = { ok: true; bytes: Buffer } | { ok: false; error: string };

async function readImportFile(formData: FormData): Promise<FileCheck> {
  const f = formData.get("file");
  if (!(f instanceof File) || f.size === 0) return { ok: false, error: IMPORT_MESSAGES.file_missing };
  if (f.size > MAX_IMPORT_BYTES) return { ok: false, error: IMPORT_MESSAGES.file_too_large };
  const okType =
    f.type === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
    f.type === "application/octet-stream" || // some browsers omit the xlsx MIME
    f.type === "";
  if (!okType) return { ok: false, error: IMPORT_MESSAGES.file_type };
  const bytes = Buffer.from(await f.arrayBuffer());
  // Content check — never the extension alone. .xls (CFB) and anything else fails here.
  if (!looksLikeXlsx(bytes)) return { ok: false, error: IMPORT_MESSAGES.file_type };
  return { ok: true, bytes };
}

function parseMappingParam(raw: unknown): ColumnMapping[] | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 100_000) return null;
  try {
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr) || arr.length > 200) return null;
    const out: ColumnMapping[] = [];
    for (const m of arr) {
      const o = (m ?? {}) as Record<string, unknown>;
      if (typeof o.index !== "number" || !Number.isSafeInteger(o.index) || o.index < 0) return null;
      out.push({
        index: o.index,
        header: typeof o.header === "string" ? o.header.slice(0, 200) : "",
        field: typeof o.field === "string" ? (o.field as CatalogImportField) : null,
        status: "auto",
      });
    }
    return out;
  } catch {
    return null;
  }
}

interface Pipeline {
  rows: NormalizedRow[];
  rowsByNum: Map<number, NormalizedRow>;
  matches: Map<number, { status: MatchStatus; record: IdentityRow | null }>;
  snapshotRows: IdentityRow[];
  snapshotSkus: string[];
  snapshotBarcodes: Set<string>;
  partial: boolean;
  byField: Partial<Record<CatalogImportField, number>>;
  classifications: NewRowClassification[];
}

type PipelineResult = { ok: true; p: Pipeline } | { ok: false; error: string };

async function runPipeline(
  supabase: ReturnType<typeof createClient>,
  bytes: Buffer,
  sheetName: string,
  mapping: ColumnMapping[],
): Promise<PipelineResult> {
  const mv = validateCatalogMapping(mapping);
  if (!mv.ok) {
    return {
      ok: false,
      error: mv.error === "no_identifier" ? IMPORT_MESSAGES.mapping_identifier
        : mv.error === "duplicate_field" ? IMPORT_MESSAGES.mapping_duplicate
        : IMPORT_MESSAGES.mapping_invalid,
    };
  }
  const extracted = await extractSheetRows(bytes, sheetName);
  if (extracted.status !== "ok") {
    return {
      ok: false,
      error: extracted.code === "sheet_not_found" ? IMPORT_MESSAGES.sheet_not_found
        : extracted.code === "too_many_rows" ? IMPORT_MESSAGES.too_many_rows
        : extracted.code === "too_many_columns" ? IMPORT_MESSAGES.too_many_columns
        : extracted.code === "empty" ? IMPORT_MESSAGES.file_empty
        : IMPORT_MESSAGES.file_unreadable,
    };
  }
  const byField = mappingByField(mapping);
  const rows: NormalizedRow[] = [];
  for (let i = 0; i < extracted.rows.length; i++) {
    // true Excel row number from the sparse reader (header is row 1)
    const row = normalizeCatalogExcelRow(extracted.rowNums[i] ?? i + 2, extracted.rows[i], byField);
    if (!row.empty) rows.push(row);
  }

  const scan = await loadIdentitySnapshot(supabase);
  if (scan.status !== "ok") return { ok: false, error: IMPORT_MESSAGES.scan_failed };
  const indexes = buildIdentityIndexes(scan.snapshot.rows);
  const fileDups = findFileDuplicates(rows);

  const matches = new Map<number, { status: MatchStatus; record: IdentityRow | null }>();
  for (const r of rows) matches.set(r.rowNum, matchCatalogRow(r, indexes, fileDups));

  const productSkus = new Set(
    scan.snapshot.rows.filter((r) => r.kind === "product").map((r) => (r.sku ?? "").toLowerCase()),
  );
  const fileNewProductSkus = new Set<string>();
  for (const r of rows) {
    if (r.kind === "product" && r.sku && matches.get(r.rowNum)?.status === "not_found") fileNewProductSkus.add(r.sku);
  }
  const classifications: NewRowClassification[] = [];
  for (const r of rows) {
    const m = matches.get(r.rowNum)!;
    if (m.status === "not_found" || m.status === "invalid" || m.status === "conflict" || m.status === "dup_in_file" || m.status === "dup_in_db") {
      classifications.push(detectNewCatalogRecord(r, m.status, (sku) => productSkus.has(sku), fileNewProductSkus));
    }
  }

  return {
    ok: true,
    p: {
      rows,
      rowsByNum: new Map(rows.map((r) => [r.rowNum, r])),
      matches,
      snapshotRows: scan.snapshot.rows,
      snapshotSkus: scan.snapshot.skus,
      snapshotBarcodes: scan.snapshot.barcodes,
      partial: scan.snapshot.partial,
      byField,
      classifications,
    },
  };
}

// current values of matched records, keyed by record id
const PRODUCT_READ_COLUMNS =
  "id, sku, barcode, name_en, name_ar, description_en, description_ar, brand_id, main_category, size, price, discount_price, keywords_en, keywords_ar, approval";
const VARIANT_READ_COLUMNS = "id, sku, barcode, variant_name, variant_name_en, color, size, price";

function inList(values: readonly string[]): string {
  return `(${values.map((v) => `"${v.replace(/"/g, '""')}"`).join(",")})`;
}

async function readCurrentRecords(
  supabase: ReturnType<typeof createClient>,
  productIds: string[],
  variantIds: string[],
): Promise<{ products: Map<string, Record<string, unknown>>; variants: Map<string, Record<string, unknown>>; brands: Map<string, string> } | null> {
  const products = new Map<string, Record<string, unknown>>();
  const variants = new Map<string, Record<string, unknown>>();
  const brands = new Map<string, string>();
  try {
    for (let i = 0; i < productIds.length; i += 100) {
      const chunk = productIds.slice(i, i + 100);
      if (chunk.length === 0) break;
      const { data, error } = await supabase.from("products").select(PRODUCT_READ_COLUMNS).filter("id", "in", inList(chunk));
      if (error) return null;
      for (const r of data ?? []) {
        const o = r as Record<string, unknown>;
        if (typeof o.id === "string") products.set(o.id, o);
      }
    }
    for (let i = 0; i < variantIds.length; i += 100) {
      const chunk = variantIds.slice(i, i + 100);
      if (chunk.length === 0) break;
      const { data, error } = await supabase.from("product_variants").select(VARIANT_READ_COLUMNS).filter("id", "in", inList(chunk));
      if (error) return null;
      for (const r of data ?? []) {
        const o = r as Record<string, unknown>;
        if (typeof o.id === "string") variants.set(o.id, o);
      }
    }
    const { data: brandRows } = await supabase.from("brands").select("id, name");
    for (const b of brandRows ?? []) {
      const o = b as { id?: unknown; name?: unknown };
      if (typeof o.id === "string" && typeof o.name === "string") brands.set(o.id, o.name);
    }
  } catch {
    return null;
  }
  return { products, variants, brands };
}

function currentFieldValues(
  record: Record<string, unknown>,
  kind: "product" | "variant",
  brands: Map<string, string>,
): Partial<Record<CatalogImportField, string | null>> {
  const s = (v: unknown) => (typeof v === "string" && v !== "" ? v : v === 0 ? "0" : typeof v === "number" ? String(v) : null);
  if (kind === "variant") {
    return {
      sku: s(record.sku), barcode: s(record.barcode), variant_name: s(record.variant_name),
      variant_name_en: s(record.variant_name_en), color: s(record.color), size: s(record.size), price: s(record.price),
    };
  }
  const brandId = typeof record.brand_id === "string" ? record.brand_id : null;
  return {
    sku: s(record.sku), barcode: s(record.barcode), name_en: s(record.name_en), name_ar: s(record.name_ar),
    description_en: s(record.description_en), description_ar: s(record.description_ar),
    brand: brandId ? (brands.get(brandId) ?? null) : null,
    main_category: s(record.main_category), size: s(record.size), price: s(record.price),
    discount_price: s(record.discount_price), keywords_en: s(record.keywords_en), keywords_ar: s(record.keywords_ar),
    approval: s(record.approval), color: s(record.color),
  };
}

function brandResolverFrom(brands: Map<string, string>): (name: string) => string | null {
  const byName = new Map<string, string>();
  for (const [id, name] of brands) byName.set(name.trim().toLowerCase(), id);
  return (name: string) => byName.get(name.trim().toLowerCase()) ?? null;
}

// ── Step 1: inspect (upload → sheets or headers) ─────────────────────────────

export interface InspectResponse {
  sheets: { name: string; rows: number }[];
  /** set when the workbook has exactly one sheet — mapping comes immediately */
  headers?: { mapping: ColumnMapping[]; sheetName: string; formulaCells: number };
}

export async function inspectCatalogImport(
  formData: FormData,
): Promise<{ data: InspectResponse } | { error: string }> {
  if (!(await isSignedIn())) return { error: IMPORT_MESSAGES.not_signed_in };
  try {
    const file = await readImportFile(formData);
    if (!file.ok) return { error: file.error };

    const inspected = await inspectWorkbook(file.bytes);
    if (inspected.status !== "ok") {
      return { error: inspected.code === "empty" ? IMPORT_MESSAGES.no_sheet : IMPORT_MESSAGES.file_unreadable };
    }
    if (inspected.sheets.length === 1) {
      const sheetName = inspected.sheets[0].name;
      const extracted = await extractSheetRows(file.bytes, sheetName);
      if (extracted.status !== "ok") {
        return {
          error: extracted.code === "too_many_rows" ? IMPORT_MESSAGES.too_many_rows
            : extracted.code === "too_many_columns" ? IMPORT_MESSAGES.too_many_columns
            : extracted.code === "empty" ? IMPORT_MESSAGES.file_empty
            : IMPORT_MESSAGES.file_unreadable,
        };
      }
      return {
        data: {
          sheets: inspected.sheets,
          headers: { mapping: detectCatalogColumns(extracted.headers), sheetName, formulaCells: extracted.formulaCells },
        },
      };
    }
    return { data: { sheets: inspected.sheets } };
  } catch {
    return { error: IMPORT_MESSAGES.unexpected_inspect };
  }
}

export async function readSheetHeaders(
  formData: FormData,
): Promise<{ data: { mapping: ColumnMapping[]; sheetName: string; formulaCells: number } } | { error: string }> {
  if (!(await isSignedIn())) return { error: IMPORT_MESSAGES.not_signed_in };
  try {
    const file = await readImportFile(formData);
    if (!file.ok) return { error: file.error };
    const sheetName = formData.get("sheet");
    if (typeof sheetName !== "string" || sheetName === "") return { error: IMPORT_MESSAGES.sheet_required };
    const extracted = await extractSheetRows(file.bytes, sheetName.slice(0, 200));
    if (extracted.status !== "ok") {
      return {
        error: extracted.code === "sheet_not_found" ? IMPORT_MESSAGES.sheet_not_found
          : extracted.code === "too_many_rows" ? IMPORT_MESSAGES.too_many_rows
          : extracted.code === "too_many_columns" ? IMPORT_MESSAGES.too_many_columns
          : extracted.code === "empty" ? IMPORT_MESSAGES.file_empty
          : IMPORT_MESSAGES.file_unreadable,
      };
    }
    return {
      data: { mapping: detectCatalogColumns(extracted.headers), sheetName: sheetName.slice(0, 200), formulaCells: extracted.formulaCells },
    };
  } catch {
    return { error: IMPORT_MESSAGES.unexpected_inspect };
  }
}

// ── Step 2: full preview plan ────────────────────────────────────────────────

export interface PreviewUpdateRow {
  rowNum: number;
  recordKind: "product" | "variant";
  recordId: string;
  sku: string | null;
  barcode: string | null;
  displayName: string;
  imageUrl: string | null;
  matchStatus: MatchStatus;
  plan: RowUpdatePlan;
  warnings: string[];
}

export interface PreviewProblemRow {
  rowNum: number;
  kind: "product" | "variant" | "unknown";
  sku: string | null;
  barcode: string | null;
  message: string;
}

export interface PreviewNewGroup {
  mainRowNum: number;
  mainSku: string | null;
  needsSku: boolean;
  needsImage: true; // Excel image columns are ignored in v1 — every new product needs its image later
  displayName: string;
  fields: { field: CatalogImportField; label: string; value: string }[];
  variants: { rowNum: number; sku: string | null; barcode: string | null; name: string }[];
  missing: string[];
  blockedReason: string | null;
  similar: { level: "none" | "similar" | "exact"; cards: SimilarProductCard[]; total: number };
}

export interface PreviewNewVariant {
  rowNum: number;
  sku: string;
  barcode: string | null;
  name: string;
  parent: SimilarProductCard | null;
  parentId: string;
  parentFingerprint: string;
  blockedReason: string | null;
}

export interface ImportPreview {
  summary: {
    productUpdates: number; variantUpdates: number; newProducts: number; newVariants: number;
    problems: number; unchanged: number;
  };
  updates: PreviewUpdateRow[];
  newGroups: PreviewNewGroup[];
  newVariants: PreviewNewVariant[];
  problems: PreviewProblemRow[];
  unchangedRows: number[];
  partialSnapshot: boolean;
}

const SIMILAR_HYDRATION_GROUP_CAP = 20;

function parentVariantsFingerprint(snapshotRows: readonly IdentityRow[], parentId: string): string {
  const list = snapshotRows
    .filter((r) => r.kind === "variant" && r.productId === parentId)
    .map((r) => `${r.id}:${(r.sku ?? "").toLowerCase()}`)
    .sort()
    .join("|");
  return fingerprintRecord(["sku"], { sku: list });
}

function rowFieldValue(row: NormalizedRow, field: CatalogImportField): string {
  const v = row.values.find((x) => x.field === field && !x.clear);
  return v ? v.value : "";
}

function selectedFieldsParam(raw: unknown): Set<CatalogImportField> {
  const known = new Set<string>(CATALOG_FIELD_DEFS.map((d) => d.field));
  const out = new Set<CatalogImportField>();
  if (typeof raw !== "string" || raw.length > 2000) return out;
  for (const f of raw.split(",")) {
    const t = f.trim();
    if (known.has(t)) out.add(t as CatalogImportField);
  }
  return out;
}

export async function previewCatalogImport(
  formData: FormData,
): Promise<{ data: ImportPreview } | { error: string }> {
  if (!(await isSignedIn())) return { error: IMPORT_MESSAGES.not_signed_in };
  try {
    const file = await readImportFile(formData);
    if (!file.ok) return { error: file.error };
    const sheetName = formData.get("sheet");
    if (typeof sheetName !== "string" || sheetName === "") return { error: IMPORT_MESSAGES.sheet_required };
    const mapping = parseMappingParam(formData.get("mapping"));
    if (!mapping) return { error: IMPORT_MESSAGES.mapping_invalid };
    const selectedFields = selectedFieldsParam(formData.get("fields"));

    const supabase = createClient();
    const pipe = await runPipeline(supabase, file.bytes, sheetName.slice(0, 200), mapping);
    if (!pipe.ok) return { error: pipe.error };
    const p = pipe.p;

    // current values for matched rows
    const productIds: string[] = [];
    const variantIds: string[] = [];
    for (const r of p.rows) {
      const m = p.matches.get(r.rowNum)!;
      if (m.record) (m.record.kind === "product" ? productIds : variantIds).push(m.record.id);
    }
    const currents = await readCurrentRecords(supabase, productIds, variantIds);
    if (!currents) return { error: IMPORT_MESSAGES.scan_failed };
    const brandResolver = brandResolverFrom(currents.brands);

    const updates: PreviewUpdateRow[] = [];
    const problems: PreviewProblemRow[] = [];
    const unchangedRows: number[] = [];

    for (const r of p.rows) {
      const m = p.matches.get(r.rowNum)!;
      if (m.status === "conflict") {
        problems.push({ rowNum: r.rowNum, kind: r.kind, sku: r.sku, barcode: r.barcode, message: IMPORT_MESSAGES.conflict_ids });
        continue;
      }
      if (m.status === "dup_in_file") {
        problems.push({ rowNum: r.rowNum, kind: r.kind, sku: r.sku, barcode: r.barcode, message: IMPORT_MESSAGES.dup_in_file });
        continue;
      }
      if (m.status === "dup_in_db") {
        problems.push({ rowNum: r.rowNum, kind: r.kind, sku: r.sku, barcode: r.barcode, message: IMPORT_MESSAGES.dup_in_db });
        continue;
      }
      if (m.status === "invalid") {
        problems.push({ rowNum: r.rowNum, kind: r.kind, sku: r.sku, barcode: r.barcode, message: r.errors[0] ?? IMPORT_MESSAGES.mapping_invalid });
        continue;
      }
      if (!m.record) continue; // not_found → handled by new-record classification below

      const table = m.record.kind === "product" ? currents.products : currents.variants;
      const rec = table.get(m.record.id);
      if (!rec) {
        problems.push({ rowNum: r.rowNum, kind: r.kind, sku: r.sku, barcode: r.barcode, message: IMPORT_MESSAGES.scan_failed });
        continue;
      }
      const current = currentFieldValues(rec, m.record.kind, currents.brands);
      const plan = buildRowUpdatePlan(r, m.record.id, m.record.kind, current, {
        categories: CATEGORIES,
        brandResolver,
        selectedFields,
      });
      if (plan.changes.length === 0 || plan.changes.every((c) => c.equal)) {
        unchangedRows.push(r.rowNum);
        continue;
      }
      updates.push({
        rowNum: r.rowNum,
        recordKind: m.record.kind,
        recordId: m.record.id,
        sku: r.sku ?? m.record.sku,
        barcode: r.barcode ?? m.record.barcode,
        displayName: m.record.nameAr || m.record.nameEn || m.record.sku || "سجل في الكتالوج",
        imageUrl: null,
        matchStatus: m.status,
        plan,
        warnings: r.warnings,
      });
    }

    // new records
    const newGroupsRaw = groupNewProductRows(p.classifications, p.rowsByNum);
    const newGroups: PreviewNewGroup[] = [];
    for (const g of newGroupsRaw) {
      const main = p.rowsByNum.get(g.mainRowNum);
      if (!main) continue;
      const nameEn = rowFieldValue(main, "name_en");
      const nameAr = rowFieldValue(main, "name_ar");
      const missing: string[] = [];
      if (!nameAr && !nameEn) missing.push("الاسم");
      if (g.needsSku) missing.push("SKU (سيُولّد تلقائيًا)");
      if (main.barcode === null) missing.push("الباركود (سيُولّد تلقائيًا)");
      missing.push("الصورة");

      const dup = findDuplicates(
        {
          sku: main.sku ?? "",
          barcodes: main.barcode ? [main.barcode] : [],
          brand: rowFieldValue(main, "brand"),
          nameEn,
          nameAr,
          size: rowFieldValue(main, "size"),
          shade: rowFieldValue(main, "color"),
        },
        p.snapshotRows,
      );
      let cards: SimilarProductCard[] = [];
      let total = dup.total;
      if (dup.level !== "none" && newGroups.length < SIMILAR_HYDRATION_GROUP_CAP) {
        const hyd = await loadSimilarProductCards(supabase, dup.matches, dup.total, 5);
        cards = hyd.cards;
        total = hyd.total;
      }
      newGroups.push({
        mainRowNum: g.mainRowNum,
        mainSku: g.mainSku,
        needsSku: g.needsSku,
        needsImage: true,
        displayName: nameAr || nameEn || g.mainSku || `صف ${g.mainRowNum}`,
        fields: main.values.filter((v) => !v.clear).map((v) => ({
          field: v.field,
          label: CATALOG_FIELD_DEFS.find((d) => d.field === v.field)?.label ?? v.field,
          value: v.value,
        })),
        variants: g.variantRowNums.map((n) => {
          const vr = p.rowsByNum.get(n)!;
          return { rowNum: n, sku: vr.sku, barcode: vr.barcode, name: rowFieldValue(vr, "variant_name") || rowFieldValue(vr, "variant_name_en") };
        }),
        missing,
        blockedReason: dup.level === "exact" ? IMPORT_MESSAGES.duplicate_blocks_create : null,
        similar: { level: dup.level, cards, total },
      });
    }

    // new variants for EXISTING parents
    const newVariantRows = p.classifications.filter((c) => c.cls === "new_variant_existing_parent");
    const parentIdBySku = new Map<string, string>();
    for (const row of p.snapshotRows) {
      if (row.kind === "product" && row.sku) parentIdBySku.set(row.sku.toLowerCase(), row.id);
    }
    const parentIds = Array.from(
      new Set(
        newVariantRows
          .map((c) => p.rowsByNum.get(c.rowNum)?.parentSku)
          .filter((s): s is string => typeof s === "string")
          .map((s) => parentIdBySku.get(s))
          .filter((x): x is string => typeof x === "string"),
      ),
    );
    const parentCards = await loadSimilarProductCards(
      supabase,
      parentIds.map((id) => ({ productId: id, level: "similar" as const, reasons: [], score: 0 })),
      parentIds.length,
      Math.min(parentIds.length, 50),
    );
    const parentCardById = new Map(parentCards.cards.map((c) => [c.id, c]));

    const newVariants: PreviewNewVariant[] = [];
    for (const c of newVariantRows) {
      const row = p.rowsByNum.get(c.rowNum);
      if (!row || !row.sku || !row.parentSku) continue;
      const parentId = parentIdBySku.get(row.parentSku);
      if (!parentId) {
        problems.push({ rowNum: c.rowNum, kind: "variant", sku: row.sku, barcode: row.barcode, message: IMPORT_MESSAGES.parent_missing });
        continue;
      }
      newVariants.push({
        rowNum: c.rowNum,
        sku: row.sku,
        barcode: row.barcode,
        name: rowFieldValue(row, "variant_name") || rowFieldValue(row, "variant_name_en") || row.sku,
        parent: parentCardById.get(parentId) ?? null,
        parentId,
        parentFingerprint: parentVariantsFingerprint(p.snapshotRows, parentId),
        blockedReason: null,
      });
    }

    // remaining problem classes
    for (const c of p.classifications) {
      if (c.cls === "orphan_variant" || c.cls === "needs_review" || c.cls === "blocked") {
        const row = p.rowsByNum.get(c.rowNum);
        if (!row) continue;
        const already = problems.some((x) => x.rowNum === c.rowNum);
        if (already) continue;
        problems.push({
          rowNum: c.rowNum, kind: row.kind, sku: row.sku, barcode: row.barcode,
          message: c.reason ?? NEW_CLASS_LABELS[c.cls],
        });
      }
    }

    return {
      data: {
        summary: {
          productUpdates: updates.filter((u) => u.recordKind === "product").length,
          variantUpdates: updates.filter((u) => u.recordKind === "variant").length,
          newProducts: newGroups.length,
          newVariants: newVariants.length,
          problems: problems.length,
          unchanged: unchangedRows.length,
        },
        updates,
        newGroups,
        newVariants,
        problems,
        unchangedRows,
        partialSnapshot: p.partial,
      },
    };
  } catch {
    return { error: IMPORT_MESSAGES.unexpected_preview };
  }
}

// ── Step 3a: apply UPDATES (batch) ───────────────────────────────────────────

function parseJsonParam<T>(raw: unknown, maxLen: number): T | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > maxLen) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export async function applyCatalogUpdates(
  formData: FormData,
): Promise<{ data: { results: ImportRecordResult[] } } | { error: string }> {
  if (!(await isSignedIn())) return { error: IMPORT_MESSAGES.not_signed_in };
  try {
    const file = await readImportFile(formData);
    if (!file.ok) return { error: file.error };
    const sheetName = formData.get("sheet");
    if (typeof sheetName !== "string" || sheetName === "") return { error: IMPORT_MESSAGES.sheet_required };
    const mapping = parseMappingParam(formData.get("mapping"));
    if (!mapping) return { error: IMPORT_MESSAGES.mapping_invalid };
    const selectedFields = selectedFieldsParam(formData.get("fields"));
    const rowNums = parseJsonParam<number[]>(formData.get("rows"), 50_000);
    const fingerprints = parseJsonParam<Record<string, string>>(formData.get("fingerprints"), 200_000);
    if (!rowNums || !Array.isArray(rowNums) || rowNums.length === 0 || rowNums.length > 100 || !fingerprints) {
      return { error: IMPORT_MESSAGES.mapping_invalid };
    }

    const supabase = createClient();
    // INV.6B — structural variant sync goes through the service-role client; the
    // atomic sync_product_variants RPC is admin-only after the lockdown. Product
    // metadata still writes through the session `supabase` handle (RLS applies).
    const admin = createAdminClient();
    const pipe = await runPipeline(supabase, file.bytes, sheetName.slice(0, 200), mapping);
    if (!pipe.ok) return { error: pipe.error };
    const p = pipe.p;

    const wanted = new Set(rowNums.filter((n) => Number.isSafeInteger(n)));
    const productIds: string[] = [];
    const variantIds: string[] = [];
    for (const r of p.rows) {
      if (!wanted.has(r.rowNum)) continue;
      const m = p.matches.get(r.rowNum)!;
      if (m.record) (m.record.kind === "product" ? productIds : variantIds).push(m.record.id);
    }
    const currents = await readCurrentRecords(supabase, productIds, variantIds);
    if (!currents) return { error: IMPORT_MESSAGES.scan_failed };
    const brandResolver = brandResolverFrom(currents.brands);

    const results: ImportRecordResult[] = [];
    for (const r of p.rows) {
      if (!wanted.has(r.rowNum)) continue;
      const m = p.matches.get(r.rowNum)!;
      const base = { rowNum: r.rowNum, sku: r.sku, barcode: r.barcode, changedFields: [] as string[] };

      if (!m.record) {
        results.push({ ...base, recordKind: r.kind === "variant" ? "variant" : "product", recordId: null, status: "conflict", message: IMPORT_MESSAGES.conflict_ids });
        continue;
      }
      const kind = m.record.kind;
      const table = kind === "product" ? currents.products : currents.variants;
      const rec = table.get(m.record.id);
      if (!rec) {
        results.push({ ...base, recordKind: kind, recordId: m.record.id, status: "failed", message: kind === "product" ? IMPORT_MESSAGES.update_product_failed : IMPORT_MESSAGES.update_variant_failed });
        continue;
      }
      const current = currentFieldValues(rec, kind, currents.brands);
      const plan = buildRowUpdatePlan(r, m.record.id, kind, current, { categories: CATEGORIES, brandResolver, selectedFields });

      // optimistic concurrency: the fingerprint the user PREVIEWED must still
      // match the record's fresh fingerprint — otherwise someone edited it.
      const previewFp = fingerprints[String(r.rowNum)];
      if (typeof previewFp !== "string" || previewFp !== plan.fingerprint) {
        results.push({ ...base, recordKind: kind, recordId: m.record.id, status: "changed_after_preview", message: IMPORT_MESSAGES.changed_after_preview });
        continue;
      }

      const payload: Record<string, unknown> = {};
      const changedFields: string[] = [];
      for (const c of plan.changes) {
        if (c.decision !== "update" || c.error) continue;
        const column = fieldColumn(c.field, kind);
        if (!column) continue;
        if (c.field === "brand") {
          const brandId = c.excel === null ? null : brandResolver(c.excel);
          if (c.excel !== null && brandId === null) continue; // unknown brand → skip field
          payload[column] = brandId;
        } else if (c.field === "price" || c.field === "discount_price") {
          payload[column] = c.excel === null ? null : Number(c.excel);
        } else {
          payload[column] = c.excel; // null on explicit clear
        }
        changedFields.push(c.label);
      }
      if (changedFields.length === 0) {
        results.push({ ...base, recordKind: kind, recordId: m.record.id, status: "skipped", message: "لا توجد حقول مختارة للتحديث." });
        continue;
      }

      try {
        const table = kind === "product" ? "products" : "product_variants";
        const { error } = await supabase.from(table).update(payload).filter("id", "eq", m.record.id);
        if (error) {
          results.push({ ...base, recordKind: kind, recordId: m.record.id, status: "failed", message: kind === "product" ? IMPORT_MESSAGES.update_product_failed : IMPORT_MESSAGES.update_variant_failed });
          continue;
        }
        results.push({
          ...base,
          changedFields,
          recordKind: kind,
          recordId: m.record.id,
          status: kind === "product" ? "product_updated" : "variant_updated",
          message: "تم التحديث.",
        });
      } catch {
        results.push({ ...base, recordKind: kind, recordId: m.record.id, status: "failed", message: kind === "product" ? IMPORT_MESSAGES.update_product_failed : IMPORT_MESSAGES.update_variant_failed });
      }
    }

    return { data: { results } };
  } catch {
    return { error: IMPORT_MESSAGES.unexpected_apply };
  }
}

// ── Step 3b: apply CREATES (batch) ───────────────────────────────────────────

function emptyProductInput(): ProductInput {
  return {
    sku: "", barcode: "", name_en: "", name_ar: "", brand_id: "", main_category: "",
    sub_category: "", product_type: "", color: "", size: "", price: "", discount_price: "",
    cost: "", stock_quantity: "", stock_status: "", platform_status: "", approval: "",
    rejection_reason: "", image_filename: "", image_url: "", description_en: "",
    description_ar: "", keywords_en: "", keywords_ar: "", notes: "", variants: [],
  };
}

export async function applyCatalogCreates(
  formData: FormData,
): Promise<{ data: { results: ImportRecordResult[] } } | { error: string }> {
  if (!(await isSignedIn())) return { error: IMPORT_MESSAGES.not_signed_in };
  try {
    const file = await readImportFile(formData);
    if (!file.ok) return { error: file.error };
    const sheetName = formData.get("sheet");
    if (typeof sheetName !== "string" || sheetName === "") return { error: IMPORT_MESSAGES.sheet_required };
    const mapping = parseMappingParam(formData.get("mapping"));
    if (!mapping) return { error: IMPORT_MESSAGES.mapping_invalid };
    const groupRows = parseJsonParam<number[]>(formData.get("groups"), 20_000) ?? [];
    const variantRows = parseJsonParam<number[]>(formData.get("newVariants"), 20_000) ?? [];
    const parentFps = parseJsonParam<Record<string, string>>(formData.get("parentFingerprints"), 100_000) ?? {};
    if (groupRows.length + variantRows.length === 0 || groupRows.length > 20 || variantRows.length > 50) {
      return { error: IMPORT_MESSAGES.mapping_invalid };
    }

    const supabase = createClient();
    // INV.6B — product rows are inserted with the session client (RLS); inventory
    // initialization goes through the service-role initializer adapter (direct
    // inventory/variant writes are impossible after the strict lockdown).
    const admin = createAdminClient();
    const inventoryInit = makeInventoryInitializer(admin);
    const pipe = await runPipeline(supabase, file.bytes, sheetName.slice(0, 200), mapping);
    if (!pipe.ok) return { error: pipe.error };
    const p = pipe.p;

    const { brands } = (await readCurrentRecords(supabase, [], [])) ?? { brands: new Map<string, string>() };
    const brandResolver = brandResolverFrom(brands as Map<string, string>);

    const groups = groupNewProductRows(p.classifications, p.rowsByNum);
    const groupByMainRow = new Map(groups.map((g) => [g.mainRowNum, g]));

    const usedSkus = new Set(p.snapshotSkus.map((s) => s.toLowerCase()));
    const usedBarcodes = new Set(p.snapshotBarcodes);
    const results: ImportRecordResult[] = [];

    // ── new product groups ──
    for (const mainRowNum of groupRows) {
      const g = groupByMainRow.get(mainRowNum);
      const main = g ? p.rowsByNum.get(g.mainRowNum) : undefined;
      if (!g || !main) {
        results.push({ rowNum: mainRowNum, recordKind: "product", recordId: null, sku: null, barcode: null, status: "conflict", message: IMPORT_MESSAGES.changed_after_preview, changedFields: [] });
        continue;
      }
      const nameEn = rowFieldValue(main, "name_en");
      const nameAr = rowFieldValue(main, "name_ar");
      if (!nameAr && !nameEn) {
        results.push({ rowNum: mainRowNum, recordKind: "product", recordId: null, sku: main.sku, barcode: main.barcode, status: "needs_review", message: IMPORT_MESSAGES.name_required_create, changedFields: [] });
        continue;
      }
      const category = rowFieldValue(main, "main_category");
      if (category && !CATEGORIES.includes(category as (typeof CATEGORIES)[number])) {
        results.push({ rowNum: mainRowNum, recordKind: "product", recordId: null, sku: main.sku, barcode: main.barcode, status: "failed", message: IMPORT_MESSAGES.unknown_category, changedFields: [] });
        continue;
      }

      // fresh duplicate re-check — an exact match blocks creation
      const dup = findDuplicates(
        { sku: main.sku ?? "", barcodes: main.barcode ? [main.barcode] : [], brand: rowFieldValue(main, "brand"), nameEn, nameAr, size: rowFieldValue(main, "size"), shade: rowFieldValue(main, "color") },
        p.snapshotRows,
      );
      if (dup.level === "exact") {
        results.push({ rowNum: mainRowNum, recordKind: "product", recordId: null, sku: main.sku, barcode: main.barcode, status: "conflict", message: IMPORT_MESSAGES.duplicate_blocks_create, changedFields: [] });
        continue;
      }

      // identifiers — generated where missing, checked against catalog + batch
      let sku = main.sku;
      if (!sku) sku = nextMkSku([...usedSkus]);
      if (usedSkus.has(sku)) {
        results.push({ rowNum: mainRowNum, recordKind: "product", recordId: null, sku, barcode: main.barcode, status: "conflict", message: IMPORT_MESSAGES.dup_in_db, changedFields: [] });
        continue;
      }
      let barcode = main.barcode;
      if (barcode !== null && !isValidEan13(barcode)) {
        results.push({ rowNum: mainRowNum, recordKind: "product", recordId: null, sku, barcode, status: "failed", message: IMPORT_MESSAGES.invalid_barcode, changedFields: [] });
        continue;
      }
      const variantsNeedingBarcodes = g.variantRowNums.filter((n) => {
        const vr = p.rowsByNum.get(n);
        return vr && vr.barcode === null;
      }).length;
      let generated: string[] = [];
      try {
        generated = generateUniqueEan13Batch((barcode === null ? 1 : 0) + variantsNeedingBarcodes, usedBarcodes, Math.random);
      } catch {
        results.push({ rowNum: mainRowNum, recordKind: "product", recordId: null, sku, barcode, status: "failed", message: IMPORT_MESSAGES.create_product_failed, changedFields: [] });
        continue;
      }
      let gi = 0;
      if (barcode === null) barcode = generated[gi++];

      const variants: VariantInput[] = [];
      let variantProblem: string | null = null;
      for (const n of g.variantRowNums) {
        const vr = p.rowsByNum.get(n);
        if (!vr || !vr.sku) { variantProblem = IMPORT_MESSAGES.create_variant_failed; break; }
        if (!vr.sku.startsWith(`${sku}-`)) { variantProblem = IMPORT_MESSAGES.create_variant_failed; break; }
        let vBarcode = vr.barcode;
        if (vBarcode !== null && !isValidEan13(vBarcode)) { variantProblem = IMPORT_MESSAGES.invalid_barcode; break; }
        if (vBarcode === null) vBarcode = generated[gi++];
        variants.push({
          variant_name: rowFieldValue(vr, "variant_name"),
          variant_name_en: rowFieldValue(vr, "variant_name_en"),
          sku: vr.sku,
          barcode: vBarcode,
          color: rowFieldValue(vr, "color"),
          size: rowFieldValue(vr, "size"),
          price: rowFieldValue(vr, "price"),
          stock_quantity: "",
        });
      }
      if (variantProblem) {
        // a mandatory-variant failure blocks the WHOLE group — nothing partial
        results.push({ rowNum: mainRowNum, recordKind: "product", recordId: null, sku, barcode, status: "failed", message: variantProblem, changedFields: [] });
        continue;
      }

      const input: ProductInput = {
        ...emptyProductInput(),
        sku,
        barcode: barcode ?? "",
        name_en: nameEn,
        name_ar: nameAr,
        brand_id: brandResolver(rowFieldValue(main, "brand")) ?? "",
        main_category: category,
        size: rowFieldValue(main, "size"),
        color: rowFieldValue(main, "color"),
        price: rowFieldValue(main, "price"),
        discount_price: rowFieldValue(main, "discount_price"),
        description_en: rowFieldValue(main, "description_en"),
        description_ar: rowFieldValue(main, "description_ar"),
        keywords_en: rowFieldValue(main, "keywords_en"),
        keywords_ar: rowFieldValue(main, "keywords_ar"),
        // forced server-side regardless of any Excel value:
        approval: "",
        platform_status: "",
        variants,
      };

      try {
        const row = await toProductRow(input);
        const core = await createProductCore(supabase, row, projectVariantInsertRows(variants), inventoryInit);
        if (!core.ok) {
          results.push({
            rowNum: mainRowNum, recordKind: "product", recordId: null, sku, barcode,
            status: core.duplicateIdentity ? "conflict" : "failed",
            message: core.stage === "variant_insert" ? IMPORT_MESSAGES.create_variant_failed : IMPORT_MESSAGES.create_product_failed,
            changedFields: [],
          });
          continue;
        }
        usedSkus.add(sku);
        if (barcode) usedBarcodes.add(barcode);
        results.push({
          rowNum: mainRowNum, recordKind: "product", recordId: core.productId, sku, barcode,
          status: "product_created", changedFields: [],
          message: `${IMPORT_MESSAGES.needs_image_note}`,
        });
        for (const v of variants) {
          usedSkus.add((v.sku ?? "").toLowerCase());
          if (v.barcode) usedBarcodes.add(v.barcode);
          results.push({
            rowNum: g.variantRowNums[variants.indexOf(v)], recordKind: "variant", recordId: core.productId,
            sku: v.sku ?? null, barcode: v.barcode ?? null, status: "variant_created", changedFields: [], message: "تم إنشاء الخيار مع المنتج.",
          });
        }
      } catch {
        results.push({ rowNum: mainRowNum, recordKind: "product", recordId: null, sku, barcode, status: "failed", message: IMPORT_MESSAGES.create_product_failed, changedFields: [] });
      }
    }

    // ── new variants appended to EXISTING products ──
    const parentIdBySku = new Map<string, string>();
    for (const row of p.snapshotRows) {
      if (row.kind === "product" && row.sku) parentIdBySku.set(row.sku.toLowerCase(), row.id);
    }
    for (const rowNum of variantRows) {
      const r = p.rowsByNum.get(rowNum);
      const cls = p.classifications.find((c) => c.rowNum === rowNum);
      if (!r || !r.sku || !r.parentSku || cls?.cls !== "new_variant_existing_parent") {
        results.push({ rowNum, recordKind: "variant", recordId: null, sku: r?.sku ?? null, barcode: r?.barcode ?? null, status: "conflict", message: IMPORT_MESSAGES.changed_after_preview, changedFields: [] });
        continue;
      }
      const parentId = parentIdBySku.get(r.parentSku);
      if (!parentId) {
        results.push({ rowNum, recordKind: "variant", recordId: null, sku: r.sku, barcode: r.barcode, status: "failed", message: IMPORT_MESSAGES.parent_missing, changedFields: [] });
        continue;
      }
      // parent unchanged since preview?
      const freshFp = parentVariantsFingerprint(p.snapshotRows, parentId);
      const previewFp = parentFps[String(rowNum)];
      if (typeof previewFp !== "string" || previewFp !== freshFp) {
        results.push({ rowNum, recordKind: "variant", recordId: null, sku: r.sku, barcode: r.barcode, status: "changed_after_preview", message: IMPORT_MESSAGES.changed_after_preview, changedFields: [] });
        continue;
      }
      let vBarcode = r.barcode;
      if (vBarcode !== null && !isValidEan13(vBarcode)) {
        results.push({ rowNum, recordKind: "variant", recordId: null, sku: r.sku, barcode: vBarcode, status: "failed", message: IMPORT_MESSAGES.invalid_barcode, changedFields: [] });
        continue;
      }
      if (vBarcode === null) {
        try {
          vBarcode = generateUniqueEan13Batch(1, usedBarcodes, Math.random)[0];
        } catch {
          results.push({ rowNum, recordKind: "variant", recordId: null, sku: r.sku, barcode: null, status: "failed", message: IMPORT_MESSAGES.create_variant_failed, changedFields: [] });
          continue;
        }
      }

      try {
        // Load the parent's FULL current variant list and APPEND — a partial
        // list would read as deletion of the existing variants. Existing rows
        // keep their ids and skus verbatim; nothing is renumbered.
        const parent = await loadProductForEdit(supabase, parentId);
        if (parent.status !== "ok") {
          results.push({ rowNum, recordKind: "variant", recordId: null, sku: r.sku, barcode: vBarcode, status: "failed", message: IMPORT_MESSAGES.parent_missing, changedFields: [] });
          continue;
        }
        const full: VariantInput[] = [
          ...parent.initial.variants.map((v) => ({ ...v })),
          {
            variant_name: rowFieldValue(r, "variant_name"),
            variant_name_en: rowFieldValue(r, "variant_name_en"),
            sku: r.sku,
            barcode: vBarcode,
            color: rowFieldValue(r, "color"),
            size: rowFieldValue(r, "size"),
            price: rowFieldValue(r, "price"),
            stock_quantity: "",
          },
        ];
        const sync = await syncProductVariants(admin, parentId, full);
        if (!sync.ok) {
          results.push({ rowNum, recordKind: "variant", recordId: null, sku: r.sku, barcode: vBarcode, status: "failed", message: sync.message, changedFields: [] });
          continue;
        }
        usedSkus.add(r.sku);
        usedBarcodes.add(vBarcode);
        results.push({ rowNum, recordKind: "variant", recordId: parentId, sku: r.sku, barcode: vBarcode, status: "variant_created", changedFields: [], message: "تمت إضافة الخيار للمنتج." });
      } catch {
        results.push({ rowNum, recordKind: "variant", recordId: null, sku: r.sku, barcode: vBarcode, status: "failed", message: IMPORT_MESSAGES.create_variant_failed, changedFields: [] });
      }
    }

    return { data: { results } };
  } catch {
    return { error: IMPORT_MESSAGES.unexpected_apply };
  }
}
