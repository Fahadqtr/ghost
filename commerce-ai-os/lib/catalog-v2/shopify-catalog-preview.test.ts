// Tests for the Shopify catalog mobile UX + product preview (Phase UI.3C.1):
// the duplicate-match wording, the client-safe preview projection, and source
// scans of the preview client component, the page component and the select
// styling. PURE tests only — no database, no network, no Shopify, no rendering.
//
// The .tsx files are verified by source scanning rather than by rendering:
// node's --experimental-strip-types cannot load .tsx at all, so this is the same
// approach the Phase UI.1/UI.2/UI.3C suites already use for V2 components. This
// file lives under lib/ so the existing "lib/**/*.test.ts" glob picks it up.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  SHOPIFY_FILTER_OPTIONS,
  SHOPIFY_SORT_OPTIONS,
  getMatchStatusLabel,
  getMatchStatusExplanation,
  getPreviewDisplayName,
  previewProductHref,
  toPreviewItem,
  toPreviewItems,
  type ShopifyCatalogRow,
} from "./shopify-catalog-view.ts";

function strip(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const PREVIEW_SRC = readFileSync(
  new URL("../../components/v2/catalog/ShopifyProductPreview.tsx", import.meta.url),
  "utf8",
);
const CATALOG_SRC = readFileSync(
  new URL("../../components/v2/catalog/ShopifyCatalog.tsx", import.meta.url),
  "utf8",
);
const CSS_SRC = readFileSync(new URL("../../app/globals.css", import.meta.url), "utf8");
// The dialog chrome + lightbox were extracted in UI.3C.1 so the Malikas catalog
// reuses the exact same approved behaviour; the guarantees are asserted there.
const SHELL_SRC = readFileSync(
  new URL("../../components/v2/catalog/CatalogPreviewDialog.tsx", import.meta.url),
  "utf8",
);

function row(over: Partial<ShopifyCatalogRow> = {}): ShopifyCatalogRow {
  return {
    masterProductId: "p1",
    masterVariantId: null,
    nameAr: "منتج",
    nameEn: "Product",
    sku: "MK-1",
    barcode: "BAR-1",
    imageUrl: "https://img/1.jpg",
    price: 10,
    shopifyProductId: "gid://shopify/Product/1",
    shopifyVariantId: "gid://shopify/ProductVariant/2",
    shopifyInventoryItemId: "gid://shopify/InventoryItem/3",
    shopifyStatus: "active",
    presenceStatus: "present",
    matchStatus: "matched_sku",
    matchReason: "unique SKU match",
    ...over,
  };
}

// ── 1. Duplicate-match wording ───────────────────────────────────────────────

test("ambiguous label reads مطابقة مكررة (the old wording is gone)", () => {
  assert.equal(getMatchStatusLabel("ambiguous"), "مطابقة مكررة");
  assert.ok(!CATALOG_SRC.includes("غير محدد (تكرار)"), "old wording removed from the page component");
  assert.ok(!PREVIEW_SRC.includes("غير محدد (تكرار)"), "old wording removed from the preview component");
});

test("ambiguous carries a fixed explanation; other states carry none", () => {
  assert.equal(
    getMatchStatusExplanation("ambiguous"),
    "يوجد أكثر من متغير في Shopify يحمل نفس SKU أو الباركود، لذلك تتطلب المطابقة مراجعة يدوية.",
  );
  for (const s of ["matched_sku", "matched_barcode", "unmatched", "unknown"] as const) {
    assert.equal(getMatchStatusExplanation(s), null, `${s} needs no explanation`);
  }
  // Prototype-safe and never throws on junk.
  assert.equal(getMatchStatusExplanation("__proto__" as never), null);
  assert.equal(getMatchStatusExplanation("toString" as never), null);
});

test("the explanation never embeds a raw matchReason, SKU, barcode or ID", () => {
  const text = getMatchStatusExplanation("ambiguous") as string;
  for (const banned of ["gid://", "matchReason", "MK-1", "BAR-1", "unique SKU match"]) {
    assert.ok(!text.includes(banned), `explanation must not contain ${banned}`);
  }
  // It is rendered from the helper, not from row data.
  assert.ok(/getMatchStatusExplanation\s*\(/.test(PREVIEW_SRC), "preview renders the fixed explanation helper");
  assert.ok(!/matchReason/.test(strip(PREVIEW_SRC)), "preview never touches matchReason");
});

// ── 2. Filter + sort options ─────────────────────────────────────────────────

test("all required status filter options are present, in order", () => {
  assert.deepEqual(
    SHOPIFY_FILTER_OPTIONS.map((o) => o.label),
    [
      "الكل",
      "موجود في Shopify",
      "غير موجود في Shopify",
      "مطابق بالـSKU",
      "مطابق بالباركود",
      "مطابقة مكررة",
      "غير معروف",
    ],
  );
  assert.deepEqual(
    SHOPIFY_FILTER_OPTIONS.map((o) => o.value),
    ["all", "present", "missing", "matched_sku", "matched_barcode", "ambiguous", "unknown"],
    "values are unchanged — only the labels were reworded",
  );
});

test("all required sort options are present", () => {
  assert.deepEqual(SHOPIFY_SORT_OPTIONS.map((o) => o.label), ["الاسم", "SKU", "الحالة"]);
  assert.deepEqual(SHOPIFY_SORT_OPTIONS.map((o) => o.value), ["name", "sku", "status"]);
});

test("both selects use the mobile-safe select styling, not the plain input class", () => {
  const selects = CATALOG_SRC.match(/<select[^>]*>/g) ?? [];
  assert.equal(selects.length, 2, "filter + sort selects");
  for (const s of selects) {
    assert.ok(/className="select-input"/.test(s), `select must use select-input: ${s}`);
    assert.ok(!/className="input"/.test(s), "select must not use the plain input class");
  }
});

test("select styling forces a light native popup with explicit option colours", () => {
  assert.ok(/@utility select-input/.test(CSS_SRC), "select-input utility exists");
  // The actual Android failure was a dark-mode popup inheriting dark text.
  assert.ok(/color-scheme:\s*light/.test(CSS_SRC), "pins the native popup to light mode");
  assert.ok(/\.select-input option\s*\{[^}]*background-color:\s*#ffffff/.test(CSS_SRC), "white option background");
  assert.ok(/\.select-input option\s*\{[^}]*color:\s*#3f2a1d/.test(CSS_SRC), "dark option text");
  // 16px on the control prevents mobile zoom-on-focus.
  assert.ok(/font-size:\s*16px/.test(CSS_SRC), "16px control text on mobile");
});

// ── 3. Preview replaces direct navigation ────────────────────────────────────

test("product rows and cards open the preview instead of navigating", () => {
  // Rows/cards are dialog triggers…
  assert.ok(/aria-haspopup="dialog"/.test(PREVIEW_SRC), "trigger announces a dialog");
  assert.ok(/onClick=\{\(e\) => open\(item\.key, e\.currentTarget\)\}/.test(PREVIEW_SRC), "click opens the preview");
  // …and are NOT links.
  const rowsBlock = PREVIEW_SRC.slice(
    PREVIEW_SRC.indexOf("Desktop table"),
    PREVIEW_SRC.indexOf("{active !== null"),
  );
  assert.ok(!/<Link/.test(rowsBlock), "no row/card is a Link — a tap must not navigate");
  // The only Link in the component is the explicit secondary action.
  assert.equal((PREVIEW_SRC.match(/<Link/g) ?? []).length, 1, "exactly one Link: فتح صفحة المنتج");
  assert.ok(PREVIEW_SRC.includes("فتح صفحة المنتج"), "secondary action present");
});

test("the secondary action links to the master product route by masterProductId", () => {
  assert.equal(previewProductHref(toPreviewItem(row({ masterProductId: "abc 1" }))), "/v2/catalog/abc%201");
  assert.ok(/previewProductHref\(item\)/.test(PREVIEW_SRC), "component uses the helper");
  assert.ok(!/\/v2\/catalog\/shopify\/\[/.test(PREVIEW_SRC), "no Shopify detail route");
});

test("preview shows exactly the catalog-safe fields", () => {
  for (const label of ["الاسم العربي", "الاسم الإنجليزي", "SKU", "الباركود", "السعر"]) {
    assert.ok(PREVIEW_SRC.includes(label), `preview field: ${label}`);
  }
  for (const badge of ["PresenceBadge", "MatchBadge", "ShopifyStatusBadge"]) {
    assert.ok(PREVIEW_SRC.includes(`<${badge} item={item} />`), `preview badge: ${badge}`);
  }
});

test("dialog has a close button, outside-click, Escape, scroll lock and focus handling", () => {
  assert.ok(/aria-label="إغلاق"/.test(SHELL_SRC), "explicit close button");
  assert.ok(/onClick=\{onClose\}/.test(SHELL_SRC), "backdrop click closes");
  assert.ok(/e\.stopPropagation\(\)/.test(SHELL_SRC), "clicks inside do not close");
  assert.ok(/e\.key !== "Escape"/.test(SHELL_SRC), "Escape handling");
  assert.ok(/if \(lightbox\) setLightbox\(false\);/.test(SHELL_SRC), "Escape closes the lightbox first");
  assert.ok(/document\.body\.style\.overflow = "hidden"/.test(SHELL_SRC), "background scroll locked");
  assert.ok(/closeRef\.current\?\.focus\(\)/.test(SHELL_SRC), "focus moves into the dialog");
  assert.ok(/role="dialog"/.test(SHELL_SRC) && /aria-modal="true"/.test(SHELL_SRC), "dialog semantics");
  assert.ok(/aria-labelledby=\{titleId\}/.test(SHELL_SRC), "dialog is labelled");
  // The Shopify side supplies the label id and restores focus to its own row.
  assert.ok(/titleId="shopify-preview-title"/.test(PREVIEW_SRC), "shopify dialog label id");
  assert.ok(/triggerRef\.current\?\.focus\(\)/.test(PREVIEW_SRC), "focus returns to the trigger");
});

test("preview is a bottom sheet on mobile and a centered modal on desktop", () => {
  assert.ok(/items-end justify-center[^"]*sm:items-center/.test(SHELL_SRC), "bottom on mobile, centered on desktop");
  assert.ok(/rounded-t-2xl[^"]*sm:rounded-2xl/.test(SHELL_SRC), "sheet corners on mobile");
});

// ── 4. Image lightbox ────────────────────────────────────────────────────────

test("tapping the image opens a fullscreen lightbox with zoom controls", () => {
  assert.ok(/setLightbox\(true\)/.test(SHELL_SRC), "image opens the lightbox");
  assert.ok(/aria-label="تكبير الصورة"/.test(SHELL_SRC), "image trigger is labelled");
  assert.ok(/aria-label="تكبير"/.test(SHELL_SRC) && /aria-label="تصغير"/.test(SHELL_SRC), "+ and − buttons");
  assert.ok(/aria-label="إعادة الحجم إلى 100%"/.test(SHELL_SRC), "reset to 100%");
  assert.ok(/aria-label="إغلاق الصورة"/.test(SHELL_SRC), "lightbox close button");
  assert.ok(/object-contain/.test(SHELL_SRC), "object-contain");
  assert.ok(/bg-black\/90/.test(SHELL_SRC), "dark backdrop");
});

test("lightbox zoom is bounded and the image cannot overflow a phone screen", () => {
  assert.ok(/const MAX_ZOOM = 4/.test(SHELL_SRC), "sane maximum zoom");
  assert.ok(/const MIN_ZOOM = 1/.test(SHELL_SRC), "minimum zoom");
  assert.ok(/Math\.min\(MAX_ZOOM/.test(SHELL_SRC) && /Math\.max\(MIN_ZOOM/.test(SHELL_SRC), "clamped");
  // A zoomed image is panned inside a scroll container instead of spilling out.
  assert.ok(/overflow-auto/.test(SHELL_SRC), "scrollable stage");
  assert.ok(/max-h-\[78vh\] max-w-full/.test(SHELL_SRC), "bounded to the viewport");
});

test("no image → placeholder, and the lightbox cannot be opened", () => {
  // The trigger button only exists when an image exists.
  assert.ok(/imageAvailable \?/.test(SHELL_SRC), "image trigger is conditional");
  assert.ok(/<ImagePlaceholder className="h-44 w-44" \/>/.test(SHELL_SRC), "placeholder otherwise");
  // Even if state were set, rendering is guarded by imageAvailable.
  assert.ok(/lightbox && imageAvailable \?/.test(SHELL_SRC), "lightbox render is image-guarded");
});

// ── 5. Nothing sensitive crosses into the client ─────────────────────────────

test("the preview projection drops every Shopify identifier", () => {
  const item = toPreviewItem(row());
  for (const banned of ["shopifyProductId", "shopifyVariantId", "shopifyInventoryItemId", "matchReason"]) {
    assert.equal(Object.hasOwn(item, banned), false, `preview item must not carry ${banned}`);
  }
  // Nothing in the serialized payload contains a GID.
  assert.ok(!JSON.stringify(item).includes("gid://"), "no GID reaches the client payload");
  // The display data it DOES carry is intact.
  assert.equal(item.sku, "MK-1");
  assert.equal(item.presenceStatus, "present");
  assert.equal(item.matchStatus, "matched_sku");
  assert.equal(item.shopifyStatus, "active");
  assert.equal(item.masterProductId, "p1");
});

test("toPreviewItems keys rows uniquely per sellable entity", () => {
  const items = toPreviewItems([
    row({ masterProductId: "p", masterVariantId: "v1" }),
    row({ masterProductId: "p", masterVariantId: "v2" }),
    row({ masterProductId: "q", masterVariantId: null }),
  ]);
  assert.deepEqual(items.map((i) => i.key), ["p::v1", "p::v2", "q::"]);
  assert.equal(new Set(items.map((i) => i.key)).size, 3, "keys are unique");
  assert.ok(!JSON.stringify(items).includes("gid://"), "no GID in the whole payload");
});

test("Shopify IDs and inventory quantities are never rendered", () => {
  for (const [name, raw] of [
    ["preview", PREVIEW_SRC],
    ["catalog", CATALOG_SRC],
  ] as const) {
    const src = strip(raw);
    for (const banned of [
      "shopifyProductId",
      "shopifyVariantId",
      "shopifyInventoryItemId",
      "inventoryItemId",
      "inventoryQuantity",
      "stock_quantity",
      "gid://",
      "customer",
      "shopify_synced_orders",
      "talabat_orders",
    ]) {
      assert.ok(!src.includes(banned), `${name} must not reference ${banned}`);
    }
  }
});

test("preview display name prefers Arabic, then English, else a dash", () => {
  assert.equal(getPreviewDisplayName(toPreviewItem(row({ nameAr: "عربي", nameEn: "En" }))), "عربي");
  assert.equal(getPreviewDisplayName(toPreviewItem(row({ nameAr: "   ", nameEn: "En" }))), "En");
  assert.equal(getPreviewDisplayName(toPreviewItem(row({ nameAr: null, nameEn: null }))), "—");
});

// ── 6. No writes, no fetching, no timers ─────────────────────────────────────

test("the client component performs no fetch, write, timer, polling or subscription", () => {
  const src = strip(PREVIEW_SRC) + strip(SHELL_SRC);
  for (const banned of [
    "fetch(",
    "setInterval",
    "setTimeout",
    "subscribe(",
    ".insert(",
    ".update(",
    ".upsert(",
    ".delete(",
    ".rpc(",
    "createAdminClient",
    "service_role",
    "process.env",
    "console.",
    "productCreate",
    "productUpdate",
    "productVariantsBulkUpdate",
    "inventoryAdjust",
    "inventorySet",
  ]) {
    assert.ok(!src.includes(banned), `preview must not use ${banned}`);
  }
});

test("Shopify loading and matching logic stay out of the client component", () => {
  const src = strip(PREVIEW_SRC);
  for (const banned of [
    "loadShopifyCatalog",
    "projectShopifyCatalog",
    "fetchAllShopifyProducts",
    "normalizeSku",
    "normalizeBarcode",
    "createClient",
    "supabase",
  ]) {
    assert.ok(!src.includes(banned), `preview must not contain ${banned}`);
  }
  // It only imports pure label/href helpers plus the preview type.
  assert.ok(/from "@\/lib\/catalog-v2\/shopify-catalog-view"/.test(PREVIEW_SRC), "imports the pure view helpers");
});

test("the page component stays a Server Component and delegates the results", () => {
  assert.ok(!/^\s*["']use client["']/m.test(CATALOG_SRC), "catalog page component has no 'use client'");
  assert.ok(/^"use client";/m.test(PREVIEW_SRC), "the interactive part is the client component");
  assert.ok(/<ShopifyCatalogResults items=\{toPreviewItems\(items\)\} \/>/.test(CATALOG_SRC), "delegates via the projection");
  // The server component no longer renders the row markup itself.
  assert.ok(!/<tbody>/.test(CATALOG_SRC.slice(0, CATALOG_SRC.indexOf("غير المرتبطة"))), "row markup moved to the client");
});
