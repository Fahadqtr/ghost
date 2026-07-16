import { test } from "node:test";
import assert from "node:assert/strict";
import { computePureSeoulIdMap, type CatalogNameRow } from "./pure-seoul-map-compute.ts";

const catalog: CatalogNameRow[] = [
  { id: "p1", name_en: "La Roche Posay Hyalu B5 Serum (30ml)", name_ar: "سيروم هيالو ب5" },
  { id: "p2", name_en: "Anua Niacinamide 10% + TXA Serum - 30ml" },
  { id: "p3", name_en: "Almond Press-On Nails" },
  { id: "p4", name_en: "Beauty of Joseon Propolis & Niacinamide Serum", pure_seoul_id: "PS-ALREADY" },
];

test("exact normalized-name match yields a pair", () => {
  const r = computePureSeoulIdMap([{ spi: "A1", nameEn: "La Roche‑Posay Hyalu B5 Serum" }], catalog);
  // punctuation/spacing differences normalize away
  const p = r.pairs.find((x) => x.product_id === "p1");
  assert.ok(p, "should match p1");
  assert.equal(p!.pure_seoul_id, "A1");
});

test("subset match (extra size/qualifier words) is accepted", () => {
  const r = computePureSeoulIdMap([{ spi: "A3", nameEn: "Long Almond Press-On Nails - Burgundy Color - 24Pcs" }], catalog);
  const p = r.pairs.find((x) => x.product_id === "p3");
  assert.ok(p, "subset should match p3");
  assert.equal(p!.matched, "subset");
});

test("already-set id is counted, not re-written", () => {
  const r = computePureSeoulIdMap([{ spi: "PS-ALREADY", nameEn: "Beauty of Joseon Propolis & Niacinamide Serum" }], catalog);
  assert.equal(r.alreadySet, 1);
  assert.equal(r.pairs.length, 0);
});

test("unrelated product is left unmatched (no false pair)", () => {
  const r = computePureSeoulIdMap([{ spi: "Z9", nameEn: "JBL Go Essential Bluetooth Speaker" }], catalog);
  assert.equal(r.mapped, 0);
  assert.equal(r.unmatched, 1);
});

test("one catalog product is claimed by at most one PS spi", () => {
  const r = computePureSeoulIdMap([
    { spi: "A1", nameEn: "La Roche Posay Hyalu B5 Serum" },
    { spi: "A2", nameEn: "La Roche Posay Hyalu B5 Serum (30ml)" }, // same product, second row
  ], catalog);
  const forP1 = r.pairs.filter((x) => x.product_id === "p1");
  assert.equal(forP1.length, 1, "p1 claimed once");
  assert.equal(forP1[0].pure_seoul_id, "A1", "first row wins");
});

test("duplicate PS spi is ignored on the second occurrence", () => {
  const r = computePureSeoulIdMap([
    { spi: "A2", nameEn: "Anua Niacinamide 10% + TXA Serum - 30ml" },
    { spi: "A2", nameEn: "Anua Niacinamide 10% + TXA Serum - 30ml" },
  ], catalog);
  assert.equal(r.pairs.length, 1);
});

test("blank spi rows are skipped", () => {
  const r = computePureSeoulIdMap([{ spi: "", nameEn: "Almond Press-On Nails" }], catalog);
  assert.equal(r.pairs.length, 0);
  assert.equal(r.unmatched, 0);
});
