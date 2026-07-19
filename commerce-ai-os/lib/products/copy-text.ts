// Pure, DB-free builder for the "copy everything" text of a product — title,
// bilingual names/descriptions, codes, price, category, keywords, and every
// option (variant). Empty fields are skipped so the block stays clean. Used by
// the product page's «نسخ كل التفاصيل» button. Unit-tested.

export interface CopyProduct {
  name_en?: string | null; name_ar?: string | null;
  sku?: string | null; barcode?: string | null; snoonu_id?: string | null;
  brand?: string | null;
  main_category?: string | null; sub_category?: string | null; product_type?: string | null;
  color?: string | null; size?: string | null;
  price?: number | string | null; discount_price?: number | string | null;
  stock?: number | string | null; stock_status?: string | null;
  description_en?: string | null; description_ar?: string | null;
  keywords_en?: string | null; keywords_ar?: string | null;
  notes?: string | null;
}

export interface CopyVariant {
  variant_name?: string | null; variant_name_en?: string | null; sku?: string | null; barcode?: string | null;
  color?: string | null; size?: string | null; price?: number | string | null;
}

const s = (v: unknown) => String(v ?? "").trim();
const has = (v: unknown) => s(v) !== "";

/** Assemble the full copyable text block. Empty fields are omitted. */
export function buildProductCopyText(p: CopyProduct, variants: CopyVariant[] = []): string {
  const lines: string[] = [];
  const push = (label: string, value: unknown) => { if (has(value)) lines.push(`${label}: ${s(value)}`); };

  // Titles first (no label — they're the heading).
  if (has(p.name_en)) lines.push(s(p.name_en));
  if (has(p.name_ar)) lines.push(s(p.name_ar));
  if (lines.length) lines.push("");

  push("SKU", p.sku);
  push("Barcode / الباركود", p.barcode);
  push("Snoonu ID", p.snoonu_id);
  push("Brand / الماركة", p.brand);

  const cat = [p.main_category, p.sub_category, p.product_type].map(s).filter(Boolean).join(" › ");
  if (cat) lines.push(`التصنيف / Category: ${cat}`);

  const attrs = [has(p.color) && `اللون: ${s(p.color)}`, has(p.size) && `المقاس: ${s(p.size)}`].filter(Boolean).join(" · ");
  if (attrs) lines.push(attrs);

  if (has(p.price)) {
    lines.push(`السعر / Price: ${s(p.price)}${has(p.discount_price) ? ` (بعد الخصم: ${s(p.discount_price)})` : ""}`);
  }
  if (has(p.stock) || has(p.stock_status)) {
    lines.push(`المخزون / Stock: ${[s(p.stock), s(p.stock_status)].filter(Boolean).join(" · ")}`);
  }

  if (has(p.description_en)) lines.push("", "الوصف (EN):", s(p.description_en));
  if (has(p.description_ar)) lines.push("", "الوصف (AR):", s(p.description_ar));

  if (has(p.keywords_en)) { lines.push(""); push("Keywords (EN)", p.keywords_en); }
  if (has(p.keywords_ar)) push("Keywords (AR)", p.keywords_ar);
  if (has(p.notes)) { lines.push(""); push("ملاحظات / Notes", p.notes); }

  const vs = (variants ?? []).filter((v) => has(v.variant_name) || has(v.variant_name_en) || has(v.sku) || has(v.barcode));
  if (vs.length) {
    lines.push("", `الخيارات / Options (${vs.length}):`);
    for (const v of vs) {
      const bits = [
        [has(v.variant_name) && s(v.variant_name), has(v.variant_name_en) && s(v.variant_name_en)].filter(Boolean).join(" / "),
        has(v.sku) && `SKU ${s(v.sku)}`,
        has(v.barcode) && `باركود ${s(v.barcode)}`,
        has(v.color) && `لون ${s(v.color)}`,
        has(v.size) && `مقاس ${s(v.size)}`,
        has(v.price) && `السعر ${s(v.price)}`,
      ].filter(Boolean).join(" · ");
      lines.push(`• ${bits}`);
    }
  }

  return lines.join("\n").trim();
}
