// CH.6B — deterministic match tests (SPI + SKU/barcode; storefront isolation).
// node --conditions=react-server --experimental-strip-types --test lib/adapters/snoonu/merchant/image-match.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { classifyImageMatch } from "./image-match.ts";
import { type MerchantListing, type SnoonuStorefrontKey } from "./merchant-contract.ts";

const listing = (o: Partial<MerchantListing> & { storefrontKey: SnoonuStorefrontKey; spi: string }): MerchantListing => ({
  sku: null, barcode: null, title: null, imageUrl: "https://cdn.snoonu.com/x.jpg", ...o,
});
const product = { id: "p1", sku: "MK-1", barcode: "29001" };

test("MATCHED requires SPI + at least one exact SKU/barcode verify", () => {
  const r = classifyImageMatch({
    storefrontKey: "snoonu:malikas", product, spi: "SPI-A", sessionState: "authenticated",
    listing: listing({ storefrontKey: "snoonu:malikas", spi: "SPI-A", sku: "MK-1", barcode: "29001" }),
  });
  assert.equal(r.status, "MATCHED");
  assert.equal(r.provenance.confidence, "high");
  assert.equal(r.merchantImageUrl, "https://cdn.snoonu.com/x.jpg");
});

test("SPI matches but SKU/barcode disagree → NEEDS_REVIEW (never auto-import)", () => {
  const r = classifyImageMatch({
    storefrontKey: "snoonu:malikas", product, spi: "SPI-A", sessionState: "authenticated",
    listing: listing({ storefrontKey: "snoonu:malikas", spi: "SPI-A", sku: "OTHER", barcode: "99999" }),
  });
  assert.equal(r.status, "NEEDS_REVIEW");
});

test("session not authenticated → SESSION_REQUIRED", () => {
  const r = classifyImageMatch({ storefrontKey: "snoonu:malikas", product, spi: "SPI-A", sessionState: "session_required", listing: null });
  assert.equal(r.status, "SESSION_REQUIRED");
});

test("no ECL SPI for the storefront → NOT_FOUND (name-only is manual review)", () => {
  const r = classifyImageMatch({ storefrontKey: "snoonu:pure_seoul", product, spi: null, sessionState: "authenticated", listing: null });
  assert.equal(r.status, "NOT_FOUND");
});

test("MATCHED listing without a source image → NEEDS_REVIEW", () => {
  const r = classifyImageMatch({
    storefrontKey: "snoonu:malikas", product, spi: "SPI-A", sessionState: "authenticated",
    listing: listing({ storefrontKey: "snoonu:malikas", spi: "SPI-A", sku: "MK-1", imageUrl: null }),
  });
  assert.equal(r.status, "NEEDS_REVIEW");
  assert.equal(r.merchantImageUrl, null);
});

test("storefront isolation: Malikas SPI resolves independently from Pure Seoul", () => {
  const mal = classifyImageMatch({
    storefrontKey: "snoonu:malikas", product, spi: "SPI-A", sessionState: "authenticated",
    listing: listing({ storefrontKey: "snoonu:malikas", spi: "SPI-A", sku: "MK-1" }),
  });
  const ps = classifyImageMatch({
    storefrontKey: "snoonu:pure_seoul", product, spi: "SPI-B", sessionState: "authenticated",
    listing: listing({ storefrontKey: "snoonu:pure_seoul", spi: "SPI-B", sku: "MK-1" }),
  });
  assert.equal(mal.status, "MATCHED");
  assert.equal(ps.status, "MATCHED");
  assert.equal(mal.provenance.spi, "SPI-A");
  assert.equal(ps.provenance.spi, "SPI-B");
});

test("a Malikas SPI presented in the Pure Seoul lookup does not verify (mismatched spi)", () => {
  const r = classifyImageMatch({
    storefrontKey: "snoonu:pure_seoul", product, spi: "SPI-B", sessionState: "authenticated",
    listing: listing({ storefrontKey: "snoonu:pure_seoul", spi: "SPI-A", sku: "MK-1" }), // wrong SPI returned
  });
  assert.equal(r.status, "NEEDS_REVIEW");
});
