// Tests for the DM responder core.
// Run: node --experimental-strip-types --test lib/dm/respond-compute.test.ts

import test from "node:test";
import assert from "node:assert/strict";

import { dmSearchTokens, matchDmProducts, matchDmProductsByCategory, detectCategories, buildDmPrompt, parseDmReply, type DmProduct } from "./respond-compute.ts";

const P = (over: Partial<DmProduct>): DmProduct => ({
  sku: "mk1", name_en: "Stanley H2.0 Tumbler", name_ar: "ستانلي تمبلر", price: 139, discount_price: null, stock: 4, ...over,
});

test("dmSearchTokens keeps product words, drops greetings/stopwords", () => {
  const t = dmSearchTokens("السلام عليكم كم سعر ستانلي تمبلر الأزرق؟");
  assert.ok(t.includes("ستانلي"));
  assert.ok(t.includes("تمبلر"));
  assert.ok(!t.includes("سعر"));
  assert.ok(!t.includes("السلام"));
});

test("matchDmProducts ranks by token hits and caps results", () => {
  const products = [
    P({}),
    P({ sku: "mk2", name_en: "Rhode Lip Tint", name_ar: "رود ليب تينت" }),
  ];
  const hits = matchDmProducts(products, dmSearchTokens("بكم ستانلي تمبلر"));
  assert.equal(hits.length, 1);
  assert.equal(hits[0].sku, "mk1");
  assert.deepEqual(matchDmProducts(products, []), []);
});

test("buildDmPrompt embeds effective price, stock and history", () => {
  const p = buildDmPrompt({
    history: [{ direction: "in", body: "بكم الستانلي؟" }],
    products: [P({ discount_price: 99 })],
    storeInfo: "توصيل قطر ٢٤ ساعة",
  });
  assert.match(p, /99 ر\.ق/);
  assert.match(p, /متوفر/);
  assert.match(p, /العميل: بكم الستانلي؟/);
  assert.match(p, /توصيل قطر/);
});

test("parseDmReply tolerates prose around the JSON and enforces reply", () => {
  assert.deepEqual(
    parseDmReply('أكيد: {"reply":"السعر 139 ر.ق 🌹","handoff":false}'),
    { reply: "السعر 139 ر.ق 🌹", handoff: false },
  );
  assert.equal(parseDmReply('{"handoff":true}'), null);
  assert.equal(parseDmReply("no json"), null);
  assert.equal(parseDmReply('{"reply":"ok","handoff":true}')!.handoff, true);
});

test("detectCategories maps Arabic/English browse terms to catalog categories", () => {
  assert.ok(detectCategories("شنو عندكم منتجات للبشرة").includes("Face Care"));
  assert.ok(detectCategories("منتجات للبشرة").includes("Body Care"));
  assert.ok(detectCategories("do you have hair products?").includes("Hair Care"));
  assert.deepEqual(detectCategories("بكم ستانلي تمبلر"), []);
});

test("matchDmProductsByCategory returns category items, in-stock first", () => {
  const products = [
    P({ sku: "a", category: "Hair Care", stock: 0 }),
    P({ sku: "b", category: "Face Care", stock: 3 }),
    P({ sku: "c", category: "Face Care", stock: 0 }),
    P({ sku: "d", category: "Toys", stock: 9 }),
  ];
  const hits = matchDmProductsByCategory(products, detectCategories("منتجات للبشرة"));
  const skus = hits.map((h) => h.sku);
  assert.ok(skus.includes("b") && skus.includes("c"));
  assert.ok(!skus.includes("d")); // Toys isn't a skincare category
  assert.equal(hits[0].sku, "b"); // in-stock first
});
