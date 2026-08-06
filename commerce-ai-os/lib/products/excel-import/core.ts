// Catalog Excel import — the pure core (Phase UI.6): field registry, column
// detection/mapping, row normalization, matching, update planning +
// fingerprints, and new-record classification/grouping.
//
// ONE self-contained module by design: node:test loads it directly, so it has
// NO runtime imports (the only import is the type-only IdentityRow). The
// original per-concern sections are kept in order below.

import type { IdentityRow } from "../duplicate-detect";

// ═══════════ fields ═══════════

export type CatalogImportField =
  // shared identifiers
  | "sku"
  | "barcode"
  // product fields
  | "name_en"
  | "name_ar"
  | "description_en"
  | "description_ar"
  | "brand"
  | "main_category"
  | "size"
  | "price"
  | "discount_price"
  | "keywords_en"
  | "keywords_ar"
  | "approval"
  // variant-only fields
  | "variant_name"
  | "variant_name_en"
  | "color";

export interface FieldDef {
  field: CatalogImportField;
  /** Arabic label shown in mapping + preview. */
  label: string;
  /** normalized header aliases (see normalizeHeader). */
  aliases: string[];
  /** applies to products, variants, or both */
  scope: "product" | "variant" | "both";
  kind: "text" | "price" | "category" | "approval" | "identifier" | "brand";
  /** may the __CLEAR__ token blank this field? */
  clearable: boolean;
  /** selected by default in the global field picker? */
  defaultSelected: boolean;
}

