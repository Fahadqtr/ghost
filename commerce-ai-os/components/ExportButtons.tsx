"use client";

export interface ExportVariant {
  variant_name: string | null;
  sku: string | null;
  price: number | null;
  stock_quantity: number | null;
}
export interface ExportProduct {
  sku: string | null;
  barcode: string | null;
  name_en: string | null;
  name_ar: string | null;
  main_category: string | null;
  price: number | null;
  discount_price: number | null;
  stock_quantity: number | null;
  image_url: string | null;
  variants: ExportVariant[];
}

const cell = (v: unknown) => {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const toCsv = (headers: string[], rows: unknown[][]) =>
  [headers, ...rows].map((r) => r.map(cell).join(",")).join("\n");

function download(filename: string, csv: string) {
  // Phase 1 placeholder banner so these are never mistaken for real feeds.
  const banner = `# PHASE 1 PLACEHOLDER EXPORT — not a live channel feed\n`;
  const blob = new Blob([banner + csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export default function ExportButtons({ products }: { products: ExportProduct[] }) {
  function shopify() {
    const rows = products.map((p) => [
      (p.name_en ?? "").toLowerCase().replace(/\s+/g, "-"),
      p.name_en, "", "Malika's Universe", p.main_category, "",
      p.sku, p.price, p.stock_quantity, p.image_url,
    ]);
    download("shopify_export.csv", toCsv(
      ["Handle", "Title", "Body (HTML)", "Vendor", "Type", "Tags", "Variant SKU", "Variant Price", "Variant Inventory Qty", "Image Src"],
      rows
    ));
  }

  function snoonu() {
    const rows = products.map((p) => [p.sku, p.name_en, p.name_ar, p.main_category, p.price, p.stock_quantity, p.image_url]);
    download("snoonu_masterlist.csv", toCsv(
      ["SKU", "Name (EN)", "Name (AR)", "Category", "Price", "Stock", "Image"],
      rows
    ));
  }

  function talabat() {
    // Talabat has no variants -> split each variant into its own row.
    const rows: unknown[][] = [];
    for (const p of products) {
      if (p.variants.length > 0) {
        for (const v of p.variants) {
          rows.push([p.sku, `${p.name_en ?? ""} - ${v.variant_name ?? ""}`.trim(), v.sku, v.price ?? p.price, v.stock_quantity ?? 0]);
        }
      } else {
        rows.push([p.sku, p.name_en, p.sku, p.price, p.stock_quantity]);
      }
    }
    download("talabat_split.csv", toCsv(
      ["Parent SKU", "Item Name", "Item SKU", "Price", "Stock"],
      rows
    ));
  }

  function rafeeq() {
    const rows = products.map((p) => [p.sku, p.name_en, p.price, p.discount_price, p.stock_quantity]);
    download("rafeeq_export.csv", toCsv(
      ["SKU", "Name", "Price", "Discount Price", "Stock"],
      rows
    ));
  }

  const buttons = [
    { label: "Shopify CSV", onClick: shopify },
    { label: "Snoonu masterlist", onClick: snoonu },
    { label: "Talabat split-CSV", onClick: talabat },
    { label: "Rafeeq CSV", onClick: rafeeq },
  ];

  return (
    <div className="card space-y-3">
      <div>
        <h3 className="text-sm font-semibold text-ink">Export per channel</h3>
        <p className="text-xs text-muted">
          Generates a placeholder CSV from your current {products.length} product(s). No data is sent anywhere — files download locally.
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        {buttons.map((b) => (
          <button key={b.label} onClick={b.onClick} className="btn-ghost">⬇ {b.label}</button>
        ))}
      </div>
    </div>
  );
}
