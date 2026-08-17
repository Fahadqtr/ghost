// INT.2E — Shopify validation + preview guard (source scan). Proves:
//   • READ-ONLY: no Shopify Admin MUTATION method is imported or called; no
//     product/price/media/inventory write; the only live call is the canonical
//     paginated READ (fetchAllShopifyProducts)
//   • no ECL / catalog / inventory / availability / lifecycle WRITE anywhere
//   • ECL-first GID identity; NO legacy per-store id column; NO fuzzy/name match;
//     needs_review is a CONFLICT and a claimed GID is never promoted
//   • no auto-publish rule and no raw inventory quantity write is ever planned
//   • the diff/plan is pure; the reader is server-only + read-only and batches its
//     reads (no per-variant query); the client component holds no DB access
// node --conditions=react-server --experimental-strip-types --test lib/export/shopify/int2e-shopify-guard.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

const PURE = "lib/export/shopify/preview.ts";
const SERVER = "lib/export/shopify/preview.server.ts";
const COMPONENT = "components/v2/export/ShopifyPreview.tsx";
const ROUTE = "app/(v2)/v2/export/[destination]/page.tsx";
const ALL = [PURE, SERVER, COMPONENT, ROUTE];

// ── the only Shopify Admin surface used is the canonical READ ─────────────────
test("Shopify access is read-only: the canonical read is used and no mutation method appears", () => {
  const server = read(SERVER);
  assert.ok(/fetchAllShopifyProducts\(\)/.test(server), "uses the canonical paginated read");
  assert.ok(/shopifyConfigured\(\)/.test(server), "gates on configuration (unconfigured ⇒ UNKNOWN)");
  // NONE of the Admin mutation helpers may be imported or called anywhere.
  const MUTATIONS = [
    /createShopifyProduct/, /updateVariantPrice/, /updateShopifyProductContent/,
    /addProductImage/, /setInventoryQuantities/, /pushInventoryStockToShopify/,
    /resolveInventoryItemIdBySku/, /fetchPrimaryLocationId/,
  ];
  for (const f of ALL) {
    const s = read(f);
    for (const re of MUTATIONS) assert.equal(re.test(s), false, `${f} must not touch ${re}`);
    // no raw GraphQL mutation is issued from the adapter
    assert.equal(/shopifyGraphQL\s*[<(]|mutation\s*\(/.test(s), false, `${f} must not issue a Shopify mutation`);
  }
});

// ── no DB / business writes anywhere (read-only) ──────────────────────────────
test("adapter performs no DB writes and no business mutation engine", () => {
  for (const f of [PURE, SERVER, COMPONENT]) {
    const s = read(f);
    for (const re of [/\.update\(/, /\.insert\(/, /\.delete\(/, /\.upsert\(/, /\.rpc\(/]) {
      assert.equal(re.test(s), false, `${f} must not write (${re})`);
    }
    for (const re of [
      /@\/lib\/inventory\/engine/, /@\/lib\/availability\/engine/,
      /transitionProductLifecycle/, /ecl-repair-write/,
    ]) {
      assert.equal(re.test(s), false, `${f} must not match ${re}`);
    }
  }
});

// ── ECL-first GID identity; no legacy per-store id column; no fuzzy/name match ─
test("identity is ECL-first GID and no legacy shopify id column is referenced", () => {
  const server = read(SERVER);
  assert.ok(/external_channel_listings/.test(server), "reads ECL for identity");
  assert.ok(/external_product_id/.test(server) && /external_variant_id/.test(server), "GID = ECL external product/variant id");
  assert.ok(/storefront_key\)\s*!==\s*SHOPIFY_STOREFRONT_KEY/.test(server), "ECL scoped to shopify:malikas");
  for (const f of [PURE, SERVER]) {
    const s = read(f);
    // never read a legacy products column for the Shopify id
    assert.equal(/products\.shopify_id|\bshopify_id\b|shopify_gid_column/.test(s), false, `${f} must not reference a legacy shopify id column`);
    for (const re of [/levenshtein/i, /fuzzy/i, /similarity/i, /\.includes\(.*name/i]) {
      assert.equal(re.test(s), false, `${f} must not name/near match (${re})`);
    }
  }
});

// ── needs_review is a CONFLICT; a contested/claimed GID is never promoted ──────
test("needs_review is a contested identity that never surfaces a usable GID", () => {
  const pure = read(PURE);
  assert.ok(/status === "needs_review"/.test(pure), "detects needs_review");
  assert.ok(/block\("IDENTITY_NEEDS_REVIEW"/.test(pure), "needs_review → block");
  // a mapped GID is only surfaced from an ACTIVE, non-conflicting, live-present mapping
  assert.ok(/shopifyProductGid = ev\.productGid/.test(pure), "GID surfaced only on the proven path");
  // an unmapped product whose SKU already exists on Shopify is a CONFLICT, not NEW
  assert.ok(/liveSkuToGid\.has\(/.test(pure), "detects unlinked-duplicate SKU");
});

// ── no auto-publish rule; no raw inventory quantity write is ever planned ──────
test("no auto-publish and no raw inventory write is planned", () => {
  const pure = read(PURE);
  // status diff is explicitly informational (actionable:false) and drives no op
  assert.ok(/field: "status", changed: statusChanged, actionable: false/.test(pure), "status is informational only");
  // the plan op vocabulary is exactly §12 — no PUBLISH / SET_INVENTORY / SET_QUANTITY op
  assert.equal(/PUBLISH|SET_INVENTORY|SET_QUANTITY|SET_STOCK|UPDATE_INVENTORY/.test(pure), false, "no publish/inventory op type");
});

// ── the diff/plan model is pure (no server-only, no @/ imports, no I/O) ────────
test("the preview model is pure", () => {
  const s = read(PURE);
  assert.equal(/server-only/.test(s), false, "pure module is not server-only");
  assert.equal(/from "@\//.test(s), false, "pure module has no @/ imports");
  assert.equal(/\bfetch\(|createClient|createAdminClient/.test(s), false, "pure module performs no I/O");
});

// ── server reader: server-only, read-only, single batched read (no N+1) ───────
test("server reader is server-only + read-only and batches its internal reads", () => {
  const s = read(SERVER);
  assert.ok(/import "server-only"/.test(s), "server-only");
  assert.ok(/Promise\.all\(/.test(s), "batched reads");
  assert.ok(/\.range\(from, from \+ PAGE - 1\)/.test(s), "paged bounded reads");
  // the only .from() lives in the shared readAll helper (no per-product/-variant query)
  const fromCalls = (s.match(/\.from\(/g) ?? []).length;
  assert.ok(fromCalls <= 1, `expected a single .from() (in readAll), found ${fromCalls}`);
});

// ── client component holds no DB access and no network mutation ───────────────
test("the client component holds no DB/network mutation access", () => {
  const c = read(COMPONENT);
  for (const bad of [/createAdminClient/, /createClient\(/, /@\/lib\/supabase/, /\.from\(/, /fetch\(/]) {
    assert.equal(bad.test(c), false, `component must not contain ${bad}`);
  }
});

// ── the detail route renders the read-only preview and never publishes ────────
test("the Shopify detail route is read-only (no publish, no generation)", () => {
  const s = read(ROUTE);
  assert.ok(/ShopifyPreview/.test(s), "renders the read-only preview surface");
  assert.ok(/loadShopifyPreview\(\)/.test(s), "loads the certified preview");
  assert.equal(/pushProductsToShopify|createShopifyProduct|\.publish\(/.test(s), false, "no publish/create in the route");
});
