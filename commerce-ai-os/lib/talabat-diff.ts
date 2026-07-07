// Pure Talabat catalog diff — DB-free, unit-tested.
//
// Talabat has no API for us: the merchant uploads Talabat's own catalog
// export (xlsx, unknown/loose column names) and we answer one question —
// which of OUR sellable products are missing over there. Talabat rejects
// variant products, so products WITH options are still sent — SPLIT into one
// standalone row per option (mk123-1, mk123-2 …) by the package builder; the
// diff just marks them. Only Approved products count as sellable.

export interface TalabatOurRow {
  id: string;
  sku: string | null;
  barcode?: string | null;
  name_en: string | null;
  name_ar: string | null;
  approval: string | null;
  hasVariants: boolean;
  image_url?: string | null;
  price?: number | string | null;
  discount_price?: number | string | null;
}

export interface TalabatColumns {
  sku?: string;
  barcode?: string;
  nameEn?: string;
  nameAr?: string;
}

export interface TalabatDiff {
  ok: boolean;
  error?: string;
  columns: TalabatColumns; // what we recognized in their sheet
  counts: {
    ours: number;
    eligible: number;         // Approved (option products included — they split)
    withOptions: number;      // among missing: products that will be split
    notApproved: number;
    theirRows: number;
    matched: number;
    missing: number;          // eligible but absent from their sheet
    noPrice: number;          // among missing: rows with no sellable price
    extraOnTalabat: number;   // their rows we couldn't map to the catalog
  };
  missing: { product_id: string; sku: string | null; name_en: string; hasVariants: boolean; image_url: string | null; noPrice: boolean }[];
  extraOnTalabat: { sku: string; name: string }[];
}

