import test from "node:test";
import assert from "node:assert/strict";

import { planReelShots, shotCountForDuration, MIN_SHOTS, MAX_SHOTS } from "./shot-plan.ts";

test("planReelShots(3) opens on hero and ends on cta with a detail in between", () => {
  const shots = planReelShots(3);
  assert.equal(shots.length, 3);
  assert.deepEqual(shots.map((s) => s.key), ["hero", "detail", "cta"]);
  assert.ok(shots.every((s) => s.prompt.length > 20));
});

test("planReelShots(4) inserts a lifestyle shot before the cta", () => {
  const shots = planReelShots(4);
  assert.deepEqual(shots.map((s) => s.key), ["hero", "detail", "lifestyle", "cta"]);
});

test("planReelShots clamps out-of-range counts to [3,4]", () => {
  assert.equal(planReelShots(1).length, MIN_SHOTS);
  assert.equal(planReelShots(9).length, MAX_SHOTS);
  assert.equal(planReelShots(0).length, MIN_SHOTS);
});

test("every shot keeps the product identity locked", () => {
  for (const s of planReelShots(4)) {
    assert.match(s.prompt, /EXACTLY as in the image/);
  }
});

test("shotCountForDuration uses 3 shots normally and 4 for a long voice", () => {
  assert.equal(shotCountForDuration(8.5), 3);
  assert.equal(shotCountForDuration(12), 3);
  assert.equal(shotCountForDuration(16), 4);
  assert.equal(shotCountForDuration(null), 3);
});
