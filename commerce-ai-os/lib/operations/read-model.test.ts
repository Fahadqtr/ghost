// Operations read-model tests (Phase UI.7.2): orchestration + degraded Shopify
// + page/component source-safety scans. The engines are injected so this file
// loads directly under node:test.
// Run: node --conditions=react-server --experimental-strip-types --test lib/operations/read-model.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { loadOperationsDashboard, type OperationsEngines, type OperationsReadClient } from "./read-model.ts";
import { computeProductReadiness } from "./readiness/readiness.ts";
import { computePlatformStatuses } from "./platforms/platform-status.ts";
import { generateProductTasks } from "./tasks/task-engine.ts";
import { classifyNewProducts } from "./new-products/new-product-engine.ts";
import { computeHealthSummary } from "./health/health-engine.ts";
import { toListItem, mapProductRow } from "./dashboard-view.ts";
import { presence } from "./shared/test-fixtures.ts";

const engines: OperationsEngines = {
  computeProductReadiness,
  computePlatformStatuses,
  generateProductTasks,
  classifyNewProducts,
  computeHealthSummary,
  toListItem,
  mapProductRow,
};

/** A fake session client returning fixed product/variant rows. */
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
  { id: "ready", sku: "mk1", barcode: "6291041500011", name_ar: "جاهز", name_en: "Ready", price: 20, image_url: "https://x/1.jpg", main_category: "Makeup", brand_id: "b1", approval: "Approved", platform_status: "shopify", description_ar: "d", description_en: "d" },
  { id: "newp", sku: "mk2", barcode: "6291041500022", name_ar: "جديد", name_en: "New", price: 15, image_url: "https://x/2.jpg", main_category: "Makeup", brand_id: "b1", approval: "", platform_status: "", description_ar: "d", description_en: "d" },
  { id: "noimg", sku: "mk3", barcode: "6291041500033", name_ar: "بلا صورة", name_en: "NoImage", price: 15, image_url: "", main_category: "Makeup", brand_id: "b1", approval: "Approved", platform_status: "shopify", description_ar: "d", description_en: "d" },
];
const variantRows = [{ parent_product_id: "ready" }, { parent_product_id: "ready" }];

test("loads Malikas, computes engines, and buckets/health line up", async () => {
  const res = await loadOperationsDashboard(fakeClient(productRows, variantRows), { engines });
  assert.equal(res.status, "ok");
  if (res.status !== "ok") return;
  assert.equal(res.data.items.length, 3);
  assert.equal(res.data.health.totalProducts, 3);
  assert.equal(res.data.health.newProducts, 1);
  assert.equal(res.data.health.needsImage, 1);
  assert.deepEqual(res.data.buckets.newProducts, ["newp"]);
  assert.deepEqual(res.data.buckets.needsImage, ["noimg"]);
  // variant count rolled up
  const ready = res.data.items.find((i) => i.id === "ready")!;
  assert.ok(ready.platforms.some((p) => p.platform === "shopify"));
});

test("no Shopify reader → every platform is unknown, never missing (degraded honesty)", async () => {
  const res = await loadOperationsDashboard(fakeClient(productRows, variantRows), { engines });
  assert.equal(res.status, "ok");
  if (res.status !== "ok") return;
  assert.equal(res.data.shopifyAvailable, false);
  for (const it of res.data.items) {
    assert.equal(it.platforms.find((p) => p.platform === "shopify")?.status, "unknown");
    assert.equal(it.platforms.find((p) => p.platform === "puresoul")?.status, "unknown");
  }
});

test("Shopify reader that throws → degraded (available:false), Malikas still renders", async () => {
  const res = await loadOperationsDashboard(fakeClient(productRows, variantRows), {
    engines,
    shopify: { loadShopifyPresence: async () => { throw new Error("shopify down"); } },
  });
  assert.equal(res.status, "ok");
  if (res.status !== "ok") return;
  assert.equal(res.data.shopifyAvailable, false);
  assert.equal(res.data.items.length, 3, "Malikas rows still render when Shopify is down");
});

test("trusted Shopify presence flows into platform status", async () => {
  const res = await loadOperationsDashboard(fakeClient(productRows, variantRows), {
    engines,
    shopify: {
      loadShopifyPresence: async () => ({
        available: true,
        byProductId: new Map([["ready", presence({ linked: true, live: true })]]),
      }),
    },
  });
  assert.equal(res.status, "ok");
  if (res.status !== "ok") return;
  assert.equal(res.data.shopifyAvailable, true);
  const ready = res.data.items.find((i) => i.id === "ready")!;
  assert.equal(ready.platforms.find((p) => p.platform === "shopify")?.status, "published");
  const other = res.data.items.find((i) => i.id === "noimg")!;
  assert.equal(other.platforms.find((p) => p.platform === "shopify")?.status, "unknown", "no presence for this id → unknown");
});

test("a DB error yields the single constant error status — never a raw error", async () => {
  const errClient = {
    from: () => ({
      select: () => ({
        order: () => ({ range: async () => ({ data: null, error: { message: "boom" } }) }),
      }),
    }),
  } as unknown as OperationsReadClient;
  const res = await loadOperationsDashboard(errClient, { engines });
  assert.equal(res.status, "error");
});

// ── source-safety scans (page / component / read-model / adapter) ────────────

const READMODEL_SRC = readFileSync(new URL("./read-model.ts", import.meta.url), "utf8");
const PRESENCE_SRC = readFileSync(new URL("./shopify-presence.ts", import.meta.url), "utf8");
const PAGE_SRC = readFileSync(new URL("../../app/(v2)/v2/operations/page.tsx", import.meta.url), "utf8");
const DASH_SRC = readFileSync(new URL("../../components/v2/operations/OperationsDashboard.tsx", import.meta.url), "utf8");

test("read model + adapter: session-client only, no service role / admin / write / rpc / raw errors", () => {
  for (const src of [READMODEL_SRC, PRESENCE_SRC]) {
    for (const banned of ["service_role", "createAdminClient", ".insert(", ".update(", ".delete(", ".rpc(", "error.message"]) {
      assert.ok(!src.includes(banned), `read layer must not contain ${banned}`);
    }
  }
  assert.ok(READMODEL_SRC.includes('import "server-only"'));
});

test("page is force-dynamic, session client, no service role, and shows a fixed Arabic error", () => {
  assert.ok(PAGE_SRC.includes('export const dynamic = "force-dynamic"'));
  assert.ok(PAGE_SRC.includes("createClient"));
  assert.ok(!PAGE_SRC.includes("createAdminClient"));
  assert.ok(!PAGE_SRC.includes("service_role"));
  assert.ok(PAGE_SRC.includes("تعذر تحميل مركز العمليات"));
  assert.ok(PAGE_SRC.includes("loadOperationsDashboard"));
});

test("dashboard component has NO business logic and no write/DB access", () => {
  for (const banned of ["computeProductReadiness", "generateProductTasks", "computeHealthSummary", "@/lib/supabase", "createClient", "createAdminClient", ".insert(", ".update("]) {
    assert.ok(!DASH_SRC.includes(banned), `dashboard must not contain ${banned}`);
  }
  // it renders precomputed values + the degraded Shopify message
  assert.ok(DASH_SRC.includes("تعذر قراءة Shopify حاليًا"));
  assert.ok(DASH_SRC.includes("المصدر الرئيسي"));
});
