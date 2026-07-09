// Tests for the story-ad prompt core.
// Run: node --experimental-strip-types --test lib/social/story-compute.test.ts

import test from "node:test";
import assert from "node:assert/strict";

import { buildStoryAdPrompt } from "./story-compute.ts";

test("carries brand, product name, notes, CTA and vertical story sizing", () => {
  const p = buildStoryAdPrompt({ nameAr: "أحمر خدود", nameEn: "Blush", description: "لمسة حريرية", price: "78 ر.ق" });
  assert.ok(p.includes("MALIKA'S"));
  assert.ok(p.includes("أحمر خدود"));
  assert.ok(p.includes("Blush"));
  assert.ok(p.includes("لمسة حريرية"));
  assert.ok(p.includes("اطلبيه الآن"));
  assert.ok(p.includes("9:16")); // vertical story canvas
  assert.ok(p.includes("1080x1920"));
});

test("includes the price badge with the amount when a price is given", () => {
  const p = buildStoryAdPrompt({ nameAr: "منتج", price: "78 ر.ق" });
  assert.ok(p.includes("سعر خاص"));
  assert.ok(p.includes("«78 ر.ق»"));
});

test("omits the price badge when there is no price", () => {
  const p = buildStoryAdPrompt({ nameAr: "منتج", price: "" });
  assert.ok(!p.includes("سعر خاص"));
  assert.ok(p.includes("(no price badge)"));
});

test("omits the notes clause when there is no description", () => {
  assert.ok(!buildStoryAdPrompt({ nameAr: "منتج" }).includes("Notes:"));
});
