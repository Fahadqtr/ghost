// Tests for Malak's deterministic intent router.
// Run: node --conditions=react-server --experimental-strip-types --test lib/malak/intent.test.ts
//
// This runs BEFORE the model and force-routes write/creative requests to the
// right tool. A misroute sends a user's request to the wrong tool (or lets a
// write "escape" into a text-only reply), so the branch/guard ordering matters.

import test from "node:test";
import assert from "node:assert/strict";

import { detectForcedTool } from "./intent.ts";

test("routes clear catalog-write intents", () => {
  assert.equal(detectForcedTool("أضف منتج جديد"), "add_product");
  assert.equal(detectForcedTool("اعتمد هذا المنتج"), "set_approval");
  assert.equal(detectForcedTool("غيّر المخزون إلى 5"), "update_stock");
  assert.equal(detectForcedTool("غيّر السعر إلى 20"), "set_price");
});

test("routes creative image generation", () => {
  assert.equal(detectForcedTool("سوّي صورة إعلانية للمنتج"), "generate_product_image");
  assert.equal(detectForcedTool("اعمل لي بوستر"), "generate_product_image");
});

test("guard: a READ about products missing an image is NOT image generation", () => {
  // missingImageRead guard must win over the bare صورة+createVerb match.
  assert.notEqual(detectForcedTool("كم منتج بدون صورة؟"), "generate_product_image");
});

test("guard: 'أضف منتج جديد' is add_product, not list_uncategorized", () => {
  // "جديد" also appears in the new-products read; the addVerb guard disambiguates.
  assert.equal(detectForcedTool("أضف منتج جديد"), "add_product");
  assert.equal(detectForcedTool("اعرض المنتجات الجديدة"), "list_uncategorized");
});

test("price: a review/check (no change verb) is price_issues, not set_price", () => {
  assert.equal(detectForcedTool("راجع مشاكل الأسعار"), "price_issues");
  assert.equal(detectForcedTool("غيّر السعر إلى 30"), "set_price");
});

test("availability sync", () => {
  assert.equal(detectForcedTool("زامني التوفّر مع المنصّات"), "sync_availability");
});

test("web intents: bare URL browses, net search searches", () => {
  assert.equal(detectForcedTool("افتح https://example.com"), "browse_web");
  assert.equal(detectForcedTool("ابحث في قوقل عن أفضل سيروم"), "web_search");
});

test("play a song with sound", () => {
  assert.equal(detectForcedTool("شغّل أغنية هادئة"), "play_song");
});

test("plain chat forces no tool", () => {
  assert.equal(detectForcedTool("هلا، كيف الحال؟"), null);
  assert.equal(detectForcedTool(""), null);
});
