// CI.1 — product platform matrix reader tests (server-only, injected store).
// Run: node --conditions=react-server --experimental-strip-types --test lib/operations/platform-matrix-read.test.ts

import test from "node:test";
import assert from "node:assert/strict";

import { loadProductPlatformMatrix, type MatrixSnapshotStore } from "./platform-matrix-read.ts";
import { createSnapshot } from "../platforms/core/snapshot.ts";
import type { PlatformSnapshot } from "../platforms/core/types.ts";

const NOW = Date.parse("2026-08-10T12:00:00.000Z");
const AT = "2026-08-10T10:00:00.000Z";

function storeOf(snaps: PlatformSnapshot[], opts?: { throw?: boolean }): MatrixSnapshotStore {
  return {
    async listByProduct(productId: string) {
      if (opts?.throw) throw new Error("db down");
      return snaps.filter((s) => s.productId === productId);
    },
  };
}

test("builds a matrix from the product's latest snapshots (reuses listByProduct)", async () => {
  const snaps = [
    createSnapshot({ platform: "rafeeq", productId: "p1", capturedAt: AT, externalId: "R1", status: "Active", metadata: { rafeeq: { verdict: "present" } } }),
    createSnapshot({ platform: "talabat", productId: "p1", capturedAt: AT, status: "missing", metadata: { talabat: { verdict: "missing" } } }),
  ];
  const m = await loadProductPlatformMatrix(null, "p1", { sku: "S", barcode: "B", now: NOW, deps: { store: storeOf(snaps) } });
  assert.equal(m.productId, "p1");
  assert.equal(m.cells.find((c) => c.platform === "rafeeq")!.state, "present");
  assert.equal(m.cells.find((c) => c.platform === "talabat")!.state, "missing");
  // untouched platforms → unknown, never missing
  assert.equal(m.cells.find((c) => c.platform === "shopify")!.state, "unknown");
  assert.equal(m.issueCount, 1);
});

test("degraded read → all-unknown matrix (never missing, never throws)", async () => {
  const m = await loadProductPlatformMatrix(null, "p1", { now: NOW, deps: { store: storeOf([], { throw: true }) } });
  for (const c of m.cells) assert.equal(c.state, "unknown");
  assert.equal(m.needsAttention, false);
});

test("blank / oversized id → all-unknown matrix, store never called", async () => {
  let called = false;
  const store: MatrixSnapshotStore = { async listByProduct() { called = true; return []; } };
  const blank = await loadProductPlatformMatrix(null, "   ", { now: NOW, deps: { store } });
  const big = await loadProductPlatformMatrix(null, "x".repeat(500), { now: NOW, deps: { store } });
  for (const c of [...blank.cells, ...big.cells]) assert.equal(c.state, "unknown");
  assert.equal(called, false, "invalid id must not hit the store");
});

test("product scoping: only the requested product's snapshots are used", async () => {
  const snaps = [
    createSnapshot({ platform: "rafeeq", productId: "p1", capturedAt: AT, status: "Active", metadata: { rafeeq: { verdict: "present" } } }),
    createSnapshot({ platform: "rafeeq", productId: "p2", capturedAt: AT, status: "Not Listed", metadata: { rafeeq: { verdict: "missing" } } }),
  ];
  const m = await loadProductPlatformMatrix(null, "p1", { now: NOW, deps: { store: storeOf(snaps) } });
  assert.equal(m.cells.find((c) => c.platform === "rafeeq")!.state, "present"); // p2's "missing" not leaked
});
