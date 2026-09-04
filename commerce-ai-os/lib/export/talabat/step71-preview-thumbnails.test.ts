// STEP 71 — the Talabat preview table shows a real product THUMBNAIL in the
// الصورة column instead of a bare filename.
//
// UI ONLY. These tests pin two things:
//   1. the DATA contract — every preview row already carries the resolved
//      primaryImageUrl (simple, variant-inherited, and missing), so the UI
//      needs no new query and no second image-resolution system;
//   2. the RENDER contract — the component reuses the shared ProductThumb and
//      keeps the filename and the shared-image warning visible.
//
// The runner uses --conditions=react-server, under which react-dom/server
// refuses to load, so a client component cannot be rendered to markup here.
// The JSX is therefore asserted by source scan — the same idiom the INT.2A/2B
// guards and STEP 60/62/64/68 suites already use in this repo.
//
// node --conditions=react-server --experimental-strip-types --test lib/export/talabat/step71-preview-thumbnails.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { buildTalabatPreview, type TalabatPreviewProduct } from "./preview.ts";

const HERE = join(fileURLToPath(new URL(".", import.meta.url)));
const APP_ROOT = join(HERE, "../../..");
const raw = (rel: string): string => readFileSync(join(APP_ROOT, rel), "utf8");
/** source with comments stripped — a comment mentioning a thing is not the thing. */
const code = (rel: string): string =>
  raw(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const COMPONENT = "components/v2/export/TalabatPreview.tsx";
const PAGE = "app/(v2)/v2/export/[destination]/page.tsx";
const THUMB = "components/ProductThumb.tsx";

const IMG = "https://cdn.test/product-images/mk1000.jpg";

function product(over: Partial<TalabatPreviewProduct> & { id: string; sku: string }): TalabatPreviewProduct {
  return {
    barcode: "1234567890123", nameEn: `EN ${over.sku}`, nameAr: `ع ${over.sku}`,
    price: 50, discountPrice: null, category: "Face Care", descriptionEn: "d", descriptionAr: "و",
    imageUrl: IMG, imageFilename: `${over.sku}.jpg`, galleryImageUrls: [], imageCount: 1,
    approved: true, lifecycleState: "ACTIVE", variants: [], ...over,
  };
}

// ── 1: a simple product row carries a thumbnail source ───────────────────────

test("1: a simple product row exposes the resolved primaryImageUrl", () => {
  const res = buildTalabatPreview({ products: [product({ id: "p1", sku: "mk1000" })] });
  assert.equal(res.rows.length, 1);
  const r = res.rows[0];
  assert.equal(r.isVariant, false);
  assert.equal(r.primaryImageUrl, IMG, "the URL the UI renders as a thumbnail");
  assert.equal(r.hasImage, true);
  assert.equal(r.imageExportName, "mk1000.jpg", "the filename stays available as secondary text");
});

// ── 2 & 3: variant rows ──────────────────────────────────────────────────────

test("2: a variant row carries an image URL (its own when one exists)", () => {
  // The row's primaryImageUrl is whatever the preview resolved for it — the UI
  // renders that value verbatim and never re-derives a source of its own.
  const res = buildTalabatPreview({
    products: [product({
      id: "p2", sku: "mk1001",
      variants: [{ id: "v1", sku: "mk1001-1-pink", barcode: "1234567890124", nameEn: "Pink", nameAr: "وردي", price: 60 }],
    })],
  });
  const v = res.rows.find((x) => x.isVariant)!;
  assert.ok(v, "a variant row exists");
  assert.equal(typeof v.primaryImageUrl, "string");
  assert.equal(v.primaryImageUrl, IMG);
  assert.equal(v.imageExportName, "mk1001-1-pink.jpg", "the variant keeps its OWN export filename");
});

test("3: an inherited-image variant renders the parent thumbnail, warning intact", () => {
  const res = buildTalabatPreview({
    products: [product({
      id: "p3", sku: "mk1002",
      variants: [{ id: "v1", sku: "mk1002-1-blue", barcode: "1234567890125", nameEn: "Blue", nameAr: "أزرق", price: 60 }],
    })],
  });
  const parent = res.rows.find((x) => !x.isVariant);
  const v = res.rows.find((x) => x.isVariant)!;
  assert.equal(parent, undefined, "a variant product emits NO parent row");
  assert.equal(v.inheritedParentImage, true);
  assert.equal(v.primaryImageUrl, IMG, "the inherited parent URL is what the thumbnail shows");
  // the warning the owner requires to stay accurate
  const shared = v.reasons.find((x) => x.code === "IMAGE_SHARED_FROM_PRODUCT")!;
  assert.ok(shared, "IMAGE_SHARED_FROM_PRODUCT is still raised");
  assert.equal(shared.blocking, false, "it is a warning, never a blocker");
  assert.equal(v.status, "WARNING");
});

// ── 4: missing image → fallback, never a broken row ──────────────────────────

test("4: a row with no image exposes a null URL and stays renderable", () => {
  const res = buildTalabatPreview({
    products: [product({ id: "p4", sku: "mk1003", imageUrl: null, imageFilename: null, imageCount: 0 })],
  });
  const r = res.rows[0];
  assert.equal(r.primaryImageUrl, null, "the UI falls back to the neutral badge");
  assert.equal(r.hasImage, false);
  assert.equal(r.sku, "mk1003", "the row still renders — a missing image never breaks it");
});

// ── 5: the component actually renders a thumbnail ───────────────────────────

test("5: the الصورة cell renders ProductThumb from primaryImageUrl", () => {
  const src = code(COMPONENT);
  assert.match(src, /import ProductThumb from "@\/components\/ProductThumb"/,
    "reuses the existing shared thumbnail helper — no parallel image system");
  assert.match(src, /<ProductThumb[\s\S]{0,240}imageUrl=\{r\.primaryImageUrl\}/,
    "the thumbnail is driven by the preview's own resolved URL");
  assert.match(src, /sizeClass="h-12 w-12"/, "48x48 square");
  // the old filename-only cell is gone
  assert.equal(
    /<div className="space-y-0\.5">\s*<div className="font-mono text-\[10px\] text-muted" dir="ltr">\{r\.imageExportName/.test(src),
    false,
    "the filename-only cell no longer stands alone",
  );
});

test("6: the filename stays visible and the shared-image warning is preserved", () => {
  const src = code(COMPONENT);
  assert.match(src, /\{r\.imageExportName \?\? "—"\}/, "filename still rendered as secondary text");
  assert.match(src, /title=\{r\.imageExportName \?\? undefined\}/, "and reachable as a tooltip");
  assert.match(src, /موروثة من المنتج الأب/, "the inherited-image note survives");
  // the reason label the owner pinned must remain in the legend map
  assert.match(raw(COMPONENT), /IMAGE_SHARED_FROM_PRODUCT: "الصورة مشتركة من المنتج"/);
  assert.match(src, /\{r\.hasImage \? \(/, "the cell still branches on hasImage");
  assert.match(src, /<span className="text-\[10px\] text-rose-600">مفقودة<\/span>/,
    "the missing-image state is still labelled");
  assert.match(src, /label=\{r\.hasImage \? "تعذّر التحميل" : "بدون صورة"\}/,
    "the placeholder distinguishes a failed load from a genuinely absent image");
});

test("7: ProductThumb supplies lazy loading, rounding, border and a fallback", () => {
  const t = code(THUMB);
  assert.match(t, /loading="lazy"/, "no eager load of 1454 images");
  assert.match(t, /object-cover/);
  assert.match(t, /rounded-lg/);
  assert.match(t, /border/);
  assert.match(t, /onError=/, "a failed load degrades to the neutral badge");
});

// ── 8: the VM plumbing is display-only ──────────────────────────────────────

test("8: the server page passes the ALREADY-resolved URL — no new read", () => {
  const page = code(PAGE);
  assert.match(page, /primaryImageUrl: r\.primaryImageUrl/, "straight pass-through of the preview row field");
  // exactly one Talabat VM block gained the field
  assert.equal((page.match(/primaryImageUrl: r\.primaryImageUrl/g) ?? []).length, 1);
  // the page still performs exactly the one certified preview read it always did
  assert.equal((page.match(/loadTalabatPreview\(\)/g) ?? []).length, 1, "no extra image query was added");
  assert.equal(/from\(["']product_images["']\)/.test(page), false, "the UI never queries images itself");
  assert.equal(/from\(["']product_images["']\)/.test(code(COMPONENT)), false);
});

// ── 9: export logic is untouched ────────────────────────────────────────────

test("9: no export/package/barcode/category/price logic changed", () => {
  const comp = code(COMPONENT);
  // the presentational component still performs no I/O and no rule derivation
  for (const forbidden of ["createClient", "supabase", "fetch(", "resolveTalabatBarcode", "resolveTalabatCategory"]) {
    assert.equal(comp.includes(forbidden), false, `${forbidden} must not appear in the preview component`);
  }
  // the package row builder still emits the SKU-derived filename, not a URL
  const pkg = code("lib/export/talabat/package.ts");
  assert.match(pkg, /imageFilename,/);
  assert.equal(/primaryImageUrl/.test(pkg.split("planRowImages")[0] ?? ""), false);
  // price / barcode / category resolution in the preview is byte-unchanged
  const pv = code("lib/export/talabat/preview.ts");
  assert.match(pv, /resolveTalabatSellingPrice\(\{/, "STEP 72 — the shared price resolver");
  assert.match(pv, /const talabatBarcode = bcRes\.ok \? bcRes\.barcode : null/);
  assert.match(pv, /const talabatCategory = catRes\.ok \? catRes\.category : null/);
});