/** lowercase, strip everything but letters/digits — "Name EN " == "name_en". */
export function normalizeHeader(h: unknown): string {
  if (typeof h !== "string") return "";
  return h.trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

export const CATALOG_FIELD_DEFS: readonly FieldDef[] = [
  {
    field: "sku",
    label: "SKU",
    aliases: ["sku", "productsku", "malikassku", "variantsku", "skucode", "skuupdate"],
    scope: "both",
    kind: "identifier",
    clearable: false,
    defaultSelected: false,
  },
  {
    field: "barcode",
    label: "الباركود",
    aliases: ["barcode", "barcod", "ean", "ean13", "gtin", "upc", "barcodeupdate"],
    scope: "both",
    kind: "identifier",
    clearable: false,
    defaultSelected: false,
  },
  {
    field: "name_en",
    label: "الاسم (إنجليزي)",
    aliases: ["nameen", "englishname", "productnameen", "name_en", "nameeng", "productname", "name", "productnameenupdate"],
    scope: "product",
    kind: "text",
    clearable: false,
    defaultSelected: true,
  },
  {
    field: "name_ar",
    label: "الاسم (عربي)",
    aliases: ["namear", "arabicname", "productnamear", "name_ar", "الاسم", "الاسمالعربي", "productnamearupdate"],
    scope: "product",
    kind: "text",
    clearable: false,
    defaultSelected: true,
  },
  {
    field: "description_en",
    label: "الوصف (إنجليزي)",
    aliases: ["descriptionen", "englishdescription", "description_en", "descen", "description", "productdescriptionenupdate"],
    scope: "product",
    kind: "text",
    clearable: true,
    defaultSelected: true,
  },
  {
    field: "description_ar",
    label: "الوصف (عربي)",
    aliases: ["descriptionar", "arabicdescription", "description_ar", "descar", "الوصف", "productdescriptionarupdate"],
    scope: "product",
    kind: "text",
    clearable: true,
    defaultSelected: true,
  },
  {
    field: "brand",
    label: "البراند",
    aliases: ["brand", "brandname", "البراند", "الماركة"],
    scope: "product",
    kind: "brand",
    clearable: false,
    defaultSelected: false,
  },
  {
    field: "main_category",
    label: "الفئة",
    aliases: ["category", "maincategory", "main_category", "الفئة", "التصنيف"],
    scope: "product",
    kind: "category",
    clearable: false,
    defaultSelected: false,
  },
  {
    field: "size",
    label: "الحجم",
    aliases: ["size", "الحجم", "volume"],
    scope: "both",
    kind: "text",
    clearable: true,
    defaultSelected: false,
  },
  {
    field: "price",
    label: "السعر",
    aliases: ["price", "regularprice", "السعر", "sellingprice", "priceglobal", "priceglobalupdate"],
    scope: "both",
    kind: "price",
    clearable: false,
    defaultSelected: true,
  },
  {
    field: "discount_price",
    label: "سعر الخصم",
    aliases: ["discountprice", "saleprice", "discount_price", "سعرالخصم", "offerprice"],
    scope: "product",
    kind: "price",
    clearable: true,
    defaultSelected: true,
  },
  {
    field: "keywords_en",
    label: "كلمات مفتاحية (إنجليزي)",
    aliases: ["keywordsen", "keywords_en", "keywords", "tags", "tagsen"],
    scope: "product",
    kind: "text",
    clearable: true,
    defaultSelected: false,
  },
  {
    field: "keywords_ar",
    label: "كلمات مفتاحية (عربي)",
    aliases: ["keywordsar", "keywords_ar", "tagsar", "الكلماتالمفتاحية"],
    scope: "product",
    kind: "text",
    clearable: true,
    defaultSelected: false,
  },
  {
    field: "approval",
    label: "الاعتماد",
    aliases: ["approval", "approved", "status", "الاعتماد"],
    scope: "product",
    kind: "approval",
    clearable: false,
    defaultSelected: false,
  },
  {
    field: "variant_name",
    label: "اسم الخيار (عربي)",
    aliases: ["variantname", "variant_name", "optionname", "اسمالخيار"],
    scope: "variant",
    kind: "text",
    clearable: false,
    defaultSelected: true,
  },
  {
    field: "variant_name_en",
    label: "اسم الخيار (إنجليزي)",
    aliases: ["variantnameen", "variant_name_en", "optionnameen"],
    scope: "variant",
    kind: "text",
    clearable: true,
    defaultSelected: true,
  },
  {
    field: "color",
    label: "اللون / الدرجة",
    aliases: ["color", "colour", "shade", "اللون", "الدرجة"],
    scope: "both",
    kind: "text",
    clearable: true,
    defaultSelected: false,
  },
] as const;

/** Headers we recognize but deliberately NEVER import (shown as غير مستخدم). */
export const IGNORED_HEADER_ALIASES: readonly string[] = [
  "image", "imageurl", "image_url", "الصورة", // no SSRF fetch, no raw URL trust — v1 ignores image columns
  "stock", "stockquantity", "quantity", "inventory", "المخزون", "الكمية",
  "shopify", "shopifyid", "gid", "snoonu", "talabat", "rafeeq",
  "platformstatus", "platform_status",
  "id", "uuid", "productid", "variantid", "parentproductid",
  // Malikas platform exports (Snoonu AllExportData): the exporter's own id is
  // NOT a Malikas database id — reference only, never a match or write key.
  "spi", "spiuniqueidentifier",
  "preparationtime", "preparationtimeupdate",
];

/** Recognized-but-refused header PREFIXES (normalized). Platform exports
 *  embed the store address in availability/stock headers, so exact aliases
 *  can't cover them. Stock/availability/prep-time are out of scope in UI.6. */
export const IGNORED_HEADER_PREFIXES: readonly string[] = [
  "availability",
  "stockfor",
  "preparationtime",
];

/** Platform-export (ReadOnly) headers: shown as reference only. When the
 *  matching (Update) column is present, these are auto-ignored so they never
 *  produce a duplicate mapping; without the (Update) twin the user may
 *  confirm them manually (matching stays SKU→Barcode; writing identifiers
 *  still requires enabling those fields in the field picker). */
export const READONLY_REFERENCE_ALIASES: Readonly<Record<string, CatalogImportField>> = {
  productnameenreadonly: "name_en",
  productnamearreadonly: "name_ar",
  productdescriptionenreadonly: "description_en",
  productdescriptionarreadonly: "description_ar",
  skureadonly: "sku",
  barcodereadonly: "barcode",
};

export const CLEAR_TOKEN = "__CLEAR__";

/** Excel approval text -> the catalog's canonical values (APPROVAL_OPTS). */
export function normalizeApprovalValue(v: string): string | null {
  const t = v.trim().toLowerCase();
  if (t === "approved") return "Approved";
  if (t === "rejected") return "Rejected";
  if (t === "sentai") return "SentAI";
  return null; // anything else (incl. true/yes/1) is rejected — never auto-approve
}

export function fieldDef(field: string): FieldDef | null {
  return CATALOG_FIELD_DEFS.find((d) => d.field === field) ?? null;
}

/** The DB column a field writes, per record kind. null = not writable there. */
export function fieldColumn(field: CatalogImportField, kind: "product" | "variant"): string | null {
  const def = fieldDef(field);
  if (!def) return null;
  if (def.scope !== "both" && def.scope !== kind) return null;
  if (field === "brand") return kind === "product" ? "brand_id" : null;
  return field;
}

// ═══════════ columns ═══════════

export type ColumnStatus = "auto" | "needs_confirm" | "ignored" | "unknown";

export interface ColumnMapping {
  /** zero-based column index in the sheet */
  index: number;
  header: string;
  field: CatalogImportField | null;
  status: ColumnStatus;
}

/** Exact-alias headers auto-map; recognized-but-banned headers (and empty
 *  headers) are ignored; platform-export (ReadOnly) headers auto-ignore when
 *  their (Update) twin is present; everything else is unknown and stays
 *  unused unless the user maps it. */
export function detectCatalogColumns(headers: readonly unknown[]): ColumnMapping[] {
  const first = headers.map((h, index) => {
    const header = typeof h === "string" ? h.trim() : h == null ? "" : String(h).trim();
    const norm = normalizeHeader(header);
    // An empty header (trailing export column) is deliberately ignored — it
    // must never crash, block mapping, or read as a duplicate.
    if (norm === "") return { index, header, norm, field: null as CatalogImportField | null, status: "ignored" as ColumnStatus, readonlyRef: false };
    if (IGNORED_HEADER_ALIASES.includes(norm) || IGNORED_HEADER_PREFIXES.some((p) => norm.startsWith(p))) {
      return { index, header, norm, field: null as CatalogImportField | null, status: "ignored" as ColumnStatus, readonlyRef: false };
    }
    for (const def of CATALOG_FIELD_DEFS) {
      if (def.aliases.includes(norm)) {
        // The primary alias (index 0) is unambiguous; looser aliases like
        // "name" or generic "keywords"/"status" need the user's confirmation.
        const loose = ["name", "productname", "description", "keywords", "tags", "status"].includes(norm);
        return { index, header, norm, field: def.field as CatalogImportField | null, status: (loose ? "needs_confirm" : "auto") as ColumnStatus, readonlyRef: false };
      }
    }
    const ref = READONLY_REFERENCE_ALIASES[norm];
    if (ref) return { index, header, norm, field: ref as CatalogImportField | null, status: "needs_confirm" as ColumnStatus, readonlyRef: true };
    return { index, header, norm, field: null as CatalogImportField | null, status: "unknown" as ColumnStatus, readonlyRef: false };
  });

  // Second pass: a (ReadOnly) column whose field is already claimed by a
  // direct alias column (its (Update) twin) becomes reference-only/ignored,
  // so the proposed mapping is never duplicate-invalid out of the box.
  const claimed = new Set(first.filter((m) => !m.readonlyRef && m.field !== null).map((m) => m.field));
  return first.map((m) =>
    m.readonlyRef && m.field !== null && claimed.has(m.field)
      ? { index: m.index, header: m.header, field: null, status: "ignored" as const }
      : { index: m.index, header: m.header, field: m.field, status: m.status },
  );
}

export type MappingValidation = { ok: true } | { ok: false; error: MappingError };

export type MappingError = "duplicate_field" | "no_identifier" | "forbidden_field";

const KNOWN_FIELDS = new Set<string>(CATALOG_FIELD_DEFS.map((d) => d.field));

/**
 * Validate a user-confirmed mapping (also re-run server-side at preview AND
 * apply — the browser's mapping is never trusted):
 * - a catalog field may be bound to at most ONE column;
 * - only allowlisted fields exist (anything else = forbidden);
 * - SKU or Barcode must be mapped, or safe matching is impossible.
 */
export function validateCatalogMapping(mapping: readonly ColumnMapping[]): MappingValidation {
  const used = new Set<string>();
  for (const m of mapping) {
    if (m.field === null) continue;
    if (!KNOWN_FIELDS.has(m.field)) return { ok: false, error: "forbidden_field" };
    if (used.has(m.field)) return { ok: false, error: "duplicate_field" };
    used.add(m.field);
  }
  if (!used.has("sku") && !used.has("barcode")) return { ok: false, error: "no_identifier" };
  return { ok: true };
}

/** column index per mapped field, for the row normalizer. */
export function mappingByField(mapping: readonly ColumnMapping[]): Partial<Record<CatalogImportField, number>> {
  const out: Partial<Record<CatalogImportField, number>> = {};
  for (const m of mapping) {
    if (m.field !== null && !(m.field in out)) out[m.field] = m.index;
  }
  return out;
}

// ═══════════ normalize ═══════════

const ARABIC_DIGITS = "٠١٢٣٤٥٦٧٨٩";

export function toCellText(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") {
    let out = "";
    for (const ch of v) {
      const d = ARABIC_DIGITS.indexOf(ch);
      out += d >= 0 ? String(d) : ch;
    }
    return out.trim();
  }
  if (typeof v === "number") {
    if (!Number.isFinite(v)) return "";
    // Exact integer text — 4006381333931 must never become "4.00638E+12".
    if (Number.isInteger(v) && Math.abs(v) < Number.MAX_SAFE_INTEGER) return v.toFixed(0);
    return String(v);
  }
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  return "";
}

