// Operations Dashboard view-layer tests (Phase UI.7.2). PURE.
// Run: node --conditions=react-server --experimental-strip-types --test lib/operations/dashboard-view.test.ts

import test from "node:test";
import assert from "node:assert/strict";

import {
  filterOperations,
  mapProductRow,
  OPERATIONS_PAGE_SIZE,
  paginateOperations,
  parseOperationsControls,
  searchOperations,
  selectOperationsPage,
  toListItem,
  type OperationsListItem,
} from "./dashboard-view.ts";
import { computeProductReadiness } from "./readiness/readiness.ts";
import { computePlatformStatuses } from "./platforms/platform-status.ts";
import { generateProductTasks } from "./tasks/task-engine.ts";
import { makeProduct, presence } from "./shared/test-fixtures.ts";

function item(over: Partial<OperationsListItem> = {}): OperationsListItem {
  // published on Shopify + unknown elsewhere → zero tasks by default, so
  // has_tasks / filter tests are driven only by explicit overrides.
  const p = makeProduct({ platforms: { shopify: presence({ linked: true, live: true }) }, ...(over.id ? { id: over.id } : {}) });
  const r = computeProductReadiness(p);
  const s = computePlatformStatuses(p, r.readyToPublish);
  const t = generateProductTasks(p, r, s);
  return { ...toListItem(p, r, t, s), ...over };
}

test("mapProductRow: whitelisted DB row → OperationsProduct; blanks null; expectsVariants stays unknown", () => {
  const p = mapProductRow(
    {
      id: "p9", sku: "mk9", barcode: "6291041500099", name_ar: "اسم", name_en: "Name",
      description_ar: "", description_en: "d", brand_id: "b1", main_category: "Makeup",
      price: 30, image_url: "https://x/y.jpg", approval: "Approved", platform_status: "",
    },
    2,
  );
  assert.equal(p.id, "p9");
  assert.equal(p.descriptionAr, null, "blank string → null");
  assert.equal(p.variantCount, 2);
  assert.equal(p.expectsVariants, undefined, "no trusted source → unknown");
  assert.equal(p.platforms, undefined, "no presence passed → omitted (engine reports unknown)");
});

test("mapProductRow attaches platform presence when provided", () => {
  const p = mapProductRow({ id: "p1", price: 5 }, 0, { shopify: presence({ linked: true, live: true }) });
  assert.equal(p.platforms?.shopify?.live, true);
});

test("toListItem is catalog-safe and carries the engine outputs", () => {
  const it = item({ id: "p1" });
  assert.equal(it.id, "p1");
  assert.equal(typeof it.readinessPercent, "number");
  assert.ok(Array.isArray(it.reasons));
  assert.ok(Array.isArray(it.tasks));
  assert.ok(it.platforms.some((p) => p.platform === "shopify"));
  assert.equal("approval" in (it as Record<string, unknown>), false, "no raw approval leaks to the client item");
});

test("filters select the right rows", () => {
  const items = [
    item({ id: "new1", isNew: true }),
    item({ id: "img1", needsImage: true }),
    item({ id: "rev1", needsReview: true }),
    item({ id: "ready1", readinessStatus: "ready" }),
    item({ id: "task1", taskCount: 3 }),
  ];
  assert.deepEqual(filterOperations(items, "new").map((i) => i.id), ["new1"]);
  assert.deepEqual(filterOperations(items, "needs_image").map((i) => i.id), ["img1"]);
  assert.deepEqual(filterOperations(items, "needs_review").map((i) => i.id), ["rev1"]);
  assert.deepEqual(filterOperations(items, "has_tasks").map((i) => i.id), ["task1"]);
  assert.equal(filterOperations(items, "all").length, items.length);
});

test("high_priority filter selects items with at least one high-priority task", () => {
  const high = item({
    id: "hp",
    tasks: [{ id: "needs_image:hp", productId: "hp", type: "needs_image", priority: "high", title: "t", description: "d", reason: "r" }],
  });
  const low = item({
    id: "lp",
    tasks: [{ id: "needs_data:lp", productId: "lp", type: "needs_data", priority: "low", title: "t", description: "d", reason: "r" }],
  });
  assert.deepEqual(filterOperations([high, low], "high_priority").map((i) => i.id), ["hp"]);
});

test("ticktick_synced filter selects items with ticktickSyncedCount > 0", () => {
  const synced = item({ id: "s", ticktickSyncedCount: 2 });
  const notSynced = item({ id: "n", ticktickSyncedCount: 0 });
  const none = item({ id: "x" }); // undefined count
  assert.deepEqual(filterOperations([synced, notSynced, none], "ticktick_synced").map((i) => i.id), ["s"]);
});

