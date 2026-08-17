// INT.2A — canonical export-image naming contract (PURE).
//
// Defines the naming RULES now; generates NO files. Rules (§9):
//   • primary image      → SKU.ext
//   • additional images  → SKU_2.ext, SKU_3.ext, …   (index starts at 2)
//   • sellable variants  → VARIANT_SKU.ext
//   • preserve the EXACT SKU (case preserved — NOT lowercased)
//   • sanitize only filesystem-invalid characters, deterministically
//   • never name by product title; never random
//
// NOTE: the legacy exporter helper (lib/talabat-diff.ts#imageFileFor) LOWERCASES
// the SKU. INT.2A deliberately preserves case per this spec; reconciling the
// legacy path is later-phase work, not INT.2A.

const DEFAULT_EXT = "jpg";

/** Deterministically strip a leading dot and lowercase an extension. */
export function normalizeExtension(ext: string | null | undefined): string {
  const raw = typeof ext === "string" ? ext.trim().replace(/^\.+/, "").toLowerCase() : "";
  return /^[a-z0-9]+$/.test(raw) ? raw : DEFAULT_EXT;
}

/** Extract a normalized extension from a URL/filename, defaulting to jpg. */
export function extensionFromUrl(url: string | null | undefined): string {
  if (typeof url !== "string") return DEFAULT_EXT;
  const clean = url.split(/[?#]/)[0] ?? "";
  const dot = clean.lastIndexOf(".");
  if (dot < 0 || dot === clean.length - 1) return DEFAULT_EXT;
  return normalizeExtension(clean.slice(dot + 1));
}

/**
 * Make a SKU filesystem-safe WITHOUT changing case or meaning: replace any char
 * outside [A-Za-z0-9._-] with "-", collapse runs, and trim leading/trailing
 * separators. Deterministic — same SKU always maps to the same safe token.
 */
export function sanitizeSkuForFilename(sku: string): string {
  return String(sku ?? "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
}

/** Primary image name: SKU.ext (exact SKU, sanitized only for the filesystem). */
export function primaryImageName(sku: string, ext?: string | null): string {
  return `${sanitizeSkuForFilename(sku)}.${normalizeExtension(ext)}`;
}

/**
 * Additional image name: SKU_2.ext, SKU_3.ext, … `position` is the 1-based image
 * position (1 = primary → returns the primary name; 2 = first additional, etc.).
 */
export function additionalImageName(sku: string, position: number, ext?: string | null): string {
  const p = Number.isFinite(position) ? Math.max(1, Math.floor(position)) : 1;
  const base = sanitizeSkuForFilename(sku);
  const e = normalizeExtension(ext);
  return p <= 1 ? `${base}.${e}` : `${base}_${p}.${e}`;
}

/** Sellable-variant image name: VARIANT_SKU.ext (each sellable row owns its own). */
export function variantImageName(variantSku: string, ext?: string | null): string {
  return `${sanitizeSkuForFilename(variantSku)}.${normalizeExtension(ext)}`;
}

/**
 * The full ordered image-package name list for one SKU with `count` images:
 * [SKU.ext, SKU_2.ext, …, SKU_<count>.ext]. count<=0 ⇒ empty list.
 */
export function imagePackageNames(sku: string, count: number, ext?: string | null): string[] {
  const n = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
  const names: string[] = [];
  for (let position = 1; position <= n; position++) names.push(additionalImageName(sku, position, ext));
  return names;
}