export const MAIN_SKU_RE = /^mk[0-9]+$/;
export const VARIANT_SKU_RE = /^mk[0-9]+-[1-9][0-9]*$/;

export type RowKind = "product" | "variant" | "unknown";

export interface FieldValue {
  field: CatalogImportField;
  /** normalized excel text ("" never appears here — empty cells are omitted) */
  value: string;
  /** true when the cell held the explicit __CLEAR__ token */
  clear: boolean;
}

export interface NormalizedRow {
  /** 1-based Excel row number (header = row 1) */
  rowNum: number;
  kind: RowKind;
  sku: string | null;
  /** for variant skus: the mk<base> parent sku */
  parentSku: string | null;
  barcode: string | null;
  values: FieldValue[];
  errors: string[];
  warnings: string[];
  /** every mapped cell was empty */
  empty: boolean;
}

export const ROW_MESSAGES = {
  invalid_sku: "SKU غير صالح.",
  invalid_barcode: "الباركود غير صالح.",
  invalid_price: "السعر غير صالح.",
  invalid_discount: "سعر الخصم غير صالح.",
  negative_price: "السعر لا يمكن أن يكون سالبًا.",
  invalid_approval: "قيمة الاعتماد غير معروفة.",
  clear_not_allowed: "لا يمكن مسح هذا الحقل.",
  formula_cell: "الخلية تحتوي معادلة — استخدم قيمًا ثابتة.",
} as const;

