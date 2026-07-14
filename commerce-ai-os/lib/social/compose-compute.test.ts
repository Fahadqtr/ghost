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

test("background music sits under the voiceover at low volume, looped to duration", () => {
  const s: any = buildComposeSource({ videoUrl: "https://v/x.mp4", audioUrl: "https://a/voice.mp3", musicUrl: "https://m/bed.mp3", durationSec: 10 });
  const audios = s.elements.filter((e: any) => e.type === "audio");
  assert.equal(audios.length, 2);
  const music = audios.find((e: any) => e.source === "https://m/bed.mp3");
  const voice = audios.find((e: any) => e.source === "https://a/voice.mp3");
  assert.equal(music.volume, "16%");
  assert.equal(music.loop, true);
  assert.equal(music.duration, s.duration);
  assert.equal(voice.volume, "100%");
});

test("auto-fits to the audio when duration is unknown (uploaded human voice)", () => {
  const s: any = buildComposeSource({ videoUrl: "https://v/x.mp4", audioUrl: "https://a/human.mp3" });
  assert.equal(s.duration, undefined); // composition length driven by the audio
  assert.equal(s.elements[0].type, "video");
  assert.equal(s.elements[0].loop, true);
  assert.equal(s.elements[0].duration, undefined);
  assert.ok(s.elements.some((e: any) => e.type === "audio" && e.source === "https://a/human.mp3"));
});

test("burned-in subtitle is added when provided", () => {
  const s: any = buildComposeSource({ videoUrl: "https://v/x.mp4", audioUrl: "https://a/v.mp3", subtitle: "جرّبي دكتور بِن" });
  const sub = s.elements.find((e: any) => e.type === "text" && e.text === "جرّبي دكتور بِن");
  assert.ok(sub);
});

test("resolveReelDuration clamps to [MIN, MAX] and defaults when unknown", () => {
  assert.equal(resolveReelDuration(undefined), DEFAULT_REEL_SEC);
  assert.equal(resolveReelDuration(0), DEFAULT_REEL_SEC);
  assert.equal(resolveReelDuration(2), MIN_REEL_SEC); // 2+0.6 → below floor
  assert.equal(resolveReelDuration(300), MAX_REEL_SEC); // runaway → capped
  assert.equal(resolveReelDuration(10), 10.6);
});
