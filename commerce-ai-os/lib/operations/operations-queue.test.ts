// CI.2 — Unified Operations Queue (PURE) tests.
// Run: node --experimental-strip-types --test lib/operations/operations-queue.test.ts

import test from "node:test";
import assert from "node:assert/strict";

import {
  buildCrossPlatformIssues,
  groupOperationsQueues,
  buildOperationsQueues,
  sortIssues,
  selectQueue,
  paginateIssues,
  parseQueueControl,
  MAX_QUEUE_ISSUES,
  type CrossPlatformIssue,
} from "./operations-queue.ts";
import type { OperationsListItem } from "./dashboard-view.ts";
import type { PlatformStatusValue } from "./shared/models.ts";

function item(over: Partial<OperationsListItem>): OperationsListItem {
  return { id: "p1", sku: "SKU", barcode: "BC", nameAr: null, nameEn: null, imageUrl: null, platforms: [], tasks: [], ...over } as OperationsListItem;
}
function shopify(status: PlatformStatusValue) {
  return [{ platform: "shopify" as const, status, label: "" }];
}
function issuesOf(items: OperationsListItem[]): CrossPlatformIssue[] {
  return buildCrossPlatformIssues(items).issues;
}

test("missing → high/not_listed; review → high/needs_review", () => {
  const iss = issuesOf([item({ platforms: shopify("missing"), puresoulState: "review" })]);
  const sh = iss.find((i) => i.platform === "shopify")!;
  const ps = iss.find((i) => i.platform === "puresoul")!;
  assert.equal(sh.severity, "high");
  assert.equal(sh.reason, "not_listed");
  assert.equal(ps.severity, "high");
  assert.equal(ps.reason, "needs_review");
});

test("different → medium/drifted; ready → low/staged_not_live", () => {
  const iss = issuesOf([item({ platforms: shopify("different"), talabatState: "linked" })]);
  const sh = iss.find((i) => i.platform === "shopify")!;
  const tb = iss.find((i) => i.platform === "talabat")!;
  assert.equal(sh.severity, "medium");
  assert.equal(sh.reason, "drifted");
  assert.equal(tb.severity, "low");
  assert.equal(tb.reason, "staged_not_live");
});

test("present and unknown are NEVER issues", () => {
  const iss = issuesOf([item({ platforms: shopify("published"), puresoulState: "published" })]);
  // shopify published → present (no issue); puresoul published → present (no issue);
  // talabat/rafeeq undefined → unknown (no issue)
  assert.equal(iss.length, 0);
});

test("stale never converts a state into an issue (state drives everything)", () => {
  // rafeeq present → not an issue regardless of any freshness
  const iss = issuesOf([item({ rafeeqState: "present" })]);
  assert.equal(iss.length, 0);
});

test("multiple issues per product across platforms", () => {
  const iss = issuesOf([item({ platforms: shopify("missing"), puresoulState: "price_different", talabatState: "missing", rafeeqState: "linked" })]);
  // shopify missing, puresoul different, talabat missing, rafeeq ready = 4 issues
  assert.equal(iss.length, 4);
});

test("deterministic sort: severity → platform order → sku", () => {
  const items = [
    item({ id: "b", sku: "B", rafeeqState: "linked" }),        // low
    item({ id: "a", sku: "A", platforms: shopify("missing") }), // high, shopify
    item({ id: "c", sku: "C", talabatState: "missing" }),       // high, talabat
    item({ id: "d", sku: "D", platforms: shopify("different") }), // medium
  ];
  const sorted = sortIssues(issuesOf(items));
  assert.deepEqual(sorted.map((i) => i.severity), ["high", "high", "medium", "low"]);
  // within high: shopify (platform rank 0) before talabat (rank 2)
  assert.deepEqual([sorted[0]!.platform, sorted[1]!.platform], ["shopify", "talabat"]);
});

test("groupOperationsQueues: correct buckets + counts; all = union", () => {
  const q = groupOperationsQueues(issuesOf([
    item({ id: "a", platforms: shopify("missing") }),
    item({ id: "b", puresoulState: "review" }),
    item({ id: "c", platforms: shopify("different") }),
    item({ id: "d", rafeeqState: "linked" }),
  ]));
  assert.equal(q.missing.length, 1);
  assert.equal(q.review.length, 1);
  assert.equal(q.different.length, 1);
  assert.equal(q.ready.length, 1);
  assert.equal(q.counts.total, 4);
  assert.equal(q.all.length, 4);
  assert.deepEqual(q.counts, { missing: 1, review: 1, different: 1, ready: 1, total: 4 });
});

test("selectQueue returns the right list; all is severity-sorted", () => {
  const q = buildOperationsQueues([
    item({ id: "a", rafeeqState: "linked" }),        // low
    item({ id: "b", platforms: shopify("missing") }), // high
  ]);
  assert.equal(selectQueue(q, "missing").length, 1);
  assert.equal(selectQueue(q, "ready").length, 1);
  assert.equal(selectQueue(q, "all")[0]!.severity, "high"); // high first
});

test("paginateIssues clamps + slices", () => {
  const many = Array.from({ length: 30 }, (_, n) => item({ id: `p${n}`, sku: `S${n}`, platforms: shopify("missing") }));
  const q = buildOperationsQueues(many);
  const p1 = paginateIssues(q.missing, 1, 24);
  assert.equal(p1.items.length, 24);
  assert.equal(p1.totalPages, 2);
  const p9 = paginateIssues(q.missing, 9, 24); // clamped to last page
  assert.equal(p9.page, 2);
  assert.equal(p9.items.length, 6);
});

test("defensive cap: never emits more than MAX_QUEUE_ISSUES; flags capped", () => {
  const many = Array.from({ length: MAX_QUEUE_ISSUES + 50 }, (_, n) => item({ id: `p${n}`, sku: `S${n}`, platforms: shopify("missing") }));
  const { issues, capped } = buildCrossPlatformIssues(many);
  assert.equal(issues.length, MAX_QUEUE_ISSUES);
  assert.equal(capped, true);
  assert.equal(buildOperationsQueues(many).capped, true);
});

test("parseQueueControl: whitelists queue + qpage; junk → all/1", () => {
  assert.deepEqual(parseQueueControl({ queue: "missing", qpage: "3" }), { queue: "missing", page: 3 });
  assert.deepEqual(parseQueueControl({ queue: "junk", qpage: "x" }), { queue: "all", page: 1 });
  assert.deepEqual(parseQueueControl(undefined), { queue: "all", page: 1 });
  assert.deepEqual(parseQueueControl({ queue: ["review"] }), { queue: "review", page: 1 });
});

test("issue carries product identity + display fields", () => {
  const iss = issuesOf([item({ id: "prod-9", sku: "S9", barcode: "B9", nameEn: "Nine", platforms: shopify("missing") })]);
  const i = iss[0]!;
  assert.equal(i.productId, "prod-9");
  assert.equal(i.sku, "S9");
  assert.equal(i.barcode, "B9");
  assert.equal(i.nameEn, "Nine");
});
