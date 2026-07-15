import test from "node:test";
import assert from "node:assert/strict";

import { parseTechniqueInputs, hasPromptInput } from "./flora-compute.ts";

test("parseTechniqueInputs reads inputs from the common shapes", () => {
  assert.deepEqual(
    parseTechniqueInputs({ inputs: [{ id: "img", type: "imageUrl" }, { id: "visual_prompt", type: "text" }] }),
    [{ id: "img", type: "imageUrl" }, { id: "visual_prompt", type: "text" }],
  );
  assert.deepEqual(
    parseTechniqueInputs({ data: { inputs: [{ name: "visual_prompt", inputType: "text" }] } }),
    [{ id: "visual_prompt", type: "text" }],
  );
  assert.deepEqual(parseTechniqueInputs({}), []);
});

test("hasPromptInput matches the preferred id first", () => {
  const inputs = [{ id: "img", type: "imageUrl" }, { id: "visual_prompt", type: "text" }];
  const r = hasPromptInput(inputs, "visual_prompt");
  assert.equal(r.ok, true);
  assert.equal(r.matched?.id, "visual_prompt");
});

test("hasPromptInput falls back to any text-typed input", () => {
  const r = hasPromptInput([{ id: "motion", type: "text" }], "visual_prompt");
  assert.equal(r.ok, true);
  assert.equal(r.matched?.id, "motion");
});

test("hasPromptInput returns false when the technique is image-only", () => {
  const r = hasPromptInput([{ id: "imgi_46_x", type: "imageUrl" }], "visual_prompt");
  assert.equal(r.ok, false);
});
