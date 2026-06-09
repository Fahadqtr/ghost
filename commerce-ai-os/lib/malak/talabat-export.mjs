// Shared Talabat catalog format — the SINGLE source of truth for the Talabat
// export, used by BOTH the in-app button (app/api/export/[channel]/route.ts)
// and the CLI script (scripts/export_talabat.mjs) so the two never drift.
//
// Pure: no I/O, no DB, no file reads — just data in → rows/CSV out. Each caller
// fetches its own products/variants and (optionally) a SKU→Description-EN map
// from the master sheet, then calls buildTalabatRows() + rowsToCsv().

// Exact column order (10 columns).
export const TALABAT_HEADERS = [
  "SKU",
  "Barcode",
  "Price (QAR)",
  "Discount",
  "Product Name EN",
  "Product Name AR",
  "Category",
  "Description EN",
  "Description AR",
  "New Image Filename",
];

const S = (v) => (v == null ? "" : String(v).trim());

// Keep just the file name (strip any folder/URL prefix) → e.g. "mk1215.jpg".
const fileName = (v) => { const s = S(v); const i = s.lastIndexOf("/"); return i >= 0 ? s.slice(i + 1) : s; };

// Strip emojis & decorative symbols so the Talabat sheet stays clean plain text
// (e.g. "💄 Laneige…" → "Laneige…", "المميزات (◆)" → "المميزات", "✔ ..." → "...").
// Covers emoji, flags, dingbats, geometric bullets, variation selectors, ZWJ.
// Does NOT touch normal punctuation like – & ’ ™.
const EMOJI_RE = /[\u{1F000}-\u{1FAFF}\u{1F1E6}-\u{1F1FF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{2300}-\u{23FF}\u{25A0}-\u{25FF}\u{FE00}-\u{FE0F}\u{200D}\u{20E3}]/gu;
function clean(v) {
  let s = S(v).replace(EMOJI_RE, "");
  s = s.replace(/\(\s*\)/g, "");      // drop parens left empty after removal, e.g. "(◆)"
  s = s.replace(/[ \t]{2,}/g, " ");   // collapse runs of spaces/tabs (keep newlines)
  s = s.split("\n").map((l) => l.trim()).join("\n").trim();
  return s;
}

// RFC-4180 CSV cell: quote when it contains comma/quote/newline; escape quotes.
const cell = (v) => {
  const s = S(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

// Variant export seq: the index baked into the stored variant sku
// ({parentSku}-{N}-{slug}). Returns N, or null if it can't be parsed.
export function seqOf(parentSku, variantSku) {
  const rest = S(variantSku).startsWith(parentSku + "-")
    ? S(variantSku).slice(parentSku.length + 1)
    : "";
  const n = parseInt(rest, 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * Build the Talabat rows.
 *  - products: [{ id, sku, barcode, price, discount_price, name_en, name_ar,
 *                 main_category, description_en, description_ar, image_filename }]
 *  - variants: [{ parent_product_id, variant_name, sku }]
 *  - masterDescEn: Map(sku -> Description EN) used ONLY to fill an empty DB
 *                  description (Supabase stays primary). Pass an empty Map to skip.
 *
 * Logic:
 *  • product with no variants → one row as-is.
 *  • product with variants    → one row per variant:
 *      SKU = {parentSku}-{seq}, names suffixed with " - {variant_name}",
 *      barcode/price/discount/descriptions inherited from the parent.
 *  • New Image Filename is always empty (filled in later).
 *
 * Returns { rows, stats }.
 */
export function buildTalabatRows(products, variants, masterDescEn = new Map()) {
  // Group variants by parent.
  const variantsByParent = new Map();
  for (const v of variants) {
    const arr = variantsByParent.get(v.parent_product_id) ?? [];
    arr.push(v);
    variantsByParent.set(v.parent_product_id, arr);
  }

  const rows = [];
  let withVariants = 0;
  let withoutVariants = 0;
  let descEnFromMaster = 0;
  const stillEmpty = [];
  const noImage = [];

  for (const p of products) {
    // Description EN: Supabase first, master sheet (by SKU) as fallback.
    let descEn = S(p.description_en);
    if (descEn === "") {
      const fromMaster = masterDescEn.get(S(p.sku));
      if (fromMaster) { descEn = S(fromMaster); descEnFromMaster++; }
      else stillEmpty.push({ sku: S(p.sku), name_en: S(p.name_en) });
    }

    // New Image Filename: the product's own image file name (variants inherit
    // the parent's image for now — no per-colour images yet).
    const imgFile = fileName(p.image_filename);
    if (imgFile === "") noImage.push({ sku: S(p.sku), name_en: S(p.name_en) });

    const base = {
      Barcode: S(p.barcode),
      "Price (QAR)": S(p.price),
      Discount: S(p.discount_price),
      Category: clean(p.main_category), // variants inherit the parent's category
      "Description EN": clean(descEn),
      "Description AR": clean(p.description_ar),
      "New Image Filename": imgFile,
    };

    const nameEn = clean(p.name_en);
    const nameAr = clean(p.name_ar);

    const vs = variantsByParent.get(p.id);
    if (!vs || vs.length === 0) {
      withoutVariants++;
      rows.push({
        SKU: S(p.sku),
        ...base,
        "Product Name EN": nameEn,
        "Product Name AR": nameAr,
      });
      continue;
    }

    withVariants++;
    const ordered = vs
      .map((v, i) => ({ v, seq: seqOf(p.sku, v.sku) ?? i + 1 }))
      .sort((a, b) => a.seq - b.seq);
    for (const { v, seq } of ordered) {
      const name = clean(v.variant_name);
      rows.push({
        SKU: `${S(p.sku)}-${seq}`,
        ...base,
        "Product Name EN": name ? `${nameEn} - ${name}` : nameEn,
        "Product Name AR": name ? `${nameAr} - ${name}` : nameAr,
      });
    }
  }

  return {
    rows,
    stats: {
      productsTotal: products.length,
      withoutVariants,
      withVariants,
      variantRows: rows.length - withoutVariants,
      descEnFromMaster,
      stillEmpty,
      noImage,
    },
  };
}

// Serialize rows to CSV (CRLF line endings). No BOM — callers prepend it.
export function rowsToCsv(rows) {
  const lines = [TALABAT_HEADERS.join(",")];
  for (const r of rows) lines.push(TALABAT_HEADERS.map((h) => cell(r[h])).join(","));
  return lines.join("\r\n") + "\r\n";
}

// Build a SKU → Description-EN Map from already-parsed master-sheet rows
// (the 28-col Malikas_Universe sheet). Keeps the "which column" rule in one
// place; each caller parses the xlsx with its own runtime's xlsx loader.
export function masterDescEnFromRows(rows) {
  const m = new Map();
  for (const r of rows ?? []) {
    const sku = S(r.SKU);
    const desc = S(r["Description EN"]);
    if (sku && desc) m.set(sku, desc);
  }
  return m;
}

