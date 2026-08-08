// Smart Tasks reader + page/component source-safety (Phase UI.7.3).
// Functional tests inject the engines so this file loads directly under node:test.
// Run: node --conditions=react-server --experimental-strip-types --test lib/operations/tasks-read.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { loadTasksView, loadProductOperations, type OperationsEngines, type OperationsReadClient } from "./read-model.ts";
import { loadShopifyPresence } from "./shopify-presence.ts";
import { computeProductReadiness } from "./readiness/readiness.ts";
import { computePlatformStatuses } from "./platforms/platform-status.ts";
import { generateProductTasks } from "./tasks/task-engine.ts";
import { classifyNewProducts } from "./new-products/new-product-engine.ts";
import { computeHealthSummary } from "./health/health-engine.ts";
import { toListItem, mapProductRow } from "./dashboard-view.ts";
import { flattenTasks } from "./tasks-view.ts";

const engines: OperationsEngines = {
  computeProductReadiness,
  computePlatformStatuses,
  generateProductTasks,
  classifyNewProducts,
  computeHealthSummary,
  toListItem,
  mapProductRow,
  flattenTasks,
};

function fakeClient(products: unknown[], variants: unknown[]): OperationsReadClient {
  const builder = (rows: unknown[]) => {
    const b: {
      order: () => typeof b;
      range: (from: number, to: number) => Promise<{ data: unknown[]; error: null }>;
      then: (r: (v: { data: unknown[]; error: null }) => unknown) => Promise<unknown>;
    } = {
      order: () => b,
      range: async (from: number, to: number) => ({ data: rows.slice(from, to + 1), error: null }),
      then: (r) => Promise.resolve(r({ data: rows, error: null })),
    };
    return b;
  };
  return {
    from: (table: string) => ({ select: () => builder(table === "products" ? products : variants) }),
  } as unknown as OperationsReadClient;
}

const productRows = [
  { id: "newp", sku: "mk2", barcode: "6291041500022", name_ar: "جديد", name_en: "New", price: 15, image_url: "", main_category: "Makeup", brand_id: "b1", approval: "", platform_status: "", description_ar: "d", description_en: "d" },
  { id: "ready", sku: "mk1", barcode: "6291041500011", name_ar: "جاهز", name_en: "Ready", price: 20, image_url: "https://x/1.jpg", main_category: "Makeup", brand_id: "b1", approval: "Approved", platform_status: "shopify", description_ar: "d", description_en: "d" },
];
const variantRows = [{ parent_product_id: "ready" }];

// ── loadTasksView ─────────────────────────────────────────────────────────────

test("loadTasksView flattens the engine tasks into a flat TaskViewItem list", async () => {
  const res = await loadTasksView(fakeClient(productRows, variantRows), { engines });
  assert.equal(res.status, "ok");
  if (res.status !== "ok") return;
  assert.ok(Array.isArray(res.data.tasks));
  assert.ok(res.data.tasks.length > 0, "the incomplete/new product produces tasks");
  // every view item carries product display fields joined to a task
  for (const tvItem of res.data.tasks) {
    assert.equal(typeof tvItem.productId, "string");
    assert.equal(typeof tvItem.task.id, "string");
    assert.equal(typeof tvItem.readinessPercent, "number");
  }
  assert.equal(res.data.shopifyAvailable, false, "no shopify reader → degraded");
});

test("loadTasksView surfaces the single constant error on a DB failure", async () => {
  const errClient = {
    from: () => ({ select: () => ({ order: () => ({ range: async () => ({ data: null, error: { message: "boom" } }) }) }) }),
  } as unknown as OperationsReadClient;
  const res = await loadTasksView(errClient, { engines });
  assert.equal(res.status, "error");
});

// ── loadProductOperations ─────────────────────────────────────────────────────

test("loadProductOperations returns tasks + readiness for one product", async () => {
  const res = await loadProductOperations(fakeClient(productRows, variantRows), "newp", { engines });
  assert.ok(res !== null);
  assert.ok(Array.isArray(res!.tasks));
  assert.equal(typeof res!.readinessPercent, "number");
  // the new/incomplete product has at least one task
  assert.ok(res!.tasks.length > 0);
});

