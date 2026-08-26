// INT.2D — Rafeeq export guard (source scan). Proves:
//   • ECL-first identity; NO dependency on the legacy per-store id column
//   • no fuzzy/name identity matching; no auto-resolution of needs_review
//   • needs_review is BLOCKED; a claimed id is never promoted to the active id
//   • SKU-based image filenames (never title); shared package infra reused
//   • the single canonical Rafeeq template is reused (no second template)
//   • no catalog/inventory/availability/ECL writes; no Rafeeq API publish; the
//     only write is the malak_audit trail via the shared helper
//   • writer-authorized download; read-only, server-only reader
//   • the package derives from the same validated preview dataset
// node --conditions=react-server --experimental-strip-types --test lib/export/rafeeq/int2d-rafeeq-guard.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

const PREVIEW = "lib/export/rafeeq/preview.ts";
const SERVER = "lib/export/rafeeq/preview.server.ts";
const PKG = "lib/export/rafeeq/package.ts";
const XLSX = "lib/rafeeq/package-xlsx.ts";
const GEN = "lib/rafeeq/package.server.ts";
const ROUTE = "app/api/export/rafeeq/package/route.ts";
const COMPONENT = "components/v2/export/RafeeqExport.tsx";
const ALL = [PREVIEW, SERVER, PKG, XLSX, GEN, ROUTE, COMPONENT];

// ── ECL-first; no legacy per-store id column anywhere ─────────────────────────
test("identity is ECL-first and no legacy rafeeq_product_id column is referenced", () => {
  assert.ok(/external_channel_listings/.test(read(SERVER)), "reads ECL for identity");
  assert.ok(/external_product_id/.test(read(SERVER)), "Rafeeq ID = ECL external_product_id");
  assert.ok(/storefront_key\)\s*!==\s*RAFEEQ_STOREFRONT_KEY/.test(read(SERVER)), "ECL scoped to rafeeq:malikas");
  for (const f of ALL) {
    assert.equal(read(f).includes("rafeeq_product_id"), false, `${f} must not reference the legacy rafeeq_product_id column`);
  }
});