function normalizeSkuText(t: string): string {
  return t.toLowerCase().replace(/\s+/g, "");
}

/**
 * Normalize one sheet row against the confirmed mapping.
 * `cells` is the raw AOA row (raw values, not formatted text);
 * `byField` maps field -> column index.
 */
export function normalizeCatalogExcelRow(
  rowNum: number,
  cells: readonly unknown[],
  byField: Partial<Record<CatalogImportField, number>>,
): NormalizedRow {
  const errors: string[] = [];
  const warnings: string[] = [];
  const values: FieldValue[] = [];

  const cellText = (field: CatalogImportField): string => {
    const idx = byField[field];
    if (idx === undefined) return "";
    return toCellText(cells[idx]);
  };

  // identifiers
  let sku: string | null = null;
  let parentSku: string | null = null;
  let kind: RowKind = "unknown";
  const skuRaw = cellText("sku");
  if (skuRaw !== "") {
    const s = normalizeSkuText(skuRaw);
    if (MAIN_SKU_RE.test(s)) {
      sku = s;
      kind = "product";
    } else if (VARIANT_SKU_RE.test(s)) {
      sku = s;
      parentSku = s.slice(0, s.indexOf("-"));
      kind = "variant";
    } else {
      errors.push(ROW_MESSAGES.invalid_sku);
    }
  }

  let barcode: string | null = null;
  const barcodeRaw = cellText("barcode");
  if (barcodeRaw !== "") {
    const b = barcodeRaw.replace(/\s+/g, "");
    if (/^\d{6,14}$/.test(b)) barcode = b;
    else errors.push(ROW_MESSAGES.invalid_barcode);
  }

  // field values
  let anyValue = skuRaw !== "" || barcodeRaw !== "";
  for (const [fieldName, idx] of Object.entries(byField) as [CatalogImportField, number][]) {
    if (fieldName === "sku" || fieldName === "barcode") continue;
    const def = fieldDef(fieldName);
    if (!def) continue;
    const raw = toCellText(cells[idx]);
    if (raw === "") continue; // empty cell = no change, NEVER a wipe
    anyValue = true;

    if (raw === CLEAR_TOKEN) {
      if (!def.clearable) {
        errors.push(ROW_MESSAGES.clear_not_allowed);
        continue;
      }
      values.push({ field: fieldName, value: "", clear: true });
      continue;
    }

    if (def.kind === "price") {
      const n = Number(raw);
      if (!Number.isFinite(n)) {
        errors.push(fieldName === "price" ? ROW_MESSAGES.invalid_price : ROW_MESSAGES.invalid_discount);
        continue;
      }
      if (n < 0) {
        errors.push(ROW_MESSAGES.negative_price);
        continue;
      }
      values.push({ field: fieldName, value: String(n), clear: false });
      continue;
    }

    if (def.kind === "approval") {
      const canonical = normalizeApprovalValue(raw);
      if (canonical === null) {
        errors.push(ROW_MESSAGES.invalid_approval);
        continue;
      }
      values.push({ field: fieldName, value: canonical, clear: false });
      continue;
    }

    values.push({ field: fieldName, value: raw, clear: false });
  }

  return { rowNum, kind, sku, parentSku, barcode, values, errors, warnings, empty: !anyValue };
}

