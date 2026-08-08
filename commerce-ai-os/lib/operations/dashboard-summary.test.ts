// Operations Dashboard summary-layer tests (Phase UI.8). PURE + source-safety
// scans for the upgraded page/component.
// Run: node --conditions=react-server --experimental-strip-types --test lib/operations/dashboard-summary.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  annotateTickTick,
  buildKpis,
  buildQueues,
  buildPlatformOverview,
  buildDashboardSummary,
  DEFAULT_QUEUE_TOP,
} from "./dashboard-summary.ts";
import type { OperationsListItem } from "./dashboard-view.ts";
import type { HealthSummary, OperationTask, PlatformStatus, PlatformStatusValue, TaskPriority } from "./shared/models.ts";

function shopify(status: PlatformStatusValue): PlatformStatus[] {
  return [{ platform: "shopify", status, label: "x" }];
}

function task(priority: TaskPriority, id = "needs_image:p"): OperationTask {
  return { id, productId: "p", type: "needs_image", priority, title: "t", description: "d", reason: "r" };
}

function mk(over: Partial<OperationsListItem> = {}): OperationsListItem {
  return {
    id: "p",
    sku: null,
    barcode: null,
    nameAr: null,
    nameEn: null,
    price: null,
    imageUrl: null,
    readinessPercent: 50,
    readinessStatus: "incomplete",
    reasons: [],
    isNew: false,
    needsImage: false,
    needsReview: false,
    taskCount: 0,
    tasks: [],
    platforms: shopify("unknown"),
    ...over,
  };
}

const health = (over: Partial<HealthSummary> = {}): HealthSummary => ({
  totalProducts: 0,
  readyProducts: 0,
  needsImage: 0,
  newProducts: 0,
  generatedTasks: 0,
  readinessAverage: 0,
  ...over,
});

test("buildKpis: totals come from health; counts come from items", () => {
  const items = [
    mk({ id: "a", needsReview: true, tasks: [task("high", "needs_image:a")], platforms: shopify("missing") }),
    mk({ id: "b", tasks: [task("high", "needs_image:b"), task("low", "needs_data:b")], platforms: shopify("different") }),
    mk({ id: "c", platforms: shopify("unknown"), ticktickSyncedCount: 3 }),
  ];
  const k = buildKpis(items, health({ totalProducts: 3, newProducts: 1, needsImage: 2, readyProducts: 1, generatedTasks: 9, readinessAverage: 42 }));
  assert.equal(k.totalProducts, 3);
  assert.equal(k.newProducts, 1);
  assert.equal(k.needsImage, 2);
  assert.equal(k.ready, 1);
  assert.equal(k.totalTasks, 9);
  assert.equal(k.readinessAverage, 42);
  assert.equal(k.needsReview, 1, "counted from items");
  assert.equal(k.highPriorityTasks, 2, "two high tasks across items");
  assert.equal(k.shopifyMissing, 1);
  assert.equal(k.shopifyDifferent, 1);
  assert.equal(k.ticktickLinkedTasks, 3, "sum of ticktickSyncedCount");
});

test("buildKpis: unknown Shopify status is never counted as missing", () => {
  const items = [mk({ platforms: shopify("unknown") }), mk({ platforms: shopify("unknown") })];
  const k = buildKpis(items, health({ totalProducts: 2 }));
  assert.equal(k.shopifyMissing, 0);
  assert.equal(k.shopifyDifferent, 0);
});

test("buildQueues: full totals + top-N limiting per queue", () => {
  const news = Array.from({ length: 7 }, (_, i) => mk({ id: `n${i}`, isNew: true }));
  const queues = buildQueues(news, DEFAULT_QUEUE_TOP);
  const newQ = queues.find((q) => q.key === "new")!;
  assert.equal(newQ.total, 7, "counts all matching");
  assert.equal(newQ.items.length, DEFAULT_QUEUE_TOP, "ships only the top N");
});

