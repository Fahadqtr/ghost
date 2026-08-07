// Health Engine tests (Phase UI.7.1).
// Run: node --conditions=react-server --experimental-strip-types --test lib/operations/health/health-engine.test.ts

import test from "node:test";
import assert from "node:assert/strict";

import { computeProductReadiness } from "../readiness/readiness.ts";
import { computePlatformStatuses } from "../platforms/platform-status.ts";
import { generateTasks } from "../tasks/task-engine.ts";
import { computeHealthSummary } from "./health-engine.ts";
import { makeProduct } from "../shared/test-fixtures.ts";

test("summarizes a mixed catalog end to end", () => {
  const products = [
    makeProduct({ id: "ready1" }),
    makeProduct({ id: "new1", approval: "", platformStatus: "" }),
    makeProduct({ id: "img1", imageUrl: null }),
  ];
  const readiness = products.map(computeProductReadiness);
  const tasks = generateTasks(
    products.map((p, i) => ({
      product: p,
      readiness: readiness[i],
      platformStatuses: computePlatformStatuses(p, readiness[i].readyToPublish),
    })),
  );

  const h = computeHealthSummary(readiness, tasks);
  assert.equal(h.totalProducts, 3);
  assert.equal(h.readyProducts, 1);
  assert.equal(h.needsImage, 1);
  assert.equal(h.newProducts, 1);
  assert.equal(h.generatedTasks, tasks.length);
  const expectedAvg = Math.round(readiness.reduce((s, r) => s + r.percent, 0) / 3);
  assert.equal(h.readinessAverage, expectedAvg);
  assert.ok(h.readinessAverage > 0 && h.readinessAverage <= 100);
});

test("empty catalog: zeros everywhere, average is 0 (no division by zero)", () => {
  assert.deepEqual(computeHealthSummary([], []), {
    totalProducts: 0,
    readyProducts: 0,
    needsImage: 0,
    newProducts: 0,
    generatedTasks: 0,
    readinessAverage: 0,
  });
});

test("average rounding is stable", () => {
  const readiness = [makeProduct({ id: "a" }), makeProduct({ id: "b", brandId: null })].map(
    computeProductReadiness,
  );
  const h = computeHealthSummary(readiness, []);
  assert.equal(h.readinessAverage, Math.round((readiness[0].percent + readiness[1].percent) / 2));
});
