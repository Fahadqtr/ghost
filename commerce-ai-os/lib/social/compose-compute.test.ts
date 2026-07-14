import test from "node:test";
import assert from "node:assert/strict";

import { buildComposeSource, resolveReelDuration, MIN_REEL_SEC, MAX_REEL_SEC, DEFAULT_REEL_SEC } from "./compose-compute.ts";

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

test("video loops and shares the bounded composition duration (no black tail)", () => {
  const s: any = buildComposeSource({ videoUrl: "https://v/x.mp4", audioUrl: "https://a/x.mp3", durationSec: 14 });
  assert.equal(s.duration, 14.6);
  assert.equal(s.elements[0].loop, true);
  assert.equal(s.elements[0].duration, s.duration);
});

test("optional brand line is added as a fifth element", () => {
  const s: any = buildComposeSource({ videoUrl: "https://v/x.mp4", ctaText: "اطلب الآن", brandText: "ماليكاس يونيفرس" });
  const texts = s.elements.filter((e: any) => e.type === "text").map((e: any) => e.text);
  assert.deepEqual(texts, ["اطلب الآن", "ماليكاس يونيفرس"]);
});

test("resolveReelDuration clamps to [MIN, MAX] and defaults when unknown", () => {
  assert.equal(resolveReelDuration(undefined), DEFAULT_REEL_SEC);
  assert.equal(resolveReelDuration(0), DEFAULT_REEL_SEC);
  assert.equal(resolveReelDuration(2), MIN_REEL_SEC); // 2+0.6 → below floor
  assert.equal(resolveReelDuration(300), MAX_REEL_SEC); // runaway → capped
  assert.equal(resolveReelDuration(10), 10.6);
});
