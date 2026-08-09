// Phase UI.9.5 — safety scans for the Shopify snapshot adapter (source scans,
// same pattern as the other V2 guard suites). Guards: pure adapter, server-only
// READ-from-Shopify / WRITE-only-to-snapshots capture + reader, reuse of the
// EXISTING Shopify read model (no new client/credentials/API reader/catalog
// fetcher/webhook/cron), owner-only action, no secret leakage, and page wiring.
// Run: node --experimental-strip-types --test lib/platforms/shopify/shopify-snapshot-guard.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const PURE = readFileSync(new URL("./capture-compute.ts", import.meta.url), "utf8");
const CAPTURE = readFileSync(new URL("./snapshot-capture.ts", import.meta.url), "utf8");
const READER = readFileSync(new URL("./snapshot-presence.ts", import.meta.url), "utf8");
const ACTION = readFileSync(new URL("../../../app/(v2)/v2/operations/shopify-snapshot-actions.ts", import.meta.url), "utf8");
const PAGE = readFileSync(new URL("../../../app/(v2)/v2/operations/page.tsx", import.meta.url), "utf8");

const NO_WRITE = [".update(", ".delete(", ".rpc(", "createAdminClient", "service_role", "SERVICE_ROLE"];
// Shopify Admin WRITE surface must never appear in the snapshot path.
const NO_SHOPIFY_WRITE = ["productUpdate", "productCreate", "productVariantUpdate", "inventorySet", "graphql_mutation"];
const SECRET_TOKENS = ["shpat_", "myshopify.com", "SHOPIFY_ADMIN", "access_token", "console.log"];

test("adapter is PURE — no server-only, no I/O, no Shopify client", () => {
  assert.equal(PURE.includes('import "server-only"'), false);
  for (const bad of ["fetch(", "createClient", "process.env", "shopify/admin", "Date.now(", "new Date("]) {
    assert.equal(PURE.includes(bad), false, `pure adapter must not contain ${bad}`);
  }
});

test("capture is server-only and WRITES only through the snapshot store", () => {
  assert.ok(CAPTURE.includes('import "server-only"'));
  for (const bad of NO_WRITE) assert.equal(CAPTURE.includes(bad), false, `capture must not contain ${bad}`);
  for (const bad of NO_SHOPIFY_WRITE) assert.equal(CAPTURE.includes(bad), false, `capture must not write to Shopify (${bad})`);
});

test("capture REUSES the existing Shopify read model — no new client/fetcher", () => {
  // It consumes loadShopifyCatalog (UI.3), never a bespoke Shopify client.
  assert.ok(CAPTURE.includes("shopify-catalog-read"), "capture must reuse loadShopifyCatalog");
  for (const bad of ["fetchAllShopifyProducts", "new Shopify(", "createShopifyClient", "graphql_query", "/admin/api/"]) {
    assert.equal(CAPTURE.includes(bad), false, `capture must not define/duplicate a Shopify reader (${bad})`);
  }
});

test("no scheduler / background job is added in this phase (no cron/webhook)", () => {
  // Structural check: no timers or scheduling primitives in the snapshot path.
  for (const src of [CAPTURE, READER, ACTION, PURE]) {
    assert.equal(/setInterval\(|setTimeout\(|node-cron|CronJob/.test(src), false);
  }
});

test("reader is server-only and READ-only", () => {
  assert.ok(READER.includes('import "server-only"'));
  for (const bad of [...NO_WRITE, ".insert("]) assert.equal(READER.includes(bad), false, `reader must not contain ${bad}`);
});

test("no secret / token leakage anywhere in the snapshot path", () => {
  for (const src of [PURE, CAPTURE, READER, ACTION]) {
    for (const bad of SECRET_TOKENS) assert.equal(src.includes(bad), false, `must not contain ${bad}`);
  }
});

test("capture never records Shopify price or stock availability", () => {
  // Honest mapping: the read model exposes neither, so both are nulled in the pure layer.
  assert.ok(PURE.includes("price: null"));
  assert.ok(PURE.includes("availability: null"));
});

test("action is OWNER-only and never writes to Shopify", () => {
  assert.ok(ACTION.includes('"use server"'));
  assert.ok(ACTION.includes("requireOwner"));
  for (const bad of NO_SHOPIFY_WRITE) assert.equal(ACTION.includes(bad), false);
});

test("no new platform_snapshots table / migration is introduced", () => {
  for (const src of [PURE, CAPTURE, READER]) {
    assert.equal(/create\s+table/i.test(src), false);
  }
});

test("operations page wires the snapshot reader + best-effort auto-capture", () => {
  assert.ok(PAGE.includes("loadShopifySnapshotView"), "page reads snapshots");
  assert.ok(PAGE.includes("captureShopifySnapshots"), "page fires best-effort capture");
  // fire-and-forget: the capture is never awaited into the render critical path.
  assert.ok(PAGE.includes("void captureShopifySnapshots"), "auto-capture must be fire-and-forget");
  // gated on staleness so writes/reads stay bounded (no capture on every view).
  assert.ok(PAGE.includes("shopifyStale") && PAGE.includes("shopifySnapshotAvailable"), "auto-capture gated on freshness");
});
