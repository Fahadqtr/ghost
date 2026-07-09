// Tests for the story scene brief core.
// Run: node --experimental-strip-types --test lib/social/story-compute.test.ts

import test from "node:test";
import assert from "node:assert/strict";

import { buildStorySceneBrief } from "./story-compute.ts";

test("asks for a vertical 9:16 wordless product scene", () => {
  const p = buildStorySceneBrief({ nameAr: "أحمر خدود", nameEn: "Blush" });
  assert.ok(p.includes("9:16"));
  assert.ok(p.includes("1080x1920"));
  assert.ok(p.includes("أحمر خدود"));
  assert.ok(p.includes("Blush"));
});

test("forbids ALL baked-in text so Arabic is never garbled by the model", () => {
  const p = buildStorySceneBrief({ nameEn: "Serum" });
  assert.ok(/NO text/i.test(p));
  assert.ok(/NO letters/i.test(p));
  assert.ok(/wordless/i.test(p));
});

test("reserves the lower area for the real-font overlay card", () => {
  assert.ok(/LOWER 45%/i.test(buildStorySceneBrief({ nameAr: "منتج" })));
});

test("omits the product-name clause when no name is given", () => {
  assert.ok(!buildStorySceneBrief({}).includes("the product is:"));
});
