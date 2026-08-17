// INT.2A — Export Center foundation guard (source scan). Proves the foundation
// is READ-ONLY and generates nothing (§21):
//   • no file generation (xlsx / zip / csv), no Shopify publish/update
//   • no inventory / availability / lifecycle / ECL writes
//   • no dependency on legacy identity columns (snoonu_id / pure_seoul_id / rafeeq_product_id)
//   • no Talabat parent-level flattening implementation yet (metadata only)
//   • no platform-specific business logic duplicated (no adapter/exporter imports)
//   • the Talabat sellable-grain + Snoonu two-store invariants are pinned
// node --conditions=react-server --experimental-strip-types --test lib/export/int2a-export-guard.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

function walk(dir: string, out: string[] = []): string[] {
  const abs = join(ROOT, dir);
  if (!existsSync(abs)) return out;
  for (const name of readdirSync(abs)) {
    const rel = `${dir}/${name}`;
    const st = statSync(join(ROOT, rel));
    if (st.isDirectory()) walk(rel, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(rel);
  }
  return out;
}

// The full INT.2A foundation surface (pure lib + routes + component).
const FOUNDATION = [
  ...walk("lib/export"),
  ...walk("app/(v2)/v2/export"),
  "components/v2/export/ExportCenter.tsx",
];

// ── read-only: no writes anywhere in the foundation ───────────────────────────
test("foundation performs no DB writes (read-only)", () => {
  for (const f of FOUNDATION) {
    const s = read(f);
    for (const re of [/\.update\(/, /\.insert\(/, /\.delete\(/, /\.upsert\(/, /\.rpc\(/]) {
      assert.equal(re.test(s), false, `${f} must not write (${re})`);
    }
  }
});

// ── no file/package generation, no Shopify publish ────────────────────────────
test("foundation generates no xlsx / zip / csv and never publishes to Shopify", () => {
  for (const f of FOUNDATION) {
    const s = read(f);
    for (const re of [
      // xlsx GENERATION (the SheetJS library), not the "xlsx" capability metadata string
      /from ["']xlsx["']|require\(["']xlsx["']\)|\bXLSX\./,
      /JSZip/,
      /aoa_to_sheet/,
      /buildShopifyCsv|buildSnoonuCsv|buildRafeeqAoa|buildTalabatExport|talabatResultToCsv/,
      /\.publish\(/,
      /pushProductsToShopify|shopify-adapter/,
      /createRequire/,
    ]) {
      assert.equal(re.test(s), false, `${f} must not match ${re}`);
    }
  }
});

// ── no inventory / availability / lifecycle / ECL writes or engines ───────────
test("foundation touches no inventory / availability / lifecycle / ECL write path", () => {
  for (const f of FOUNDATION) {
    const s = read(f);
    for (const re of [
      /@\/lib\/inventory\/engine/,
      /@\/lib\/availability\/engine/,
      /transitionProductLifecycle/,
      // ECL reads for identity evidence are allowed (INT.2B); ECL WRITES are not
      // (the blanket no-write test above already forbids insert/update/delete/upsert).
      /ecl-repair-write/,
    ]) {
      assert.equal(re.test(s), false, `${f} must not match ${re}`);
    }
  }
});

// ── no legacy identity-column dependency ──────────────────────────────────────
test("foundation does not depend on legacy identity columns", () => {
  for (const f of FOUNDATION) {
    const s = read(f);
    for (const col of ["snoonu_id", "pure_seoul_id", "rafeeq_product_id"]) {
      assert.equal(s.includes(col), false, `${f} must not reference legacy column ${col}`);
    }
  }
});

// ── no platform-specific business logic duplicated ────────────────────────────
// INT.2B REUSES the certified Talabat atomic helpers (buildFlattenedName /
// normalizeExportedSku / normalizeBarcode / isApprovedForTalabat) rather than
// reinventing them — that reuse is the point, not a violation. What stays
// forbidden is DUPLICATING logic via the legacy platform adapters / exporters /
// diff, and running the whole-export GENERATOR (buildTalabatExport is forbidden
// by the xlsx/package test above).
test("foundation imports no platform adapter / legacy exporter (no duplicated logic)", () => {
  for (const f of FOUNDATION) {
    const s = read(f);
    for (const re of [/@\/lib\/adapters\//, /@\/lib\/exporters/, /@\/lib\/talabat-diff/]) {
      assert.equal(re.test(s), false, `${f} must not import ${re}`);
    }
  }
});

// ── adapter foundation returns NOT_IMPLEMENTED for generate/publish ───────────
test("adapter contract declares NOT_IMPLEMENTED foundations for generate/publish", () => {
  const s = read("lib/export/adapter.ts");
  assert.ok(/NOT_IMPLEMENTED/.test(s));
  assert.ok(/notImplementedPackage/.test(s) && /notImplementedPublish/.test(s));
});

// ── Talabat sellable-grain invariant pinned in the registry ───────────────────
// (INT.2B implements the flattener in lib/export/talabat/preview.ts — the
// int2b-preview-guard test owns the "one row per variant, no parent row" proof;
// here we only pin that the grain is declared in the certified registries.)
test("Talabat sellable-listing invariant is pinned in the registry", () => {
  const dest = read("lib/export/destinations.ts");
  assert.ok(/"talabat:malikas":\s*\[[^\]]*"flattened_variants"/.test(dest), "talabat declares flattened_variants");
  // the certified grain lives in the storefront registry (talabat = variant)
  const sf = read("lib/channels/storefronts.ts");
  assert.ok(/"talabat:malikas"[\s\S]*?listingGrain:\s*"variant"/.test(sf), "storefront registry pins Talabat variant grain");
});

// ── Snoonu two-store isolation pinned ─────────────────────────────────────────
test("Snoonu two storefronts are both registered and isolated", () => {
  const dest = read("lib/export/destinations.ts");
  // capabilities keyed independently for each snoonu storefront
  assert.ok(/"snoonu:malikas":/.test(dest));
  assert.ok(/"snoonu:pure_seoul":/.test(dest));
  // the registry itself is the certified storefront registry (no second registry)
  assert.ok(/from "\.\.\/channels\/storefronts\.ts"/.test(dest), "reuses the certified storefront registry");
});

// ── history honestly unavailable ──────────────────────────────────────────────
test("history contract defaults to UNAVAILABLE (no fabricated export log)", () => {
  const s = read("lib/export/history.ts");
  assert.ok(/UNAVAILABLE/.test(s));
  assert.ok(/no durable export-history/i.test(s), "documents the absent source");
});
