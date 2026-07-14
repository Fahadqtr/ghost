import test from "node:test";
import assert from "node:assert/strict";

import { splitCaptions, timeCaptions, bilingualCaptions, buildBrandLine } from "./caption-compute.ts";
import { logoCoords } from "../social/compose-compute.ts";

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
  assert.deepEqual(logoCoords("top-left"), { x: "13%", y: "9%" });
  assert.deepEqual(logoCoords("bottom-right"), { x: "87%", y: "70%" });
  assert.deepEqual(logoCoords(null), { x: "87%", y: "9%" });
});