// ═══════════ match ═══════════

export type MatchStatus =
  | "matched_sku"
  | "matched_barcode"
  | "matched_both"
  | "conflict" // sku and barcode point at different records
  | "dup_in_file" // same identifier appears on multiple Excel rows
  | "dup_in_db" // identifier matches MULTIPLE catalog records
  | "not_found"
  | "invalid";

export interface RowMatch {
  status: MatchStatus;
  /** the matched record (id + kind + parent product), when unique */
  record: IdentityRow | null;
}

export interface IdentityIndexes {
  bySku: Map<string, IdentityRow[]>;
  byBarcode: Map<string, IdentityRow[]>;
}

export function buildIdentityIndexes(rows: readonly IdentityRow[]): IdentityIndexes {
  const bySku = new Map<string, IdentityRow[]>();
  const byBarcode = new Map<string, IdentityRow[]>();
  for (const r of rows) {
    const sku = (r.sku ?? "").trim().toLowerCase();
    if (sku) {
      const list = bySku.get(sku) ?? [];
      list.push(r);
      bySku.set(sku, list);
    }
    const barcode = (r.barcode ?? "").trim();
    if (barcode) {
      const list = byBarcode.get(barcode) ?? [];
      list.push(r);
      byBarcode.set(barcode, list);
    }
  }
  return { bySku, byBarcode };
}

