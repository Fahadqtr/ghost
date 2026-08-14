import test from "node:test";
import assert from "node:assert/strict";
import { normalizeQty, planApply, planInventoryOperation, spreadAcrossShelves, sumVariantStock } from "./compute.ts";

test("normalizeQty preserves legacy normalization", () => {
  assert.equal(normalizeQty(3), 3); assert.equal(normalizeQty("4"), 4); assert.equal(normalizeQty(2.9), 2);
  assert.equal(normalizeQty(-5), 5); assert.equal(normalizeQty("abc"), 0); assert.equal(normalizeQty(Infinity), 0);
});

test("planApply preserves legacy movement semantics", () => {
  assert.deepEqual(planApply({ type: "in", qty: 4, before: 10, sold: 7 }), { after: 14, soldAfter: null });
  assert.deepEqual(planApply({ type: "out", qty: 2, before: 10, sold: 7, reason: "Sale" }), { after: 8, soldAfter: 9 });
  assert.ok("error" in planApply({ type: "out", qty: 5, before: 3, sold: 0 }));
});

test("sumVariantStock is fail-closed and overflow-safe", () => {
  assert.equal(sumVariantStock([{stock_quantity:3},{stock_quantity:4},{stock_quantity:0}]), 7);
  assert.equal(sumVariantStock([{stock_quantity:null}]), null);
  assert.equal(sumVariantStock([{stock_quantity:-1}]), null);
  assert.equal(sumVariantStock([{stock_quantity:1.5}]), null);
  assert.equal(sumVariantStock([{stock_quantity:Number.MAX_SAFE_INTEGER},{stock_quantity:1}]), null);
});

test("spreadAcrossShelves is strict and biggest-first", () => {
  assert.deepEqual(spreadAcrossShelves([{location:"A",quantity:2},{location:"B",quantity:5},{location:"C",quantity:3}], 7), [{location:"B",deduct:5},{location:"C",deduct:2}]);
  assert.deepEqual(spreadAcrossShelves([{location:"A",quantity:2}], 5), [{location:"A",deduct:2}]);
  assert.equal(spreadAcrossShelves([{location:"A",quantity:-1}], 1), null);
});

test("adjust refuses negative resulting stock", () => {
  assert.deepEqual(planInventoryOperation({before:10,sold:2,operation:{kind:"adjust",delta:-3}}), {status:"ready",before:10,after:7,delta:-3,soldAfter:null});
  assert.deepEqual(planInventoryOperation({before:2,sold:0,operation:{kind:"adjust",delta:-3}}), {status:"error",error:"insufficient_stock"});
});

test("sell decrements stock and advances sold", () => {
  assert.deepEqual(planInventoryOperation({before:10,sold:4,operation:{kind:"sell",quantity:3}}), {status:"ready",before:10,after:7,delta:-3,soldAfter:7});
});

test("absolute setters share strict set semantics", () => {
  for (const kind of ["setAbsolute", "setVariantAbsolute"] as const) {
    assert.deepEqual(planInventoryOperation({before:10,sold:4,operation:{kind,quantity:6}}), {status:"ready",before:10,after:6,delta:-4,soldAfter:null});
  }
});

test("receive increments without changing sold", () => {
  assert.deepEqual(planInventoryOperation({before:10,sold:4,operation:{kind:"receive",quantity:5}}), {status:"ready",before:10,after:15,delta:5,soldAfter:null});
});

test("planner fails closed on malformed inputs and overflow", () => {
  assert.deepEqual(planInventoryOperation({before:10.5,sold:0,operation:{kind:"receive",quantity:1}}), {status:"error",error:"invalid_stock"});
  assert.deepEqual(planInventoryOperation({before:10,sold:0,operation:{kind:"sell",quantity:1.2}}), {status:"error",error:"invalid_quantity"});
  assert.deepEqual(planInventoryOperation({before:10,sold:0,operation:{kind:"receive",quantity:Number.MAX_SAFE_INTEGER}}), {status:"error",error:"overflow"});
});
