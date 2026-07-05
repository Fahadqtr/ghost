// Tests for the ad design variants + layouts.
// Run: node --experimental-strip-types --test lib/social/ad-variants.test.ts

import test from "node:test";
import assert from "node:assert/strict";

import { AD_VARIANTS, AD_LAYOUTS, hashSeed, pickVariant, pickLayout, buildSceneBrief, buildProductSceneBrief, PRODUCT_SCENE_BASE, WORN_SCENE_BASE, PRODUCT_REFINE_PROMPT } from "./ad-variants.ts";

test("product-in-scene brief grounds the exact product and bans added text", () => {
  for (const l of AD_LAYOUTS) {
    const brief = buildProductSceneBrief(AD_VARIANTS[0], l);
    assert.ok(brief.includes("THAT EXACT PRODUCT"));
    assert.ok(brief.includes("100% IDENTICAL"));
    assert.ok(brief.includes("NEVER look pasted, cut out or floating"));
    assert.ok(brief.includes("Do NOT add ANY marketing text"));
    assert.ok(brief.includes("PLACEMENT:"));
    assert.ok(brief.includes("Setting:"));
  }
});

test("product-in-scene brief fences the product out of the text zones", () => {
  for (const l of AD_LAYOUTS) {
    const brief = buildProductSceneBrief(AD_VARIANTS[0], l);
    assert.ok(brief.includes("CRITICAL FRAMING RULE"));       // base hard rule
    assert.ok(brief.includes("NEVER substitute"));            // anti product-swap rule
    assert.ok(brief.includes("KEEP-OUT ZONES"));              // per-layout reserved zones
    assert.ok(brief.includes("NO higher than"));              // explicit top-edge cap
  }
});

test("worn brief keeps the photographed subject and swaps cleanly into any layout brief", () => {
  assert.ok(WORN_SCENE_BASE.includes("KEEP THE SUBJECT"));
  assert.ok(WORN_SCENE_BASE.includes("REPLACE ONLY THE BACKGROUND"));
  assert.ok(WORN_SCENE_BASE.includes("Do NOT add ANY marketing text"));
  assert.ok(WORN_SCENE_BASE.includes("KEEP-OUT ZONES"));
  for (const l of AD_LAYOUTS) {
    const brief = buildProductSceneBrief(AD_VARIANTS[0], l);
    const worn = brief.replace(PRODUCT_SCENE_BASE, WORN_SCENE_BASE); // the server-side swap
    assert.ok(worn.startsWith(WORN_SCENE_BASE));                     // base really replaced
    assert.ok(worn.includes("PLACEMENT:"));                          // layout survives
    assert.ok(worn.includes("Setting:"));                            // mood survives
  }
});

test("product-refine brief keeps the product identical and strips clutter", () => {
  assert.ok(PRODUCT_REFINE_PROMPT.includes("IDENTICAL"));
  assert.ok(PRODUCT_REFINE_PROMPT.includes("WHITE background"));
  assert.ok(PRODUCT_REFINE_PROMPT.includes("hands, faces, people"));
  assert.ok(PRODUCT_REFINE_PROMPT.includes("collage"));
  assert.ok(PRODUCT_REFINE_PROMPT.includes("Do NOT add any new text"));
});

test("brand palette is valid monochrome chrome", async () => {
  const { BRAND_PALETTE } = await import("./ad-variants.ts");
  for (const c of [BRAND_PALETTE.ink, BRAND_PALETTE.muted, BRAND_PALETTE.gold, BRAND_PALETTE.dark]) {
    assert.match(c, /^#[0-9a-f]{6}$/i);
  }
  assert.match(BRAND_PALETTE.panel, /^\d+,\d+,\d+$/);
});

test("every variant is complete (palette colors + a mood clause)", () => {
  assert.ok(AD_VARIANTS.length >= 4);
  for (const v of AD_VARIANTS) {
    assert.ok(v.key);
    for (const c of [v.palette.ink, v.palette.muted, v.palette.gold, v.palette.dark]) {
      assert.match(c, /^#[0-9a-f]{6}$/i);
    }
    assert.match(v.palette.panel, /^\d+,\d+,\d+$/);
    assert.ok(v.setting.startsWith("Setting:"));
  }
});

test("variant and layout keys are unique", () => {
  assert.equal(new Set(AD_VARIANTS.map((v) => v.key)).size, AD_VARIANTS.length);
  assert.equal(new Set(AD_LAYOUTS.map((l) => l.key)).size, AD_LAYOUTS.length);
});

test("scene brief carries the safety rules + layout composition + mood", () => {
  for (const l of AD_LAYOUTS) {
    const brief = buildSceneBrief(AD_VARIANTS[0], l);
    assert.ok(brief.includes("COMPLETELY EMPTY"));            // backdrop only — no product
    assert.ok(brief.includes("NO text, letters, logos"));     // nothing the model can garble
    assert.ok(brief.includes("NO people, faces, hands"));
    assert.ok(brief.includes("COMPOSITION:"));
    assert.ok(brief.includes("Setting:"));
  }
});

test("stable per product, rotates per tap, wraps around", () => {
  const a0 = pickVariant("product-a", 0);
  assert.equal(pickVariant("product-a", 0).key, a0.key);       // deterministic
  assert.notEqual(pickVariant("product-a", 1).key, a0.key);    // re-tap → new look
  assert.equal(pickVariant("product-a", AD_VARIANTS.length).key, a0.key); // wraps
});

test("5×3 coprime rotation → 15 unique palette×layout combos per product", () => {
  const combos = new Set<string>();
  for (let tap = 0; tap < AD_VARIANTS.length * AD_LAYOUTS.length; tap++) {
    combos.add(`${pickVariant("p", tap).key}|${pickLayout("p", tap).key}`);
  }
  assert.equal(combos.size, AD_VARIANTS.length * AD_LAYOUTS.length);
});

test("hashSeed is deterministic and spreads different ids", () => {
  assert.equal(hashSeed("x"), hashSeed("x"));
  const keys = new Set(["p1", "p2", "p3", "p4", "p5"].map((s) => pickVariant(s, 0).key));
  assert.ok(keys.size >= 2); // different products land on different variants
});
