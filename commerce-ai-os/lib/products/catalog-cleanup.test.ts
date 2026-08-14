// Catalog Cleanup (post-migration) guards. Locks in the low-risk cleanup that
// followed the final Catalog audit:
//   1. the duplicate barcode generator (a local genEan13) is gone — catalog/health
//      uses the canonical lib/products/barcode-ean13 module;
//   2. the three dead exports orphaned by UX.4E-9C stay deleted and unimported;
//   3. the legacy product editor + Excel importer files stay absent.
//
// PURE — no DB, no network, no React. It reads source text and checks file
// existence only.
//
// Run: node --conditions=react-server --experimental-strip-types --test lib/products/catalog-cleanup.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

/** Every runtime .ts/.tsx file under the given dirs (tests excluded). */
function runtimeFiles(dirs: readonly string[]): string[] {
  const out: string[] = [];
  for (const dir of dirs) {
    for (const entry of readdirSync(join(ROOT, dir), { recursive: true })) {
      const rel = join(dir, String(entry));
      if (!/\.(ts|tsx)$/.test(rel) || /\.test\.(ts|tsx)$/.test(rel)) continue;
      if (!statSync(join(ROOT, rel)).isFile()) continue;
      out.push(rel);
    }
  }
  return out;
}

const HEALTH_PAGE = "app/(app)/catalog/health/page.tsx";

// ── 1. No duplicate barcode generator ────────────────────────────────────────
// The canonical EAN-13 generator lives in lib/products/barcode-ean13.ts. No
// runtime file may declare or call a local `genEan13` clone of it.

test("no runtime file declares or calls a local genEan13", () => {
  const offenders: string[] = [];
  for (const rel of runtimeFiles(["app", "components"])) {
    const src = read(rel);
    if (/\bfunction\s+genEan13\b/.test(src) || /\bconst\s+genEan13\b/.test(src)) {
      offenders.push(`${rel} declares genEan13`);
    }
    if (/\bgenEan13\s*\(/.test(src)) offenders.push(`${rel} calls genEan13`);
  }
  assert.deepEqual(offenders, [], "no local genEan13 clone remains");
});

test("catalog/health generates barcodes via the canonical module", () => {
  const src = read(HEALTH_PAGE);
  assert.ok(
    /import\s*\{[^}]*\bgenerateEan13\b[^}]*\}\s*from\s*["']@\/lib\/products\/barcode-ean13["']/.test(src),
    "imports generateEan13 from the canonical module",
  );
  assert.ok(src.includes("generateEan13(Math.random)"), "calls the canonical generator");
});

// ── 2. Dead exports stay deleted and unimported ──────────────────────────────

const DEAD_EXPORTS = ["describeProductFromImage", "uploadNewProductImage", "editNewProductImage"];

test("the dead exports are defined nowhere in runtime code", () => {
  const offenders: string[] = [];
  for (const rel of runtimeFiles(["app", "components", "lib"])) {
    const src = read(rel);
    for (const sym of DEAD_EXPORTS) {
      if (new RegExp(`export\\s+(?:async\\s+)?(?:function|const)\\s+${sym}\\b`).test(src)) {
        offenders.push(`${rel} still exports ${sym}`);
      }
    }
  }
  assert.deepEqual(offenders, [], "no dead export definition remains");
});

test("nothing imports the dead exports", () => {
  const offenders: string[] = [];
  const importRe = /import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*["'][^"']*products\/(?:actions|image-actions)["']/g;
  for (const rel of runtimeFiles(["app", "components", "lib"])) {
    const src = read(rel);
    for (const m of src.matchAll(importRe)) {
      for (const sym of DEAD_EXPORTS) {
        if (new RegExp(`\\b${sym}\\b`).test(m[1])) offenders.push(`${rel} imports ${sym}`);
      }
    }
  }
  assert.deepEqual(offenders, [], "no runtime import of the dead exports");
});

// ── 3. Legacy editor + importer files stay absent ────────────────────────────

test("legacy product editor and Excel importer files remain deleted", () => {
  for (const rel of [
    "components/ProductForm.tsx",
    "components/ExcelImport.tsx",
    "app/(app)/import-export/actions.ts",
  ]) {
    assert.equal(existsSync(join(ROOT, rel)), false, `${rel} must stay deleted`);
  }
});
