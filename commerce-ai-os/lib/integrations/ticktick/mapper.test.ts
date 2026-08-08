// TickTick mapper tests (Phase UI.7.5). PURE — no db/network/clock.
// Run: node --conditions=react-server --experimental-strip-types --test lib/integrations/ticktick/mapper.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  buildMarker, parseMarker, priorityToTickTick, projectKeyFor, resolveProjectId,
  productUrl, buildTitle, buildContent, mapTaskToPayload, summarizeContent, DEFAULT_APP_URL,
} from "./mapper.ts";
import type { OperationTask } from "../../operations/shared/models.ts";
import type { TaskViewItem } from "../../operations/tasks-view.ts";
import type { TickTickProjectMap } from "./types.ts";

function mkTask(over: Partial<OperationTask> = {}): OperationTask {
  return {
    id: over.id ?? "needs_image:p1",
    productId: over.productId ?? "p1",
    type: over.type ?? "needs_image",
    priority: over.priority ?? "high",
    title: over.title ?? "إضافة صورة",
    description: over.description ?? "أضف صورة للمنتج.",
    reason: over.reason ?? "لا توجد صورة.",
    ...(over.platform ? { platform: over.platform } : {}),
  };
}

function mkItem(over: Partial<TaskViewItem> & { task?: Partial<OperationTask> } = {}): TaskViewItem {
  const task = mkTask(over.task);
  return {
    task,
    productId: over.productId ?? task.productId,
    sku: over.sku ?? "MK2239",
    barcode: over.barcode ?? "6291041500213",
    nameAr: over.nameAr ?? "كريم مرطب",
    nameEn: over.nameEn ?? "Hydrating Cream",
    imageUrl: over.imageUrl ?? null,
    readinessPercent: over.readinessPercent ?? 40,
  };
}

const FULL_MAP: TickTickProjectMap = {
  photos: "PJ_PHOTOS", review: "PJ_REVIEW", new_products: "PJ_NEW",
  shopify: "PJ_SHOP", puresoul: "PJ_PS", talabat: "PJ_TAL", rafeeq: "PJ_RAF",
};

// ── marker (deterministic identity) ──────────────────────────────────────────

test("buildMarker/parseMarker round-trip; foreign content has no marker", () => {
  const m = buildMarker("publish_platform:shopify:p1");
  assert.equal(parseMarker(m), "publish_platform:shopify:p1");
  assert.equal(parseMarker("a manual personal task"), null);
  assert.equal(parseMarker(null), null);
  assert.equal(parseMarker(`some text\n${m}\nmore`), "publish_platform:shopify:p1");
});

// ── priority (mapped only, never computed) ───────────────────────────────────

test("priority maps high→5, medium→3, low→1", () => {
  assert.equal(priorityToTickTick("high"), 5);
  assert.equal(priorityToTickTick("medium"), 3);
  assert.equal(priorityToTickTick("low"), 1);
});

// ── project routing ──────────────────────────────────────────────────────────

test("projectKeyFor routes by type and platform", () => {
  assert.equal(projectKeyFor(mkTask({ type: "needs_image" })), "photos");
  assert.equal(projectKeyFor(mkTask({ type: "new_product" })), "new_products");
  assert.equal(projectKeyFor(mkTask({ type: "needs_review" })), "review");
  assert.equal(projectKeyFor(mkTask({ type: "needs_data" })), "review");
  assert.equal(projectKeyFor(mkTask({ type: "publish_platform", platform: "shopify" })), "shopify");
  assert.equal(projectKeyFor(mkTask({ type: "platform_review", platform: "talabat" })), "talabat");
  assert.equal(projectKeyFor(mkTask({ type: "publish_platform" })), "review", "no platform → review");
});

test("resolveProjectId returns configured id, else undefined", () => {
  assert.equal(resolveProjectId("photos", FULL_MAP), "PJ_PHOTOS");
  assert.equal(resolveProjectId("shopify", FULL_MAP), "PJ_SHOP");
  assert.equal(resolveProjectId("photos", {}), undefined);
  assert.equal(resolveProjectId("photos", { photos: "   " }), undefined, "blank id → undefined");
});

