// OPS.2 — Media Center core unit tests (pure). Health, duplicate detection,
// dashboard, missing queue, filters, search, url normalization.
// node --conditions=react-server --experimental-strip-types --test lib/operations/media/media-core.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import {
  baseUrl,
  normName,
  mediaStatus,
  computeMediaHealth,
  mediaHealthTone,
  detectDuplicates,
  duplicateProductIds,
  buildMediaDashboard,
  buildMissingQueue,
  applyMediaFilter,
  searchRows,
  MEDIA_ROUTES,
  type MediaProductRow,
  type GalleryImageRow,
} from "./media-core.ts";

const row = (id: string, over: Partial<MediaProductRow> = {}): MediaProductRow => ({
  productId: id, sku: id, nameEn: id.toUpperCase(), nameAr: null, brandId: "b1", category: "Makeup",
  imageUrl: `https://cdn/${id}.jpg?t=1`, imageFilename: `${id}.jpg`, galleryCount: 1, ...over,
});

// ── url/name normalization ───────────────────────────────────────────────────
test("baseUrl strips cache-bust query + lowercases; normName trims/lowercases", () => {
  assert.equal(baseUrl("https://X/a.JPG?t=999"), "https://x/a.jpg");
  assert.equal(baseUrl(""), null);
  assert.equal(baseUrl(null), null);
  assert.equal(normName("  MK1.JPG "), "mk1.jpg");
  assert.equal(normName(""), null);
});

// ── media status + health ────────────────────────────────────────────────────
test("mediaStatus: missing / duplicate / has_primary", () => {
  assert.equal(mediaStatus(row("p", { imageUrl: null }), false), "MISSING");
  assert.equal(mediaStatus(row("p"), true), "DUPLICATE");
  assert.equal(mediaStatus(row("p"), false), "HAS_PRIMARY");
});

test("media health scoring: primary 60, gallery 25, no-duplicate 15", () => {
  assert.equal(computeMediaHealth(row("p", { imageUrl: null, galleryCount: 0 }), false).score, 15); // only no-dup
  assert.equal(computeMediaHealth(row("p", { galleryCount: 1 }), false).score, 75); // primary + nodup
  assert.equal(computeMediaHealth(row("p", { galleryCount: 2 }), false).score, 100); // all
  assert.equal(computeMediaHealth(row("p", { galleryCount: 2 }), true).score, 85); // dup loses 15
  assert.equal(mediaHealthTone(100), "good");
  assert.equal(mediaHealthTone(75), "warn");
  assert.equal(mediaHealthTone(15), "bad");
});

// ── duplicate detection ──────────────────────────────────────────────────────
test("detectDuplicates: cross-product url + filename, and same-product gallery url", () => {
  const rows = [
    row("p1", { imageUrl: "https://cdn/dup.jpg?t=1", imageFilename: "dup.jpg" }),
    row("p2", { imageUrl: "https://cdn/dup.jpg?t=2", imageFilename: "dup.jpg" }),
    row("p3", { imageUrl: "https://cdn/unique.jpg", imageFilename: "unique.jpg" }),
  ];
  const gallery: GalleryImageRow[] = [
    { productId: "p3", url: "https://cdn/g.jpg?t=1", filename: "g.jpg" },
    { productId: "p3", url: "https://cdn/g.jpg?t=5", filename: "g.jpg" },
  ];
  const groups = detectDuplicates(rows, gallery);
  assert.ok(groups.some((g) => g.kind === "cross_product_url" && g.value === "https://cdn/dup.jpg" && g.productIds.join() === "p1,p2"));
  assert.ok(groups.some((g) => g.kind === "cross_product_filename" && g.value === "dup.jpg"));
  assert.ok(groups.some((g) => g.kind === "same_product_url" && g.productIds.join() === "p3"));
  const dupIds = duplicateProductIds(groups);
  // same-product url is NOT a cross-product membership
  assert.ok(dupIds.has("p1") && dupIds.has("p2"));
  assert.equal(dupIds.has("p3"), false);
});