// ── no fuzzy/name matching; no auto-resolution of needs_review ─────────────────
test("no fuzzy/name matching and needs_review is never auto-resolved", () => {
  for (const f of [PREVIEW, SERVER, PKG, GEN]) {
    const s = read(f);
    for (const re of [/levenshtein/i, /fuzzy/i, /similarity/i, /\.includes\(.*name/i]) {
      assert.equal(re.test(s), false, `${f} must not fuzzy-match (${re})`);
    }
  }
  const preview = read(PREVIEW);
  // needs_review BLOCKS, and a non-resolved mapping never surfaces a usable id
  assert.ok(/mapping\.status === "needs_review"/.test(preview), "detects needs_review");
  assert.ok(/block\("IDENTITY_NEEDS_REVIEW"/.test(preview), "needs_review → block()");
  assert.ok(/rafeeqId = mapping\.status === "resolved" \? mapping\.externalId : null/.test(preview), "claimed/contested id is never promoted");
  // the generator does not resolve/activate anything
  assert.equal(/claimed_external_product_id|activateIdentity|resolveConflict/.test(read(GEN)), false, "no conflict resolution in the generator");
});

// ── SKU-based image filenames; shared infra reused ────────────────────────────
test("image filenames are SKU-based and the package reuses shared infrastructure", () => {
  const pkg = read(PKG);
  assert.ok(/primaryImageName\(sku/.test(pkg), "the ONE primary image is named from the parent sku");
  assert.equal(/additionalImageName\(/.test(pkg), false, "PRIMARY ONLY (owner contract): gallery image names are never produced for Rafeeq");
  assert.equal(/(primaryImageName|additionalImageName)\([^)]*(title|nameEn|nameAr)/.test(pkg), false, "never name an image from a title");
  const gen = read(GEN);
  assert.ok(/from "@\/lib\/net\/zip"/.test(gen), "reuses the shared ZIP writer");
  assert.ok(/from "@\/lib\/export\/package-core"/.test(gen), "reuses shared package-core");
  assert.ok(/RAFEEQ_NATIVE_HEADERS/.test(pkg) && /RAFEEQ_PACKAGE_COLUMNS = RAFEEQ_NATIVE_HEADERS/.test(pkg),
    "reuses the AUDITED native Rafeeq template (never a second/invented template)");
});

// ── package derives from the same validated preview dataset ────────────────────
test("the package is built from the certified preview dataset", () => {
  const gen = read(GEN);
  assert.ok(/loadRafeeqPreview\(\)/.test(gen), "consumes the certified preview");
  assert.ok(/resolveRafeeqGenerationSet\(/.test(gen), "selection via the pure plan");
  assert.equal(/\.from\(["'](products|product_variants|external_channel_listings)["']\)/.test(gen), false, "no direct re-read in the generator");
});

// ── no business writes; no Rafeeq publish; audit-only ─────────────────────────
test("generation performs no business mutation and no Rafeeq publish", () => {
  for (const f of [GEN, ROUTE, COMPONENT, SERVER]) {
    assert.equal(/\.publish\(|publishToRafeeq|pushProductsToShopify/.test(read(f)), false, `${f} must not publish`);
  }
  for (const f of [GEN, SERVER]) {
    const s = read(f);
    for (const re of [/\.update\(/, /\.upsert\(/, /\.delete\(/, /\.rpc\(/]) assert.equal(re.test(s), false, `${f} must not ${re}`);
  }
  const gen = read(GEN);
  assert.equal(/\.insert\(/.test(gen), false, "no direct insert (audit via insertAuditRow)");
  assert.ok(/insertAuditRow\(/.test(gen) && /action_type: "rafeeq_package_export"/.test(gen), "audits a package-export event");
  for (const re of [/@\/lib\/inventory\/engine/, /@\/lib\/availability\/engine/, /ecl-repair-write/, /transitionProductLifecycle/]) {
    assert.equal(re.test(gen), false, `generator must not touch ${re}`);
  }
});

// ── writer auth + SSRF-safe media + collision + integrity ─────────────────────
test("download is writer-gated; media reuses SSRF boundary; collision + integrity before zip", () => {
  const route = read(ROUTE);
  assert.ok(/requireMalakWriter\(\)/.test(route) && /if \(!writer\.ok\)/.test(route), "writer-gated");
  const gen = read(GEN);
  assert.ok(/safeImageUrlOrNull\(|safeFetchImage\(/.test(gen), "reuses the certified media boundary");
  assert.equal(/169\.254|isPrivateIpv4|metadata\.google/.test(gen), false, "no rebuilt SSRF logic");
  const collisionAt = gen.indexOf("detectFilenameCollisions(");
  const integrityAt = gen.indexOf("checkReferentialIntegrity(");
  const zipAt = gen.indexOf("buildZip(");
  assert.ok(collisionAt > -1 && collisionAt < zipAt, "collision checked before the zip");
  assert.ok(integrityAt > -1 && integrityAt < zipAt, "integrity checked before the zip");
});

// ── read-only, server-only reader; client holds no DB ─────────────────────────
test("reader is server-only + read-only and the client holds no DB access", () => {
  const server = read(SERVER);
  assert.ok(/import "server-only"/.test(server), "server-only");
  for (const re of [/\.update\(/, /\.insert\(/, /\.delete\(/, /\.upsert\(/, /\.rpc\(/]) assert.equal(re.test(server), false, `reader must not write (${re})`);
  const c = read(COMPONENT);
  for (const bad of [/createAdminClient/, /createClient\(/, /@\/lib\/supabase/, /\.from\(/]) assert.equal(bad.test(c), false, `component must not contain ${bad}`);
});
