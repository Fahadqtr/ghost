// STAFF COPY PANEL — owner proofs.
//
// The panel's promise is narrow and total: it copies canonical values without
// changing them, it never lets one product's photo into another's archive, it
// never mixes a variant's identity with its parent's, and it writes nothing.
// Each test below pins one of those.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  buildCopyAllText,
  buildCopyFields,
  buildDownloadUrlPayload,
  buildVariantCopyAllText,
  buildVariantFields,
  dragMimeForName,
  imagesZipFilename,
  planProductImageZip,
  productImageZipName,
  variantImageZipName,
  type CopyPanelImage,
  type CopyPanelProduct,
  type CopyPanelVariant,
} from "./copy-panel.ts";
import { toCopyPanelData } from "./copy-panel-read.server.ts";

const code = (rel: string): string =>
  readFileSync(new URL(rel, import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const PANEL = "../../../components/v2/catalog/CopyProductPanel.tsx";
const ROUTE = "../../../app/api/catalog/copy-panel/images/route.ts";
const READ = "./copy-panel-read.server.ts";
const PAGE = "../../../app/(v2)/v2/catalog/[id]/page.tsx";

const product = (over: Partial<CopyPanelProduct> = {}): CopyPanelProduct => ({
  sku: "mk900", barcode: "9237730615193",
  nameEn: "Seemsure Dark Spot Corrector Brightening Serum - 50ml",
  nameAr: "سيمشور سيروم مصحح البقع الداكنة",
  price: 45, discountPrice: null,
  category: "Face Care", subCategory: null, brand: "Seemsure", size: "50ml", color: null,
  descriptionEn: "A lightweight brightening formula.\nSecond line.",
  descriptionAr: "سيروم تفتيح خفيف.",
  ...over,
});

const variant = (over: Partial<CopyPanelVariant> = {}): CopyPanelVariant => ({
  id: "v1", optionNameAr: "وردي", optionNameEn: "Pink", sku: "mk900-pink",
  barcode: "111", price: 50, color: "Pink", size: null, imageUrl: null, ...over,
});

const img = (url: string, isPrimary = false): CopyPanelImage => ({ url, filename: null, isPrimary });

// ── 1. the panel opens for a product ─────────────────────────────────────────
test("1 · the detail page renders the panel, and the panel owns an open control", () => {
  const page = code(PAGE);
  assert.ok(page.includes("<CopyProductPanel"), "detail page mounts the panel");
  assert.ok(page.includes("نسخ بيانات المنتج") || code(PANEL).includes("نسخ بيانات المنتج"), "the Arabic label exists");
  const panel = code(PANEL);
  assert.ok(panel.includes('data-testid="open-copy-panel"'), "an open control exists");
  assert.ok(panel.includes('data-testid="copy-panel"'), "the drawer exists");
  assert.ok(panel.includes("useState"), "open/closed is real state, not a link");
});

// ── 2-7. every named field is copyable, verbatim ─────────────────────────────
test("2 · English title is projected verbatim", () => {
  const f = buildCopyFields(product()).find((x) => x.key === "name_en");
  assert.equal(f?.value, "Seemsure Dark Spot Corrector Brightening Serum - 50ml");
});

test("3 · Arabic title is projected verbatim", () => {
  const f = buildCopyFields(product()).find((x) => x.key === "name_ar");
  assert.equal(f?.value, "سيمشور سيروم مصحح البقع الداكنة");
});

test("4 · SKU is projected verbatim", () => {
  assert.equal(buildCopyFields(product()).find((x) => x.key === "sku")?.value, "mk900");
});

test("5 · barcode is projected verbatim — the canonical EAN, not the SKU", () => {
  const f = buildCopyFields(product());
  assert.equal(f.find((x) => x.key === "barcode")?.value, "9237730615193");
  assert.notEqual(f.find((x) => x.key === "barcode")?.value, f.find((x) => x.key === "sku")?.value);
});

test("6 · price copies as a bare number a marketplace form accepts", () => {
  assert.equal(buildCopyFields(product()).find((x) => x.key === "price")?.value, "45");
  assert.equal(buildCopyFields(product({ price: 0 })).find((x) => x.key === "price")?.value, "0");
});

test("7 · both descriptions are full text and flagged multiline, never truncated", () => {
  const f = buildCopyFields(product());
  const en = f.find((x) => x.key === "description_en");
  const ar = f.find((x) => x.key === "description_ar");
  assert.equal(en?.value, "A lightweight brightening formula.\nSecond line.");
  assert.equal(ar?.value, "سيروم تفتيح خفيف.");
  assert.equal(en?.multiline, true);
  assert.equal(ar?.multiline, true);
});

// ── 8. copy all ──────────────────────────────────────────────────────────────
test("8 · Copy All carries every visible field and no internal identifier", () => {
  const fields = buildCopyFields(product());
  const all = buildCopyAllText(fields);
  for (const f of fields) assert.ok(all.includes(f.value), `${f.key} present in the block`);
  assert.ok(all.includes("SKU: mk900"), "single-line fields are label: value");
  assert.ok(all.includes("الوصف بالإنجليزية:\nA lightweight"), "long text starts on its own line");
  // nothing internal can ride along: the projection has no id to leak
  assert.ok(!/[0-9a-f]{8}-[0-9a-f]{4}-/i.test(all), "no UUID in the copied block");
});

test("9 · empty fields are omitted rather than copied as blanks", () => {
  const fields = buildCopyFields(product({ brand: null, size: "", discountPrice: null, color: null }));
  assert.ok(!fields.some((f) => f.key === "brand"));
  assert.ok(!fields.some((f) => f.key === "size"));
  assert.ok(!fields.some((f) => f.key === "discount_price"));
  assert.ok(fields.every((f) => f.value !== ""));
});

// ── 10-11. image download + url copy ─────────────────────────────────────────
test("10 · main and gallery images each expose download and copy-url controls", () => {
  const panel = code(PANEL);
  assert.ok(panel.includes("تنزيل الصورة"), "download control");
  assert.ok(panel.includes("نسخ رابط الصورة"), "copy-url control");
  assert.ok(panel.includes("الصورة الرئيسية"), "primary section");
  assert.ok(panel.includes("صور إضافية"), "gallery section");
  assert.ok(panel.includes("/api/products/image?url="), "downloads go through the same-origin proxy");
});

test("11 · downloads never hand out the raw storage URL as the href", () => {
  const panel = code(PANEL);
  assert.ok(panel.includes("function proxyHref"), "one place builds the download href");
  assert.ok(panel.includes("dl=1"), "the proxy is asked for an attachment");
  assert.ok(!/href=\{(?:image|item)\.url\}/.test(panel), "no anchor points straight at the storage URL");
});

// ── 12. the ZIP is scoped to ONE product ─────────────────────────────────────
test("12 · the archive is planned from the product's own images only", () => {
  const plan = planProductImageZip("mk900", [img("https://x/a.jpg", true), img("https://x/b.png")]);
  assert.deepEqual(plan.map((p) => p.name), ["mk900-main.jpg", "mk900-01.png"]);
  assert.deepEqual(plan.map((p) => p.url), ["https://x/a.jpg", "https://x/b.png"]);
  assert.equal(imagesZipFilename("mk900"), "mk900-images.zip");
});

test("13 · the ZIP endpoint takes a product id and resolves URLs server-side", () => {
  const route = code(ROUTE);
  assert.ok(route.includes('searchParams.get("productId")'), "the request carries an id");
  assert.ok(!/searchParams\.get\("url"\)/.test(route), "it never accepts a caller-supplied image URL");
  assert.ok(route.includes("loadProductMedia"), "images come from that product's own rows");
  assert.ok(route.includes("safeFetchImage") && route.includes("safeImageUrlOrNull"), "every fetch is SSRF-guarded");
});

test("14 · duplicate URLs collapse and colliding names are suffixed, never overwritten", () => {
  const plan = planProductImageZip("mk900", [img("https://x/a.jpg", true), img("https://x/a.jpg"), img("https://x/b.jpg")]);
  assert.equal(plan.length, 2, "the same photo is not zipped twice");
  const names = planProductImageZip("mk1", [img("https://x/1.jpg", true)], [variant({ sku: null, imageUrl: "https://x/2.jpg" })]).map((p) => p.name);
  assert.equal(new Set(names).size, names.length, "names are unique");
});

// ── 15-17. variants keep their own identity ──────────────────────────────────
test("15 · variant fields stay attached to their own variant", () => {
  const a = buildVariantFields(variant({ sku: "mk900-pink", price: 50, optionNameAr: "وردي" }));
  const b = buildVariantFields(variant({ id: "v2", sku: "mk900-blue", price: 60, optionNameAr: "أزرق" }));
  assert.equal(a.find((f) => f.key === "variant_sku")?.value, "mk900-pink");
  assert.equal(b.find((f) => f.key === "variant_sku")?.value, "mk900-blue");
  assert.equal(a.find((f) => f.key === "variant_price")?.value, "50");
  assert.equal(b.find((f) => f.key === "variant_price")?.value, "60");
});

test("16 · a variant block never carries the parent's SKU or barcode", () => {
  const p = product();
  const all = buildVariantCopyAllText(variant(), buildVariantFields(variant()));
  assert.ok(!all.includes(String(p.barcode)), "parent barcode absent");
  assert.ok(all.includes("mk900-pink"), "its own sku present");
  assert.ok(!/\bSKU: mk900\b/.test(all), "parent sku line absent");
});

test("17 · a variant image is named by the variant, never as a parent photo", () => {
  assert.equal(variantImageZipName("mk900", "mk900-pink", 0, "jpg"), "mk900-variant-mk900-pink.jpg");
  assert.equal(variantImageZipName("mk900", null, 0, "png"), "mk900-variant-01.png");
  const plan = planProductImageZip("mk900", [img("https://x/a.jpg", true)], [variant({ imageUrl: "https://x/v.jpg" })]);
  assert.deepEqual(plan.map((p) => p.name), ["mk900-main.jpg", "mk900-variant-mk900-pink.jpg"]);
  assert.equal(plan.find((p) => p.kind === "variant")?.url, "https://x/v.jpg");
});

// ── 18-20. shapes: no variants · one image · many images ─────────────────────
test("18 · a product with no variants yields no variant rows and a clean plan", () => {
  assert.deepEqual(buildVariantFields(variant({ optionNameAr: null, optionNameEn: null, sku: null, barcode: null, price: null, color: null, size: null })), []);
  const plan = planProductImageZip("mk1", [img("https://x/a.jpg", true)], []);
  assert.equal(plan.length, 1);
  assert.equal(plan[0].kind, "primary");
});

test("19 · a single-image product names it -main, not -01", () => {
  const plan = planProductImageZip("mk1", [img("https://x/only.jpg", true)]);
  assert.deepEqual(plan.map((p) => p.name), ["mk1-main.jpg"]);
});

test("20 · a multi-image product numbers the extras deterministically from 01", () => {
  const plan = planProductImageZip("mk1", [img("https://x/a.jpg", true), img("https://x/b.jpg"), img("https://x/c.webp")]);
  assert.deepEqual(plan.map((p) => p.name), ["mk1-main.jpg", "mk1-01.jpg", "mk1-02.webp"]);
  assert.equal(productImageZipName("mk1", 9, "jpg"), "mk1-10.jpg");
});

// ── 21. drag metadata ────────────────────────────────────────────────────────
test("21 · drag advertises DownloadURL as mime:filename:absolute-url, or nothing", () => {
  assert.equal(buildDownloadUrlPayload("mk900-main.jpg", "https://app.test/api/products/image?url=x&dl=1"),
    "image/jpeg:mk900-main.jpg:https://app.test/api/products/image?url=x&dl=1");
  assert.equal(dragMimeForName("a.png"), "image/png");
  assert.equal(dragMimeForName("a.webp"), "image/webp");
  // a relative URL would produce a dead drop — refused, so the button is the fallback
  assert.equal(buildDownloadUrlPayload("a.jpg", "/api/products/image?url=x"), null);
  assert.equal(buildDownloadUrlPayload("", "https://app.test/x"), null);
  const panel = code(PANEL);
  assert.ok(panel.includes('setData("DownloadURL"'), "the drag type is set");
  assert.ok(panel.includes('setData("text/uri-list"'), "a standard fallback type is set");
  assert.ok(panel.includes("draggable"), "thumbnails are draggable");
});

// ── 22. the whole feature writes nothing ─────────────────────────────────────
test("22 · no write API is reachable from the feature", () => {
  for (const [label, src] of [["panel", code(PANEL)], ["route", code(ROUTE)], ["read", code(READ)]] as const) {
    assert.ok(!/\.(insert|update|upsert|delete)\s*\(/.test(src), `${label}: no mutating client call`);
    assert.ok(!/method:\s*["'](POST|PUT|PATCH|DELETE)["']/i.test(src), `${label}: no mutating fetch`);
    assert.ok(!/use server/.test(src), `${label}: no server action`);
  }
  const route = code(ROUTE);
  assert.ok(route.includes("export async function GET"), "the endpoint is GET");
  assert.ok(!/export async function (POST|PUT|PATCH|DELETE)/.test(route), "no mutating handler exists");
});

test("23 · the read selects no cost, stock, notes or platform column", () => {
  const read = code(READ);
  const cols = /const PRODUCT_COLUMNS =\s*([\s\S]*?);/.exec(read)?.[1] ?? "";
  assert.ok(cols.includes("description_en") && cols.includes("main_category"), "it does select what the panel copies");
  for (const forbidden of ["cost", "stock_quantity", "notes", "keywords_en", "platform_status", "approval"]) {
    assert.ok(!cols.includes(forbidden), `${forbidden} is not selected`);
  }
});

test("24 · the projection keeps variant ids out of every copyable string", () => {
  const data = toCopyPanelData(
    { sku: "mk900", name_en: "X", price: 45, description_en: "d" },
    [{ id: "0f13775a-0eca-2401-922f-43ecac4b062a", variant_name: "وردي", sku: "mk900-pink", price: 50 }],
    "Seemsure",
  );
  assert.equal(data.variants[0].id, "0f13775a-0eca-2401-922f-43ecac4b062a", "the id is kept for React keys");
  const all = buildVariantCopyAllText(data.variants[0], buildVariantFields(data.variants[0]));
  assert.ok(!all.includes("0f13775a"), "but it never reaches the clipboard");
  assert.equal(data.product.brand, "Seemsure", "brand comes from the lookup, not a product column");
});

test("25 · image extensions reuse the channel-packaging helpers, not a new implementation", () => {
  const pure = code("./copy-panel.ts");
  assert.ok(pure.includes('from "../../export/image-naming.ts"'), "names reuse the shared helpers");
  assert.ok(!/function\s+(normalizeExtension|extensionFromUrl)\b/.test(pure), "no duplicate normalizer is defined");
  const route = code(ROUTE);
  assert.ok(route.includes("sniffImageExtension"), "the route sniffs real bytes");
  assert.ok(route.includes("mimeToExt"), "and falls back to the validated MIME");
  assert.ok(route.includes('from "@/lib/net/zip"'), "the archive uses the shared tested ZIP writer");
});
