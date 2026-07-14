import test from "node:test";
import assert from "node:assert/strict";

import { buildGulfScriptPrompt, buildGulfDialectPrompt, cleanScriptLines } from "./voice-compute.ts";

test("buildGulfScriptPrompt enforces Gulf dialect + pronunciation, includes product/topic", () => {
  const p = buildGulfScriptPrompt({ topic: "خصم رمضان", productName: "دكتور بِن" });
  assert.match(p, /WHITE GULF ARABIC/);
  assert.match(p, /NEVER Egyptian/);
  assert.match(p, /text-to-speech/);
  assert.match(p, /دكتور بِن/);
  assert.match(p, /خصم رمضان/);
});

test("buildGulfScriptPrompt works with no product/topic", () => {
  const p = buildGulfScriptPrompt({});
  assert.match(p, /Malika's Universe/);
  assert.doesNotMatch(p, /Topic \/ angle:/);
});

test("buildGulfDialectPrompt carries the source script and the rules", () => {
  const p = buildGulfDialectPrompt("مرحبا كيف حالك");
  assert.match(p, /مرحبا كيف حالك/);
  assert.match(p, /WHITE GULF ARABIC/);
  assert.match(p, /tashkeel/);
});

test("cleanScriptLines strips numbering, bullets and quotes and drops blanks", () => {
  const raw = `1. تعانين من آثار الحبوب؟\n\n- «دكتور بِن» الحل\n2) استخدميه بروتينج\n`;
  assert.equal(
    cleanScriptLines(raw),
    "تعانين من آثار الحبوب؟\nدكتور بِن» الحل\nاستخدميه بروتينج",
  );
});

test("cleanScriptLines caps the number of lines", () => {
  const raw = Array.from({ length: 10 }, (_, i) => `سطر ${i}`).join("\n");
  assert.equal(cleanScriptLines(raw, 3).split("\n").length, 3);
});
