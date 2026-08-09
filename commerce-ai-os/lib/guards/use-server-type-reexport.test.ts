// Guard: a "use server" module must not LOCALLY re-export a type binding, i.e.
//   export type { X, Y };            // ← no `from` clause
// when X/Y are type-only imports. Turbopack's server-action transform emits a
// runtime reference to those erased bindings, which crashes the whole route at
// module evaluation:
//   ReferenceError: X is not defined
// The safe form re-exports straight from the source module, so nothing local is
// referenced at runtime:
//   export type { X, Y } from "@/lib/...";
//
// This regressed /import-export/pure-seoul in production (app/(app)/products/
// actions.ts:31). Scope is deliberately narrow — only server-action files under
// app/, only the local `export type { ... };` form, only type-only names.
//
// Run: node --conditions=react-server --experimental-strip-types --test lib/guards/use-server-type-reexport.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const APP_DIR = fileURLToPath(new URL("../../app/", import.meta.url));

// All server-action source files: .ts under app/ that carry the "use server"
// directive. (Route/layout .tsx are Server Components, not action modules.)
function useServerFiles(): string[] {
  const out: string[] = [];
  for (const rel of readdirSync(APP_DIR, { recursive: true }) as string[]) {
    if (!rel.endsWith(".ts") || rel.endsWith(".d.ts") || rel.includes("node_modules")) continue;
    const src = readFileSync(APP_DIR + rel, "utf8");
    if (/^\s*(["'])use server\1/m.test(src)) out.push(rel);
  }
  return out;
}

// A local `export type { ... };` (ends in `;` — no `from` clause).
const LOCAL_TYPE_REEXPORT = /export\s+type\s*\{([^}]*)\}\s*;/g;

test('no "use server" file locally re-exports type-only bindings (no `from`)', () => {
  const violations: string[] = [];

  for (const rel of useServerFiles()) {
    const src = readFileSync(APP_DIR + rel, "utf8");
    for (const m of src.matchAll(LOCAL_TYPE_REEXPORT)) {
      const names = m[1].split(",").map((n) => n.trim().split(/\s+as\s+/)[0].trim()).filter(Boolean);
      // Only flag names that are TYPE-ONLY imports in this same file — those are
      // erased at runtime, so the local re-export becomes a dangling reference.
      const typeOnly = names.filter((name) => {
        const importedAsType = new RegExp(`\\btype\\s+${name}\\b`).test(src);
        const declaredAsValue = new RegExp(`\\b(?:function|const|let|var|class)\\s+${name}\\b`).test(src);
        return importedAsType && !declaredAsValue;
      });
      if (typeOnly.length > 0) {
        violations.push(`${rel}: export type { ${typeOnly.join(", ")} }; → use \`export type { … } from "…"\` instead`);
      }
    }
  }

  assert.deepEqual(
    violations,
    [],
    `Local type re-export in a "use server" file crashes the route at module eval:\n${violations.join("\n")}`
  );
});