// ── product URL ──────────────────────────────────────────────────────────────

test("productUrl uses the default domain, trims trailing slash, encodes id", () => {
  assert.equal(productUrl("p1"), `${DEFAULT_APP_URL}/v2/catalog/p1`);
  assert.equal(productUrl("p1", "https://example.test/"), "https://example.test/v2/catalog/p1");
  assert.ok(productUrl("a b").endsWith("/v2/catalog/a%20b"));
});

// ── title + content ──────────────────────────────────────────────────────────

test("buildTitle appends the product label (SKU) to the engine title", () => {
  assert.equal(buildTitle(mkItem()), "إضافة صورة — MK2239");
  assert.equal(buildTitle(mkItem({ sku: "", nameAr: "منتج" })), "إضافة صورة — منتج", "falls back to name when SKU is blank");
});

test("buildContent carries every required field, the reason, platform and marker", () => {
  const item = mkItem({ task: { type: "publish_platform", platform: "shopify", reason: "جاهز للنشر." } });
  const c = buildContent(item, "https://example.test");
  assert.ok(c.includes("SKU: MK2239"));
  assert.ok(c.includes("الباركود: 6291041500213"));
  assert.ok(c.includes("كريم مرطب"));
  assert.ok(c.includes("Hydrating Cream"));
  assert.ok(c.includes("السبب: جاهز للنشر."));
  assert.ok(c.includes("Shopify"));
  assert.ok(c.includes("https://example.test/v2/catalog/p1"));
  assert.equal(parseMarker(c), item.task.id, "content embeds the deterministic marker");
});

test("buildContent omits the platform line when there is no platform", () => {
  const c = buildContent(mkItem({ task: { type: "needs_image", platform: undefined } }));
  assert.ok(!c.includes("المنصة:"));
});

// ── full payload ─────────────────────────────────────────────────────────────

test("mapTaskToPayload builds a routed, prioritized payload from a configured list", () => {
  const mapped = mapTaskToPayload(mkItem(), { projectMap: FULL_MAP });
  assert.equal(mapped.projectId, "PJ_PHOTOS");
  assert.equal(mapped.projectKey, "photos");
  assert.equal(mapped.payload.projectId, "PJ_PHOTOS");
  assert.equal(mapped.payload.priority, 5);
  assert.equal(mapped.payload.title, "إضافة صورة — MK2239");
  assert.equal(parseMarker(mapped.payload.content), "needs_image:p1");
});

test("mapTaskToPayload leaves projectId undefined when the list is unconfigured", () => {
  const mapped = mapTaskToPayload(mkItem(), { projectMap: {} });
  assert.equal(mapped.projectId, undefined);
  assert.ok(!("projectId" in mapped.payload), "no projectId key → adapter will skip, never Inbox");
});

// ── content summary (previews) ───────────────────────────────────────────────

test("summarizeContent strips the marker line and clamps the length", () => {
  const c = buildContent(mkItem(), "https://example.test");
  const s = summarizeContent(c);
  assert.ok(!s.includes("[[malikas:"), "the deterministic marker line is removed");
  assert.ok(s.includes("SKU: MK2239"), "keeps the human-readable fields");
  assert.ok(summarizeContent("a".repeat(500)).length <= 200, "clamped to the max");
  assert.equal(summarizeContent(null), "", "null content → empty summary");
});

// ── the mapper carries NO business rules ─────────────────────────────────────

test("mapper source contains no engine/business-logic imports", () => {
  const src = readFileSync(new URL("./mapper.ts", import.meta.url), "utf8");
  for (const banned of ["computeProductReadiness", "generateProductTasks", "task-engine", "readiness", "supabase", "fetch(", "Date.now", "new Date(", "Math.random"]) {
    assert.ok(!src.includes(banned), `mapper must not contain ${banned}`);
  }
});
