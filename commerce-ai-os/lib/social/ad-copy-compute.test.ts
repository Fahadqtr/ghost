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
  assert.ok(p.includes('"benefits"'));
  assert.ok(p.includes('"features"'));
});

test("omits the description line when absent", () => {
  assert.ok(!buildAdCopyPrompt({ nameAr: "منتج" }).includes("الوصف:"));
});

// ---- parseAdCopy --------------------------------------------------------------

test("parses well-formed JSON", () => {
  const c = parseAdCopy('{"headline":"فرشاة السيلوليت","benefits":["تحفّز الدورة","تنعّم البشرة","سهلة"],"features":["جودة عالية","خشب طبيعي","صديقة للبيئة"]}');
  assert.equal(c.headline, "فرشاة السيلوليت");
  assert.deepEqual(c.benefits, ["تحفّز الدورة", "تنعّم البشرة", "سهلة"]);
  assert.equal(c.features.length, 3);
});

test("tolerates prose around the JSON", () => {
  const c = parseAdCopy('أكيد! إليك النص:\n{"headline":"X","benefits":["a"],"features":[]}\nبالتوفيق');
  assert.equal(c.headline, "X");
  assert.deepEqual(c.benefits, ["a"]);
  assert.deepEqual(c.features, []);
});

test("caps benefits at 5 / features at 3 and drops empties", () => {
  const c = parseAdCopy('{"headline":"H","benefits":["1","","2","3","4","5","6"],"features":["a","b","c","d"]}');
  assert.deepEqual(c.benefits, ["1", "2", "3", "4", "5"]);
  assert.deepEqual(c.features, ["a", "b", "c"]);
});

test("falls back to the product name and empty arrays on garbage", () => {
  const c = parseAdCopy("no json here", "منتج احتياطي");
  assert.equal(c.headline, "منتج احتياطي");
  assert.deepEqual(c.benefits, []);
  assert.deepEqual(c.features, []);
});
