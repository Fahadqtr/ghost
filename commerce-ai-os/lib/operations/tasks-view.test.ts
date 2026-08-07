// Smart Tasks view-layer tests (Phase UI.7.3). PURE — no db/network/clock.
// Run: node --conditions=react-server --experimental-strip-types --test lib/operations/tasks-view.test.ts

import test from "node:test";
import assert from "node:assert/strict";

import {
  flattenTasks,
  sortTaskViews,
  filterTaskViews,
  searchTaskViews,
  summarizeTasks,
  paginateTaskViews,
  parseTaskControls,
  selectTaskPage,
  productWidgetTasks,
  TASK_ICONS,
  TASK_FILTER_VALUES,
  TASK_FILTER_LABELS,
  TASK_PAGE_SIZE,
  type TaskViewItem,
} from "./tasks-view.ts";
import type { OperationsListItem } from "./dashboard-view.ts";
import type { OperationTask, TaskPriority, TaskType } from "./shared/models.ts";
import { makeProduct } from "./shared/test-fixtures.ts";
import { computeProductReadiness } from "./readiness/readiness.ts";
import { computePlatformStatuses } from "./platforms/platform-status.ts";
import { generateProductTasks } from "./tasks/task-engine.ts";
import { toListItem } from "./dashboard-view.ts";

// ── helpers ──────────────────────────────────────────────────────────────────

let seq = 0;
function mkTask(over: Partial<OperationTask> = {}): OperationTask {
  seq += 1;
  return {
    id: over.id ?? `t${seq}`,
    productId: over.productId ?? "p1",
    type: over.type ?? "needs_data",
    priority: over.priority ?? "medium",
    title: over.title ?? "مهمة",
    description: over.description ?? "وصف المهمة",
    reason: over.reason ?? "سبب",
    ...(over.platform ? { platform: over.platform } : {}),
  };
}

function tv(over: Partial<TaskViewItem> & { task?: Partial<OperationTask> } = {}): TaskViewItem {
  const task = mkTask(over.task);
  return {
    task,
    productId: over.productId ?? task.productId,
    sku: over.sku ?? "mk1",
    barcode: over.barcode ?? "6291041500001",
    nameAr: over.nameAr ?? "اسم عربي",
    nameEn: over.nameEn ?? "English Name",
    imageUrl: over.imageUrl ?? null,
    readinessPercent: over.readinessPercent ?? 50,
  };
}

// ── flatten ──────────────────────────────────────────────────────────────────

test("flattenTasks joins each task to its product's display fields, engine order preserved", () => {
  const items: OperationsListItem[] = [
    {
      id: "pA", sku: "A", barcode: "b1", nameAr: "أ", nameEn: "A", price: 10, imageUrl: null,
      readinessPercent: 40, readinessStatus: "incomplete", reasons: [], isNew: false,
      needsImage: true, needsReview: false, taskCount: 2, platforms: [],
      tasks: [mkTask({ id: "x1", productId: "pA" }), mkTask({ id: "x2", productId: "pA" })],
    },
    {
      id: "pB", sku: "B", barcode: "b2", nameAr: "ب", nameEn: "B", price: 20, imageUrl: "u",
      readinessPercent: 90, readinessStatus: "ready", reasons: [], isNew: false,
      needsImage: false, needsReview: false, taskCount: 1, platforms: [],
      tasks: [mkTask({ id: "y1", productId: "pB" })],
    },
  ];
  const flat = flattenTasks(items);
  assert.deepEqual(flat.map((f) => f.task.id), ["x1", "x2", "y1"]);
  assert.equal(flat[0]!.productId, "pA");
  assert.equal(flat[0]!.sku, "A");
  assert.equal(flat[2]!.imageUrl, "u");
  assert.equal(flat[2]!.readinessPercent, 90);
});

// ── sort ─────────────────────────────────────────────────────────────────────

test("sortTaskViews orders high→medium→low, then type, then id; stable + non-mutating", () => {
  const input = [
    tv({ task: { id: "c", priority: "low", type: "needs_image" } }),
    tv({ task: { id: "a", priority: "high", type: "needs_review" } }),
    tv({ task: { id: "b", priority: "high", type: "needs_image" } }),
    tv({ task: { id: "d", priority: "medium", type: "needs_data" } }),
  ];
  const before = input.map((i) => i.task.id);
  const sorted = sortTaskViews(input);
  assert.deepEqual(sorted.map((i) => i.task.id), ["b", "a", "d", "c"]);
  assert.deepEqual(input.map((i) => i.task.id), before, "does not mutate the input array");
});