test("puresoul filters read the puresoul platform status (out-of-stock=ready, review)", () => {
  const outOfStock = item({ id: "oos", platforms: [{ platform: "puresoul", status: "ready", label: "x" }] });
  const review = item({ id: "rev", platforms: [{ platform: "puresoul", status: "review_required", label: "x" }] });
  const published = item({ id: "pub", platforms: [{ platform: "puresoul", status: "published", label: "x" }] });
  const unknown = item({ id: "unk", platforms: [{ platform: "puresoul", status: "unknown", label: "x" }] });
  const items = [outOfStock, review, published, unknown];
  assert.deepEqual(filterOperations(items, "puresoul_out_of_stock").map((i) => i.id), ["oos"]);
  assert.deepEqual(filterOperations(items, "puresoul_review").map((i) => i.id), ["rev"]);
  assert.equal(filterOperations(items, "puresoul_out_of_stock").some((i) => i.id === "unk"), false, "unknown is never out-of-stock");
});

test("shopify filters read the shopify platform status only", () => {
  const missing = item({ id: "m", platforms: [{ platform: "shopify", status: "missing", label: "غير موجود" }] });
  const different = item({ id: "d", platforms: [{ platform: "shopify", status: "different", label: "مختلف" }] });
  const unknown = item({ id: "u", platforms: [{ platform: "shopify", status: "unknown", label: "غير مربوط" }] });
  const items = [missing, different, unknown];
  assert.deepEqual(filterOperations(items, "shopify_missing").map((i) => i.id), ["m"]);
  assert.deepEqual(filterOperations(items, "shopify_different").map((i) => i.id), ["d"]);
  assert.equal(filterOperations(items, "shopify_missing").some((i) => i.id === "u"), false, "unknown is never missing");
});

test("search matches sku / barcode / arabic / english, case-insensitive", () => {
  const items = [
    item({ id: "a", sku: "mk777", barcode: "6291041500777", nameAr: "كريم", nameEn: "Rose Cream" }),
    item({ id: "b", sku: "mk888", barcode: "6291041500888", nameAr: "سيروم", nameEn: "Serum" }),
  ];
  assert.deepEqual(searchOperations(items, "MK777").map((i) => i.id), ["a"]);
  assert.deepEqual(searchOperations(items, "500888").map((i) => i.id), ["b"]);
  assert.deepEqual(searchOperations(items, "كريم").map((i) => i.id), ["a"]);
  assert.deepEqual(searchOperations(items, "serum").map((i) => i.id), ["b"]);
  assert.equal(searchOperations(items, "").length, 2);
});

test("pagination clamps and slices; never renders everything at once", () => {
  const items = Array.from({ length: OPERATIONS_PAGE_SIZE * 3 + 5 }, (_, i) => item({ id: `p${i}` }));
  const first = paginateOperations(items, 1);
  assert.equal(first.items.length, OPERATIONS_PAGE_SIZE);
  assert.equal(first.totalPages, 4);
  const clamped = paginateOperations(items, 999);
  assert.equal(clamped.page, 4, "out-of-range page clamps to the last");
  assert.equal(clamped.startIndex, OPERATIONS_PAGE_SIZE * 3);
});

test("parseOperationsControls validates filter, clamps page, bounds query", () => {
  assert.deepEqual(parseOperationsControls({ filter: "new", page: "2", query: "abc" }), {
    query: "abc", filter: "new", page: 2,
  });
  assert.equal(parseOperationsControls({ filter: "evil" }).filter, "all", "unknown filter falls back");
  assert.equal(parseOperationsControls({ page: "-9" }).page, 1);
  assert.equal(parseOperationsControls({ query: "x".repeat(500) }).query.length, 80);
  assert.deepEqual(parseOperationsControls(null), { query: "", filter: "all", page: 1 });
});

test("selectOperationsPage runs filter → search → paginate together", () => {
  const items = [
    item({ id: "new-rose", isNew: true, nameEn: "Rose" }),
    item({ id: "new-serum", isNew: true, nameEn: "Serum" }),
    item({ id: "ready1", readinessStatus: "ready", isNew: false, nameEn: "Rose" }),
  ];
  const res = selectOperationsPage(items, { filter: "new", query: "rose", page: 1 });
  assert.deepEqual(res.items.map((i) => i.id), ["new-rose"]);
});
