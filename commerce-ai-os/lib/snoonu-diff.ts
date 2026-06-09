// Pure, DB-free Snoonu diff logic — shared by the server action and tests.
// No next/headers, no Supabase here, so it can be unit-tested directly.

export const SNOONU_SHEET = "NonFoodProducts";

export interface SnoonuExportRow {
  id: string;
  name_en?: string;
  name_ar?: string;
  description_en?: string;
  description_ar?: string;
  price?: string;
  discount?: string;
  approval?: string;
  is_featured?: string;
  is_promoted?: string;
  has_buy1get1?: string;
}

export interface FieldChange { field: string; old: string; new: string }
export interface UpdatedEntry { snoonu_id: string; product_id: string; name_en: string; changes: FieldChange[] }
export interface NewEntry { id: string; name_en: string }
export interface MissingEntry { snoonu_id: string; product_id: string; sku: string | null; name_en: string | null }

export interface SnoonuDiff {
  ok: boolean;
  error?: string;
  existingOptionalCols: string[];
  missingOptionalCols: string[];
  counts: { exportRows: number; matched: number; updated: number; newCount: number; missing: number; unchanged: number };
  fieldCounts: Record<string, number>;     // per-column total # of changed rows
  changedColsPerProduct: string[][];        // for each updated product, the changed column names
  updated: UpdatedEntry[];
  newProducts: NewEntry[];
  missing: MissingEntry[];
}

export type Field = { ex: keyof SnoonuExportRow; col: string; type: "str" | "num" | "bool" };

// export field -> product column.
export const ALWAYS: Field[] = [
  { ex: "name_en", col: "name_en", type: "str" },
  { ex: "name_ar", col: "name_ar", type: "str" },
  { ex: "description_en", col: "description_en", type: "str" },
  { ex: "description_ar", col: "description_ar", type: "str" },
  { ex: "price", col: "price", type: "num" },
  { ex: "discount", col: "discount_price", type: "num" },
];
export const OPTIONAL: Field[] = [
  { ex: "approval", col: "approval", type: "str" },
  { ex: "is_featured", col: "is_featured", type: "bool" },
  { ex: "is_promoted", col: "is_promoted", type: "bool" },
  { ex: "has_buy1get1", col: "has_buy1get1", type: "bool" },
];

// Columns the read needs (deduped); the comparison columns plus identity ones.
export function readColumns(fields: Field[]): string {
  const set = new Set<string>(["id", "snoonu_id", "sku", "name_en"]);
  for (const f of fields) set.add(f.col);
  return [...set].join(", ");
}

export const s = (v: unknown) => String(v ?? "").trim();

// Normalize TEXT fields so COSMETIC differences are not treated as changes:
// escaped newlines, CRLF, unicode form, emoji variation selectors / ZWJ,
// zero-width chars, NBSP, HTML entities, collapsed space runs, blank lines.
// Used for both comparison AND the value written on Apply. NOTE: this only
// removes formatting noise \u2014 genuinely different text (e.g. an extra emoji or
// extra sentence) still differs, as it should.
function safeCp(n: number): string { try { return Number.isFinite(n) ? String.fromCodePoint(n) : ""; } catch { return ""; } }
export function normalizeText(v: unknown): string {
  return String(v ?? "")
    .replace(/\\r\\n|\\n|\\r/g, "\n")          // literal "\n"/"\r\n" -> real LF
    .replace(/\\t/g, " ")                       // literal "\t" -> space
    .replace(/\r\n?/g, "\n")                    // CRLF / CR -> LF
    .normalize("NFC")                           // unicode canonical form
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"').replace(/&#0?39;|&apos;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => safeCp(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeCp(parseInt(d, 10)))
    .replace(/[\uFE0E\uFE0F\u200D]/g, "")       // emoji variation selectors + ZWJ
    .replace(/[\u200B\u200C\uFEFF]/g, "")      // zero-width chars
    .replace(/\u00A0/g, " ")                    // NBSP -> space
    .replace(/[ \t]+/g, " ")                    // collapse runs of spaces/tabs
    .replace(/ *\n */g, "\n")                   // drop spaces around line breaks
    .replace(/\n{2,}/g, "\n")                   // collapse blank lines
    .trim();
}
const numEq = (a: unknown, b: unknown) => {
  const x = s(a), y = s(b);
  if (x === "" && y === "") return true;
  const nx = Number(x), ny = Number(y);
  if (isNaN(nx) || isNaN(ny)) return x === y;
  return nx === ny;
};
const boolNorm = (v: unknown) => {
  const t = s(v).toLowerCase();
  if (["true", "1", "yes", "y"].includes(t)) return "true";
  if (["false", "0", "no", "n", ""].includes(t)) return "false";
  return t;
};
export function writeVal(type: string, exStr: string): unknown {
  if (type === "num") { const n = Number(exStr); return isNaN(n) ? null : n; }
  if (type === "bool") { const b = boolNorm(exStr); return b === "true" ? true : b === "false" ? false : null; }
  return exStr;
}

