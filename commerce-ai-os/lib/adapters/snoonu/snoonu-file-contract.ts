// CH.6A — Snoonu / Pure Seoul export file contract (PURE, read-only model).
//
// Re-audit of the current Snoonu "AllExportData" XLSX/CSV contract (as parsed by
// lib/snoonu-diff.ts HEADER_MAP). This module MODELS the contract as a typed,
// canonical row and provides a pure normalizer — it does NOT change any existing
// import/export behavior. Both Snoonu storefronts (Malikas, Pure Seoul) share the
// SAME file format; the SPI value is scoped PER storefront (a product has a
// different SPI in each store), so a canonical row is only meaningful together
// with the storefront it came from.
//
// PURE: no imports. node:test loads it directly.

/**
 * The real Snoonu export columns (normalized: lowercase, non-alphanumerics
 * stripped) → canonical field. Mirrors lib/snoonu-diff.ts so the two never drift.
 * Availability/Stock columns are store-name-suffixed → matched by prefix.
 */
export const SNOONU_EXPORT_FIELDS = {
  spiuniqueidentifier: "spi", //          "SPI(UniqueIdentifier)"  — the durable listing id
  productnameenreadonly: "name_en", //    "Product Name (En)(ReadOnly)"
  productnamearreadonly: "name_ar", //    "Product Name (Ar)(ReadOnly)"
  priceglobalupdate: "price", //          "Price Global(Update)"
  approval: "approval",
  // availability* → availability, stock* → stock (prefix match, store-suffixed)
} as const;

export type SnoonuCanonicalField = "spi" | "name_en" | "name_ar" | "price" | "approval" | "availability" | "stock";

/** One canonical Snoonu export row (storefront-agnostic in FORMAT). */
export interface SnoonuCanonicalRow {
  spi: string | null; //          external listing identity (per storefront)
  name_en: string | null;
  name_ar: string | null;
  price: string | null;
  approval: string | null; //     listing status / approval on the store
  availability: string | null; // "True" / "False" (store-suffixed column)
  stock: string | null; //        informational only; NEVER an inventory source
}

const norm = (h: string): string => h.toLowerCase().replace(/[^a-z0-9]/g, "");
const s = (v: unknown): string | null => {
  const t = String(v ?? "").trim();
  return t === "" ? null : t;
};

/** Resolve a raw export header to its canonical field (prefix rules included). */
export function canonicalFieldForHeader(header: string): SnoonuCanonicalField | null {
  const n = norm(header);
  if (n in SNOONU_EXPORT_FIELDS) return SNOONU_EXPORT_FIELDS[n as keyof typeof SNOONU_EXPORT_FIELDS];
  if (n.startsWith("availability")) return "availability";
  if (n.startsWith("stock")) return "stock";
  return null;
}

/**
 * Normalize one raw export row into a canonical Snoonu row. Pure; tolerant of
 * missing columns. Does not decide the storefront — the caller supplies it.
 */
export function canonicalizeSnoonuExportRow(raw: Record<string, unknown>): SnoonuCanonicalRow {
  const out: SnoonuCanonicalRow = { spi: null, name_en: null, name_ar: null, price: null, approval: null, availability: null, stock: null };
  for (const [header, value] of Object.entries(raw)) {
    const field = canonicalFieldForHeader(header);
    if (field) out[field] = s(value);
  }
  return out;
}

/** Map the store's Availability text to the explicit SnoonuAvailability value. */
export function availabilityFromExport(availability: string | null): "in_stock" | "out_of_stock" | "unknown" {
  const v = (availability ?? "").trim().toLowerCase();
  if (v === "true" || v === "available" || v === "in_stock") return "in_stock";
  if (v === "false" || v === "unavailable" || v === "out_of_stock") return "out_of_stock";
  return "unknown";
}
