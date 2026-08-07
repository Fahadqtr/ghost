// Operations Engine purity guard (Phase UI.7.1).
//
// The whole point of lib/operations is that every engine is a PURE function
// layer: models in, models out. This scan fails the suite if anyone slips in
// a database client, fetch, storage, clock, randomness, or a runtime import
// (only `import type` from shared models is allowed — that is what keeps the
// engines directly loadable by node:test).
// Run: node --conditions=react-server --experimental-strip-types --test lib/operations/operations-purity.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const ENGINE_FILES = [
  "shared/models.ts",
  "readiness/readiness.ts",
  "tasks/task-engine.ts",
  "platforms/platform-status.ts",
  "new-products/new-product-engine.ts",
  "health/health-engine.ts",
] as const;

const BANNED = [
  "fetch(",
  "supabase",
  "createClient",
  "createAdminClient",
  "process.env",
  "Date.now",
  "new Date(",
  "Math.random",
  "localStorage",
  "console.",
  '"use server"',
  "server-only",
  "next/",
  "@/lib",
  ".rpc(",
] as const;

function src(rel: string): string {
  return readFileSync(new URL(`./${rel}`, import.meta.url), "utf8");
}

test("engines are pure: no db/network/storage/clock/randomness/framework code", () => {
  for (const rel of ENGINE_FILES) {
    const text = src(rel);
    for (const banned of BANNED) {
      assert.ok(!text.includes(banned), `${rel} must not contain ${banned}`);
    }
  }
});

test("engines only ever use type-only imports (node-loadable, zero runtime deps)", () => {
  for (const rel of ENGINE_FILES) {
    const lines = src(rel).split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line.startsWith("import ")) continue;
      assert.ok(
        line.startsWith("import type"),
        `${rel}:${i + 1} — engines may only "import type": ${line}`,
      );
    }
  }
});

test("shared/models.ts is types ONLY — no runtime exports at all", () => {
  const lines = src("shared/models.ts").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line.startsWith("export ")) continue;
    assert.ok(
      line.startsWith("export type") || line.startsWith("export interface"),
      `shared/models.ts:${i + 1} — runtime export forbidden in the models module: ${line}`,
    );
  }
});
