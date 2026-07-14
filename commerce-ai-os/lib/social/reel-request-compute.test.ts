import test from "node:test";
import assert from "node:assert/strict";

import {
  REEL_STYLES, styleLabelAr, reelProductUrl, buildReelBrief, buildScriptPrompt,
  REEL_NEGATIVE_PROMPT, REEL_MASTER_REFERENCE, REEL_SHOT_STRUCTURE, REEL_CAMERA,
} from "./reel-request-compute.ts";

test("styleLabelAr resolves known slugs and falls back", () => {
  assert.equal(styleLabelAr("ugc_gadget_saved_me"), "توصية: غيّر روتيني");
  assert.equal(styleLabelAr("unknown_slug"), "unknown_slug");
  assert.equal(styleLabelAr(null), "UGC");
});

test("reelProductUrl builds a storefront search link", () => {
  assert.match(reelProductUrl("mk1196"), /malikasuniverse\.com\/search\?q=mk1196$/);
  assert.match(reelProductUrl(null), /^https:\/\/malikasuniverse\.com$/);
});

test("buildReelBrief includes product, style, Arabic + CTA, notes and schedule", () => {
  const b = buildReelBrief({
    productName: "Dr Pen Ultima A1-C", sku: "mk1196", style: "ugc_gadget_saved_me",
    notes: "ركّزي على النتيجة السريعة", scheduledAtIso: "2026-07-15T10:00:00.000Z",
  });
  assert.match(b, /Dr Pen Ultima A1-C/);
  assert.match(b, /SKU mk1196/);
  assert.match(b, /This gadget saved me \(ugc_gadget_saved_me\)/);
  assert.match(b, /Gulf Arabic/);
  assert.match(b, /Owner notes: ركّزي على النتيجة السريعة/);
  assert.match(b, /Schedule for: 2026-07-15T10:00:00.000Z/);
});

test("buildReelBrief embeds master references, 5-shot structure, camera + negatives", () => {
  const b = buildReelBrief({ productName: "Dr Pen", style: "ugc" });
  assert.match(b, /STRICT MASTER PRODUCT REFERENCE/);
  assert.match(b, /MASTER CHARACTER REFERENCE/);
  assert.match(b, /SHOT 1/);
  assert.match(b, /SHOT 5/);
  assert.match(b, /No serum dropper/);
  assert.match(b, /No product morphing/);
  assert.match(b, /subtle push-in/);
});

test("buildReelBrief omits notes/schedule when absent", () => {
  const b = buildReelBrief({ productName: "X", style: "ugc" });
  assert.doesNotMatch(b, /Owner notes:/);
  assert.doesNotMatch(b, /Schedule for:/);
});

test("buildReelBrief embeds a verbatim script when provided", () => {
  const b = buildReelBrief({ productName: "X", style: "ugc", script: "سطر أول\nسطر ثاني" });
  assert.match(b, /VERBATIM/);
  assert.match(b, /سطر أول/);
  assert.match(b, /سطر ثاني/);
});

test("buildScriptPrompt asks for 4 white-Gulf lines, no dialect mixing, with the fixed CTA", () => {
  const p = buildScriptPrompt({ productName: "Dr Pen", style: "ugc_gadget_saved_me", notes: "ركّزي على التوفير", priceQar: 123.5 });
  assert.match(p, /Dr Pen/);
  assert.match(p, /WHITE GULF ARABIC/);
  assert.match(p, /NEVER Egyptian, Levantine, Moroccan/);
  assert.match(p, /4 short lines/);
  assert.match(p, /دكتور بِن/);
  assert.match(p, /اطلبيه من متجر ماليكاز يونيفرس، توصيل لكل قطر/);
  assert.match(p, /Owner direction: ركّزي على التوفير/);
  assert.match(p, /123.5 QAR/);
});

test("negative prompt + master reference + camera constants carry the guardrails", () => {
  assert.match(REEL_NEGATIVE_PROMPT, /No serum dropper/);
  assert.match(REEL_NEGATIVE_PROMPT, /No extra fingers/);
  assert.match(REEL_MASTER_REFERENCE, /same shape, colour, size/);
  assert.match(REEL_SHOT_STRUCTURE, /SHOT 3/);
  assert.match(REEL_CAMERA, /gentle handheld stabilization/);
});

test("every style has a slug, Arabic and English label", () => {
  for (const s of REEL_STYLES) {
    assert.ok(s.slug && s.labelAr && s.labelEn);
  }
});