test("buildQueues: platform_issues = trusted negative shopify verdicts only (unknown excluded)", () => {
  const items = [
    mk({ id: "miss", platforms: shopify("missing") }),
    mk({ id: "diff", platforms: shopify("different") }),
    mk({ id: "rev", platforms: shopify("review_required") }),
    mk({ id: "unk", platforms: shopify("unknown") }),
    mk({ id: "pub", platforms: shopify("published") }),
  ];
  const q = buildQueues(items).find((x) => x.key === "platform_issues")!;
  assert.equal(q.total, 3, "missing + different + review_required only");
  assert.equal(q.items.some((i) => i.id === "unk"), false, "unknown is not an issue");
  assert.equal(q.items.some((i) => i.id === "pub"), false, "published is not an issue");
});

test("buildQueues: high_priority needs a high task; queue items are compact (no tasks array)", () => {
  const items = [
    mk({ id: "hp", tasks: [task("high", "needs_image:hp")] }),
    mk({ id: "lp", tasks: [task("low", "needs_data:lp")] }),
  ];
  const q = buildQueues(items).find((x) => x.key === "high_priority")!;
  assert.deepEqual(q.items.map((i) => i.id), ["hp"]);
  assert.equal("tasks" in (q.items[0] as Record<string, unknown>), false, "queue item is compact");
});

test("buildPlatformOverview: Shopify counted by status; other platforms not-connected (never missing)", () => {
  const items = [
    mk({ platforms: shopify("published") }),
    mk({ platforms: shopify("missing") }),
    mk({ platforms: shopify("different") }),
    mk({ platforms: shopify("unknown") }),
  ];
  const ov = buildPlatformOverview(items, true);
  assert.equal(ov.shopify.available, true);
  assert.equal(ov.shopify.published, 1);
  assert.equal(ov.shopify.missing, 1);
  assert.equal(ov.shopify.different, 1);
  assert.equal(ov.puresoul.available, false, "PureSoul not passed → not connected");
  assert.equal(ov.talabat, "not_connected");
  assert.equal(ov.rafeeq, "not_connected");
});

function puresoul(status: PlatformStatusValue): PlatformStatus[] {
  return [{ platform: "puresoul", status, label: "x" }];
}

test("buildPlatformOverview: PureSoul counts published/out-of-stock/review; unknown never missing", () => {
  const items = [
    mk({ id: "a", platforms: puresoul("published") }),
    mk({ id: "b", platforms: puresoul("ready") }), // مخلّصة (out of stock)
    mk({ id: "c", platforms: puresoul("ready") }),
    mk({ id: "d", platforms: puresoul("review_required") }),
    mk({ id: "e", platforms: puresoul("unknown") }),
  ];
  const ov = buildPlatformOverview(items, false, true);
  assert.equal(ov.puresoul.available, true);
  assert.equal(ov.puresoul.published, 1);
  assert.equal(ov.puresoul.outOfStock, 2);
  assert.equal(ov.puresoul.reviewRequired, 1);
  // there is no "missing" field for PureSoul — unknown is simply not counted.
});

test("buildPlatformOverview: degraded Shopify → available:false, unknown rows not counted missing", () => {
  const items = [mk({ platforms: shopify("unknown") }), mk({ platforms: shopify("unknown") })];
  const ov = buildPlatformOverview(items, false);
  assert.equal(ov.shopify.available, false);
  assert.equal(ov.shopify.missing, 0, "unknown is never missing");
});

test("annotateTickTick: sets per-item synced count from the marker set; empty set → 0", () => {
  const items = [
    mk({ id: "a", tasks: [task("high", "needs_image:a"), task("low", "needs_data:a")] }),
    mk({ id: "b", tasks: [task("high", "needs_image:b")] }),
  ];
  const annotated = annotateTickTick(items, new Set(["needs_image:a", "needs_data:a"]));
  assert.equal(annotated[0].ticktickSyncedCount, 2);
  assert.equal(annotated[1].ticktickSyncedCount, 0);
  // pure: inputs are not mutated
  assert.equal(items[0].ticktickSyncedCount, undefined);
  assert.equal(annotateTickTick(items, new Set())[0].ticktickSyncedCount, 0);
});