const key = (v: unknown): string =>
  String(v ?? "").toLowerCase().normalize("NFKC").replace(/[’']/g, "").replace(/["،,.\-–—]/g, " ").replace(/\s+/g, " ").trim();

const norm = (h: string) => h.toLowerCase().replace(/[^a-z؀-ۿ]+/g, " ").trim();

/**
 * Guess which columns of Talabat's sheet hold SKU / barcode / names. Their
 * exports are not stable, so we match on header keywords (EN + AR).
 */
export function detectTalabatColumns(headers: string[]): TalabatColumns {
  const out: TalabatColumns = {};
  for (const h of headers) {
    const n = norm(h);
    if (!out.sku && (/\bsku\b/.test(n) || /(item|product|master)\s*code/.test(n) || n === "code")) out.sku = h;
    else if (!out.barcode && /barcode|\bean\b|\bupc\b|\bgtin\b/.test(n)) out.barcode = h;
    else if (!out.nameAr && ((/name|title|product/.test(n) && /\bar\b|arabic|عرب/.test(n)) || /اسم|الاسم/.test(n))) out.nameAr = h;
    else if (!out.nameEn && ((/name|title/.test(n) && /\ben\b|english/.test(n)) || /^(product\s*)?(name|title)$/.test(n) || n === "product name")) out.nameEn = h;
  }
  return out;
}

/** "mk123-4" → "mk123" (our old variant-split SKUs that may live on Talabat). */
export function baseSku(v: unknown): string {
  return key(v).replace(/\s\d{1,3}$/, ""); // key() turned "-" into " "
}

export function diffTalabat(ours: TalabatOurRow[], theirRows: Record<string, unknown>[]): TalabatDiff {
  const empty: TalabatDiff = {
    ok: false, columns: {},
    counts: { ours: 0, eligible: 0, withOptions: 0, notApproved: 0, theirRows: 0, matched: 0, missing: 0, noPrice: 0, extraOnTalabat: 0 },
    missing: [], extraOnTalabat: [],
  };
  if (!theirRows.length) return { ...empty, error: "الملف فاضي — ما فيه صفوف." };

  const columns = detectTalabatColumns(Object.keys(theirRows[0]));
  if (!columns.sku && !columns.barcode && !columns.nameEn && !columns.nameAr) {
    return { ...empty, error: "ما تعرّفت على أعمدة الملف (SKU / Barcode / Name) — تأكد إنه تصدير كتالوج طلبات." };
  }

  // Index THEIR sheet.
  const theirSkus = new Set<string>();
  const theirSkuBases = new Set<string>();
  const theirBarcodes = new Set<string>();
  const theirNames = new Set<string>();
  for (const r of theirRows) {
    const sku = key(columns.sku ? r[columns.sku] : "");
    if (sku) { theirSkus.add(sku); theirSkuBases.add(baseSku(columns.sku ? r[columns.sku] : "")); }
    const bc = key(columns.barcode ? r[columns.barcode] : "");
    if (bc) theirBarcodes.add(bc);
    for (const c of [columns.nameEn, columns.nameAr]) {
      const t = key(c ? r[c] : "");
      if (t) theirNames.add(t);
    }
  }

  // Walk OUR catalog.
  const missing: TalabatDiff["missing"] = [];
  const matchedOurKeys = { skus: new Set<string>(), barcodes: new Set<string>(), names: new Set<string>() };
  let eligible = 0, notApproved = 0, matched = 0, withOptions = 0, noPriceCount = 0;

  for (const o of ours) {
    const sku = key(o.sku);
    const bc = key(o.barcode);
    const nEn = key(o.name_en);
    const nAr = key(o.name_ar);
    const hit =
      (sku && (theirSkus.has(sku) || theirSkuBases.has(sku))) ||
      (bc && theirBarcodes.has(bc)) ||
      (nEn && theirNames.has(nEn)) ||
      (nAr && theirNames.has(nAr));
    // Remember every matchable key of ours (variants included) so their extra
    // rows are judged against the WHOLE catalog, not just eligible rows.
    if (sku) matchedOurKeys.skus.add(sku);
    if (bc) matchedOurKeys.barcodes.add(bc);
    if (nEn) matchedOurKeys.names.add(nEn);
    if (nAr) matchedOurKeys.names.add(nAr);

    if (String(o.approval ?? "") !== "Approved") { notApproved++; continue; }
    eligible++;
    if (hit) { matched++; continue; }
    if (o.hasVariants) withOptions++;
    const noPrice = !(Number(o.price) > 0 || Number(o.discount_price) > 0);
    if (noPrice) noPriceCount++;
    missing.push({ product_id: o.id, sku: o.sku, name_en: String(o.name_en ?? ""), hasVariants: o.hasVariants, image_url: o.image_url ?? null, noPrice });
  }

  // Their rows that map to nothing we sell (any key, any product).
  const extraOnTalabat: TalabatDiff["extraOnTalabat"] = [];
  for (const r of theirRows) {
    const sku = key(columns.sku ? r[columns.sku] : "");
    const bc = key(columns.barcode ? r[columns.barcode] : "");
    const nEn = key(columns.nameEn ? r[columns.nameEn] : "");
    const nAr = key(columns.nameAr ? r[columns.nameAr] : "");
    const known =
      (sku && (matchedOurKeys.skus.has(sku) || matchedOurKeys.skus.has(baseSku(columns.sku ? r[columns.sku] : "")))) ||
      (bc && matchedOurKeys.barcodes.has(bc)) ||
      (nEn && matchedOurKeys.names.has(nEn)) ||
      (nAr && matchedOurKeys.names.has(nAr));
    if (!known && (sku || nEn || nAr)) {
      extraOnTalabat.push({
        sku: String(columns.sku ? r[columns.sku] ?? "" : ""),
        name: String((columns.nameEn ? r[columns.nameEn] : "") || (columns.nameAr ? r[columns.nameAr] : "") || ""),
      });
    }
  }

  return {
    ok: true,
    columns,
    counts: {
      ours: ours.length, eligible, withOptions, notApproved,
      theirRows: theirRows.length, matched, missing: missing.length, noPrice: noPriceCount, extraOnTalabat: extraOnTalabat.length,
    },
    missing, extraOnTalabat,
  };
}

/**
 * The sheet's "New Image Filename": the stored filename when present, else a
 * name DERIVED from the SKU + the image URL's extension (Shopify-imported
 * products carry image_url but no image_filename). The images ZIP uses the
 * same rule, so sheet and archive always agree.
 */
export function imageFileFor(sku: unknown, imageFilename: unknown, imageUrl: unknown): string {
  const f = String(imageFilename ?? "").trim();
  if (f) { const i = f.lastIndexOf("/"); return i >= 0 ? f.slice(i + 1) : f; }
  const s = String(sku ?? "").trim().toLowerCase();
  const u = String(imageUrl ?? "").trim();
  if (!s || !u) return "";
  const m = u.split(/[?#]/)[0].match(/\.(jpe?g|png|webp|gif|avif)$/i);
  return `${s}.${m ? m[1].toLowerCase() : "jpg"}`;
}

/** Ready-to-send email (AR + EN) asking Talabat to add the missing products. */
export function talabatEmailText(count: number, storeName = "Malika's Universe"): string {
  return [
    "السلام عليكم فريق طلبات،",
    "",
    `نرغب بإضافة ${count} منتج جديد لمتجر ${storeName}.`,
    "مرفق ملف إكسل بتفاصيل المنتجات (الأسعار والأسماء والوصف)، وملف مضغوط بصور المنتجات — اسم كل صورة يطابق عمود New Image Filename في الملف.",
    "",
    "نرجو إضافتها وإبلاغنا عند اكتمالها. شكرًا لكم 🌹",
    "",
    "---",
    "",
    "Hello Talabat team,",
    "",
    `We would like to add ${count} new products to the ${storeName} store.`,
    "Attached: an Excel file with the product details, and a ZIP with the product images — each image is named exactly as the \"New Image Filename\" column.",
    "",
    "Please add them and let us know once done. Thank you!",
  ].join("\n");
}
