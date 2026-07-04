// Tests for the social content engine core.
// Run: node --experimental-strip-types --test lib/social/content-compute.test.ts

import test from "node:test";
import assert from "node:assert/strict";

import {
  pickSpotlightProduct,
  buildPostPrompt,
  parseCaptionReply,
  parsePostReply,
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

// ---- buildPostPrompt -----------------------------------------------------------

test("prompt carries the product, brand, price, hook rule, CTA and safety rules", () => {
  const p = buildPostPrompt(c({ name_ar: "سيروم التوهج", name_en: "Glow Serum", brand: "Rhode", price: 100, discount_price: 79 }));
  assert.ok(p.includes("سيروم التوهج"));
  assert.ok(p.includes("Glow Serum"));
  assert.ok(p.includes("البراند: Rhode"));
  assert.ok(p.includes("لا تحذفي البراند"));
  assert.ok(p.includes("79"));            // discount wins over list price
  assert.ok(!p.includes("100 ر.ق"));
  assert.ok(p.includes("Hook"));
  assert.ok(p.includes("اطلبيه الآن من Malika's Universe"));
  assert.ok(p.includes("الادعاءات الطبية"));
  assert.ok(p.includes('"story"'));
  assert.ok(p.includes('"reel"'));
  assert.ok(p.includes('"alt"'));
});

test("includes the Gemini image analysis block only when provided", () => {
  assert.ok(buildPostPrompt(c({}), "عبوة زجاجية بغطاء ذهبي").includes("عبوة زجاجية"));
  assert.ok(!buildPostPrompt(c({})).includes("تحليل صورة المنتج"));
});

test("omits brand/price lines when absent", () => {
  const p = buildPostPrompt(c({ brand: null, price: null, discount_price: null }));
  assert.ok(!p.includes("البراند:"));
  assert.ok(!p.includes("السعر:"));
});

// ---- parseCaptionReply ---------------------------------------------------------

test("prefers JSON {caption}, falls back to raw text, caps at 2200", () => {
  assert.equal(parseCaptionReply('بالتأكيد! {"caption":"جمالك يبدأ هنا ✨"}'), "جمالك يبدأ هنا ✨");
  assert.equal(parseCaptionReply("نص عادي بدون JSON"), "نص عادي بدون JSON");
  assert.equal(parseCaptionReply("x".repeat(3000)).length, 2200);
});

// ---- parsePostReply ------------------------------------------------------------

test("parses caption + story/reel/alt extras", () => {
  const r = parsePostReply('{"caption":"كابشن","story":"ستوري","reel":"ريلز","alt":"وصف"}');
  assert.equal(r.caption, "كابشن");
  assert.deepEqual(r.extras, { story: "ستوري", reel: "ريلز", alt: "وصف" });
});

test("missing extras come back empty; garbage falls back to raw caption", () => {
  const r1 = parsePostReply('{"caption":"بس كابشن"}');
  assert.equal(r1.caption, "بس كابشن");
  assert.deepEqual(r1.extras, { story: "", reel: "", alt: "" });

  const r2 = parsePostReply("مافيه JSON هنا");
  assert.equal(r2.caption, "مافيه JSON هنا");
  assert.deepEqual(r2.extras, { story: "", reel: "", alt: "" });
});

test("extras are length-capped", () => {
  const r = parsePostReply(JSON.stringify({ caption: "c", story: "s".repeat(900), reel: "r".repeat(900), alt: "a".repeat(900) }));
  assert.equal(r.extras.story.length, 500);
  assert.equal(r.extras.reel.length, 700);
  assert.equal(r.extras.alt.length, 300);
});
