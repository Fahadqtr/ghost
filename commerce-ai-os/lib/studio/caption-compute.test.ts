import test from "node:test";
import assert from "node:assert/strict";

import { splitCaptions, timeCaptions, bilingualCaptions, buildBrandLine, alignCaptions, ctaWindow, planShots } from "./caption-compute.ts";
import { logoCoords, reelQA, REEL_WIDTH, REEL_HEIGHT } from "../social/compose-compute.ts";

test("splitCaptions breaks on sentence punctuation", () => {
  const out = splitCaptions("شوفي هالمنتج؟ بسيط وعملي. ويستاهل يكون عندج");
  assert.deepEqual(out, ["شوفي هالمنتج؟", "بسيط وعملي.", "ويستاهل يكون عندج"]);
});

test("splitCaptions wraps long lines on word boundaries under the cap", () => {
  const long = "كلمة ".repeat(20).trim(); // 20 words → must wrap
  const out = splitCaptions(long, 20);
  assert.ok(out.length > 1);
  assert.ok(out.every((l) => l.length <= 20));
});

test("timeCaptions distributes across the duration without gaps and stays in bounds", () => {
  const cues = timeCaptions(["جملة قصيرة", "جملة أطول شوية هنا"], 10);
  assert.equal(cues.length, 2);
  assert.equal(cues[0].time, 0);
  // second starts where the first ends
  assert.equal(cues[1].time, cues[0].duration);
  const end = cues[1].time + cues[1].duration;
  assert.ok(Math.abs(end - 10) < 0.1);
});

test("timeCaptions returns nothing for empty input", () => {
  assert.deepEqual(timeCaptions([], 10), []);
});

test("bilingualCaptions stacks Arabic over English", () => {
  assert.deepEqual(bilingualCaptions(["مرحبا"], ["Hello"]), ["مرحبا\nHello"]);
});

test("buildBrandLine joins product + handle", () => {
  assert.equal(buildBrandLine("دكتور بِن", "@malikasuniverse"), "دكتور بِن  ·  @malikasuniverse");
  assert.equal(buildBrandLine("", ""), "");
});

test("logoCoords maps every corner, default top-right", () => {
  assert.deepEqual(logoCoords("top-left"), { x: "15%", y: "11%" });
  assert.deepEqual(logoCoords("bottom-right"), { x: "85%", y: "66%" });
  assert.deepEqual(logoCoords(null), { x: "85%", y: "11%" });
});

test("alignCaptions uses real character timestamps for two lines", () => {
  // stream: "ابج دهـ" split into two captions "ابج" and "دهـ"
  const chars = ["ا", "ب", "ج", " ", "د", "ه", "ـ"];
  const starts = [0, 0.2, 0.4, 0.6, 0.7, 0.9, 1.1];
  const ends = [0.2, 0.4, 0.6, 0.7, 0.9, 1.1, 1.3];
  const cues = alignCaptions(["ابج", "دهـ"], { chars, starts, ends });
  assert.ok(cues);
  assert.equal(cues!.length, 2);
  assert.equal(cues![0].time, 0);
  assert.ok(cues![1].time >= 0.7); // second line starts after the space
});

test("alignCaptions falls back to null when the lines don't match the audio", () => {
  const chars = ["ا", "ب", "ج"];
  const starts = [0, 0.2, 0.4];
  const ends = [0.2, 0.4, 0.6];
  assert.equal(alignCaptions(["hello world"], { chars, starts, ends }), null);
});

test("ctaWindow puts the CTA in the last seconds only", () => {
  const w = ctaWindow(10);
  assert.ok(w.time > 6 && w.time < 10);
  assert.ok(w.duration <= 2.5 && w.duration >= 1.4);
  assert.ok(w.time + w.duration <= 10.01);
});

test("planShots sequences multiple shots without overlap and covers the duration", () => {
  const plan = planShots(["https://a/1.mp4", "https://b/2.mp4", "https://c/3.mp4"], 12);
  assert.equal(plan.length, 3);
  assert.equal(plan[0].time, 0);
  // slices are contiguous and reach the end
  assert.ok(Math.abs(plan[2].time + plan[2].duration - 12) < 0.05);
  assert.ok(Math.abs(plan[1].time - (plan[0].time + plan[0].duration)) < 0.05);
});

test("planShots loops a single shot for the whole duration", () => {
  const plan = planShots(["https://a/1.mp4"], 9);
  assert.deepEqual(plan, [{ source: "https://a/1.mp4", time: 0, duration: 9 }]);
});

test("reelQA fails a sub-1080x1920 proxy and passes a real vertical render", () => {
  assert.equal(reelQA({ width: 540, height: 960, durationSec: 9 }, 8.5).pass, false);
  assert.equal(reelQA({ width: REEL_WIDTH, height: REEL_HEIGHT, durationSec: 9.1 }, 8.5).pass, true);
});