/** identifiers appearing on MORE than one Excel row (sku + barcode). */
export function findFileDuplicates(rows: readonly NormalizedRow[]): Set<number> {
  const skuRows = new Map<string, number[]>();
  const barcodeRows = new Map<string, number[]>();
  for (const r of rows) {
    if (r.sku) {
      const l = skuRows.get(r.sku) ?? [];
      l.push(r.rowNum);
      skuRows.set(r.sku, l);
    }
    if (r.barcode) {
      const l = barcodeRows.get(r.barcode) ?? [];
      l.push(r.rowNum);
      barcodeRows.set(r.barcode, l);
    }
  }
  const dupRows = new Set<number>();
  for (const list of [...skuRows.values(), ...barcodeRows.values()]) {
    if (list.length > 1) for (const n of list) dupRows.add(n);
  }
  return dupRows;
}

export function matchCatalogRow(
  row: NormalizedRow,
  indexes: IdentityIndexes,
  fileDupRows: ReadonlySet<number>,
): RowMatch {
  if (row.errors.length > 0) return { status: "invalid", record: null };
  if (fileDupRows.has(row.rowNum)) return { status: "dup_in_file", record: null };

  const skuHits = row.sku ? (indexes.bySku.get(row.sku) ?? []) : [];
  const barcodeHits = row.barcode ? (indexes.byBarcode.get(row.barcode) ?? []) : [];

  if (skuHits.length > 1 || barcodeHits.length > 1) return { status: "dup_in_db", record: null };

  const bySku = skuHits[0] ?? null;
  const byBarcode = barcodeHits[0] ?? null;

  if (bySku && byBarcode) {
    if (bySku.id === byBarcode.id) return { status: "matched_both", record: bySku };
    return { status: "conflict", record: null };
  }
  if (bySku) return { status: "matched_sku", record: bySku };
  if (byBarcode) return { status: "matched_barcode", record: byBarcode };
  return { status: "not_found", record: null };
}

// ═══════════ plan ═══════════

export interface FieldChange {
  field: CatalogImportField;
  label: string;
  current: string | null;
  excel: string | null; // null = explicit clear
  equal: boolean;
  /** proposed decision; the user can flip update<->skip per field */
  decision: "update" | "skip";
  warning: string | null;
  error: string | null;
}

export interface RowUpdatePlan {
  rowNum: number;
  recordId: string;
  recordKind: "product" | "variant";
  changes: FieldChange[];
  /** fingerprint of the CURRENT values of every mapped field */
  fingerprint: string;
  changedCount: number;
}

/** djb2 over a stable field:value serialization — cheap, deterministic. */
export function fingerprintRecord(
  fields: readonly CatalogImportField[],
  current: Readonly<Partial<Record<CatalogImportField, string | null>>>,
): string {
  const parts = [...fields].sort().map((f) => `${f}=${current[f] ?? " "}`);
  let h = 5381;
  const s = parts.join("");
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(16).padStart(8, "0") + ":" + s.length.toString(16);
}

/** normalized equality: trim + unify inner whitespace; numbers numerically. */
export function valuesEqual(kind: string, a: string | null, b: string | null): boolean {
  const na = a === null ? null : a.trim().replace(/\s+/g, " ");
  const nb = b === null ? null : b.trim().replace(/\s+/g, " ");
  if (kind === "price") {
    const pa = na === null || na === "" ? null : Number(na);
    const pb = nb === null || nb === "" ? null : Number(nb);
    return pa === pb;
  }
  if ((na === null || na === "") && (nb === null || nb === "")) return true;
  return na === nb;
}

export const PLAN_WARNINGS = {
  discount_above_price: "سعر الخصم أعلى من أو يساوي السعر الأساسي.",
  unknown_brand: "البراند غير موجود في القائمة — سيتم تجاهل هذا الحقل.",
  unknown_category: "الفئة غير موجودة.",
} as const;

/**
 * Build the per-field change plan for one MATCHED row.
 * `current` holds the record's present values keyed by import field;
 * `brandResolver` maps a brand display name -> brand_id (null = unknown).
 * `categories` is the locked category list.
 */
