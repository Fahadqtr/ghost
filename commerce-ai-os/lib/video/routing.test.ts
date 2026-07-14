import test from "node:test";
import assert from "node:assert/strict";

import { VIDEO_KINDS, DEFAULT_VIDEO_KIND, videoKindDef, resolveProvider } from "./routing.ts";
import { buildFloraInputs, floraStatus, firstFloraOutputUrl } from "./flora-compute.ts";

test("product kinds default to FLORA, talking kinds to Higgsfield", () => {
  assert.equal(resolveProvider("product_cinematic"), "flora");
  assert.equal(resolveProvider("luxury_product_ad"), "flora");
  assert.equal(resolveProvider("product_showcase"), "flora");
  assert.equal(resolveProvider("ugc_creator"), "higgsfield");
  assert.equal(resolveProvider("talking_presenter"), "higgsfield");
});

test("an explicit engine choice overrides the kind default", () => {
  assert.equal(resolveProvider("product_cinematic", "higgsfield"), "higgsfield");
  assert.equal(resolveProvider("ugc_creator", "flora"), "flora");
  assert.equal(resolveProvider("product_showcase", "auto"), "flora"); // auto → kind default
  assert.equal(resolveProvider("product_showcase", ""), "flora");
});

test("unknown kind falls back to the default kind's provider", () => {
  assert.equal(videoKindDef("nope").kind, DEFAULT_VIDEO_KIND);
  assert.equal(resolveProvider(null), "flora");
});

test("every video kind has labels and a provider", () => {
  for (const k of VIDEO_KINDS) {
    assert.ok(k.labelAr && k.labelEn && (k.provider === "flora" || k.provider === "higgsfield"));
  }
});

test("buildFloraInputs sends the image, and prompt/negative only when present", () => {
  const a = buildFloraInputs({ imageUrl: "https://i/p.jpg" });
  assert.deepEqual(a, [{ id: "input_image", type: "imageUrl", value: "https://i/p.jpg" }]);
  const b = buildFloraInputs({ imageUrl: "https://i/p.jpg", prompt: "cinematic", negativePrompt: "no morph" });
  assert.equal(b.length, 3);
  assert.deepEqual(b[1], { id: "visual_prompt", type: "text", value: "cinematic" });
  assert.deepEqual(b[2], { id: "negative_prompt", type: "text", value: "no morph" });
});

test("buildFloraInputs honours custom technique field ids", () => {
  const a = buildFloraInputs({ imageUrl: "https://i/p.jpg", prompt: "x", fieldIds: { image: "product_img", prompt: "brief" } });
  assert.equal(a[0].id, "product_img");
  assert.equal(a[1].id, "brief");
});

test("floraStatus maps raw states + output presence", () => {
  assert.equal(floraStatus("pending", false), "pending");
  assert.equal(floraStatus("processing", false), "pending");
  assert.equal(floraStatus("succeeded", false), "completed");
  assert.equal(floraStatus("", true), "completed"); // has output
  assert.equal(floraStatus("failed", false), "failed");
});

test("firstFloraOutputUrl prefers a video url", () => {
  assert.equal(firstFloraOutputUrl([{ url: "https://x/a.png" }, { url: "https://x/b.mp4" }]), "https://x/b.mp4");
  assert.equal(firstFloraOutputUrl([{ url: "https://x/a.png" }]), "https://x/a.png");
  assert.equal(firstFloraOutputUrl(null), undefined);
});
