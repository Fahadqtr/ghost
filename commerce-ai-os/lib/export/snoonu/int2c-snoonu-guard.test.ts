// INT.2C — Snoonu multi-store export guard (source scan). Proves:
//   • Malikas / Pure Seoul isolation — identity is storefront-scoped, never shared
//   • ECL-first identity; NO dependency on legacy per-store id columns
//   • SKU-based image filenames (never title/random)
//   • the single canonical Snoonu template is reused (no second template)
//   • no catalog/inventory/availability/ECL writes; no Snoonu API publish; the
//     only write is the malak_audit trail via the shared helper
//   • writer-authorized download; read-only, server-only reader
// node --conditions=react-server --experimental-strip-types --test lib/export/snoonu/int2c-snoonu-guard.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

const PREVIEW = "lib/export/snoonu/preview.ts";
const SERVER = "lib/export/snoonu/preview.server.ts";
const PKG = "lib/export/snoonu/package.ts";
const XLSX = "lib/snoonu/package-xlsx.ts";
const GEN = "lib/snoonu/package.server.ts";
const ROUTE = "app/api/export/snoonu/[unit]/package/route.ts";
const COMPONENT = "components/v2/export/SnoonuExport.tsx";
const ALL = [PREVIEW, SERVER, PKG, XLSX, GEN, ROUTE, COMPONENT];

// ── storefront isolation ──────────────────────────────────────────────────────
test("identity is storefront-scoped — Malikas and Pure Seoul never share SPI", () => {
  const server = read(SERVER);
  assert.ok(/storefront_key\)\s*!==\s*storefrontKey/.test(server), "ECL is filtered to THIS storefront_key");
  assert.ok(/loadSnoonuPreview\(storefrontKey/.test(server) || /storefrontKey: SnoonuStorefrontKey/.test(server), "reader is per-storefront");
  const pure = read(PREVIEW);
  assert.ok(/storefrontKey: input\?\.storefrontKey|const storefrontKey = input/.test(pure), "preview is built per storefront");
  // the route maps the [unit] segment to exactly one storefront key
  const route = read(ROUTE);
  assert.ok(/malikas: "snoonu:malikas"/.test(route) && /"pure-seoul": "snoonu:pure_seoul"/.test(route), "unit → storefront mapping");
});

// ── ECL-first identity; no legacy per-store id columns anywhere ────────────────
test("SPI is ECL-first and no legacy per-store id column is referenced", () => {
  assert.ok(/external_channel_listings/.test(read(SERVER)), "reads ECL for identity");
  assert.ok(/external_product_id/.test(read(SERVER)), "SPI = ECL external_product_id");
  for (const f of ALL) {
    const s = read(f);
    for (const col of ["snoonu_id", "pure_seoul_id", "rafeeq_product_id"]) {
      assert.equal(s.includes(col), false, `${f} must not reference legacy column ${col}`);
    }
  }
  // SPI is never fabricated — unmapped stays null / blank
  assert.ok(/const UNMAPPED[\s\S]*externalId: null/.test(read(PREVIEW)), "absent mapping ⇒ null SPI");
  assert.ok(/snoonuId: r\.spi \?\? ""/.test(read(PKG)), "new product ⇒ blank Snoonu ID (never invented)");
});

// ── SKU-based image filenames ─────────────────────────────────────────────────
test("image filenames derive from the SKU (never the title)", () => {
  const pkg = read(PKG);
  assert.ok(/primaryImageName\(sku/.test(pkg) && /additionalImageName\(sku/.test(pkg), "primary + gallery from sku");
  assert.equal(/(primaryImageName|additionalImageName)\([^)]*(title|nameEn|nameAr)/.test(pkg), false, "never name an image from a title");
  assert.ok(/primaryImageName\(sku, ext\)/.test(read(PREVIEW)), "preview image filename from sku");
});

// ── single canonical template reused ──────────────────────────────────────────
test("the canonical Snoonu template is reused — no second template", () => {
  const pkg = read(PKG);
  assert.ok(/import \{ SNOONU_HEADERS \} from "\.\.\/\.\.\/exporters\.ts"/.test(pkg), "reuses SNOONU_HEADERS");
  assert.ok(/SNOONU_PACKAGE_COLUMNS = SNOONU_HEADERS/.test(pkg), "columns ARE the canonical header set");
});

// ── no business writes; no Snoonu publish; audit-only ─────────────────────────
test("generation performs no business mutation and no Snoonu publish", () => {
  for (const f of [GEN, ROUTE, COMPONENT, SERVER]) {
    const s = read(f);
    assert.equal(/\.publish\(|publishToSnoonu|pushProductsToShopify/.test(s), false, `${f} must not publish`);
  }
  for (const f of [GEN, SERVER]) {
    const s = read(f);
    for (const re of [/\.update\(/, /\.upsert\(/, /\.delete\(/, /\.rpc\(/]) {
      assert.equal(re.test(s), false, `${f} must not ${re}`);
    }
  }
  const gen = read(GEN);
  assert.equal(/\.insert\(/.test(gen), false, "no direct insert (audit goes through insertAuditRow)");
  assert.ok(/insertAuditRow\(/.test(gen) && /action_type: "snoonu_package_export"/.test(gen), "audits a package-export event");
  for (const re of [/@\/lib\/inventory\/engine/, /@\/lib\/availability\/engine/, /ecl-repair-write/, /transitionProductLifecycle/]) {
    assert.equal(re.test(gen), false, `generator must not touch ${re}`);
  }
});

// ── writer authorization + reused media/SSRF boundary + integrity ─────────────
test("download is writer-gated; media fetch reuses the SSRF-safe boundary; integrity before zip", () => {
  const route = read(ROUTE);
  assert.ok(/requireMalakWriter\(\)/.test(route) && /if \(!writer\.ok\)/.test(route), "writer-gated");
  const gen = read(GEN);
  assert.ok(/safeImageUrlOrNull\(|safeFetchImage\(/.test(gen), "reuses the certified media boundary");
  assert.equal(/169\.254|isPrivateIpv4|metadata\.google/.test(gen), false, "no rebuilt SSRF logic");
  const integrityAt = gen.indexOf("checkReferentialIntegrity(");
  const zipAt = gen.indexOf("buildZip(");
  assert.ok(integrityAt > -1 && zipAt > -1 && integrityAt < zipAt, "integrity is checked BEFORE the zip");
  assert.ok(/if \(!integrity\.ok\) return/.test(gen), "a failed integrity check aborts generation");
});

// ── read-only, server-only reader; client holds no DB ─────────────────────────
test("the reader is server-only + read-only and the client holds no DB access", () => {
  const server = read(SERVER);
  assert.ok(/import "server-only"/.test(server), "server-only");
  for (const re of [/\.update\(/, /\.insert\(/, /\.delete\(/, /\.upsert\(/, /\.rpc\(/]) {
    assert.equal(re.test(server), false, `reader must not write (${re})`);
  }
  const c = read(COMPONENT);
  for (const bad of [/createAdminClient/, /createClient\(/, /@\/lib\/supabase/, /\.from\(/]) {
    assert.equal(bad.test(c), false, `component must not contain ${bad}`);
  }
});
