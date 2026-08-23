// SHOPIFY.EXPORT.ROUTE.FIX — Export Center detail routing regression tests.
//
// Production defect: the card href is percent-encoded ("shopify%3Amalikas") and
// Next.js delivers the [destination] param still encoded, but the page looked
// the RAW param up in the registry → "لا توجد وجهة تصدير بهذا المعرّف" for every
// colon destination reached from a card. These tests pin the decoding-aware
// resolver, the href↔resolver round-trip for EVERY destination, and the page's
// dispatch to the existing Shopify implementation.
//
// Run: node --conditions=react-server --experimental-strip-types --test lib/export/destination-route.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  EXPORT_DESTINATIONS,
  exportDestinationByKey,
  resolveExportDestinationParam,
} from "./destinations.ts";
import { exportDetailHref } from "./export-center.ts";

test("shopify:malikas exists in the canonical destination registry with its capabilities", () => {
  const dest = exportDestinationByKey("shopify:malikas");
  assert.ok(dest, "registry entry exists");
  assert.equal(dest!.channel, "shopify");
  assert.ok(dest!.capabilities.includes("preview"));
  assert.ok(dest!.capabilities.includes("publish"));
});

test("resolver accepts BOTH the plain and the percent-encoded param", () => {
  assert.equal(resolveExportDestinationParam("shopify:malikas")?.key, "shopify:malikas");
  assert.equal(resolveExportDestinationParam("shopify%3Amalikas")?.key, "shopify:malikas");
});

test("card href → route param → resolver round-trips for EVERY destination", () => {
  for (const d of EXPORT_DESTINATIONS) {
    const href = exportDetailHref(d.key);
    assert.ok(href.startsWith("/v2/export/"), href);
    const param = href.slice("/v2/export/".length); // exactly what Next hands the page
    const resolved = resolveExportDestinationParam(param);
    assert.equal(resolved?.key, d.key, `${d.key} must survive the href round-trip`);
  }
});

test("unknown and malformed params resolve to null — never throw, never a wrong destination", () => {
  assert.equal(resolveExportDestinationParam("nope:unknown"), null);
  assert.equal(resolveExportDestinationParam(""), null);
  assert.equal(resolveExportDestinationParam("%E0%A4%A"), null, "malformed percent-sequence is safe");
});

test("the detail page resolves through the decoding-aware resolver and keeps the Shopify dispatch", () => {
  const src = readFileSync(
    path.join(process.cwd(), "app/(v2)/v2/export/[destination]/page.tsx"),
    "utf8",
  );
  assert.ok(src.includes("resolveExportDestinationParam(destination)"), "page uses the decoding resolver");
  assert.ok(src.includes('dest.key === "shopify:malikas"'), "Shopify dispatch branch intact");
  assert.ok(src.includes("ShopifyDetail"), "dispatches to the EXISTING Shopify implementation");
  // The other destinations keep their existing dispatches untouched.
  for (const pin of ['"talabat:malikas"', '"snoonu:malikas"', '"snoonu:pure_seoul"', '"rafeeq:malikas"']) {
    assert.ok(src.includes(pin), `dispatch for ${pin} unchanged`);
  }
});
