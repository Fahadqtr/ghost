// INT.2C — shared export-package CORE (PURE).
//
// Channel-agnostic building blocks reused by outbound file-package adapters
// (Snoonu here; Talabat has its own copy predating this module). It performs NO
// I/O: no xlsx serialization, no zip, no fetch, no DB. It only decides cell
// safety, image content type, and XLSX↔archive referential integrity. Keeping
// these here means the two Snoonu storefronts share ONE implementation and one
// template contract — never a second, divergent one. Framework-free so node:test
// loads it directly.

/** One AoA cell: a string (text) or a number (price/quantity). */
export type AoaCell = string | number;

/** Bounded, server-side generation limits (§ performance). */
export const PACKAGE_LIMITS = {
  maxRows: 5000,
  maxGalleryPerRow: 8,
  maxImageBytes: 15 * 1024 * 1024,
} as const;

/**
 * Guard a spreadsheet TEXT cell against formula/command injection: a value that
 * begins with = + - @ (or a tab/CR that Excel treats as a formula lead-in) is
 * prefixed with a single apostrophe so it renders as literal text. Numeric cells
 * are never passed through here, so legitimate numbers are untouched.
 */
export function sanitizeSpreadsheetText(value: string | null | undefined): string {
  const v = value == null ? "" : String(value);
  if (v === "") return "";
  return /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
}

// ── image content sniffing (§ actual content is an image) ─────────────────────

/** Sniff a real image type from leading magic bytes; null when not an image. */
export function sniffImageExtension(bytes: Uint8Array | null | undefined): string | null {
  if (!bytes || bytes.length < 12) return null;
  const b = bytes;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpg"; // JPEG
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "png"; // PNG
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return "gif"; // GIF8
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "webp"; // RIFF..WEBP
  if (b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) { // ISO-BMFF ftyp
    const brand = String.fromCharCode(b[8], b[9], b[10], b[11]).toLowerCase();
    if (brand.startsWith("avif") || brand.startsWith("avis")) return "avif";
    if (brand.startsWith("heic") || brand.startsWith("heif") || brand.startsWith("mif1")) return "heic";
  }
  return null;
}

/** Map an image content-type to a canonical extension (null if unknown). */
export function mimeToExt(contentType: string | null | undefined): string | null {
  const ct = String(contentType ?? "").toLowerCase().split(";")[0].trim();
  switch (ct) {
    case "image/jpeg": return "jpg";
    case "image/png": return "png";
    case "image/webp": return "webp";
    case "image/gif": return "gif";
    case "image/avif": return "avif";
    default: return null;
  }
}

/** Extract a normalized extension from a URL/filename, defaulting to jpg. */
export function extensionFromUrl(url: string | null | undefined): string {
  if (typeof url !== "string") return "jpg";
  const clean = url.split(/[?#]/)[0] ?? "";
  const dot = clean.lastIndexOf(".");
  if (dot < 0 || dot === clean.length - 1) return "jpg";
  const raw = clean.slice(dot + 1).toLowerCase();
  return /^[a-z0-9]+$/.test(raw) ? raw : "jpg";
}

/** The extension a packaged image should use: validated MIME first, else the URL. */
export function resolvePackagedExtension(sourceUrl: string, contentType: string | null): string {
  return mimeToExt(contentType) ?? extensionFromUrl(sourceUrl);
}

// ── XLSX ↔ archive referential integrity (deterministic, pre-finalization) ────

export interface PackagedFile {
  name: string;
  kind: "primary" | "gallery";
  /** for gallery files: the primary filename they belong to. */
  ownerPrimary?: string;
}

export interface IntegrityResult {
  ok: boolean;
  /** rows whose primary image is NOT present in the archive. */
  missingForRows: string[];
  /** packaged primary images with NO corresponding row. */
  orphanPrimaries: string[];
  /** packaged gallery images whose owning primary has NO row. */
  orphanGallery: string[];
}

/**
 * Every row's primary reference must resolve to a packaged primary; no packaged
 * primary may lack a row; every gallery file must belong to a primary that has a
 * row. Run BEFORE the archive is finalized.
 */
export function checkReferentialIntegrity(
  rowImageRefs: readonly string[],
  packaged: readonly PackagedFile[],
): IntegrityResult {
  const refs = new Set(rowImageRefs);
  const packagedPrimaries = new Set(packaged.filter((p) => p.kind === "primary").map((p) => p.name));
  const missingForRows = [...refs].filter((r) => !packagedPrimaries.has(r)).sort();
  const orphanPrimaries = packaged.filter((p) => p.kind === "primary" && !refs.has(p.name)).map((p) => p.name).sort();
  const orphanGallery = packaged.filter((p) => p.kind === "gallery" && (!p.ownerPrimary || !refs.has(p.ownerPrimary))).map((p) => p.name).sort();
  return {
    ok: missingForRows.length === 0 && orphanPrimaries.length === 0 && orphanGallery.length === 0,
    missingForRows,
    orphanPrimaries,
    orphanGallery,
  };
}
