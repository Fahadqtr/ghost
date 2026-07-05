// Tests for the ad-copy core.
// Run: node --experimental-strip-types --test lib/social/ad-copy-compute.test.ts

import test from "node:test";
import assert from "node:assert/strict";

import { buildAdCopyPrompt, parseAdCopy } from "./ad-copy-compute.ts";

// ---- buildAdCopyPrompt --------------------------------------------------------

test("prompt carries the product name, description, and the JSON shape rule", () => {
  const p = buildAdCopyPrompt({ nameAr: "فرشاة تدليك", nameEn: "Massager", description: "خشب طبيعي" });
  assert.ok(p.includes("فرشاة تدليك"));
  assert.ok(p.includes("(Massager)"));
  assert.ok(p.includes("خشب طبيعي"));
  assert.ok(p.includes('"headline"'));
  assert.ok(p.includes('"headlineEn"'));
  assert.ok(p.includes('"subtitle"'));
  assert.ok(p.includes('"benefits"'));
  assert.ok(p.includes('"features"'));
});

test("omits the description line when absent", () => {
  assert.ok(!buildAdCopyPrompt({ nameAr: "منتج" }).includes("الوصف:"));
});

// ---- parseAdCopy --------------------------------------------------------------

test("parses well-formed JSON with title/sub bullets", () => {
  const c = parseAdCopy('{"headline":"فرش مكياج","subtitle":"6 قطع متعددة","benefits":[{"title":"شعيرات ناعمة","sub":"توزيع متساوٍ"},{"title":"سهلة التنظيف","sub":"تجف بسرعة"}],"features":[{"title":"جودة عالية","sub":"خامات فاخرة"}]}');
  assert.equal(c.headline, "فرش مكياج");
  assert.equal(c.subtitle, "6 قطع متعددة");
  assert.equal(c.benefits.length, 2);
  assert.equal(c.benefits[0].title, "شعيرات ناعمة");
  assert.equal(c.benefits[0].sub, "توزيع متساوٍ");
  assert.equal(c.features[0].title, "جودة عالية");
});

test("accepts plain-string bullets (sub empty) and tolerates surrounding prose", () => {
  const c = parseAdCopy('أكيد:\n{"headline":"X","subtitle":"","benefits":["ميزة أولى","ميزة ثانية"],"features":[]}\nتم');
  assert.equal(c.headline, "X");
  assert.equal(c.benefits[0].title, "ميزة أولى");
  assert.equal(c.benefits[0].sub, "");
  assert.deepEqual(c.features, []);
});

test("caps benefits at 5 / features at 3 and drops title-less bullets", () => {
  const c = parseAdCopy('{"headline":"H","benefits":[{"title":"1"},{"title":""},{"title":"2"},{"title":"3"},{"title":"4"},{"title":"5"},{"title":"6"}],"features":[{"title":"a"},{"title":"b"},{"title":"c"},{"title":"d"}]}');
  assert.deepEqual(c.benefits.map((b) => b.title), ["1", "2", "3", "4", "5"]);
  assert.deepEqual(c.features.map((f) => f.title), ["a", "b", "c"]);
});

test("falls back to the product name and empty arrays on garbage", () => {
  const c = parseAdCopy("no json here", "منتج احتياطي", "Backup Product");
  assert.equal(c.headline, "منتج احتياطي");
  assert.equal(c.headlineEn, "Backup Product");
  assert.deepEqual(c.benefits, []);
  assert.deepEqual(c.features, []);
});

test("parses the English echo line and leaves it empty without a fallback", () => {
  const c = parseAdCopy('{"headline":"سيروم التوهج","headlineEn":"Glow Repair Serum"}');
  assert.equal(c.headlineEn, "Glow Repair Serum");
  assert.equal(parseAdCopy('{"headline":"X"}').headlineEn, "");
});
