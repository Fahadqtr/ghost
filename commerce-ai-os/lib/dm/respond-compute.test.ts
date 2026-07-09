// Tests for the DM responder core.
// Run: node --experimental-strip-types --test lib/dm/respond-compute.test.ts

import test from "node:test";
import assert from "node:assert/strict";

import { dmSearchTokens, matchDmProducts, buildDmPrompt, parseDmReply, type DmProduct } from "./respond-compute.ts";

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
