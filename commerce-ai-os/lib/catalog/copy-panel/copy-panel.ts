// STAFF COPY PANEL — pure projection of one product into copyable fields,
// deterministic image names, and the drag payload.
//
// PURE — no I/O, no framework imports. node:test loads this directly.
//
// The panel exists so staff can retype nothing when they list a product on a
// marketplace by hand. It is READ-ONLY by construction: this module produces
// strings to copy and names to save under, and nothing here can describe a
// write. Internal identifiers (product/variant UUIDs) and cost/stock/notes are
// deliberately absent from the projection so they cannot reach a clipboard or
// an archive — a field that is never built is a field that cannot leak.
//
// Image extensions come from the SAME helpers channel packaging uses
// (extensionFromUrl / normalizeExtension, and sniffImageExtension on the
// server) — this module never re-implements image normalization.

import { normalizeExtension, extensionFromUrl, sanitizeSkuForFilename } from "../../export/image-naming.ts";

// ── inputs ───────────────────────────────────────────────────────────────────

/** One product, projected to exactly the marketplace-ready fields. */
export interface CopyPanelProduct {
  sku: string | null;
  barcode: string | null;
  nameEn: string | null;
  nameAr: string | null;
  price: number | null;
  discountPrice: number | null;
  category: string | null;
  subCategory: string | null;
  brand: string | null;
  size: string | null;
  color: string | null;
  descriptionEn: string | null;
  descriptionAr: string | null;
}

/** One variant, projected. Variant identity is NEVER merged with the parent. */
export interface CopyPanelVariant {
  /** durable variant id — used as a React key only, never copied or exported. */
  id: string | null;
  optionNameAr: string | null;
  optionNameEn: string | null;
  sku: string | null;
  barcode: string | null;
  price: number | null;
  color: string | null;
  size: string | null;
  imageUrl: string | null;
}

/** One image as the panel shows it. */
export interface CopyPanelImage {
  url: string;
  filename: string | null;
  isPrimary: boolean;
}

// ── copyable fields ──────────────────────────────────────────────────────────

export interface CopyField {
  /** stable key — test anchor and React key. */
  key: string;
  /** Arabic label shown to staff. */
  label: string;
  /** the exact canonical value, unmodified. */
  value: string;
  /** long text that needs a scrollable box rather than one line. */
  multiline: boolean;
}

const text = (v: string | null | undefined): string => (typeof v === "string" ? v.trim() : "");

/** Money is copied as the bare number — a marketplace form wants `45`, not `45 ر.ق`. */
function money(v: number | null | undefined): string {
  return typeof v === "number" && Number.isFinite(v) ? String(v) : "";
}

/**
 * Project a product into the ordered field list. A field with no value is
 * OMITTED — staff should never copy an empty string and believe it is the
 * canonical value.
 */
export function buildCopyFields(p: CopyPanelProduct): CopyField[] {
  const candidates: CopyField[] = [
    { key: "name_en", label: "الاسم بالإنجليزية", value: text(p.nameEn), multiline: false },
    { key: "name_ar", label: "الاسم بالعربية", value: text(p.nameAr), multiline: false },
    { key: "sku", label: "SKU", value: text(p.sku), multiline: false },
    { key: "barcode", label: "الباركود", value: text(p.barcode), multiline: false },
    { key: "price", label: "السعر", value: money(p.price), multiline: false },
    { key: "discount_price", label: "سعر الخصم", value: money(p.discountPrice), multiline: false },
    { key: "category", label: "الفئة", value: text(p.category), multiline: false },
    { key: "sub_category", label: "الفئة الفرعية", value: text(p.subCategory), multiline: false },
    { key: "brand", label: "العلامة التجارية", value: text(p.brand), multiline: false },
    { key: "size", label: "الحجم", value: text(p.size), multiline: false },
    { key: "color", label: "اللون", value: text(p.color), multiline: false },
    { key: "description_en", label: "الوصف بالإنجليزية", value: text(p.descriptionEn), multiline: true },
    { key: "description_ar", label: "الوصف بالعربية", value: text(p.descriptionAr), multiline: true },
  ];
  return candidates.filter((f) => f.value !== "");
}

/** Project one variant. Same omit-empty rule; keys are variant-scoped. */
export function buildVariantFields(v: CopyPanelVariant): CopyField[] {
  const candidates: CopyField[] = [
    { key: "option_name_ar", label: "اسم الخيار", value: text(v.optionNameAr), multiline: false },
    { key: "option_name_en", label: "اسم الخيار (إنجليزي)", value: text(v.optionNameEn), multiline: false },
    { key: "variant_sku", label: "SKU الخيار", value: text(v.sku), multiline: false },
    { key: "variant_barcode", label: "باركود الخيار", value: text(v.barcode), multiline: false },
    { key: "variant_price", label: "سعر الخيار", value: money(v.price), multiline: false },
    { key: "variant_color", label: "اللون", value: text(v.color), multiline: false },
    { key: "variant_size", label: "الحجم", value: text(v.size), multiline: false },
  ];
  return candidates.filter((f) => f.value !== "");
}

/**
 * The "copy everything" block: `label: value` lines, long text on its own lines
 * under its label. Built FROM the same field list the panel shows, so what is
 * copied is exactly what is on screen — no hidden field can ride along.
 */