test("loadProductOperations returns null for an unknown id and for a blank id", async () => {
  assert.equal(await loadProductOperations(fakeClient(productRows, variantRows), "nope", { engines }), null);
  assert.equal(await loadProductOperations(fakeClient(productRows, variantRows), "", { engines }), null);
});

test("loadProductOperations returns null (never throws) on a DB failure", async () => {
  const errClient = {
    from: () => ({ select: () => ({ order: () => ({ range: async () => ({ data: null, error: { message: "boom" } }) }) }) }),
  } as unknown as OperationsReadClient;
  assert.equal(await loadProductOperations(errClient, "ready", { engines }), null);
});

// keep the real adapter import referenced (it is wired in the page).
test("the shopify presence adapter is importable", () => {
  assert.equal(typeof loadShopifyPresence, "function");
});

// ── source-safety scans ──────────────────────────────────────────────────────

const PAGE_SRC = readFileSync(new URL("../../app/(v2)/v2/tasks/page.tsx", import.meta.url), "utf8");
const LOADING_SRC = readFileSync(new URL("../../app/(v2)/v2/tasks/loading.tsx", import.meta.url), "utf8");
const SMART_SRC = readFileSync(new URL("../../components/v2/operations/SmartTasks.tsx", import.meta.url), "utf8");
const WIDGET_SRC = readFileSync(new URL("../../components/v2/operations/ProductTasksWidget.tsx", import.meta.url), "utf8");
const DETAIL_PAGE_SRC = readFileSync(new URL("../../app/(v2)/v2/catalog/[id]/page.tsx", import.meta.url), "utf8");

test("tasks page: force-dynamic, session client, no admin/service role, fixed Arabic error", () => {
  assert.ok(PAGE_SRC.includes('export const dynamic = "force-dynamic"'));
  assert.ok(PAGE_SRC.includes("createClient"));
  assert.ok(!PAGE_SRC.includes("createAdminClient"));
  assert.ok(!PAGE_SRC.includes("service_role"));
  assert.ok(PAGE_SRC.includes("loadTasksView"));
  assert.ok(PAGE_SRC.includes("تعذر تحميل المهام"));
});

test("tasks loading state is accessible", () => {
  assert.ok(LOADING_SRC.includes('aria-busy="true"'));
  assert.ok(LOADING_SRC.includes("sr-only"));
});

test("SmartTasks component: no business logic, no data access, no manual-completion action", () => {
  for (const banned of [
    "computeProductReadiness", "generateProductTasks", "generateTasks", "computeHealthSummary",
    "@/lib/supabase", "createClient", "createAdminClient",
    ".insert(", ".update(", ".delete(", ".rpc(",
    // NOTE: the TickTick status badge + owner-only sync form ARE allowed here
    // (Phase UI.7.5) — the ban below covers only MANUAL task completion/editing.
    'type="checkbox"', "إنجاز", "إكمال", "حذف",
  ]) {
    assert.ok(!SMART_SRC.includes(banned), `SmartTasks must not contain ${banned}`);
  }
  // the required empty state + the only action (open the product)
  assert.ok(SMART_SRC.includes("لا توجد مهام حالياً"));
  assert.ok(SMART_SRC.includes("فتح المنتج"));
  assert.ok(SMART_SRC.includes("/v2/catalog/"));
});

test("ProductTasksWidget: pure render, no data access, uses the view helper", () => {
  for (const banned of ["@/lib/supabase", "createClient", "createAdminClient", ".insert(", ".update(", ".rpc(", "computeProductReadiness", "generateProductTasks"]) {
    assert.ok(!WIDGET_SRC.includes(banned), `widget must not contain ${banned}`);
  }
  assert.ok(WIDGET_SRC.includes("productWidgetTasks"));
  assert.ok(WIDGET_SRC.includes("أخرى"));
});

test("the product detail page wires the tasks widget through the session-client reader", () => {
  assert.ok(DETAIL_PAGE_SRC.includes("loadProductOperations"));
  assert.ok(DETAIL_PAGE_SRC.includes("ProductTasksWidget"));
  assert.ok(!DETAIL_PAGE_SRC.includes("createAdminClient"));
  assert.ok(!DETAIL_PAGE_SRC.includes("service_role"));
});
