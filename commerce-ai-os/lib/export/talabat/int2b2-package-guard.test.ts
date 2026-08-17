// INT.2B.2 — Talabat package-generator guard (source scan). Proves the file
// generator honors every P0 invariant (§26):
//   • it CONSUMES the certified INT.2B preview (no second flattening algorithm)
//   • no parent row for a variant product; no parent SKU / parent image for variants
//   • no BLOCKED row is ever packaged
//   • exported image filenames are SKU-derived only (never title/random/UUID)
//   • no Talabat publish; no inventory/availability/lifecycle/ECL/catalog writes
//     (the ONLY write is the malak_audit trail via the shared helper)
//   • generation is WRITER-authorized; the certified media/SSRF boundary is reused
// node --conditions=react-server --experimental-strip-types --test lib/export/talabat/int2b2-package-guard.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

const PKG = "lib/export/talabat/package.ts";
const XLSX = "lib/talabat/package-xlsx.ts";
const SERVER = "lib/talabat/package.server.ts";
const ROUTE = "app/api/export/talabat/package/route.ts";
const CONTROLS = "components/v2/export/TalabatPackageControls.tsx";
const PREVIEW = "lib/export/talabat/preview.ts";

// ── consumes the certified preview; no second flattening ──────────────────────
test("the generator consumes the INT.2B canonical preview", () => {
  const s = read(SERVER);
  assert.ok(/loadTalabatPreview\(\)/.test(s), "reads the certified preview adapter");
  assert.ok(/resolveGenerationSet\(/.test(s), "delegates row selection to the pure plan");
  // it does NOT run the legacy whole-export generator or re-read the catalog itself
  assert.equal(/buildTalabatExport|talabatResultToCsv/.test(s), false, "no legacy exporter");
  assert.equal(/\.from\(["'](products|product_variants)["']\)/.test(s), false, "no direct catalog re-read");
});

test("there is exactly ONE flattening — only the preview stages variants into rows", () => {
  // the sole flattener lives in preview.ts
  assert.ok(/for \(const v of variants\) staged\.push/.test(read(PREVIEW)), "preview owns the flattening");
  // neither the plan nor the generator re-implements flattening or re-derives titles
  for (const f of [PKG, SERVER, XLSX]) {
    const s = read(f);
    assert.equal(/buildFlattenedName|staged\.push|for \(const v of .*variants/.test(s), false, `${f} must not re-flatten`);
    // the plan/generator consume FLAT rows — they never walk a product's variants
    assert.equal(/\.variants\b/.test(s), false, `${f} must not read product.variants`);
  }
});

// ── no parent row / no parent identity for variants ───────────────────────────
test("no parent row or parent SKU/image is ever used for a variant", () => {
  for (const f of [PKG, SERVER]) {
    const s = read(f);
    // filenames + identity come from the row's OWN sellable sku (r.sku), never a parent
    assert.equal(/parentSku|parent_sku|p\.sku|product\.sku/.test(s), false, `${f} must not use a parent sku`);
    assert.equal(/parentImage|parent_image/.test(s), false, `${f} must not use a parent image`);
  }
  // image filenames are built from the sellable SKU via the certified helpers only
  const pkg = read(PKG);
  assert.ok(/primaryImageName\(sku|variantImageName\(sku/.test(pkg), "primary/variant filename from sku");
  assert.equal(/(primaryImageName|variantImageName|additionalImageName)\([^)]*(title|nameEn|nameAr)/.test(pkg), false, "never name an image from a title");
});

// ── variant image is DISCLOSED, never blocked; MISSING_VARIANT_IMAGE never added ─
test("a variant sharing the product image is a non-blocking disclosure, never a block", () => {
  const preview = read(PREVIEW);
  // the shared-image case is emitted as a WARNING (warn), never as a block
  assert.ok(/warn\("IMAGE_SHARED_FROM_PRODUCT"/.test(preview), "shared image → warn(), not block()");
  assert.equal(/block\("IMAGE_SHARED_FROM_PRODUCT"/.test(preview), false, "never blocks on shared image");
  // the forbidden MISSING_VARIANT_IMAGE concept was never introduced anywhere
  for (const f of [PREVIEW, PKG, SERVER, XLSX, ROUTE, CONTROLS]) {
    assert.equal(/MISSING_VARIANT_IMAGE/.test(read(f)), false, `${f} must not introduce MISSING_VARIANT_IMAGE`);
  }
});

// ── no blocked row is ever packaged ───────────────────────────────────────────
test("blocked rows can never enter the package", () => {
  const s = read(PKG);
  assert.ok(/status === "READY" \|\| .*status === "WARNING"/.test(s), "exportable = READY or WARNING only");
  assert.ok(/excludedBlocked\.push/.test(s), "blocked rows are routed to the excluded bucket");
  // a blocked row is skipped BEFORE any selection membership check
  assert.ok(/if \(!isExportableRow\(r\)\)/.test(s), "non-exportable rows short-circuit first");
});

// ── no Talabat publish / no channel-or-business writes ────────────────────────
test("generation performs no publish and no business-data mutation", () => {
  for (const f of [SERVER, ROUTE, CONTROLS]) {
    const s = read(f);
    assert.equal(/\.publish\(|pushProductsToShopify|publishToTalabat/.test(s), false, `${f} must not publish`);
  }
  // the server generator writes NOTHING except the audit trail (via the helper).
  const server = read(SERVER);
  for (const re of [/\.update\(/, /\.upsert\(/, /\.delete\(/, /\.rpc\(/]) {
    assert.equal(re.test(server), false, `generator must not ${re}`);
  }
  // no direct .insert on any business table — the only write is insertAuditRow
  assert.equal(/\.insert\(/.test(server), false, "no direct insert (audit goes through insertAuditRow)");
  assert.ok(/insertAuditRow\(/.test(server), "durable history uses the shared audit helper");
  assert.ok(/action_type: "talabat_package_export"/.test(server), "audits a package-export event");
  // no inventory / availability / lifecycle / ECL write engines
  for (const re of [/@\/lib\/inventory\/engine/, /@\/lib\/availability\/engine/, /transitionProductLifecycle/, /ecl-repair-write/]) {
    assert.equal(re.test(server), false, `generator must not touch ${re}`);
  }
});

// ── writer authorization + reused media boundary ──────────────────────────────
test("the download route is WRITER-authorized and exposes no service role to the client", () => {
  const route = read(ROUTE);
  assert.ok(/requireMalakWriter\(\)/.test(route), "writer boundary enforced");
  assert.ok(/if \(!writer\.ok\)/.test(route), "unauthorized is rejected");
  // the client controls never import an admin/service-role client
  const controls = read(CONTROLS);
  assert.equal(/createAdminClient|service_role|SUPABASE_SERVICE/.test(controls), false, "no service role in the client");
});

test("image fetching reuses the certified SSRF-safe boundary (no rebuilt logic)", () => {
  const s = read(SERVER);
  assert.ok(/safeImageUrlOrNull\(|safeFetchImage\(/.test(s), "reuses the certified media fetch boundary");
  // it does not re-implement its own private-network/SSRF checks
  assert.equal(/169\.254|isPrivateIpv4|isPrivateHost|metadata\.google/.test(s), false, "no rebuilt SSRF logic");
  // content is verified before packaging (real image bytes)
  assert.ok(/sniffImageExtension\(/.test(s), "verifies actual image content");
});

// ── XLSX↔ZIP referential integrity is checked before finalization ─────────────
test("an integrity check runs before the archive is finalized", () => {
  const s = read(SERVER);
  const integrityAt = s.indexOf("checkReferentialIntegrity(");
  const zipAt = s.indexOf("buildZip(");
  assert.ok(integrityAt > -1, "integrity is checked");
  assert.ok(zipAt > -1, "archive is built");
  assert.ok(integrityAt < zipAt, "integrity is verified BEFORE the zip is assembled");
  assert.ok(/if \(!integrity\.ok\) return/.test(s), "a failed integrity check aborts generation");
});
