// Tests for the cross-platform availability reconciliation logic.
// Run: node --experimental-strip-types --test lib/availability-reconcile.test.ts

import test from "node:test";
import assert from "node:assert/strict";

import { reconcile, cellToAvailable, type MasterProduct, type PlatformUpload } from "./availability-reconcile.ts";

const masters: MasterProduct[] = [
  { id: "p1", snoonu_id: "S1", sku: "mk1", barcode: "B1", name_en: "Glow Serum 30ml" },
  { id: "p2", snoonu_id: "S2", sku: "mk2", barcode: "B2", name_en: "Hydrating Toner 100ml" },
  { id: "p3", snoonu_id: "S3", sku: "mk3", barcode: "B3", name_en: "Lip Balm Cherry" },
  { id: "p4", rafeeq_product_id: "R4", sku: "mk4", barcode: "B4", name_en: "Clay Mask Green Tea" },
];

test("out anywhere = out everywhere; reconciled out", () => {
  const uploads: PlatformUpload[] = [
    { platform: "malika", rows: [{ id: "S1", available: true }, { id: "S2", available: true }] },
    { platform: "pure_seoul", rows: [{ id: "S1", available: false }, { id: "S2", available: true }] },
  ];
  const r = reconcile(masters, uploads);
  const p1 = r.matrix.find((m) => m.id === "p1")!;
  assert.equal(p1.reconciled, "out");      // out on pure_seoul → out everywhere
  assert.equal(p1.conflict, true);          // in on malika, out on pure_seoul
  const p2 = r.matrix.find((m) => m.id === "p2")!;
  assert.equal(p2.reconciled, "in");
  assert.equal(p2.conflict, false);
  assert.deepEqual(r.applyOutIds, ["p1"]);
  assert.deepEqual(r.applyInIds, ["p2"]);
});

test("corrections: hide list per platform where reconciled out but shown in", () => {
  const uploads: PlatformUpload[] = [
    { platform: "malika", rows: [{ id: "S1", available: false }] },        // out on malika
    { platform: "pure_seoul", rows: [{ id: "S1", available: true }] },      // still listed on PS
    { platform: "talabat", rows: [{ name: "Glow Serum 30ml", available: true }] }, // listed on talabat
  ];
  const r = reconcile(masters, uploads);
  const ps = r.corrections.find((c) => c.platform === "pure_seoul")!;
  const tb = r.corrections.find((c) => c.platform === "talabat")!;
  const mk = r.corrections.find((c) => c.platform === "malika")!;
  assert.deepEqual(ps.hide.map((h) => h.id), ["p1"]); // must hide on PS
  assert.deepEqual(tb.hide.map((h) => h.id), ["p1"]); // must hide on talabat
  assert.deepEqual(mk.hide.map((h) => h.id), []);     // already out on malika
});

test("matches by id, barcode, sku, and tolerant name", () => {
  const uploads: PlatformUpload[] = [
    { platform: "malika", rows: [{ barcode: "B2", available: false }] },        // by barcode
    { platform: "talabat", rows: [{ name: "hydrating toner (100ml)", available: true }] }, // by name (alnum norm)
    { platform: "rafeeq", rows: [{ id: "R4", available: false }] },             // by rafeeq id
    { platform: "pure_seoul", rows: [{ sku: "mk3", available: true }] },        // by sku
  ];
  const r = reconcile(masters, uploads);
  assert.equal(r.counts.unmatchedByPlatform.malika, 0);
  assert.equal(r.counts.unmatchedByPlatform.talabat, 0);
  assert.equal(r.counts.unmatchedByPlatform.rafeeq, 0);
  assert.equal(r.counts.unmatchedByPlatform.pure_seoul, 0);
  assert.equal(r.matrix.find((m) => m.id === "p2")!.reconciled, "out"); // matched by barcode, was false
  assert.equal(r.matrix.find((m) => m.id === "p4")!.reconciled, "out"); // rafeeq id, false
});

test("subset name match (extra size words) still matches", () => {
  const uploads: PlatformUpload[] = [
    { platform: "talabat", rows: [{ name: "Clay Mask Green Tea Purifying 120ml", available: false }] },
  ];
  const r = reconcile(masters, uploads);
  assert.equal(r.counts.unmatchedByPlatform.talabat, 0);
  assert.equal(r.matrix.find((m) => m.id === "p4")!.reconciled, "out");
});

test("unmatched rows are counted, not silently dropped", () => {
  const uploads: PlatformUpload[] = [
    { platform: "talabat", rows: [{ name: "Totally Unknown Product XYZ", available: false }] },
  ];
  const r = reconcile(masters, uploads);
  assert.equal(r.counts.unmatchedByPlatform.talabat, 1);
  assert.equal(r.matrix.length, 0);
});

test("variant rows: out on any row makes the product out", () => {
  const uploads: PlatformUpload[] = [
    { platform: "talabat", rows: [
      { name: "Glow Serum 30ml", available: true },
      { name: "Glow Serum 30ml", available: false }, // a variant sold out
    ] },
  ];
  const r = reconcile(masters, uploads);
  assert.equal(r.matrix.find((m) => m.id === "p1")!.reconciled, "out");
});

test("cellToAvailable understands strings, arabic, and stock numbers", () => {
  assert.equal(cellToAvailable("Active"), true);
  assert.equal(cellToAvailable("inactive"), false);
  assert.equal(cellToAvailable("مفعّل"), true);
  assert.equal(cellToAvailable("غير مفعّل"), false);
  assert.equal(cellToAvailable("مخلّص"), false);
  assert.equal(cellToAvailable("5"), true);
  assert.equal(cellToAvailable("0"), false);
  assert.equal(cellToAvailable(""), null);
  assert.equal(cellToAvailable("???"), null);
});