export function buildCopyAllText(fields: readonly CopyField[]): string {
  const parts: string[] = [];
  for (const f of fields) {
    parts.push(f.multiline ? `${f.label}:\n${f.value}` : `${f.label}: ${f.value}`);
  }
  return parts.join("\n");
}

/** The same block for one variant, headed by the variant's own label. */
export function buildVariantCopyAllText(v: CopyPanelVariant, fields: readonly CopyField[]): string {
  const head = text(v.optionNameAr) || text(v.optionNameEn) || text(v.sku) || "خيار";
  return [`الخيار: ${head}`, buildCopyAllText(fields)].filter((s) => s !== "").join("\n");
}

// ── image names ──────────────────────────────────────────────────────────────

/**
 * Deterministic archive name for a product image: the primary is `-main`, the
 * rest are `-01`, `-02`, … in the order the panel shows them. `position` is the
 * index among the NON-primary images (0-based).
 */
export function productImageZipName(sku: string, position: number | "main", ext?: string | null): string {
  const base = sanitizeSkuForFilename(sku);
  const e = normalizeExtension(ext);
  if (position === "main") return `${base}-main.${e}`;
  const n = Math.max(0, Math.trunc(position)) + 1;
  return `${base}-${String(n).padStart(2, "0")}.${e}`;
}

/**
 * Archive name for a VARIANT image — the variant SKU is kept in the name so a
 * variant photo is never mistaken for a parent photo. Falls back to an indexed
 * `-variant-NN` when the variant carries no SKU of its own.
 */
export function variantImageZipName(sku: string, variantSku: string | null, index: number, ext?: string | null): string {
  const base = sanitizeSkuForFilename(sku);
  const e = normalizeExtension(ext);
  const vs = sanitizeSkuForFilename(text(variantSku));
  if (vs !== "") return `${base}-variant-${vs}.${e}`;
  return `${base}-variant-${String(Math.max(0, Math.trunc(index)) + 1).padStart(2, "0")}.${e}`;
}

/** `<SKU>-images.zip` — the archive staff receives. */
export function imagesZipFilename(sku: string): string {
  return `${sanitizeSkuForFilename(sku)}-images.zip`;
}

/**
 * Plan every archive entry for one product, deterministically. Duplicate URLs
 * collapse to one entry (the same photo listed twice must not be zipped twice),
 * and a name that would collide is suffixed rather than silently overwritten.
 */
export interface ZipImagePlanEntry {
  name: string;
  url: string;
  kind: "primary" | "gallery" | "variant";
}

export function planProductImageZip(
  sku: string,
  images: readonly CopyPanelImage[],
  variants: readonly CopyPanelVariant[] = [],
): ZipImagePlanEntry[] {
  const out: ZipImagePlanEntry[] = [];
  const seenUrl = new Set<string>();
  const usedName = new Set<string>();

  const push = (name: string, url: string, kind: ZipImagePlanEntry["kind"]) => {
    if (url === "" || seenUrl.has(url)) return;
    seenUrl.add(url);
    let final = name;
    if (usedName.has(final)) {
      const dot = final.lastIndexOf(".");
      const stem = dot > 0 ? final.slice(0, dot) : final;
      const ext = dot > 0 ? final.slice(dot) : "";
      let n = 2;
      while (usedName.has(`${stem}-${n}${ext}`)) n += 1;
      final = `${stem}-${n}${ext}`;
    }
    usedName.add(final);
    out.push({ name: final, url, kind });
  };

  let gallery = 0;
  for (const img of images) {
    const url = text(img.url);
    if (url === "") continue;
    const ext = extensionFromUrl(url);
    if (img.isPrimary) push(productImageZipName(sku, "main", ext), url, "primary");
    else {
      push(productImageZipName(sku, gallery, ext), url, "gallery");
      gallery += 1;
    }
  }

  variants.forEach((v, i) => {
    const url = text(v.imageUrl);
    if (url === "") return;
    push(variantImageZipName(sku, v.sku, i, extensionFromUrl(url)), url, "variant");
  });

  return out;
}

// ── drag to desktop ──────────────────────────────────────────────────────────

const MIME_BY_EXT: Record<string, string> = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png",
  webp: "image/webp", gif: "image/gif", avif: "image/avif",
};

/** The MIME a `DownloadURL` drag payload should advertise for a filename. */
export function dragMimeForName(filename: string): string {
  const dot = filename.lastIndexOf(".");
  const ext = dot > 0 ? normalizeExtension(filename.slice(dot + 1)) : "";
  return MIME_BY_EXT[ext] ?? "application/octet-stream";
}

/**
 * The Chromium `DownloadURL` drag payload: `mime:filename:absoluteUrl`.
 *
 * The URL MUST be absolute — a relative href silently produces a dead drop —
 * and it must be the app's own download endpoint rather than the storage URL,
 * so dragging cannot leak a signed or private link onto the desktop. Returns
 * null when there is nothing safe to advertise, and the caller then simply does
 * not set the type: an absent payload degrades to the Download button, which is
 * the documented fallback. Support is browser-dependent and never claimed here.
 */
export function buildDownloadUrlPayload(filename: string, absoluteUrl: string): string | null {
  const name = text(filename);
  const url = text(absoluteUrl);
  if (name === "" || url === "") return null;
  if (!/^https?:\/\//i.test(url)) return null;
  return `${dragMimeForName(name)}:${name}:${url}`;
}
