// Tests for the ad design variants.
// Run: node --experimental-strip-types --test lib/social/ad-variants.test.ts

import test from "node:test";
import assert from "node:assert/strict";

import { AD_VARIANTS, hashSeed, pickVariant } from "./ad-variants.ts";

test("every variant is complete (palette colors + a no-text scene brief)", () => {
  assert.ok(AD_VARIANTS.length >= 4);
  for (const v of AD_VARIANTS) {
    assert.ok(v.key);
    for (const c of [v.palette.ink, v.palette.muted, v.palette.gold, v.palette.dark]) {
      assert.match(c, /^#[0-9a-f]{6}$/i);
    }
    assert.match(v.palette.panel, /^\d+,\d+,\d+$/);
    assert.ok(v.scene.includes("COMPLETELY EMPTY"));            // backdrop only — no product
    assert.ok(v.scene.includes("NO text, letters, logos"));     // nothing the model can garble
    assert.ok(v.scene.includes("NO people, faces, hands"));
  }
});

test("variant keys are unique", () => {
  assert.equal(new Set(AD_VARIANTS.map((v) => v.key)).size, AD_VARIANTS.length);
});

test("stable per product, rotates per tap, wraps around", () => {
  const a0 = pickVariant("product-a", 0);
  assert.equal(pickVariant("product-a", 0).key, a0.key);       // deterministic
  assert.notEqual(pickVariant("product-a", 1).key, a0.key);    // re-tap → new look
  assert.equal(pickVariant("product-a", AD_VARIANTS.length).key, a0.key); // wraps
});

test("hashSeed is deterministic and spreads different ids", () => {
  assert.equal(hashSeed("x"), hashSeed("x"));
  const keys = new Set(["p1", "p2", "p3", "p4", "p5"].map((s) => pickVariant(s, 0).key));
  assert.ok(keys.size >= 2); // different products land on different variants
});
