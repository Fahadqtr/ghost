// INT.2F.2 — Final Talabat legacy retirement guard (source scan). Proves:
//   • the legacy per-channel CSV route is FULLY retired (410 for every channel,
//     incl. talabat) — no Talabat CSV/flatten/persist remains operator-reachable;
//   • channel_variant_mappings persistence is re-homed to the certified,
//     server-only catalog-sync helper, triggered by the writer-gated package route;
//   • the catalog-sync delegates to the INT.2F.1 boundary (no duplicate writer),
//     uses the SAME candidate builder + exact channel + fail-closed gate, and
//     introduces no legacy ids / fuzzy matching / inventory / availability writes;
//   • the Export Center is the sole operator-facing Talabat export path;
//   • order-deduction reads the same mapping keys (unchanged);
//   • /api/export/images is retained (still a live TalabatSync dependency).
// node --conditions=react-server --experimental-strip-types --test lib/talabat/mapping-sync/int2f2-retirement-guard.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
const exists = (rel: string) => existsSync(join(ROOT, rel));
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

const LEGACY_ROUTE = "app/api/export/[channel]/route.ts";
const PACKAGE_ROUTE = "app/api/export/talabat/package/route.ts";
const CATALOG_SYNC = "lib/talabat/mapping-sync/catalog-sync.server.ts";
const EXPORT_PAGE = "app/(app)/import-export/export/page.tsx";
const RESOLUTION = "lib/talabat/resolution-context.ts";

// ── 1. legacy CSV route fully retired ─────────────────────────────────────────
test("the legacy per-channel CSV route is fully retired (410 for every channel incl. talabat)", () => {
  const r = strip(read(LEGACY_ROUTE));
  assert.ok(/status: 410/.test(r), "returns 410");
  assert.ok(/talabat:\s*"\/v2\/export\/talabat:malikas"/.test(r), "talabat retired to the Export Center");
  assert.equal(/text\/csv|talabatResultToCsv|buildTalabatExport|syncTalabatMappings/.test(r), false, "no Talabat CSV/flatten/persist remains");
  assert.equal(/createClient|createAdminClient|\.from\(/.test(r), false, "the retired route performs no reads/writes");
});

// ── 2. mapping persistence re-homed to the certified path ─────────────────────
test("mapping persistence is re-homed to a server-only catalog-sync, triggered by the writer-gated package route", () => {
  const sync = strip(read(CATALOG_SYNC));
  assert.ok(/import "server-only"/.test(read(CATALOG_SYNC)), "catalog-sync is server-only");
  assert.ok(/syncTalabatMappings\(/.test(sync), "delegates to the INT.2F.1 boundary");
  assert.equal(/persistTalabatMappings\(/.test(sync), false, "does NOT duplicate the low-level writer");
  assert.ok(/buildTalabatExport\(/.test(sync), "computes the SAME candidates via buildTalabatExport");
  assert.ok(/resolveExactChannelId\(/.test(sync) && /decideExportGate\(/.test(sync), "exact channel + fail-closed gate retained");

  const pkg = strip(read(PACKAGE_ROUTE));
  const gate = pkg.indexOf("requireMalakWriter(");
  const call = pkg.indexOf("syncTalabatMappingsFromCatalog(");
  assert.ok(gate > -1 && call > -1 && gate < call, "package route is writer-gated BEFORE triggering the sync");
});

// ── 3. no duplicate writer / no legacy ids / no fuzzy / no inventory writes ────
test("catalog-sync introduces no legacy ids, no fuzzy matching, no inventory/availability writes", () => {
  const s = strip(read(CATALOG_SYNC));
  assert.equal(/snoonu_id|rafeeq_product_id|pure_seoul_id/.test(s), false, "no legacy id columns");
  for (const re of [/levenshtein/i, /fuzzy/i, /similarity/i, /normTitle/]) assert.equal(re.test(s), false, `no ${re}`);
  // never writes inventory / availability / lifecycle / channel-status tables
  for (const t of ["inventory", "product_variants\"\\)\\.update", "platform_status\"\\)\\.update", "channel_status"]) {
    assert.equal(new RegExp(`\\.update\\(`).test(s) && new RegExp(t).test(s), false, `no write to ${t}`);
  }
  // only the mapping upsert (via the boundary) — no other .update/.upsert/.delete
  assert.equal(/\.upsert\(|\.update\(|\.delete\(|\.rpc\(/.test(s), false, "no direct table mutation in catalog-sync");
});

// ── 4. Export Center is the sole operator-facing Talabat export path ───────────
test("Export Center is the sole Talabat export path — legacy CSV UI deleted, page redirects", () => {
  assert.equal(exists("components/TalabatExport.tsx"), false, "legacy TalabatExport.tsx deleted");
  const page = read(EXPORT_PAGE);
  // UX.NAV.2 canonicalised the redirect target: the hub card promises every
  // channel, so the Export Center DASHBOARD is the landing (Talabat included).
  assert.ok(/redirect\("\/v2\/export"\)/.test(page), "export page redirects to the Export Center");
  assert.equal(/TalabatExport/.test(page), false, "no legacy CSV trigger rendered");
  assert.ok(exists(PACKAGE_ROUTE), "the certified package route remains");
});

// ── 5. order-deduction reads the SAME mapping keys (unchanged) ─────────────────
test("order-deduction reader is unchanged and keyed on channel_id + master identity", () => {
  const rc = read(RESOLUTION);
  assert.ok(/\.from\(\s*["']channel_variant_mappings["']\s*\)/.test(rc), "reads channel_variant_mappings");
  for (const k of ["channel_id", "master_product_id", "master_variant_sku"]) {
    assert.ok(rc.includes(k), `order-dedup still reads ${k}`);
  }
});

// ── 6. /api/export/images retained (live TalabatSync dependency) ───────────────
test("/api/export/images is retained (still referenced by TalabatSync) — not retired speculatively", () => {
  assert.ok(exists("app/api/export/images/route.ts"), "images route retained");
  assert.ok(/\/api\/export\/images/.test(read("components/TalabatSync.tsx")), "TalabatSync still depends on it");
});