// ── filters ──────────────────────────────────────────────────────────────────

test("priority + type filters select exactly the matching tasks", () => {
  const items = [
    tv({ task: { id: "h", priority: "high", type: "needs_review" } }),
    tv({ task: { id: "m", priority: "medium", type: "needs_image" } }),
    tv({ task: { id: "l", priority: "low", type: "new_product" } }),
  ];
  assert.deepEqual(filterTaskViews(items, "all").map((i) => i.task.id), ["h", "m", "l"]);
  assert.deepEqual(filterTaskViews(items, "high").map((i) => i.task.id), ["h"]);
  assert.deepEqual(filterTaskViews(items, "medium").map((i) => i.task.id), ["m"]);
  assert.deepEqual(filterTaskViews(items, "low").map((i) => i.task.id), ["l"]);
  assert.deepEqual(filterTaskViews(items, "needs_image").map((i) => i.task.id), ["m"]);
  assert.deepEqual(filterTaskViews(items, "needs_review").map((i) => i.task.id), ["h"]);
  assert.deepEqual(filterTaskViews(items, "new_product").map((i) => i.task.id), ["l"]);
});

test("platform filters match a task's platform, and an unknown platform yields NOTHING", () => {
  const items = [
    tv({ task: { id: "s", type: "publish_platform", platform: "shopify" } }),
    tv({ task: { id: "p", type: "platform_review", platform: "puresoul" } }),
    tv({ task: { id: "none", type: "needs_data" } }), // no platform
  ];
  assert.deepEqual(filterTaskViews(items, "shopify").map((i) => i.task.id), ["s"]);
  assert.deepEqual(filterTaskViews(items, "puresoul").map((i) => i.task.id), ["p"]);
  // Talabat/Rafeeq have no task here → the filter is empty (never a false "missing").
  assert.deepEqual(filterTaskViews(items, "talabat"), []);
  assert.deepEqual(filterTaskViews(items, "rafeeq"), []);
});

test("an UNKNOWN platform (no trusted snapshot) never produces a task, so its filter is empty", () => {
  // Real engine path: a fully-ready product with NO platform snapshots at all.
  // The engine reports every platform "unknown" and emits no publish task.
  const p = makeProduct({ platforms: undefined });
  const r = computeProductReadiness(p);
  const s = computePlatformStatuses(p, r.readyToPublish);
  const t = generateProductTasks(p, r, s);
  const item = toListItem(p, r, t, s);
  const flat = flattenTasks([item]);
  for (const plat of ["shopify", "puresoul", "talabat", "rafeeq"] as const) {
    assert.equal(filterTaskViews(flat, plat).length, 0, `${plat} has no task when its presence is unknown`);
  }
});

// ── search ───────────────────────────────────────────────────────────────────

test("searchTaskViews matches sku/barcode/nameAr/nameEn case-insensitively; blank = passthrough", () => {
  const items = [
    tv({ sku: "MK-RED", barcode: "111", nameAr: "أحمر", nameEn: "Red Lipstick" }),
    tv({ sku: "MK-BLUE", barcode: "222", nameAr: "أزرق", nameEn: "Blue Serum" }),
  ];
  assert.equal(searchTaskViews(items, "red").length, 1);
  assert.equal(searchTaskViews(items, "RED").length, 1);
  assert.equal(searchTaskViews(items, "222").length, 1);
  assert.equal(searchTaskViews(items, "أزرق").length, 1);
  assert.equal(searchTaskViews(items, "   ").length, 2, "whitespace-only query is a passthrough");
  assert.equal(searchTaskViews(items, "nomatch").length, 0);
});

// ── summary ──────────────────────────────────────────────────────────────────

test("summarizeTasks counts over the WHOLE set", () => {
  const items = [
    tv({ task: { priority: "high", type: "needs_image" } }),
    tv({ task: { priority: "high", type: "needs_review" } }),
    tv({ task: { priority: "medium", type: "needs_data" } }),
    tv({ task: { priority: "low", type: "new_product" } }),
  ];
  const s = summarizeTasks(items);
  assert.equal(s.total, 4);
  assert.equal(s.high, 2);
  assert.equal(s.medium, 1);
  assert.equal(s.low, 1);
  assert.equal(s.needsImage, 1);
  assert.equal(s.needsReview, 1);
});

test("summarizeTasks on an empty set is all zeros", () => {
  assert.deepEqual(summarizeTasks([]), { total: 0, high: 0, medium: 0, low: 0, needsImage: 0, needsReview: 0 });
});

