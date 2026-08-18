// Tests for the Malikas V2 Shopify Catalog PAGE layer (Phase UI.3C):
// the pure control/search/filter/sort/paginate/summary helpers, plus source
// scans of the page, the component and the sidebar. PURE tests only — no
// database, no network, no Shopify, no rendering.
//
// The .tsx page/component are verified by source scanning rather than by
// rendering: node's --experimental-strip-types cannot load .tsx at all, so this
// is the same approach the Phase UI.1/UI.2 suites already use for V2 components.
//
// Run: node --conditions=react-server --experimental-strip-types --test lib/catalog-v2/shopify-catalog-page.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  DEFAULT_SHOPIFY_CONTROLS,
  SHOPIFY_PAGE_SIZE,
  SHOPIFY_FILTER_OPTIONS,
  SHOPIFY_SORT_OPTIONS,
  parseShopifyCatalogControls,
  filterShopifyCatalogRows,
  sortShopifyCatalogRows,
  paginateShopifyCatalog,
  summarizeShopifyCatalog,
  shopifyCatalogHref,
  getRowDisplayName,
  projectShopifyCatalog,
  type ShopifyCatalogRow,
} from "./shopify-catalog-view.ts";
import { V2_NAV_LINKS, activeNavHref } from "../v2/nav.ts";

// ── Builders ─────────────────────────────────────────────────────────────────

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
    shopifyProductId: null,
    shopifyVariantId: null,
    shopifyInventoryItemId: null,
    shopifyStatus: "unknown",
    presenceStatus: "missing",
    matchStatus: "unmatched",
    matchReason: null,
    ...over,
  };
}

