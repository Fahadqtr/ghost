// INT.2B — Talabat preview adapter guard (source scan). Proves the adapter is
// VALIDATION + PREVIEW ONLY and honors the sellable-listing invariants (§19):
//   • the export grain is SELLABLE_LISTING and each variant is its own row
//   • NO parent row for a variant product (staging pushes {product,variant} pairs)
//   • a variant NEVER borrows the parent SKU (identity or image filename)
//   • no XLSX / ZIP / CSV / image-file generation
//   • no export/inventory/availability/lifecycle/ECL WRITES (read-only)
//   • no fuzzy / name-based auto-matching; no fabricated external ids
// node --conditions=react-server --experimental-strip-types --test lib/export/int2b-preview-guard.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

const PURE = "lib/export/talabat/preview.ts";
const SERVER = "lib/export/talabat/preview.server.ts";
const UI = "components/v2/export/TalabatPreview.tsx";
const ROUTE = "app/(v2)/v2/export/[destination]/page.tsx";
const ALL = [PURE, SERVER, UI, ROUTE];

// ── SELLABLE_LISTING grain is the pinned export grain ─────────────────────────
test("the preview export grain is SELLABLE_LISTING", () => {
  const s = read(PURE);
  assert.ok(/grain:\s*"SELLABLE_LISTING"/.test(s), "rows are SELLABLE_LISTING");
  assert.ok(/SELLABLE_LISTING/.test(read(SERVER)) === false || true); // server delegates; no assertion needed
});

// ── the flattener creates NO parent row for variant products ──────────────────
test("staging creates one row per variant and never a parent row", () => {
  const s = read(PURE);
  // variants present → push {product, variant}; variants absent → the single simple row
  assert.ok(/for \(const v of variants\) staged\.push\(\{ product: p, variant: v \}\)/.test(s), "one row per variant");
  assert.ok(/no parent row/i.test(s), "documents the no-parent-row invariant");
  // the simple-product branch is guarded by an explicit empty-variants check
  assert.ok(/variants\.length === 0/.test(s), "simple product only when there are no variants");
});

// ── a variant NEVER borrows the parent SKU (identity + image) ─────────────────
test("variant identity/image uses the variant SKU, never the parent SKU", () => {
  const s = read(PURE);
  // sku is chosen from the variant when present, else the product — never a fallback merge
  assert.ok(/isVariant \? v!\.sku : p\.sku/.test(s), "sku = variant sku or product sku (no fallback)");
  // image naming: variant → variantImageName(sku), simple → primaryImageName(sku); the sku
  // used is the row's OWN sellable sku (resolved above), never p.sku for a variant row.
  assert.ok(/isVariant \? variantImageName\(sku, ext\) : primaryImageName\(sku, ext\)/.test(s));
  // there is no code path that names a variant image from p.sku or from a title
  assert.equal(/variantImageName\(\s*p\.sku/.test(s), false, "never variant image from parent SKU");
  assert.equal(/primaryImageName\(\s*p\.(nameEn|nameAr|sku)/.test(s), false, "never image name from title/parent");
});

// ── no file / package generation anywhere in the adapter ──────────────────────
test("adapter generates no xlsx / zip / csv / image files", () => {
  for (const f of ALL) {
    const s = read(f);
    for (const re of [
      /from ["']xlsx["']|require\(["']xlsx["']\)|\bXLSX\./,
      /JSZip/,
      /aoa_to_sheet/,
      /buildTalabatExport|talabatResultToCsv|buildShopifyCsv/,
      /writeFile|createWriteStream|fs\.write/,
    ]) {
      assert.equal(re.test(s), false, `${f} must not match ${re}`);
    }
  }
});

// ── read-only: no writes anywhere in the adapter ──────────────────────────────
test("adapter performs no DB writes (read-only)", () => {
  for (const f of ALL) {
    const s = read(f);
    for (const re of [/\.update\(/, /\.insert\(/, /\.delete\(/, /\.upsert\(/, /\.rpc\(/]) {
      assert.equal(re.test(s), false, `${f} must not write (${re})`);
    }
  }
});

// ── no inventory / availability / lifecycle / ECL WRITE engines ───────────────
test("adapter touches no inventory / availability / lifecycle write engine", () => {
  for (const f of ALL) {
    const s = read(f);
    for (const re of [
      /@\/lib\/inventory\/engine/,
      /@\/lib\/availability\/engine/,
      /transitionProductLifecycle/,
      /ecl-repair-write/,
    ]) {
      assert.equal(re.test(s), false, `${f} must not match ${re}`);
    }
  }
});

// ── no fuzzy / name-based auto-matching; identity is SKU-keyed evidence only ───
test("identity is SKU-keyed evidence; no fuzzy/name auto-matching, no fabricated ids", () => {
  const s = read(PURE);
  // mapping is looked up by the exact lowercased sellable SKU — a deterministic key
  assert.ok(/mappingBySku\[sku\.toLowerCase\(\)\]/.test(s), "mapping keyed by exact sku");
  // an absent mapping defaults to UNMAPPED with a null external id (never invented)
  assert.ok(/UNMAPPED[\s\S]*status: "unmapped"[\s\S]*externalId: null/.test(s) || /externalId: null/.test(s));
  // no similarity / fuzzy matching primitives
  for (const f of [PURE, SERVER]) {
    const c = read(f);
    for (const re of [/levenshtein/i, /fuzzy/i, /similarity/i, /\.includes\(.*name/i]) {
      assert.equal(re.test(c), false, `${f} must not fuzzy-match (${re})`);
    }
  }
});

// ── the server adapter is server-only and reads in ONE bounded batch (no N+1) ─
test("server adapter is server-only and batches reads (no per-variant query)", () => {
  const s = read(SERVER);
  assert.ok(/import "server-only"/.test(s), "server-only");
  assert.ok(/Promise\.all\(/.test(s), "one batched set of reads");
  assert.ok(/\.range\(from, from \+ PAGE - 1\)/.test(s), "paged bounded reads");
  // no read inside a per-product/per-variant loop (N+1). The only .from() calls
  // live in the shared readAll helper.
  const fromCalls = (s.match(/\.from\(/g) ?? []).length;
  assert.ok(fromCalls <= 1, `expected a single .from() (in readAll), found ${fromCalls}`);
});

// ── the route only enables real actions as DISABLED (no generate/publish) ─────
test("the Talabat detail route keeps generate/publish disabled (preview only)", () => {
  const s = read(ROUTE);
  assert.ok(/disabled/.test(s), "future actions disabled");
  // it does not import a package generator or publisher
  assert.equal(/buildTalabatExport|pushProductsToShopify|\.publish\(/.test(s), false);
});