// ── pagination ───────────────────────────────────────────────────────────────

test("paginateTaskViews clamps the page and slices by page size", () => {
  const items = Array.from({ length: TASK_PAGE_SIZE * 2 + 3 }, (_, i) => tv({ task: { id: `t${i}` } }));
  const first = paginateTaskViews(items, 1);
  assert.equal(first.items.length, TASK_PAGE_SIZE);
  assert.equal(first.page, 1);
  assert.equal(first.totalPages, 3);
  assert.equal(first.total, items.length);
  assert.equal(first.startIndex, 0);

  const last = paginateTaskViews(items, 99);
  assert.equal(last.page, 3, "requested page is clamped to the last page");
  assert.equal(last.items.length, 3);
  assert.equal(last.startIndex, TASK_PAGE_SIZE * 2);

  const low = paginateTaskViews(items, 0);
  assert.equal(low.page, 1, "page < 1 clamps up to 1");
});

test("paginateTaskViews on empty gives one empty page, not zero pages", () => {
  const p = paginateTaskViews([], 1);
  assert.equal(p.totalPages, 1);
  assert.equal(p.total, 0);
  assert.equal(p.items.length, 0);
});

// ── parse controls ───────────────────────────────────────────────────────────

test("parseTaskControls validates the filter, clamps the page, trims the query", () => {
  assert.deepEqual(parseTaskControls({ filter: "high", query: "abc", page: "2" }), { query: "abc", filter: "high", page: 2 });
  assert.deepEqual(parseTaskControls({ filter: "bogus" }), { query: "", filter: "all", page: 1 });
  assert.equal(parseTaskControls({ page: "-5" }).page, 1);
  assert.equal(parseTaskControls({ page: "notnum" }).page, 1);
  assert.equal(parseTaskControls({ query: ["first", "second"] }).filter, "all");
  assert.equal(parseTaskControls({ query: ["first", "second"] }).query, "first", "array param → first value");
  assert.equal(parseTaskControls(undefined).filter, "all");
  assert.equal(parseTaskControls(null).page, 1);
  assert.equal(parseTaskControls({ query: "x".repeat(200) }).query.length, 80, "query is length-capped");
});

// ── end-to-end pipeline ──────────────────────────────────────────────────────

test("selectTaskPage runs sort → filter → search → paginate together", () => {
  const items = [
    tv({ sku: "keep", task: { id: "a", priority: "low", type: "needs_image" } }),
    tv({ sku: "keep", task: { id: "b", priority: "high", type: "needs_image" } }),
    tv({ sku: "drop", task: { id: "c", priority: "high", type: "needs_image" } }),
  ];
  const page = selectTaskPage(items, { query: "keep", filter: "needs_image", page: 1 });
  // 'drop' filtered out by search; remaining sorted high-first.
  assert.deepEqual(page.items.map((i) => i.task.id), ["b", "a"]);
  assert.equal(page.total, 2);
});

// ── icons + widget ───────────────────────────────────────────────────────────

test("TASK_ICONS maps every task type to a key", () => {
  const types: TaskType[] = ["needs_image", "needs_data", "needs_review", "new_product", "publish_platform", "platform_review"];
  for (const t of types) assert.equal(typeof TASK_ICONS[t], "string");
});

test("productWidgetTasks shows the first N and reports the remainder", () => {
  const tasks = Array.from({ length: 5 }, (_, i) => mkTask({ id: `w${i}` }));
  const { shown, remaining } = productWidgetTasks(tasks, 3);
  assert.equal(shown.length, 3);
  assert.equal(remaining, 2);
  assert.deepEqual(shown.map((t) => t.id), ["w0", "w1", "w2"]);

  const few = productWidgetTasks(tasks.slice(0, 2), 3);
  assert.equal(few.shown.length, 2);
  assert.equal(few.remaining, 0, "never negative");
});

// ── filter labels cover every value ──────────────────────────────────────────

test("every TASK_FILTER value has a label", () => {
  for (const f of TASK_FILTER_VALUES) {
    assert.equal(typeof TASK_FILTER_LABELS[f], "string");
    assert.ok(TASK_FILTER_LABELS[f].length > 0);
  }
});

// priority ordering constant is exercised above; keep a tiny direct check.
test("priority values are the three known ranks", () => {
  const ranks: TaskPriority[] = ["high", "medium", "low"];
  assert.equal(ranks.length, 3);
});