function strip(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const PAGE_SRC = readFileSync(new URL("../../app/(v2)/v2/catalog/shopify/page.tsx", import.meta.url), "utf8");
const COMPONENT_SRC = readFileSync(new URL("../../components/v2/catalog/ShopifyCatalog.tsx", import.meta.url), "utf8");
const SIDEBAR_SRC = readFileSync(new URL("../../components/v2/V2Sidebar.tsx", import.meta.url), "utf8");
const RESULTS_SRC = readFileSync(
  new URL("../../components/v2/catalog/ShopifyProductPreview.tsx", import.meta.url),
  "utf8",
);

// ── Page wiring ──────────────────────────────────────────────────────────────

test("page calls the Shopify catalog reader once, through the user session client", () => {
  const src = strip(PAGE_SRC);
  assert.equal((src.match(/loadShopifyCatalog\s*\(/g) ?? []).length, 1, "reader called exactly once");
  assert.ok(/createClient\s*\(/.test(src), "uses the existing session client");
  assert.ok(/export const dynamic = "force-dynamic"/.test(src), "force-dynamic");
  // Matching is NOT re-implemented in the page.
  assert.ok(!/matched_sku|matched_barcode|normalizeSku|normalizeBarcode/.test(src), "no matching logic in page");
});

test("page renders the fixed master-error message and no partial rows", () => {
  const src = strip(PAGE_SRC);
  assert.ok(/تعذر تحميل كتالوج ماليكاس\./.test(src), "fixed master error message");
  assert.ok(/master_error/.test(src), "handles the master_error status");
  // On failure the component is not rendered at all.
  assert.ok(/loaded === null/.test(src), "fails closed to the error branch");
});

test("page hides orphans when Shopify was unavailable", () => {
  const src = strip(PAGE_SRC);
  assert.ok(/shopifyAvailable \? result\.orphanVariants : \[\]/.test(src), "orphans only when Shopify answered");
});

// ── Controls parsing ─────────────────────────────────────────────────────────

test("unknown/hostile query params fall back to defaults without error or reflection", () => {
  for (const params of [
    { filter: "DROP TABLE", sort: "<script>", page: "-4" },
    { filter: "__proto__", sort: "constructor", page: "abc" },
    { filter: ["nope"], sort: 5 as unknown as string, page: "0" },
    { page: "999999999999999999999" },
    null,
    undefined,
  ]) {
    const c = parseShopifyCatalogControls(params as never);
    assert.equal(c.filter, "all");
    assert.equal(c.sort, "name");
    assert.equal(c.page, 1);
  }
  assert.deepEqual(parseShopifyCatalogControls({}), DEFAULT_SHOPIFY_CONTROLS);
});

test("valid params parse; the query is trimmed and length-capped", () => {
  const c = parseShopifyCatalogControls({ query: "  abc  ", filter: "ambiguous", sort: "status", page: "3" });
  assert.deepEqual(c, { query: "abc", filter: "ambiguous", sort: "status", page: 3 });
  assert.equal(parseShopifyCatalogControls({ query: "x".repeat(500) }).query.length, 80);
});

test("every filter and sort option value is accepted by the parser", () => {
  for (const o of SHOPIFY_FILTER_OPTIONS) {
    assert.equal(parseShopifyCatalogControls({ filter: o.value }).filter, o.value);
  }
  for (const o of SHOPIFY_SORT_OPTIONS) {
    assert.equal(parseShopifyCatalogControls({ sort: o.value }).sort, o.value);
  }
});

// ── Search ───────────────────────────────────────────────────────────────────

const SEARCH_ROWS = [
  row({ masterProductId: "a", sku: "ALPHA-1", barcode: "1112223", nameAr: "كريم مرطب", nameEn: "Hydrating Cream" }),
  row({ masterProductId: "b", sku: "BETA-2", barcode: "9998887", nameAr: "غسول وجه", nameEn: "Face Wash" }),
];

test("search by SKU (case-insensitive)", () => {
  const r = filterShopifyCatalogRows(SEARCH_ROWS, { query: "alpha", filter: "all" });
  assert.deepEqual(r.map((x) => x.masterProductId), ["a"]);
});

test("search by barcode", () => {
  const r = filterShopifyCatalogRows(SEARCH_ROWS, { query: "9998887", filter: "all" });
  assert.deepEqual(r.map((x) => x.masterProductId), ["b"]);
});

test("search by Arabic name", () => {
  const r = filterShopifyCatalogRows(SEARCH_ROWS, { query: "غسول", filter: "all" });
  assert.deepEqual(r.map((x) => x.masterProductId), ["b"]);
});

test("search by English name", () => {
  const r = filterShopifyCatalogRows(SEARCH_ROWS, { query: "hydrating", filter: "all" });
  assert.deepEqual(r.map((x) => x.masterProductId), ["a"]);
});

test("empty query matches everything; no match yields an empty list", () => {
  assert.equal(filterShopifyCatalogRows(SEARCH_ROWS, { query: "", filter: "all" }).length, 2);
  assert.equal(filterShopifyCatalogRows(SEARCH_ROWS, { query: "zzzz", filter: "all" }).length, 0);
});

// ── Filters ──────────────────────────────────────────────────────────────────

const FILTER_ROWS = [
  row({ masterProductId: "present-sku", presenceStatus: "present", matchStatus: "matched_sku" }),
  row({ masterProductId: "present-bar", presenceStatus: "present", matchStatus: "matched_barcode" }),
  row({ masterProductId: "amb", presenceStatus: "present", matchStatus: "ambiguous" }),
  row({ masterProductId: "gone", presenceStatus: "missing", matchStatus: "unmatched" }),
  row({ masterProductId: "unk", presenceStatus: "unknown", matchStatus: "unknown" }),
];

const idsFor = (filter: string) =>
  filterShopifyCatalogRows(FILTER_ROWS, { query: "", filter: filter as never }).map((r) => r.masterProductId);

test("filter: present", () => assert.deepEqual(idsFor("present"), ["present-sku", "present-bar", "amb"]));
test("filter: missing", () => assert.deepEqual(idsFor("missing"), ["gone"]));
test("filter: matched_sku", () => assert.deepEqual(idsFor("matched_sku"), ["present-sku"]));
test("filter: matched_barcode", () => assert.deepEqual(idsFor("matched_barcode"), ["present-bar"]));
test("filter: ambiguous", () => assert.deepEqual(idsFor("ambiguous"), ["amb"]));
test("filter: unknown", () => assert.deepEqual(idsFor("unknown"), ["unk"]));
test("filter: all", () => assert.equal(idsFor("all").length, 5));

// ── Sorting ──────────────────────────────────────────────────────────────────

test("sort by name (Arabic display name; blanks last) and never mutates the input", () => {
  const input = [
    row({ masterProductId: "c", nameAr: "جيم", nameEn: null }),
    row({ masterProductId: "a", nameAr: "ألف", nameEn: null }),
    row({ masterProductId: "z", nameAr: null, nameEn: null }),
    row({ masterProductId: "b", nameAr: "باء", nameEn: null }),
  ];
  const snapshot = input.map((r) => r.masterProductId);
  const sorted = sortShopifyCatalogRows(input, "name");
  assert.equal(sorted[sorted.length - 1]!.masterProductId, "z", "nameless row sorts last");
  assert.deepEqual(input.map((r) => r.masterProductId), snapshot, "input not mutated");
});

test("sort by SKU; rows without a SKU sort last", () => {
  const sorted = sortShopifyCatalogRows(
    [row({ masterProductId: "x", sku: null }), row({ masterProductId: "b", sku: "B" }), row({ masterProductId: "a", sku: "A" })],
    "sku",
  );
  assert.deepEqual(sorted.map((r) => r.masterProductId), ["a", "b", "x"]);
});

test("sort by status puts rows needing attention first", () => {
  const sorted = sortShopifyCatalogRows(
    [
      row({ masterProductId: "ok", matchStatus: "matched_sku" }),
      row({ masterProductId: "unk", matchStatus: "unknown" }),
      row({ masterProductId: "gone", matchStatus: "unmatched" }),
      row({ masterProductId: "amb", matchStatus: "ambiguous" }),
      row({ masterProductId: "bar", matchStatus: "matched_barcode" }),
    ],
    "status",
  );
  assert.deepEqual(sorted.map((r) => r.masterProductId), ["gone", "amb", "unk", "bar", "ok"]);
});

test("sorting is deterministic for equal keys (stable tie-break on identity)", () => {
  const rows = [
    row({ masterProductId: "p", masterVariantId: "v2", sku: "SAME" }),
    row({ masterProductId: "p", masterVariantId: "v1", sku: "SAME" }),
  ];
  assert.deepEqual(
    sortShopifyCatalogRows(rows, "sku").map((r) => r.masterVariantId),
    ["v1", "v2"],
  );
});

// ── Pagination ───────────────────────────────────────────────────────────────

test("pagination uses PAGE_SIZE 50 and clamps an over-large page to the last one", () => {
  assert.equal(SHOPIFY_PAGE_SIZE, 50);
  const rows = Array.from({ length: 120 }, (_, i) => row({ masterProductId: `p${i}` }));

  const first = paginateShopifyCatalog(rows, 1);
  assert.equal(first.items.length, 50);
  assert.equal(first.totalPages, 3);
  assert.equal(first.startIndex, 0);

  const last = paginateShopifyCatalog(rows, 3);
  assert.equal(last.items.length, 20);
  assert.equal(last.startIndex, 100);

  const clamped = paginateShopifyCatalog(rows, 99);
  assert.equal(clamped.page, 3, "over-large page clamps to the last real page");
  assert.equal(clamped.items.length, 20, "never a false empty state");
});

test("pagination of an empty list yields one empty page", () => {
  const p = paginateShopifyCatalog([], 1);
  assert.equal(p.totalPages, 1);
  assert.equal(p.totalItems, 0);
  assert.deepEqual(p.items, []);
});

test("pagination href preserves query/filter/sort and omits defaults", () => {
  assert.equal(shopifyCatalogHref({ query: "", filter: "all", sort: "name", page: 1 }, 1), "/v2/catalog/shopify");
  assert.equal(
    shopifyCatalogHref({ query: "ab c", filter: "ambiguous", sort: "status", page: 1 }, 2),
    "/v2/catalog/shopify?query=ab+c&filter=ambiguous&sort=status&page=2",
  );
});

// ── Summary ──────────────────────────────────────────────────────────────────

test("summary cards use real row counts", () => {
  const s = summarizeShopifyCatalog(FILTER_ROWS, true);
  assert.equal(s.total, 5);
  assert.equal(s.present, 3);
  assert.equal(s.missing, 1);
  assert.equal(s.unmatched, 1);
  assert.equal(s.ambiguous, 1);
});

test("Shopify unavailable never counts rows as missing/unmatched — the counts are unknown", () => {
  // Build rows the way the projector really does when Shopify is unavailable.
  const projected = projectShopifyCatalog(
    [
      { id: "p1", sku: "A", barcode: "B", name_ar: "أ", name_en: "A", price: 1, image_url: null },
      { id: "p2", sku: "C", barcode: "D", name_ar: "ب", name_en: "B", price: 2, image_url: null },
    ],
    [],
    null,
  );
  const s = summarizeShopifyCatalog(projected.rows, projected.shopifyAvailable);
  assert.equal(s.total, 2, "the Malikas total is still a real number");
  assert.equal(s.present, null);
  assert.equal(s.missing, null, "missing must not be asserted as fact");
  assert.equal(s.unmatched, null);
  assert.equal(s.ambiguous, null);
  // And none of the rows claims to be missing.
  for (const r of projected.rows) {
    assert.equal(r.presenceStatus, "unknown");
    assert.equal(r.matchStatus, "unknown");
  }
});

test("display name prefers Arabic, then English, else a dash", () => {
  assert.equal(getRowDisplayName(row({ nameAr: "عربي", nameEn: "En" })), "عربي");
  assert.equal(getRowDisplayName(row({ nameAr: "  ", nameEn: "En" })), "En");
  assert.equal(getRowDisplayName(row({ nameAr: null, nameEn: null })), "—");
});

// ── Component: rendered content ──────────────────────────────────────────────

test("component renders the required desktop table headers", () => {
  // The results table moved into the client component in UI.3C.1 so a row can
  // open the preview dialog; the required columns are unchanged.
  for (const header of ["الصورة", "الاسم", "SKU", "الباركود", "السعر", "حالة الوجود", "طريقة المطابقة", "حالة Shopify"]) {
    assert.ok(RESULTS_SRC.includes(header), `desktop table header: ${header}`);
  }
});

test("component renders the mobile card fields", () => {
  const mobile = RESULTS_SRC.slice(RESULTS_SRC.indexOf("Mobile cards"));
  assert.ok(/Thumb/.test(mobile), "image");
  assert.ok(/getPreviewDisplayName/.test(mobile), "name");
  assert.ok(/SKU:/.test(mobile), "sku");
  assert.ok(/باركود:/.test(mobile), "barcode");
  assert.ok(/السعر:/.test(mobile), "price");
  assert.ok(/PresenceBadge/.test(mobile), "presence badge");
  assert.ok(/MatchBadge/.test(mobile), "match badge");
  assert.ok(/ShopifyStatusBadge/.test(mobile), "shopify status");
});

test("component renders header, read-only badge and the five summary cards", () => {
  assert.ok(COMPONENT_SRC.includes("كتالوج Shopify"), "title");
  assert.ok(COMPONENT_SRC.includes("مقارنة منتجات ماليكاس مع منتجات Shopify"), "description");
  assert.ok(COMPONENT_SRC.includes("قراءة فقط"), "read-only badge");
  for (const label of [
    "إجمالي العناصر القابلة للبيع",
    "موجودة في Shopify",
    "غير موجودة في Shopify",
    "غير مطابقة",
    "تتطلب مراجعة",
  ]) {
    assert.ok(COMPONENT_SRC.includes(label), `summary card: ${label}`);
  }
});

test("terminology matches the row grain: sellable entities, not products", () => {
  // A row is one sellable entity (a variant-less product, or one variant), so
  // the aggregate labels must not claim to count products.
  assert.ok(!COMPONENT_SRC.includes("إجمالي منتجات ماليكاس"), "no product-grain total label");
  assert.ok(COMPONENT_SRC.includes("لا توجد عناصر قابلة للبيع في كتالوج ماليكاس."), "sellable-entity empty state");
  assert.ok(!COMPONENT_SRC.includes("لا توجد منتجات في كتالوج ماليكاس."), "old product-grain empty state removed");
  // The orphan section reports Shopify VARIANTS.
  assert.ok(COMPONENT_SRC.includes("متغيرات Shopify غير المرتبطة"), "variant-grain orphan title");
  assert.ok(!COMPONENT_SRC.includes("منتجات Shopify غير المرتبطة"), "old product-grain orphan title removed");
});

test("component shows the fixed Shopify-unavailable and partial messages", () => {
  assert.ok(
    COMPONENT_SRC.includes("تعذر تحميل بيانات Shopify حاليًا. تم عرض كتالوج ماليكاس دون تحديد حالة الوجود."),
    "fixed Shopify-unavailable message",
  );
  assert.ok(COMPONENT_SRC.includes("تم تحميل جزء من البيانات فقط."), "fixed partial message");
});

test("component renders pagination controls and the result counter", () => {
  assert.ok(COMPONENT_SRC.includes("السابق"), "prev");
  assert.ok(COMPONENT_SRC.includes("التالي"), "next");
  assert.ok(/عرض \{firstOnPage\}–\{lastOnPage\} من \{matchCount\} نتيجة/.test(COMPONENT_SRC), "X–Y of Z");
  assert.ok(/صفحة \{page\} من \{totalPages\}/.test(COMPONENT_SRC), "page N of M");
});

test("rows reach the MASTER product page; no Shopify detail route is created", () => {
  // Since UI.3C.1 a row opens the preview dialog, and the dialog carries the
  // explicit link to the master product page.
  assert.ok(/previewProductHref\(item\)/.test(RESULTS_SRC), "dialog links to the master detail");
  assert.ok(RESULTS_SRC.includes("فتح صفحة المنتج"), "explicit secondary action");
  assert.ok(!/\/v2\/catalog\/shopify\/\[/.test(RESULTS_SRC), "no Shopify detail route");
  assert.ok(!/\/v2\/catalog\/shopify\/\[/.test(COMPONENT_SRC), "no Shopify detail route in the page component");
});

// ── Orphan section ───────────────────────────────────────────────────────────

test("orphan section is separate, collapsed, and hidden when Shopify is unavailable", () => {
  assert.ok(COMPONENT_SRC.includes("متغيرات Shopify غير المرتبطة"), "orphan section title");
  assert.ok(/<details/.test(COMPONENT_SRC), "collapsed by default (details without open)");
  assert.ok(!/<details[^>]*\sopen/.test(COMPONENT_SRC), "not open by default");
  assert.ok(
    /shopifyAvailable && orphanVariants\.length > 0/.test(COMPONENT_SRC),
    "hidden entirely when Shopify unavailable",
  );
  // It is rendered outside the main results table branch.
  assert.ok(COMPONENT_SRC.indexOf("متغيرات Shopify غير المرتبطة") > COMPONENT_SRC.indexOf("Mobile cards"), "below the table");
});

test("orphan rows show only title/sku/barcode/status/reason — never an ID", () => {
  const orphan = COMPONENT_SRC.slice(COMPONENT_SRC.indexOf("متغيرات Shopify غير المرتبطة"));
  assert.ok(/o\.title/.test(orphan) && /o\.sku/.test(orphan) && /o\.barcode/.test(orphan), "title/sku/barcode");
  assert.ok(/getShopifyStatusLabel\(o\.status\)/.test(orphan), "status");
  assert.ok(/getOrphanReasonLabel\(o\.reason\)/.test(orphan), "reason");
  for (const banned of ["o.shopifyProductId", "o.shopifyVariantId", "o.shopifyInventoryItemId"]) {
    assert.ok(!orphan.includes(banned), `orphan must not render ${banned}`);
  }
});

// ── Leak safety: no Shopify GIDs / inventory / raw errors in the UI ──────────

test("no raw Shopify IDs, inventory quantity, or order/customer data is rendered", () => {
  // Comments are never rendered, so the leak scan runs on comment-stripped source
  // (the doc headers deliberately NAME the fields they promise not to render).
  for (const [name, src] of [
    ["component", strip(COMPONENT_SRC)],
    ["page", strip(PAGE_SRC)],
  ] as const) {
    for (const banned of [
      "shopifyProductId",
      "shopifyVariantId",
      "shopifyInventoryItemId",
      "inventoryItemId",
      "inventoryQuantity",
      "stock_quantity",
      "gid://",
      "matchReason",
      "customer",
      "shopify_synced_orders",
      "talabat_orders",
    ]) {
      assert.ok(!src.includes(banned), `${name} must not reference ${banned}`);
    }
  }
});

// ── Source safety scans: page, component, sidebar ────────────────────────────

const FORBIDDEN: readonly (readonly [RegExp, string])[] = [
  [/productCreate/, "productCreate"],
  [/productUpdate/, "productUpdate"],
  [/productVariantsBulkUpdate/, "productVariantsBulkUpdate"],
  [/inventoryAdjust/, "inventoryAdjust"],
  [/inventorySet/, "inventorySet"],
  [/\.insert\s*\(/, ".insert("],
  [/\.update\s*\(/, ".update("],
  [/\.upsert\s*\(/, ".upsert("],
  [/\.delete\s*\(/, ".delete("],
  [/\.rpc\s*\(/, ".rpc("],
  [/createAdminClient/, "createAdminClient"],
  [/service_role/, "service_role"],
  [/process\.env/, "process.env"],
  [/console\./, "console."],
  [/select\(\s*["']\*["']\s*\)/, 'select("*")'],
  [/dangerouslySetInnerHTML/, "dangerouslySetInnerHTML"],
];

test("new UI sources contain no writes, admin client, env, logging or select(*)", () => {
  for (const [name, raw] of [
    ["page", PAGE_SRC],
    ["component", COMPONENT_SRC],
    ["sidebar", SIDEBAR_SRC],
  ] as const) {
    const src = strip(raw);
    for (const [re, msg] of FORBIDDEN) {
      assert.ok(!re.test(src), `forbidden in ${name}: ${msg}`);
    }
  }
});

test("the UI performs no Shopify write and no database write of its own", () => {
  const src = strip(PAGE_SRC);
  // The only data entry point is the read-model loader.
  assert.ok(/loadShopifyCatalog/.test(src), "reads through the read model");
  assert.ok(!/fetch\s*\(/.test(src), "no direct fetch from the page");
  assert.ok(!/fetch\s*\(/.test(strip(COMPONENT_SRC)), "no fetch from the component");
  // No timer / polling / subscription anywhere in the new UI.
  for (const [name, raw] of [
    ["page", PAGE_SRC],
    ["component", COMPONENT_SRC],
    ["sidebar", SIDEBAR_SRC],
  ] as const) {
    const src2 = strip(raw);
    for (const banned of ["setInterval", "setTimeout", "subscribe(", "revalidate ="]) {
      assert.ok(!src2.includes(banned), `${name} must not use ${banned}`);
    }
  }
});

test("the component is a Server Component (no client directive, no state)", () => {
  assert.ok(!/^\s*["']use client["']/m.test(COMPONENT_SRC), "no 'use client'");
  assert.ok(!/useState|useEffect/.test(COMPONENT_SRC), "no client state");
});

// ── Sidebar ──────────────────────────────────────────────────────────────────

test("the catalog section contains exactly the Malikas and Shopify catalog links", () => {
  // The sidebar now carries a Beauty Rewards section too, so this pins the
  // CATALOG SECTION specifically rather than the whole list.
  const catalog = V2_NAV_LINKS.filter((l) => l.section === "الكتالوج");
  // WAVE.1A added the read-only «حملة الإطلاق» (/v2/catalog/launch) workspace.
  assert.deepEqual(
    catalog.map((l) => l.href),
    ["/v2/catalog", "/v2/catalog/shopify", "/v2/catalog/launch"],
    "catalog links, in order",
  );
  assert.deepEqual(
    catalog.map((l) => l.label),
    ["كتالوج ماليكاس", "كتالوج Shopify", "حملة الإطلاق"],
  );
  // No sales platform beyond Shopify is introduced yet.
  const serialized = JSON.stringify(V2_NAV_LINKS) + SIDEBAR_SRC;
  for (const banned of ["Talabat", "طلبات", "Pure Seoul", "Rafeeq", "رفيق", "Snoonu", "سنونو"]) {
    assert.ok(!serialized.includes(banned), `sidebar must not link ${banned} yet`);
  }
});

test("sidebar drives its highlight from the shared nav rule", () => {
  assert.ok(/activeNavHref\s*\(/.test(SIDEBAR_SRC), "uses the pure rule");
  assert.ok(/groupNavLinks\(\)/.test(SIDEBAR_SRC), "renders the shared link list, grouped by section");
  assert.ok(/activeHref === link\.href/.test(SIDEBAR_SRC), "one winner per render");
});

// The three cases the review asked to pin down.

test("/v2/catalog → Malikas active only", () => {
  const active = activeNavHref("/v2/catalog");
  assert.equal(active, "/v2/catalog");
  assert.notEqual(active, "/v2/catalog/shopify");
});

test("/v2/catalog/<product-id> → Malikas active only", () => {
  for (const id of ["abc123", "7f3d-9e21", "منتج", "a%2Fb"]) {
    const active = activeNavHref(`/v2/catalog/${id}`);
    assert.equal(active, "/v2/catalog", `detail page keeps Malikas lit: ${id}`);
  }
});

test("/v2/catalog/shopify → Shopify active only (Malikas not lit)", () => {
  const active = activeNavHref("/v2/catalog/shopify");
  assert.equal(active, "/v2/catalog/shopify");
  assert.notEqual(active, "/v2/catalog");
});

test("nav rule: a future platform link claims its subtree without re-lighting Malikas", () => {
  // Simulate adding platforms later — the parent must never win over a child.
  const future = [
    ...V2_NAV_LINKS,
    { href: "/v2/catalog/talabat", label: "كتالوج طلبات", icon: "catalog" as const },
  ];
  assert.equal(activeNavHref("/v2/catalog/talabat", future), "/v2/catalog/talabat");
  assert.equal(activeNavHref("/v2/catalog/talabat/xyz", future), "/v2/catalog/talabat", "and its sub-pages");
  // The existing routes are unaffected by the addition.
  assert.equal(activeNavHref("/v2/catalog", future), "/v2/catalog");
  assert.equal(activeNavHref("/v2/catalog/shopify", future), "/v2/catalog/shopify");
  assert.equal(activeNavHref("/v2/catalog/some-product", future), "/v2/catalog");
});

test("nav rule: matches whole segments only, and tolerates missing/foreign paths", () => {
  // A sibling route that merely shares a prefix must NOT light the catalog link.
  assert.equal(activeNavHref("/v2/catalogue"), null);
  assert.equal(activeNavHref("/v2/catalog-archive"), null);
  // HOME.1 — /v2 is now the Executive Home link (exact-match only; it never
  // becomes a subtree catch-all, so the foreign paths above still resolve null).
  assert.equal(activeNavHref("/v2"), "/v2");
  assert.equal(activeNavHref("/dashboard"), null);
  assert.equal(activeNavHref(null), null);
  assert.equal(activeNavHref(undefined), null);
  assert.equal(activeNavHref(""), null);
});

// ── Auth ─────────────────────────────────────────────────────────────────────

test("/v2/catalog/shopify is auth-protected by the (v2) layout, not public", () => {
  const layout = strip(readFileSync(new URL("../../app/(v2)/v2/layout.tsx", import.meta.url), "utf8"));
  assert.ok(/auth\.getUser\s*\(/.test(layout), "layout checks the session");
  assert.ok(/redirect\(\s*["']\/login["']\s*\)/.test(layout), "redirects to /login");
  // The page itself must not opt out of that gate.
  assert.ok(!/export const runtime|force-static/.test(strip(PAGE_SRC)), "page does not bypass the gate");
});
