// Tests for the Malikas catalog preview experience (Phase UI.3C.1): the
// client-safe projection, the mobile-safe selects, and source scans of the
// results client component and the shared dialog shell. PURE tests only — no
// database, no network, no rendering.
//
// The .tsx files are verified by source scanning rather than by rendering:
// node's --experimental-strip-types cannot load .tsx at all. This file lives
// under lib/ so the existing "lib/**/*.test.ts" glob picks it up.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  DEFAULT_CONTROLS,
  catalogDetailHref,
  getPreviewApprovalLabel,
  getPreviewItemDisplayName,
  toMasterCatalogPreviewItem,
  toMasterCatalogPreviewItems,
  type CatalogControls,
  type MasterCatalogProduct,
} from "./master-catalog-view.ts";

function strip(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const CATALOG_SRC = readFileSync(new URL("../../components/v2/catalog/MasterCatalog.tsx", import.meta.url), "utf8");
const RESULTS_SRC = readFileSync(
  new URL("../../components/v2/catalog/MasterCatalogPreview.tsx", import.meta.url),
  "utf8",
);
const SHELL_SRC = readFileSync(
  new URL("../../components/v2/catalog/CatalogPreviewDialog.tsx", import.meta.url),
  "utf8",
);
const CSS_SRC = readFileSync(new URL("../../app/globals.css", import.meta.url), "utf8");

function product(over: Partial<MasterCatalogProduct> = {}): MasterCatalogProduct {
  return {
    id: "p1",
    sku: "MK-1",
    barcode: "BAR-1",
    nameAr: "منتج",
    nameEn: "Product",
    price: 100,
    discountPrice: null,
    imageUrl: "https://img/1.jpg",
    approval: "Approved",
    variantCount: 3,
    ...over,
  };
}
const controls = (over: Partial<CatalogControls> = {}): CatalogControls => ({ ...DEFAULT_CONTROLS, ...over });

// ── 1. Mobile-safe dropdowns ─────────────────────────────────────────────────

test("Malikas catalog selects use select-input, not the plain input class", () => {
  const selects = CATALOG_SRC.match(/<select[^>]*>/g) ?? [];
  assert.equal(selects.length, 2, "filter + sort selects");
  for (const s of selects) {
    assert.ok(/className="select-input"/.test(s), `select must use select-input: ${s}`);
    assert.ok(!/className="input"/.test(s), "select must not use the plain input class");
  }
  // Same utility the Shopify catalog uses — one fix, both pages.
  assert.ok(/@utility select-input/.test(CSS_SRC), "select-input utility exists");
  assert.ok(/color-scheme:\s*light/.test(CSS_SRC), "native popup pinned to light mode");
  assert.ok(/\.select-input option\s*\{[^}]*background-color:\s*#ffffff/.test(CSS_SRC), "white option background");
  assert.ok(/\.select-input option\s*\{[^}]*color:\s*#3f2a1d/.test(CSS_SRC), "dark option text");
});

test("filter and sort option values and logic are untouched", () => {
  // The select markup still binds the same names and the same option sources.
  assert.ok(/name="filter"/.test(CATALOG_SRC) && /name="sort"/.test(CATALOG_SRC), "same param names");
  assert.ok(/CATALOG_FILTER_OPTIONS\.map/.test(CATALOG_SRC), "same filter options source");
  assert.ok(/CATALOG_SORT_OPTIONS\.map/.test(CATALOG_SRC), "same sort options source");
  // Filtering/sorting/pagination were not moved to the browser.
  for (const banned of ["filterCatalogProducts", "sortCatalogProducts", "paginateCatalog"]) {
    assert.ok(!RESULTS_SRC.includes(banned), `${banned} must stay on the server`);
  }
});

// ── 2. Row / card opens the preview ──────────────────────────────────────────

test("desktop rows and mobile cards open the preview instead of navigating", () => {
  assert.ok(/aria-haspopup="dialog"/.test(RESULTS_SRC), "trigger announces a dialog");
  assert.ok(/onClick=\{\(e\) => open\(item\.key, e\.currentTarget\)\}/.test(RESULTS_SRC), "click opens the preview");
  const rowsBlock = RESULTS_SRC.slice(RESULTS_SRC.indexOf("Desktop table"), RESULTS_SRC.indexOf("{active !== null"));
  assert.ok(!/<Link/.test(rowsBlock), "no row/card is a Link — a tap must not navigate");
  assert.equal((RESULTS_SRC.match(/<Link/g) ?? []).length, 1, "exactly one Link: فتح صفحة المنتج");
});

test("desktop rows are keyboard operable with Enter and Space", () => {
  assert.ok(/role="button"/.test(RESULTS_SRC), "row exposes a button role");
  assert.ok(/tabIndex=\{0\}/.test(RESULTS_SRC), "row is focusable");
  assert.ok(/e\.key === "Enter" \|\| e\.key === " "/.test(RESULTS_SRC), "Enter and Space activate the row");
  assert.ok(/e\.preventDefault\(\)/.test(RESULTS_SRC), "Space does not scroll the page");
});

// ── 3. Preview content ───────────────────────────────────────────────────────

test("preview shows every required catalog-safe field", () => {
  for (const label of [
    "الاسم العربي",
    "الاسم الإنجليزي",
    "SKU",
    "الباركود",
    "السعر الأساسي",
    "سعر الخصم",
    "عدد الخيارات",
  ]) {
    assert.ok(RESULTS_SRC.includes(label), `preview field: ${label}`);
  }
  assert.ok(/<ApprovalBadge item=\{item\} \/>/.test(RESULTS_SRC), "approval status");
  assert.ok(/<CompletenessBadge item=\{item\} \/>/.test(RESULTS_SRC), "completeness status");
});

test("preview reuses the existing Malikas labels and states", () => {
  assert.ok(/getCompletenessLabel/.test(RESULTS_SRC), "existing completeness labels");
  assert.ok(/getPreviewApprovalLabel/.test(RESULTS_SRC), "fixed approval label");
  assert.equal(getPreviewApprovalLabel(toMasterCatalogPreviewItem(product(), controls())), "معتمد");
  assert.equal(
    getPreviewApprovalLabel(toMasterCatalogPreviewItem(product({ approval: "pending" }), controls())),
    "غير معتمد",
  );
});

test("a valid discount is carried; an invalid one is dropped", () => {
  const valid = toMasterCatalogPreviewItem(product({ price: 100, discountPrice: 80 }), controls());
  assert.equal(valid.price, 100);
  assert.equal(valid.discountPrice, 80);

  for (const bad of [null, 0, -5, 100, 150]) {
    const item = toMasterCatalogPreviewItem(product({ price: 100, discountPrice: bad }), controls());
    assert.equal(item.discountPrice, null, `discount ${bad} must be dropped`);
  }
  // No usable base price → no price at all.
  assert.equal(toMasterCatalogPreviewItem(product({ price: 0 }), controls()).price, null);
});

test("variant count and completeness come through unchanged", () => {
  assert.equal(toMasterCatalogPreviewItem(product({ variantCount: 7 }), controls()).variantCount, 7);
  assert.equal(toMasterCatalogPreviewItem(product(), controls()).completenessStatus, "complete");
  assert.equal(
    toMasterCatalogPreviewItem(product({ sku: null, barcode: null }), controls()).completenessStatus,
    "missing_multiple",
  );
  assert.equal(toMasterCatalogPreviewItem(product({ imageUrl: null }), controls()).completenessStatus, "missing_image");
});

test("preview display name prefers Arabic, then English, else a dash", () => {
  assert.equal(getPreviewItemDisplayName(toMasterCatalogPreviewItem(product({ nameAr: "عربي" }), controls())), "عربي");
  assert.equal(
    getPreviewItemDisplayName(toMasterCatalogPreviewItem(product({ nameAr: "   ", nameEn: "En" }), controls())),
    "En",
  );
  assert.equal(
    getPreviewItemDisplayName(toMasterCatalogPreviewItem(product({ nameAr: null, nameEn: null }), controls())),
    "—",
  );
});

// ── 4. Detail URL preservation ───────────────────────────────────────────────

test("the preview links to the detail route via catalogDetailHref", () => {
  assert.ok(/href=\{item\.detailHref\}/.test(RESULTS_SRC), "renders the projected href");
  assert.ok(RESULTS_SRC.includes("فتح صفحة المنتج"), "explicit secondary action");
  const item = toMasterCatalogPreviewItem(product({ id: "abc 1" }), controls());
  assert.equal(item.detailHref, catalogDetailHref("abc 1", controls()), "identical to the shared helper");
  assert.ok(item.detailHref.startsWith("/v2/catalog/abc%201"), "id is encoded");
});

test("query, filter, sort and page are preserved in the detail href", () => {
  const c = controls({ query: "كريم", filter: "missing_sku", sort: "price_desc", page: 4 });
  const item = toMasterCatalogPreviewItem(product({ id: "p9" }), c);
  assert.equal(item.detailHref, catalogDetailHref("p9", c));
  for (const part of ["query=", "filter=missing_sku", "sort=price_desc", "page=4"]) {
    assert.ok(item.detailHref.includes(part), `detailHref preserves ${part}`);
  }
  // Defaults stay out of the URL.
  assert.equal(toMasterCatalogPreviewItem(product({ id: "p9" }), controls()).detailHref, "/v2/catalog/p9");
});

// ── 5. Image lightbox (shared shell) ─────────────────────────────────────────

test("the Malikas preview uses the shared dialog and lightbox", () => {
  assert.ok(/<CatalogPreviewDialog/.test(RESULTS_SRC), "uses the shared dialog");
  assert.ok(/imageUrl=\{item\.imageUrl\}/.test(RESULTS_SRC), "passes the image to the shell");
  assert.ok(/titleId="master-preview-title"/.test(RESULTS_SRC), "labels its own dialog");
  // …and the shell is the one carrying the approved lightbox behaviour.
  assert.ok(/setLightbox\(true\)/.test(SHELL_SRC), "image opens the lightbox");
  assert.ok(/aria-label="تكبير"/.test(SHELL_SRC) && /aria-label="تصغير"/.test(SHELL_SRC), "+ and − buttons");
  assert.ok(/aria-label="إعادة الحجم إلى 100%"/.test(SHELL_SRC), "reset to 100%");
  assert.ok(/const MAX_ZOOM = 4/.test(SHELL_SRC), "4x maximum");
  assert.ok(/object-contain/.test(SHELL_SRC) && /bg-black\/90/.test(SHELL_SRC), "contain on a dark backdrop");
  assert.ok(/max-h-\[78vh\] max-w-full/.test(SHELL_SRC), "cannot overflow a phone screen");
});

test("a product with no image shows a placeholder and cannot open the lightbox", () => {
  assert.ok(/imageAvailable \?/.test(SHELL_SRC), "image trigger is conditional");
  assert.ok(/<ImagePlaceholder className="h-44 w-44" \/>/.test(SHELL_SRC), "placeholder otherwise");
  assert.ok(/lightbox && imageAvailable \?/.test(SHELL_SRC), "lightbox render is image-guarded");
  // A product without an image projects imageUrl null, so the guard is reached.
  assert.equal(toMasterCatalogPreviewItem(product({ imageUrl: null }), controls()).imageUrl, null);
});

// ── 6. Accessibility parity with the Shopify preview ─────────────────────────

test("the dialog keeps the approved accessibility guarantees", () => {
  assert.ok(/role="dialog"/.test(SHELL_SRC) && /aria-modal="true"/.test(SHELL_SRC), "dialog semantics");
  assert.ok(/aria-labelledby=\{titleId\}/.test(SHELL_SRC), "labelled dialog");
  assert.ok(/aria-label="إغلاق"/.test(SHELL_SRC), "close button");
  assert.ok(/onClick=\{onClose\}/.test(SHELL_SRC), "backdrop click closes");
  assert.ok(/e\.key !== "Escape"/.test(SHELL_SRC), "Escape handling");
  assert.ok(/if \(lightbox\) setLightbox\(false\);/.test(SHELL_SRC), "Escape closes the lightbox first");
  assert.ok(/document\.body\.style\.overflow = "hidden"/.test(SHELL_SRC), "background scroll locked");
  assert.ok(/closeRef\.current\?\.focus\(\)/.test(SHELL_SRC), "focus moves into the dialog");
  assert.ok(/triggerRef\.current\?\.focus\(\)/.test(RESULTS_SRC), "focus returns to the product that opened it");
});

// ── 7. Client-safe projection ────────────────────────────────────────────────

const ALLOWED_KEYS = [
  "key",
  "productId",
  "detailHref",
  "nameAr",
  "nameEn",
  "sku",
  "barcode",
  "imageUrl",
  "price",
  "discountPrice",
  "variantCount",
  "approvalStatus",
  "completenessStatus",
];

test("the projection is a strict whitelist — nothing else is serialized", () => {
  const item = toMasterCatalogPreviewItem(product(), controls());
  assert.deepEqual(Object.keys(item).sort(), [...ALLOWED_KEYS].sort(), "exactly the whitelisted keys");
});

test("raw approval text never crosses into the client", () => {
  // Only an exact "approved" counts (unchanged rule) — either way the raw text
  // is normalized to an enum and never serialized.
  const approved = toMasterCatalogPreviewItem(product({ approval: "  Approved " }), controls());
  assert.equal(approved.approvalStatus, "approved");
  assert.ok(!JSON.stringify(approved).includes("Approved"), "raw approval text is not serialized");

  const hostile = toMasterCatalogPreviewItem(product({ approval: "Approved-BY-ADMIN-42" }), controls());
  assert.equal(hostile.approvalStatus, "not_approved", "a non-exact value is not treated as approved");
  assert.ok(!JSON.stringify(hostile).includes("ADMIN-42"), "raw approval text is not serialized");

  assert.equal(Object.hasOwn(approved, "approval"), false);
});

test("stock, platform identities, order and customer data are never serialized", () => {
  // Even if the source row grew such a field, the whitelist would drop it.
  const hostile = {
    ...product(),
    stock_quantity: 42,
    shopifyProductId: "gid://shopify/Product/1",
    snoonu_id: "SN-1",
    rafeeq_product_id: "RF-1",
    customer_name: "someone",
    order_id: "o-1",
  } as unknown as MasterCatalogProduct;
  const payload = JSON.stringify(toMasterCatalogPreviewItem(hostile, controls()));
  for (const banned of ["stock_quantity", "42", "gid://", "shopifyProductId", "snoonu_id", "rafeeq_product_id", "customer", "order_id"]) {
    assert.ok(!payload.includes(banned), `payload must not contain ${banned}`);
  }
});

test("toMasterCatalogPreviewItems keys every product uniquely", () => {
  const items = toMasterCatalogPreviewItems(
    [product({ id: "a" }), product({ id: "b" }), product({ id: "c" })],
    controls(),
  );
  assert.deepEqual(items.map((i) => i.key), ["a", "b", "c"]);
  assert.equal(new Set(items.map((i) => i.key)).size, 3);
  assert.deepEqual(toMasterCatalogPreviewItems([], controls()), []);
});

test("no stock/platform/order/customer field is referenced by the UI at all", () => {
  for (const [name, raw] of [
    ["results", RESULTS_SRC],
    ["catalog", CATALOG_SRC],
    ["shell", SHELL_SRC],
  ] as const) {
    const src = strip(raw);
    for (const banned of [
      "stock_quantity",
      "stock",
      "inventory",
      "shopifyProductId",
      "shopifyVariantId",
      "inventoryItemId",
      "gid://",
      "snoonu",
      "rafeeq",
      "talabat",
      "customer",
      "orders",
    ]) {
      assert.ok(!src.toLowerCase().includes(banned.toLowerCase()), `${name} must not reference ${banned}`);
    }
  }
});

// ── 8. Server/client split and no writes ─────────────────────────────────────

test("MasterCatalog stays a Server Component and delegates the results", () => {
  assert.ok(!/^\s*["']use client["']/m.test(CATALOG_SRC), "no 'use client' on the page component");
  assert.ok(/^"use client";/m.test(RESULTS_SRC), "the interactive part is the client component");
  assert.ok(
    /<MasterCatalogResults items=\{toMasterCatalogPreviewItems\(items, controls\)\} \/>/.test(CATALOG_SRC),
    "delegates via the whitelist projection",
  );
  // The KPI cards and the GET form stay server-rendered.
  assert.ok(/KpiCard/.test(CATALOG_SRC), "KPIs stay on the server");
  assert.ok(/<form method="get"/.test(CATALOG_SRC), "the control bar stays a GET form");
});

test("the client components perform no fetch, write, timer, polling or subscription", () => {
  const src = strip(RESULTS_SRC) + strip(SHELL_SRC);
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
    "createClient",
    "supabase",
  ]) {
    assert.ok(!src.includes(banned), `client must not use ${banned}`);
  }
});

test("the catalog read layer and page loader were not touched by this phase", () => {
  const readSrc = readFileSync(new URL("./master-catalog-read.ts", import.meta.url), "utf8");
  // Still server-only, still SELECT-only.
  assert.ok(/^import "server-only";/m.test(readSrc), "read layer stays server-only");
  for (const b of [".insert(", ".update(", ".upsert(", ".delete(", ".rpc("]) {
    assert.ok(!strip(readSrc).includes(b), `read layer must not ${b}`);
  }
  // The preview projection lives in the pure view layer, never in the reader.
  assert.ok(!readSrc.includes("toMasterCatalogPreviewItem"), "projection is not in the read layer");
});
