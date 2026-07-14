import test from "node:test";
import assert from "node:assert/strict";

import { VIDEO_TEMPLATES, DEFAULT_TEMPLATE_ID, videoTemplate } from "./templates.ts";

test("the Luxury Beauty Reel template exists and is a product kind", () => {
  const t = videoTemplate("luxury_beauty_reel");
  assert.ok(t);
  assert.equal(t!.kind, "luxury_product_ad");
  assert.match(t!.prompt, /Keep the product EXACTLY as in the image/);
  assert.ok(t!.previewDurationSec > 0);
});

test("default template id resolves", () => {
  assert.ok(videoTemplate(DEFAULT_TEMPLATE_ID));
  assert.equal(videoTemplate("nope"), undefined);
});

test("every template has labels, a kind and a prompt", () => {
  for (const t of VIDEO_TEMPLATES) {
    assert.ok(t.id && t.labelAr && t.labelEn && t.kind && t.prompt);
  }
});
