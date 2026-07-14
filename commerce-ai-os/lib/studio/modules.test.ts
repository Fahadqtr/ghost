import test from "node:test";
import assert from "node:assert/strict";

import { STUDIO_MODULES, STUDIO_QUICK_ACTIONS, studioModule, STUDIO_STATUS_LABEL } from "./modules.ts";

test("all expected studio modules exist with unique slugs", () => {
  const expected = [
    "ai-manager", "products", "script-writer", "dialect", "prompts", "templates",
    "video", "voice", "translate", "logo", "queue", "quality", "settings",
  ];
  const slugs = STUDIO_MODULES.map((m) => m.slug);
  for (const e of expected) assert.ok(slugs.includes(e), `missing module ${e}`);
  assert.equal(new Set(slugs).size, slugs.length, "slugs must be unique");
});

test("every module has labels, icon, description, status and a wiring note", () => {
  for (const m of STUDIO_MODULES) {
    assert.ok(m.labelAr && m.labelEn && m.icon && m.descAr && m.wiring, `incomplete module ${m.slug}`);
    assert.ok(["planned", "partial", "live"].includes(m.status));
    assert.ok(STUDIO_STATUS_LABEL[m.status]);
  }
});

test("studioModule looks up by slug", () => {
  assert.equal(studioModule("video")?.labelEn, "Video Engine");
  assert.equal(studioModule("nope"), undefined);
});

test("quick actions all point under /studio", () => {
  for (const a of STUDIO_QUICK_ACTIONS) assert.match(a.href, /^\/studio\//);
});