export function buildRowUpdatePlan(
  row: NormalizedRow,
  recordId: string,
  recordKind: "product" | "variant",
  current: Readonly<Partial<Record<CatalogImportField, string | null>>>,
  opts: {
    categories: readonly string[];
    brandResolver: (name: string) => string | null;
    /** globally selected fields; unselected fields default to skip */
    selectedFields: ReadonlySet<CatalogImportField>;
  },
): RowUpdatePlan {
  const changes: FieldChange[] = [];

  for (const v of row.values as readonly FieldValue[]) {
    const def = fieldDef(v.field);
    if (!def) continue;
    if (def.scope !== "both" && def.scope !== recordKind) continue; // wrong scope → not applicable
    const cur = current[v.field] ?? null;
    const excel = v.clear ? null : v.value;

    let warning: string | null = null;
    let error: string | null = null;

    if (v.field === "main_category" && excel !== null && !opts.categories.includes(excel)) {
      error = PLAN_WARNINGS.unknown_category;
    }
    if (v.field === "brand" && excel !== null && opts.brandResolver(excel) === null) {
      warning = PLAN_WARNINGS.unknown_brand;
    }
    if (v.field === "discount_price" && excel !== null) {
      const priceChange = (row.values as readonly FieldValue[]).find((x) => x.field === "price" && !x.clear);
      const basis = priceChange ? Number(priceChange.value) : cur !== null && current.price ? Number(current.price) : null;
      const base = priceChange ? Number(priceChange.value) : current.price != null ? Number(current.price) : basis;
      if (base !== null && base !== undefined && Number.isFinite(base) && Number(excel) >= base && base > 0) {
        warning = PLAN_WARNINGS.discount_above_price;
      }
    }

    const equal = valuesEqual(def.kind, cur, excel);
    const selected = opts.selectedFields.has(v.field);
    const decision: "update" | "skip" =
      error !== null || equal || !selected || (v.field === "brand" && warning === PLAN_WARNINGS.unknown_brand)
        ? "skip"
        : "update";

    changes.push({ field: v.field, label: def.label, current: cur, excel, equal, decision, warning, error });
  }

  const mappedFields = (row.values as readonly FieldValue[]).map((v) => v.field);
  return {
    rowNum: row.rowNum,
    recordId,
    recordKind,
    changes,
    fingerprint: fingerprintRecord(mappedFields, current),
    changedCount: changes.filter((c) => c.decision === "update").length,
  };
}

// ═══════════ new-records ═══════════

export type NewRecordClass =
  | "new_product" // valid main sku, all identifiers free
  | "new_variant_existing_parent" // mk123-4 where mk123 is in the catalog
  | "new_variant_parent_in_file" // parent is itself a new product in this file
  | "orphan_variant" // parent neither in catalog nor in file
  | "new_product_needs_sku" // barcode only — sku can be generated
  | "new_product_needs_ids" // named row with NO sku and NO barcode — both can be generated
  | "needs_review" // no identifiers and no name
  | "blocked"; // an identifier or conflict forbids creation

export interface NewRowClassification {
  rowNum: number;
  cls: NewRecordClass;
  reason: string | null;
}

export const NEW_CLASS_LABELS: Record<NewRecordClass, string> = {
  new_product: "منتج جديد محتمل",
  new_variant_existing_parent: "خيار جديد لمنتج موجود",
  new_variant_parent_in_file: "خيار جديد ومنتجه الأب داخل الملف",
  orphan_variant: "خيار جديد لكن المنتج الأب غير موجود",
  new_product_needs_sku: "منتج جديد محتمل — يحتاج SKU",
  new_product_needs_ids: "منتج جديد محتمل — يحتاج SKU وBarcode",
  needs_review: "صف جديد محتمل يحتاج مراجعة",
  blocked: "تعارض يمنع الإنشاء",
};

/**
 * Classify a NOT-FOUND row. `productSkuExists` answers "is this main sku a
 * catalog product?"; `fileNewProductSkus` is the set of valid new main skus
 * present in the same file.
 */
