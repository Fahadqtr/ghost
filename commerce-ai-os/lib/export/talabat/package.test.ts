// INT.2B.2 — Talabat package PLAN tests (pure).
// node --conditions=react-server --experimental-strip-types --test lib/export/talabat/package.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { buildTalabatPreview, type TalabatPreviewProduct, type TalabatPreviewRow } from "./preview.ts";
import {
  resolveGenerationSet,
  planRowImages,
  toPackageRow,
  buildTalabatXlsxAoa,
  sanitizeSpreadsheetText,
  checkReferentialIntegrity,
  buildManifest,
  previewGenerationPlan,
  previewRowKey,
  sniffImageExtension,
  mimeToExt,
  resolvePackagedExtension,
  primaryFilenameFor,
  TALABAT_PACKAGE_COLUMNS,
  type PackagedFile,
} from "./package.ts";
import { TALABAT_HEADERS } from "../../talabat/export.ts";

// ── fixtures ────────────────────────────────────────────────────────────────
const IMG = (n: string) => `https://cdn.example.com/${n}`;

function simpleProduct(over: Partial<TalabatPreviewProduct> = {}): TalabatPreviewProduct {
  return {
    id: "p-simple",
    sku: "mk1234",
    barcode: "6291041500213",
    nameEn: "Vitamin C Serum",
    nameAr: "سيروم فيتامين سي",
    price: 75,
    discountPrice: 65,
    category: "Korean Skincare",
    descriptionEn: "Bright skin.",
    descriptionAr: "بشرة مشرقة.",
    imageUrl: IMG("mk1234.jpg"),
    imageFilename: null,
    galleryImageUrls: [IMG("mk1234-2.png")],
    imageCount: 2,
    approved: true,
    variants: [],
    ...over,
  };
}

function variantProduct(over: Partial<TalabatPreviewProduct> = {}): TalabatPreviewProduct {
  return {
    id: "p-lip",
    sku: "lt",
    barcode: null,
    nameEn: "Lip Tint",
    nameAr: "صبغة شفاه",
    price: 65,
    discountPrice: null,
    category: "Makeup",
    descriptionEn: "Long lasting.",
    descriptionAr: "يدوم طويلاً.",
    imageUrl: IMG("lt.jpg"),
    imageFilename: null,
    galleryImageUrls: [],
    imageCount: 1,
    approved: true,
    variants: [
      { id: "v-red", sku: "lt-red", barcode: "2000000000019", nameEn: "Red", nameAr: "أحمر", price: 65 },
      { id: "v-pink", sku: "lt-pink", barcode: "2000000000026", nameEn: "Pink", nameAr: "وردي", price: 65 },
      { id: "v-nude", sku: "lt-nude", barcode: "2000000000033", nameEn: "Nude", nameAr: "عاري", price: 65 },
    ],
    ...over,
  };
}

const rows = (products: TalabatPreviewProduct[]): TalabatPreviewRow[] => buildTalabatPreview({ products }).rows;

// ── §19 simple product → exactly one row, SKU.jpg ─────────────────────────────
test("simple product → exactly one exportable row named by its SKU", () => {
  const r = rows([simpleProduct()]);
  assert.equal(r.length, 1);
  assert.equal(r[0].isVariant, false);
  const plan = planRowImages(r[0]);
  assert.equal(plan.primary?.filename, "mk1234.jpg");
  // additional (gallery) image uses SKU_2 with its own extension
  assert.deepEqual(plan.gallery.map((g) => g.filename), ["mk1234_2.png"]);
});

// ── §19 variant product → one row per variant, NO parent row, variant SKU image ─
test("variant product → 3 rows, zero parent row, each image named by the VARIANT SKU", () => {
  const r = rows([variantProduct()]);
  assert.equal(r.length, 3, "exactly 3 rows, never 4");
  assert.ok(r.every((x) => x.isVariant), "no parent row");
  const names = r.map((x) => planRowImages(x).primary?.filename);
  assert.deepEqual(names, ["lt-red.jpg", "lt-pink.jpg", "lt-nude.jpg"]);
  // a variant never inherits a gallery (primary only — documented INT.2B behavior)
  assert.ok(r.every((x) => planRowImages(x).gallery.length === 0));
  // titles fold the option into identity (RED/PINK/NUDE) — never a parent-only row
  assert.deepEqual(r.map((x) => x.title), ["Lip Tint — Red", "Lip Tint — Pink", "Lip Tint — Nude"]);
});