test("no false duplicates for distinct images", () => {
  const rows = [row("p1"), row("p2"), row("p3")];
  assert.equal(detectDuplicates(rows, []).length, 0);
});

// ── dashboard ────────────────────────────────────────────────────────────────
test("dashboard counts missing / multiple / duplicates + average health; deferred cards are null", () => {
  const rows = [
    row("p1", { galleryCount: 3 }),
    row("p2", { imageUrl: null, imageFilename: null, galleryCount: 0 }),
    row("p3", { imageUrl: "https://cdn/dup.jpg", imageFilename: "dup.jpg" }),
    row("p4", { imageUrl: "https://cdn/dup.jpg?t=2", imageFilename: "dup.jpg" }),
  ];
  const groups = detectDuplicates(rows, []);
  const dash = buildMediaDashboard(rows, groups);
  const by = Object.fromEntries(dash.cards.map((c) => [c.key, c.value]));
  assert.equal(by.products, 4);
  assert.equal(by.missing, 1);
  assert.equal(by.multiple, 1); // only p1 has galleryCount > 1
  assert.equal(by.duplicates, 2); // p3 + p4
  assert.equal(by.low_resolution, null); // deferred
  assert.equal(by.broken, null); // deferred
  assert.equal(by.recovered_shopify, null);
  assert.equal(dash.totals.withPrimary, 3);
  assert.ok(dash.totals.averageHealth > 0 && dash.totals.averageHealth <= 100);
  // every card links to a real route
  for (const c of dash.cards) assert.ok(c.href.startsWith("/"), `${c.key} has an href`);
});

// ── missing queue ────────────────────────────────────────────────────────────
test("missing queue lists only products without a primary image; default action is UPLOAD", () => {
  const rows = [row("p1"), row("p2", { imageUrl: null }), row("p3", { imageUrl: null })];
  const q = buildMissingQueue(rows);
  assert.deepEqual(q.map((i) => i.productId), ["p2", "p3"]);
  assert.ok(q.every((i) => i.suggestedAction === "UPLOAD"));
});

// ── filters + search ─────────────────────────────────────────────────────────
test("filters: missing / has_primary / multiple / duplicate preserve row subtype", () => {
  const rows = [
    { ...row("p1", { galleryCount: 2 }), isDuplicate: false, healthScore: 100 },
    { ...row("p2", { imageUrl: null, galleryCount: 0 }), isDuplicate: false, healthScore: 15 },
    { ...row("p3"), isDuplicate: true, healthScore: 85 },
  ];
  const dupIds = new Set(["p3"]);
  assert.deepEqual(applyMediaFilter(rows, "missing", dupIds).map((r) => r.productId), ["p2"]);
  assert.deepEqual(applyMediaFilter(rows, "has_primary", dupIds).map((r) => r.productId), ["p1", "p3"]);
  assert.deepEqual(applyMediaFilter(rows, "multiple", dupIds).map((r) => r.productId), ["p1"]);
  assert.deepEqual(applyMediaFilter(rows, "duplicate", dupIds).map((r) => r.productId), ["p3"]);
  // subtype preserved (healthScore accessible)
  assert.equal(applyMediaFilter(rows, "all", dupIds)[0].healthScore, 100);
});

test("search matches sku / name / brand / category", () => {
  const rows = [row("mk1", { nameEn: "Serum", brandId: "cosrx", category: "Skincare" }), row("mk2", { nameEn: "Lipstick", brandId: "mac", category: "Makeup" })];
  assert.deepEqual(searchRows(rows, "cosrx").map((r) => r.sku), ["mk1"]);
  assert.deepEqual(searchRows(rows, "makeup").map((r) => r.sku), ["mk2"]);
  assert.deepEqual(searchRows(rows, "lip").map((r) => r.sku), ["mk2"]);
  assert.equal(searchRows(rows, "").length, 2);
});

test("MEDIA_ROUTES point at existing routes only", () => {
  assert.equal(MEDIA_ROUTES.media, "/v2/operations/media");
  assert.ok(MEDIA_ROUTES.imageHealth.startsWith("/"));
});
