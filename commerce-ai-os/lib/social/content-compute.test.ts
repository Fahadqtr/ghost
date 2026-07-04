// Tests for the social content engine core.
// Run: node --experimental-strip-types --test lib/social/content-compute.test.ts

import test from "node:test";
import assert from "node:assert/strict";

import {
  pickSpotlightProduct,
  buildCaptionPrompt,
  parseCaptionReply,
  type SpotlightCandidate,
} from "./content-compute.ts";

const c = (over: Partial<SpotlightCandidate>): SpotlightCandidate => ({
  id: "p", name_en: "X", name_ar: "س", image_url: "https://x/img.jpg",
  price: 10, stock: 5, created_at: "2026-07-01T00:00:00Z", ...over,
});

// ---- pickSpotlightProduct -----------------------------------------------------

test("requires image + stock, skips recently featured, prefers newest", () => {
  const picked = pickSpotlightProduct([
    c({ id: "no-img", image_url: null }),
    c({ id: "no-stock", stock: 0 }),
    c({ id: "recent", created_at: "2026-07-03T00:00:00Z" }),   // excluded below
    c({ id: "older", created_at: "2026-06-01T00:00:00Z" }),
    c({ id: "newest", created_at: "2026-07-02T00:00:00Z" }),
  ], ["recent"]);
  assert.equal(picked?.id, "newest");
});

test("nothing eligible → null", () => {
  assert.equal(pickSpotlightProduct([c({ image_url: "" })], []), null);
  assert.equal(pickSpotlightProduct([], []), null);
});

// ---- buildCaptionPrompt --------------------------------------------------------

test("prompt carries the product name, brand, discounted price, and the CTA", () => {
  const p = buildCaptionPrompt(c({ name_ar: "سيروم التوهج", name_en: "Glow Serum", brand: "Rhode", price: 100, discount_price: 79 }));
  assert.ok(p.includes("سيروم التوهج"));
  assert.ok(p.includes("Glow Serum"));
  assert.ok(p.includes("البراند: Rhode"));
  assert.ok(p.includes("لا تحذفي البراند")); // the lead-with-brand rule
  assert.ok(p.includes("79"));          // discount wins over list price
  assert.ok(!p.includes("100 ر.ق"));
  assert.ok(p.includes("الرابط في البايو"));
});

test("prompt omits the brand line when the product has no brand", () => {
  const p = buildCaptionPrompt(c({ brand: null }));
  assert.ok(!p.includes("البراند:"));
});

test("prompt omits the price line when there is no price", () => {
  const p = buildCaptionPrompt(c({ price: null, discount_price: null }));
  assert.ok(!p.includes("السعر:"));
});

// ---- parseCaptionReply ---------------------------------------------------------

test("prefers JSON {caption}, falls back to raw text", () => {
  assert.equal(parseCaptionReply('بالتأكيد! {"caption":"جمالك يبدأ هنا ✨"}'), "جمالك يبدأ هنا ✨");
  assert.equal(parseCaptionReply("نص عادي بدون JSON"), "نص عادي بدون JSON");
});

test("caps at Instagram's 2200-char limit and survives malformed JSON", () => {
  assert.equal(parseCaptionReply("x".repeat(3000)).length, 2200);
  assert.equal(parseCaptionReply('{"caption": unquoted}').startsWith("{"), true); // falls back to raw
});