// ── §20 ready-only subset: a blocked variant is excluded, never sibling-imaged ─
test("2 ready + 1 blocked variant → package includes exactly 2 rows / 2 primary images", () => {
  // one variant is blocked (missing its own barcode) — a per-variant block.
  const p = variantProduct();
  const blocked = { ...p, variants: [p.variants[0], p.variants[1], { ...p.variants[2], barcode: null }] };
  const all = rows([blocked]);
  const set = resolveGenerationSet(all, { mode: "ready" });
  assert.equal(set.included.length, 2, "only the 2 ready variants are included");
  assert.equal(set.excludedBlocked.length, 1, "the blocked variant is excluded");
  const filenames = set.included.map((x) => planRowImages(x).primary?.filename);
  assert.deepEqual(filenames, ["lt-red.jpg", "lt-pink.jpg"]);
  assert.equal(filenames.includes("lt-nude.jpg"), false, "blocked variant is not represented by a sibling image");
});

// ── a product with NO image → all its variants blocked (MISSING_IMAGE), excluded ─
test("missing product image blocks every sellable row and none are packaged", () => {
  const p = variantProduct({ imageUrl: null, imageFilename: null, imageCount: 0, galleryImageUrls: [] });
  const all = rows([p]);
  assert.ok(all.every((x) => x.status === "BLOCKED"));
  const set = resolveGenerationSet(all, { mode: "ready" });
  assert.equal(set.included.length, 0);
  assert.equal(set.excludedBlocked.length, 3);
});

// ── BLOCKED rows can never be included, even when explicitly selected ──────────
test("selected mode never leaks a blocked row", () => {
  const p = variantProduct();
  const blocked = { ...p, variants: [p.variants[0], { ...p.variants[1], sku: null }] };
  const all = rows([blocked]);
  const blockedKey = previewRowKey(all.find((x) => x.status === "BLOCKED")!);
  const readyKey = previewRowKey(all.find((x) => x.status === "READY")!);
  const set = resolveGenerationSet(all, { mode: "selected", selectedKeys: [blockedKey, readyKey] });
  assert.equal(set.included.length, 1, "only the ready selected row is included");
  assert.equal(previewRowKey(set.included[0]), readyKey);
  assert.equal(set.excludedBlocked.length, 1);
});

// ── XLSX columns REUSE the certified Talabat template exactly ──────────────────
test("the package columns are the certified Talabat template columns", () => {
  assert.deepEqual([...TALABAT_PACKAGE_COLUMNS], [...TALABAT_HEADERS]);
  const aoa = buildTalabatXlsxAoa([toPackageRow(rows([simpleProduct()])[0], "mk1234.jpg")]);
  assert.deepEqual(aoa[0], [...TALABAT_HEADERS], "header row = canonical template");
});

// ── AoA cell mapping: SKU/barcode/filename text, price numeric, image match ───
test("AoA maps identity to text cells, price to a number, and the exact image filename", () => {
  const r = rows([simpleProduct()])[0];
  const aoa = buildTalabatXlsxAoa([toPackageRow(r, "mk1234.jpg")]);
  const row = aoa[1];
  assert.equal(row[0], "mk1234"); // SKU (string)
  assert.equal(row[1], "6291041500213"); // barcode (string, not scientific)
  assert.equal(typeof row[2], "number"); // price numeric
  assert.equal(row[2], 65); // discount-aware effective price
  assert.equal(row[4], "Vitamin C Serum");
  assert.equal(row[9], "mk1234.jpg"); // image filename matches the packaged file
});

// ── §14 formula-injection sanitization (text only; numbers untouched) ─────────
test("spreadsheet text starting with = + - @ is neutralized; numbers are not", () => {
  assert.equal(sanitizeSpreadsheetText("=SUM(A1:A9)"), "'=SUM(A1:A9)");
  assert.equal(sanitizeSpreadsheetText("+1"), "'+1");
  assert.equal(sanitizeSpreadsheetText("-2"), "'-2");
  assert.equal(sanitizeSpreadsheetText("@cmd"), "'@cmd");
  assert.equal(sanitizeSpreadsheetText("\t=1"), "'\t=1");
  assert.equal(sanitizeSpreadsheetText("Normal name"), "Normal name");
  assert.equal(sanitizeSpreadsheetText(""), "");
  // a malicious catalog name in the AoA is neutralized in the text column
  const r = rows([simpleProduct({ nameEn: "=HYPERLINK(\"http://x\")" })])[0];
  const aoa = buildTalabatXlsxAoa([toPackageRow(r, "mk1234.jpg")]);
  assert.equal(aoa[1][4], "'=HYPERLINK(\"http://x\")");
});

// ── §15 path-traversal SKU is sanitized in the packaged filename ──────────────
test("a path-traversal SKU is sanitized to a safe, recognizable filename", () => {
  const r = rows([simpleProduct({ sku: "../../etc/passwd" })])[0];
  const plan = planRowImages(r);
  const name = plan.primary?.filename ?? "";
  assert.equal(/[\\/]|\.\./.test(name), false, "no slashes or .. in the filename");
  assert.ok(name.endsWith(".jpg"));
});

