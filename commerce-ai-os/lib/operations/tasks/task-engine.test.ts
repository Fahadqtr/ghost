// Task Engine tests (Phase UI.7.1). Tasks are computed, never stored.
// Run: node --conditions=react-server --experimental-strip-types --test lib/operations/tasks/task-engine.test.ts

import test from "node:test";
import assert from "node:assert/strict";

import { computeProductReadiness } from "../readiness/readiness.ts";
import { computePlatformStatuses } from "../platforms/platform-status.ts";
import { generateProductTasks, generateTasks, sortTasks } from "./task-engine.ts";
import { makeProduct, presence } from "../shared/test-fixtures.ts";
import type { OperationsProduct } from "../shared/models";

function tasksFor(p: OperationsProduct) {
  const readiness = computeProductReadiness(p);
  const statuses = computePlatformStatuses(p, readiness.readyToPublish);
  return { readiness, statuses, tasks: generateProductTasks(p, readiness, statuses) };
}

test("ready product absent everywhere: exactly four publish tasks with deterministic ids", () => {
  const { tasks } = tasksFor(makeProduct());
  assert.deepEqual(
    tasks.map((t) => t.id),
    [
      "publish_platform:puresoul:p1",
      "publish_platform:rafeeq:p1",
      "publish_platform:shopify:p1",
      "publish_platform:talabat:p1",
    ].sort(),
  );
  for (const t of tasks) {
    assert.equal(t.type, "publish_platform");
    assert.equal(t.priority, "medium");
    assert.equal(t.productId, "p1");
    assert.ok(t.platform);
    assert.ok(t.title.length > 0 && t.description.length > 0 && t.reason.length > 0);
  }
});

test("missing image: a HIGH needs_image task, and no publish tasks (not publishable)", () => {
  const { tasks } = tasksFor(makeProduct({ imageUrl: null }));
  assert.deepEqual(tasks.map((t) => t.type), ["needs_image"]);
  assert.equal(tasks[0].priority, "high");
  assert.equal(tasks[0].id, "needs_image:p1");
});

test("image AND other data missing: needs_image and needs_data are separate tasks", () => {
  const { tasks } = tasksFor(makeProduct({ imageUrl: null, price: null, category: null }));
  assert.deepEqual(tasks.map((t) => t.type).sort(), ["needs_data", "needs_image"]);
  assert.ok(tasks.every((t) => t.priority === "high"));
});

test("new product: new_product task appears alongside the data tasks", () => {
  const { tasks } = tasksFor(makeProduct({ approval: "", platformStatus: "", imageUrl: null }));
  assert.deepEqual(tasks.map((t) => t.type), ["needs_image", "new_product"], "high before medium");
  assert.equal(tasks[1].id, "new_product:p1");
});

test("needs_review product: review task, and nothing gets published", () => {
  const { tasks } = tasksFor(makeProduct({ approval: "SentAI" }));
  assert.deepEqual(tasks.map((t) => t.type), ["needs_review"]);
  assert.equal(tasks[0].priority, "high");
  assert.equal(tasks[0].reason.length > 0, true);
});

test("platform drift and platform review flags become HIGH platform_review tasks", () => {
  const { tasks } = tasksFor(
    makeProduct({
      platforms: {
        shopify: presence({ linked: true, live: true, drift: true }),
        talabat: presence({ reviewRequired: true }),
        puresoul: presence({ linked: true, live: true }),
        rafeeq: presence({ linked: true, live: true }),
      },
    }),
  );
  assert.deepEqual(
    tasks.map((t) => t.id),
    ["platform_review:shopify:p1", "platform_review:talabat:p1"],
    "published platforms generate nothing; drift/review generate high-priority reviews",
  );
  assert.ok(tasks.every((t) => t.priority === "high"));
});

test("a staged platform copy of an UNPUBLISHABLE product never yields a publish task", () => {
  const { tasks } = tasksFor(
    makeProduct({ imageUrl: null, platforms: { shopify: presence({ linked: true }) } }),
  );
  assert.ok(tasks.every((t) => t.type !== "publish_platform"));
});

test("determinism: same input → identical task list", () => {
  const p = makeProduct({ approval: "", platformStatus: "", imageUrl: null });
  assert.deepEqual(tasksFor(p).tasks, tasksFor(p).tasks);
});

test("generateTasks over a catalog: one flat list, high priorities first", () => {
  const a = makeProduct({ id: "a", approval: "SentAI" });
  const b = makeProduct({ id: "b" });
  const entries = [a, b].map((p) => {
    const readiness = computeProductReadiness(p);
    return { product: p, readiness, platformStatuses: computePlatformStatuses(p, readiness.readyToPublish) };
  });
  const all = generateTasks(entries);
  assert.equal(all.length, 1 + 4);
  assert.equal(all[0].type, "needs_review", "high sorts before medium globally");
  assert.ok(all.slice(1).every((t) => t.type === "publish_platform"));
});

test("sortTasks is stable and total: priority, then type, then id", () => {
  const { tasks } = tasksFor(makeProduct({ approval: "", platformStatus: "", imageUrl: null, price: null }));
  assert.deepEqual(tasks, sortTasks([...tasks].reverse()));
});