test("buildDashboardSummary: one-shot assembly (kpis + queues + overview)", () => {
  const items = [mk({ id: "n", isNew: true, tasks: [task("high", "needs_image:n")] })];
  const s = buildDashboardSummary(items, health({ totalProducts: 1, newProducts: 1, generatedTasks: 1 }), true);
  assert.equal(s.kpis.newProducts, 1);
  assert.equal(s.kpis.highPriorityTasks, 1);
  assert.equal(s.queues.find((q) => q.key === "new")!.total, 1);
  assert.equal(s.platformOverview.shopify.available, true);
});

// ── source-safety scans for the upgraded page + component (Phase UI.8) ────────

const PAGE_SRC = readFileSync(new URL("../../app/(v2)/v2/operations/page.tsx", import.meta.url), "utf8");
const DASH_SRC = readFileSync(new URL("../../components/v2/operations/OperationsDashboard.tsx", import.meta.url), "utf8");

test("page: computes summary server-side, best-effort TickTick, session client, no writes", () => {
  assert.ok(PAGE_SRC.includes('export const dynamic = "force-dynamic"'));
  assert.ok(PAGE_SRC.includes("loadOperationsDashboard"), "reuses the read model");
  assert.ok(PAGE_SRC.includes("buildDashboardSummary"), "KPIs/queues computed server-side");
  assert.ok(PAGE_SRC.includes("annotateTickTick"));
  assert.ok(PAGE_SRC.includes("loadTickTickSyncedIds"));
  assert.ok(PAGE_SRC.includes(".catch("), "TickTick failure must never break the dashboard");
  assert.ok(PAGE_SRC.includes("selectOperationsPage"), "list is paginated server-side (bounded)");
  assert.ok(PAGE_SRC.includes("تعذر تحميل مركز العمليات"), "fixed Arabic load error");
  for (const banned of ["createAdminClient", "service_role", ".insert(", ".update(", ".delete(", ".rpc("]) {
    assert.ok(!PAGE_SRC.includes(banned), `page must not contain ${banned}`);
  }
});

test("component: no business logic, no DB/write, no client JS; renders KPIs/queues/overview + degraded states", () => {
  for (const banned of ["computeProductReadiness", "generateProductTasks", "computeHealthSummary", "@/lib/supabase", "createClient", "createAdminClient", ".insert(", ".update(", '"use client"']) {
    assert.ok(!DASH_SRC.includes(banned), `component must not contain ${banned}`);
  }
  // KPI labels present
  assert.ok(DASH_SRC.includes("أولوية عالية"), "high-priority KPI");
  assert.ok(DASH_SRC.includes("مهام مربوطة بـ TickTick"), "TickTick-linked KPI");
  assert.ok(DASH_SRC.includes("متوسط الجاهزية"), "readiness average KPI");
  // queues + platform overview + degraded states
  assert.ok(DASH_SRC.includes("قوائم العمل"), "queues section");
  assert.ok(DASH_SRC.includes("عرض الكل"), "queue view-all link");
  assert.ok(DASH_SRC.includes("نظرة عامة على المنصات"), "platform overview section");
  assert.ok(DASH_SRC.includes("المصدر الرئيسي"), "Malikas source-of-truth");
  assert.ok(DASH_SRC.includes("تعذر قراءة Shopify حاليًا"), "degraded Shopify message");
  assert.ok(DASH_SRC.includes("TickTick غير مربوط حاليًا"), "degraded TickTick message");
  // PureSoul (UI.9.1): real overview card + degraded banner + KPI/filter
  assert.ok(DASH_SRC.includes("PureSoulOverviewCard"), "PureSoul overview card");
  assert.ok(DASH_SRC.includes("تعذر قراءة PureSoul حاليًا"), "degraded PureSoul message");
  assert.ok(DASH_SRC.includes("puresoul_out_of_stock"), "PureSoul out-of-stock filter wired");
});