export function detectNewCatalogRecord(
  row: NormalizedRow,
  matchStatus: MatchStatus,
  productSkuExists: (sku: string) => boolean,
  fileNewProductSkus: ReadonlySet<string>,
): NewRowClassification {
  if (matchStatus === "conflict" || matchStatus === "dup_in_file" || matchStatus === "dup_in_db" || matchStatus === "invalid") {
    return { rowNum: row.rowNum, cls: "blocked", reason: null };
  }
  if (matchStatus !== "not_found") {
    return { rowNum: row.rowNum, cls: "blocked", reason: "الصف مطابق لسجل موجود." };
  }

  if (row.kind === "variant" && row.sku && row.parentSku) {
    if (productSkuExists(row.parentSku)) {
      return { rowNum: row.rowNum, cls: "new_variant_existing_parent", reason: null };
    }
    if (fileNewProductSkus.has(row.parentSku)) {
      return { rowNum: row.rowNum, cls: "new_variant_parent_in_file", reason: null };
    }
    return { rowNum: row.rowNum, cls: "orphan_variant", reason: "المنتج الأب غير موجود." };
  }

  if (row.kind === "product" && row.sku) {
    return { rowNum: row.rowNum, cls: "new_product", reason: null };
  }

  if (row.barcode) {
    return { rowNum: row.rowNum, cls: "new_product_needs_sku", reason: null };
  }

  // No identifiers at all. A NAMED row (real case: platform exports carry
  // rows with names/prices but empty SKU/Barcode) is still a creatable new
  // product — both identifiers can be generated. It is NEVER matched by
  // name; it only ever lands in the new-products tab.
  const hasName = row.values.some(
    (v) => (v.field === "name_en" || v.field === "name_ar") && !v.clear && v.value !== "",
  );
  if (hasName) {
    return { rowNum: row.rowNum, cls: "new_product_needs_ids", reason: null };
  }

  return { rowNum: row.rowNum, cls: "needs_review", reason: "لا يوجد SKU ولا باركود." };
}

export interface NewProductGroup {
  /** the main product row (rowNum), or null when sku must be generated */
  mainRowNum: number;
  mainSku: string | null;
  variantRowNums: number[];
  /** rows blocked inside the group (a mandatory-variant failure blocks all) */
  blockedRowNums: number[];
  needsSku: boolean;
}

/**
 * Group new-product rows with their in-file variants: mk2000 + mk2000-1..3
 * become ONE group. Variants whose parent is an EXISTING catalog product are
 * standalone single-variant groups handled by the variant-append path, so
 * they are not returned here.
 */
export function groupNewProductRows(
  classifications: readonly NewRowClassification[],
  rowsByNum: ReadonlyMap<number, NormalizedRow>,
): NewProductGroup[] {
  const groups = new Map<string, NewProductGroup>();
  const loose: NewProductGroup[] = [];

  for (const c of classifications) {
    const row = rowsByNum.get(c.rowNum);
    if (!row) continue;
    if (c.cls === "new_product" && row.sku) {
      const g = groups.get(row.sku) ?? {
        mainRowNum: c.rowNum,
        mainSku: row.sku,
        variantRowNums: [],
        blockedRowNums: [],
        needsSku: false,
      };
      g.mainRowNum = c.rowNum;
      groups.set(row.sku, g);
    } else if (c.cls === "new_product_needs_sku" || c.cls === "new_product_needs_ids") {
      loose.push({ mainRowNum: c.rowNum, mainSku: null, variantRowNums: [], blockedRowNums: [], needsSku: true });
    }
  }

  for (const c of classifications) {
    const row = rowsByNum.get(c.rowNum);
    if (!row || !row.parentSku) continue;
    if (c.cls === "new_variant_parent_in_file") {
      const g = groups.get(row.parentSku);
      if (g) g.variantRowNums.push(c.rowNum);
    }
  }

  for (const g of groups.values()) g.variantRowNums.sort((a, b) => a - b);
  return [...groups.values(), ...loose];
}