// EMPTY export cells are skipped (a blank never blanks our data; keeps diff==apply).
export function computeChanges(p: Record<string, unknown>, r: SnoonuExportRow, fields: Field[]) {
  const changes: { field: string; old: string; new: string; writeValue: unknown }[] = [];
  for (const f of fields) {
    const exRaw = r[f.ex];
    if (exRaw === undefined) continue;

    if (f.type === "str") {
      // Normalize both sides; only a real (non-cosmetic) text change counts,
      // and the normalized value is what gets written on Apply.
      const exN = normalizeText(exRaw);
      if (exN === "") continue;                 // empty export cell -> no update
      const dbN = normalizeText(p[f.col]);
      if (dbN !== exN) changes.push({ field: f.col, old: dbN || "—", new: exN, writeValue: exN });
      continue;
    }

    const exStr = s(exRaw);
    if (exStr === "") continue;
    const dbVal = p[f.col];
    const differs = f.type === "num" ? !numEq(dbVal, exStr) : boolNorm(dbVal) !== boolNorm(exStr);
    if (differs) changes.push({ field: f.col, old: s(dbVal) || "—", new: exStr, writeValue: writeVal(f.type, exStr) });
  }
  return changes;
}

// Pure diff: products (rows from DB) vs parsed export rows.
export function diffSnoonu(
  products: Record<string, any>[],
  rows: SnoonuExportRow[],
  fields: Field[]
): Pick<SnoonuDiff, "updated" | "newProducts" | "missing"> & { unchanged: number; matched: number } {
  const bySnoonu = new Map<string, any>();
  for (const p of products) if (p.snoonu_id) bySnoonu.set(String(p.snoonu_id), p);

  const updated: UpdatedEntry[] = [];
  const newProducts: NewEntry[] = [];
  const seenIds = new Set<string>();
  let unchanged = 0;

  for (const r of rows) {
    const id = s(r.id);
    if (!id) continue;
    seenIds.add(id);
    const p = bySnoonu.get(id);
    if (!p) { newProducts.push({ id, name_en: s(r.name_en) }); continue; }
    const ch = computeChanges(p, r, fields);
    if (ch.length) {
      updated.push({ snoonu_id: id, product_id: p.id, name_en: p.name_en ?? s(r.name_en), changes: ch.map((c) => ({ field: c.field, old: c.old, new: c.new })) });
    } else unchanged++;
  }

  const missing: MissingEntry[] = products
    .filter((p) => p.snoonu_id && !seenIds.has(String(p.snoonu_id)))
    .map((p) => ({ snoonu_id: String(p.snoonu_id), product_id: p.id, sku: p.sku ?? null, name_en: p.name_en ?? null }));

  return { updated, newProducts, missing, unchanged, matched: rows.filter((r) => bySnoonu.has(s(r.id))).length };
}

// --- export header -> field mapping (shared by client + tests) -------------
// Accepts BOTH the simple test headers and the REAL Snoonu "AllExportData"
// headers (e.g. "SPI(UniqueIdentifier)", "Product Name (En)(ReadOnly)",
// "Price Global(Update)") — normHeader strips punctuation/case so they match.
export const HEADER_MAP: Record<string, keyof SnoonuExportRow> = {
  id: "id",
  nameen: "name_en", namear: "name_ar",
  descriptionen: "description_en", descriptionar: "description_ar",
  price: "price", discount: "discount",
  approval: "approval",
  isfeatured: "is_featured", ispromoted: "is_promoted", hasbuy1get1: "has_buy1get1",
  // Real Snoonu export column names:
  spiuniqueidentifier: "id",
  productnameenreadonly: "name_en", productnamearreadonly: "name_ar",
  productdescriptionenreadonly: "description_en", productdescriptionarreadonly: "description_ar",
  priceglobalupdate: "price",
};
export const normHeader = (h: string) => h.toLowerCase().replace(/[^a-z0-9]/g, "");

export function mapExportRows(raw: Record<string, unknown>[]): {
  rows: SnoonuExportRow[]; hasId: boolean; headers: string[];
} {
  if (!raw.length) return { rows: [], hasId: false, headers: [] };
  const headers = Object.keys(raw[0]);
  const map: Record<string, keyof SnoonuExportRow> = {};
  for (const h of headers) { const f = HEADER_MAP[normHeader(h)]; if (f) map[h] = f; }
  const rows = raw.map((r) => {
    const out: any = {};
    for (const [h, f] of Object.entries(map)) out[f] = String(r[h] ?? "").trim();
    return out as SnoonuExportRow;
  }).filter((r) => r.id);
  return { rows, hasId: Object.values(map).includes("id"), headers };
}
