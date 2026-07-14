import test from "node:test";
import assert from "node:assert/strict";

import { buildComposeSource } from "./compose-compute.ts";

test("buildComposeSource layers video, audio, logo and CTA at 1080x1920", () => {
  const s: any = buildComposeSource({
    videoUrl: "https://v/x.mp4", audioUrl: "https://a/x.mp3", logoUrl: "https://l/logo.png", ctaText: "اطلب الآن",
  });
  assert.equal(s.width, 1080);
  assert.equal(s.height, 1920);
  assert.equal(s.output_format, "mp4");
  const types = s.elements.map((e: any) => e.type);
  assert.deepEqual(types, ["video", "audio", "image", "text"]);
  assert.equal(s.elements[0].source, "https://v/x.mp4");
  assert.equal(s.elements.find((e: any) => e.type === "text").text, "اطلب الآن");
});

test("buildComposeSource omits audio/logo/CTA when not provided", () => {
  const s: any = buildComposeSource({ videoUrl: "https://v/x.mp4" });
  assert.deepEqual(s.elements.map((e: any) => e.type), ["video"]);
});