// ── §8 referential integrity: rows ↔ packaged files ───────────────────────────
test("integrity passes when every row's primary is packaged and there are no orphans", () => {
  const packaged: PackagedFile[] = [
    { name: "mk1234.jpg", kind: "primary" },
    { name: "mk1234_2.png", kind: "gallery", ownerPrimary: "mk1234.jpg" },
  ];
  const res = checkReferentialIntegrity(["mk1234.jpg"], packaged);
  assert.equal(res.ok, true);
});

test("integrity fails on a row with a missing image and on an orphan primary/gallery", () => {
  const missing = checkReferentialIntegrity(["mk1.jpg"], []);
  assert.equal(missing.ok, false);
  assert.deepEqual(missing.missingForRows, ["mk1.jpg"]);

  const orphanP = checkReferentialIntegrity([], [{ name: "orphan.jpg", kind: "primary" }]);
  assert.deepEqual(orphanP.orphanPrimaries, ["orphan.jpg"]);

  const orphanG = checkReferentialIntegrity(
    ["a.jpg"],
    [{ name: "a.jpg", kind: "primary" }, { name: "b_2.jpg", kind: "gallery", ownerPrimary: "b.jpg" }],
  );
  assert.equal(orphanG.ok, false);
  assert.deepEqual(orphanG.orphanGallery, ["b_2.jpg"]);
});

// ── §11 pre-generation plan counts ────────────────────────────────────────────
test("pre-generation plan reports products / simple / variant / ready / images", () => {
  const plan = previewGenerationPlan(rows([simpleProduct(), variantProduct()]), { mode: "ready" });
  assert.equal(plan.products, 2);
  assert.equal(plan.sellableRows, 4); // 1 simple + 3 variants
  assert.equal(plan.simpleProducts, 1);
  assert.equal(plan.variantRows, 3);
  assert.equal(plan.ready, 4);
  assert.equal(plan.blocked, 0);
  assert.equal(plan.rowsIncluded, 4);
  // images expected = 1 (simple primary) + 1 (simple gallery) + 3 (variant primaries)
  assert.equal(plan.imagesExpected, 5);
});

test("pre-generation plan groups blocker reasons for excluded rows", () => {
  const p = variantProduct();
  const blocked = { ...p, variants: [p.variants[0], { ...p.variants[1], barcode: null }, { ...p.variants[2], sku: null }] };
  const plan = previewGenerationPlan(rows([blocked]), { mode: "ready" });
  assert.equal(plan.blocked, 2);
  assert.equal(plan.blockersByReason.MISSING_BARCODE, 1);
  assert.equal((plan.blockersByReason.MISSING_SKU ?? 0) >= 1, true);
});

// ── image content sniff + extension resolution (§7) ───────────────────────────
test("sniffImageExtension recognizes real image magic bytes and rejects non-images", () => {
  assert.equal(sniffImageExtension(new Uint8Array([0xff, 0xd8, 0xff, 0, 0, 0, 0, 0, 0, 0, 0, 0])), "jpg");
  assert.equal(sniffImageExtension(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])), "png");
  const webp = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
  assert.equal(sniffImageExtension(webp), "webp");
  assert.equal(sniffImageExtension(new TextEncoder().encode("<html>not an image")), null);
  assert.equal(sniffImageExtension(new Uint8Array(3)), null);
});

test("packaged extension prefers a validated MIME, else the URL", () => {
  assert.equal(mimeToExt("image/jpeg"), "jpg");
  assert.equal(mimeToExt("application/octet-stream"), null);
  assert.equal(resolvePackagedExtension(IMG("x.png"), "image/webp"), "webp");
  assert.equal(resolvePackagedExtension(IMG("x.png"), null), "png");
  assert.equal(primaryFilenameFor({ sku: "lt-red", isVariant: true }, "webp"), "lt-red.webp");
});

// ── §12 manifest carries counts + provenance, no secrets ──────────────────────
test("manifest carries counts and provenance and no credentials", () => {
  const m = buildManifest({
    destination: "talabat:malikas",
    generatedAt: "2026-08-17T09:00:00.000Z",
    actor: "owner@example.com",
    simpleProductCount: 1,
    variantRowCount: 3,
    sellableRowCount: 4,
    imageCount: 5,
    warningCount: 0,
    excludedBlockedCount: 2,
    outputFilename: "talabat-export-2026-08-17T09-00-00Z.zip",
    previewReference: { sellable_row_count: 6 },
  });
  assert.equal(m.destination, "talabat:malikas");
  assert.equal(m.sellable_row_count, 4);
  assert.equal(m.excluded_blocked_count, 2);
  const json = JSON.stringify(m).toLowerCase();
  for (const secret of ["service_role", "supabase_", "authorization", "bearer ", "password", "secret"]) {
    assert.equal(json.includes(secret), false, `manifest must not contain ${secret}`);
  }
});
