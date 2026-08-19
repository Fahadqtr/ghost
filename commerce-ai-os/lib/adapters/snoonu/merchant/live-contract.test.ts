// MEDIA.1A-P2 — verified-contract module unit tests (pure).
// node --conditions=react-server --experimental-strip-types --test lib/adapters/snoonu/merchant/live-contract.test.ts

import test from "node:test";
import assert from "node:assert/strict";

import {
  SNOONU_PORTAL_ORIGIN,
  SNOONU_PRODUCTS_SEARCH_PATH,
  SEARCH_TERM_TYPE_NAME,
  SNOONU_DISCOVERY_PAGE_SIZE,
  buildNameSearchBody,
  parseSnoonuSessionConfig,
  parseSnoonuProductsResponse,
  filterExactName,
} from "./live-contract.ts";

test("constants match the VERIFIED capture exactly", () => {
  assert.equal(SNOONU_PORTAL_ORIGIN, "https://api-portal.snoonu.com");
  assert.equal(SNOONU_PRODUCTS_SEARCH_PATH, "/api/marketplace/CatalogManagement/Products");
  assert.equal(SEARCH_TERM_TYPE_NAME, 2);
  assert.ok(SNOONU_DISCOVERY_PAGE_SIZE > 0 && SNOONU_DISCOVERY_PAGE_SIZE <= 50, "page size is bounded");
});

test("buildNameSearchBody emits exactly the verified request fields (name mode only)", () => {
  const body = buildNameSearchBody("bu-1", "vitamin serum");
  assert.deepEqual(body, {
    businessUnitId: "bu-1",
    searchTerm: "vitamin serum",
    searchTermType: SEARCH_TERM_TYPE_NAME,
    productSkip: 0,
    productTake: SNOONU_DISCOVERY_PAGE_SIZE,
  });
});

test("parseSnoonuSessionConfig accepts only the documented shape", () => {
  const ok = parseSnoonuSessionConfig(JSON.stringify({ businessUnitId: "bu-9", headers: { cookie: "x" } }));
  assert.deepEqual(ok, { businessUnitId: "bu-9", headers: { cookie: "x" } });
  // numeric businessUnitId is coerced to string
  const num = parseSnoonuSessionConfig(JSON.stringify({ businessUnitId: 42, headers: { authorization: "y" } }));
  assert.equal(num?.businessUnitId, "42");
  // rejects everything off-shape (never throws)
  assert.equal(parseSnoonuSessionConfig(""), null);
  assert.equal(parseSnoonuSessionConfig("not json"), null);
  assert.equal(parseSnoonuSessionConfig(JSON.stringify({ headers: { a: "b" } })), null); // no businessUnitId
  assert.equal(parseSnoonuSessionConfig(JSON.stringify({ businessUnitId: "x" })), null); // no headers
  assert.equal(parseSnoonuSessionConfig(JSON.stringify({ businessUnitId: "x", headers: {} })), null); // empty headers
  assert.equal(parseSnoonuSessionConfig(JSON.stringify(["a"])), null);
  assert.equal(parseSnoonuSessionConfig(42 as unknown as string), null);
});

/** A response fixture in the VERIFIED envelope shape. */
const RESPONSE = {
  status: 200,
  data: {
    products: [
      {
        id: "spi-100",
        businessUnitId: "bu-1",
        barcode: "8801234567890",
        sku: "mk2001",
        price: 99,
        locales: [
          { localeType: 1, name: "", description: "" },
          { localeType: 2, name: "COSRX Snail Mucin 96%", description: "d" },
        ],
        images: [
          { imageUri: "", imageKind: 1, localeType: 1 },
          { imageUri: "https://images.snoonu.com/product/2026-5/abc_x.jpeg", imageKind: 1, localeType: 2 },
        ],
        branchConfigurations: [],
      },
      { id: 555, sku: null, barcode: null, locales: [], images: [] }, // numeric id, sparse row
      { sku: "no-id-row" }, //                                          unaddressable → skipped
      "junk",
    ],
  },
};

test("parseSnoonuProductsResponse maps the verified fields (id→spi, sku, barcode, locale name, imageUri)", () => {
  const c = parseSnoonuProductsResponse(RESPONSE, "snoonu:malikas");
  assert.equal(c.length, 2, "unaddressable/junk rows are skipped");
  assert.deepEqual(c[0], {
    storefrontKey: "snoonu:malikas",
    spi: "spi-100",
    name: "COSRX Snail Mucin 96%", //  first NON-EMPTY locale name
    sku: "mk2001",
    barcode: "8801234567890",
    imageUrl: "https://images.snoonu.com/product/2026-5/abc_x.jpeg", // first non-empty imageUri
    imageWidth: null, //               dimensions are not in the verified response
    imageHeight: null,
  });
  assert.equal(c[1].spi, "555", "numeric portal id is coerced to string");
  assert.equal(c[1].name, null);
  assert.equal(c[1].imageUrl, null);
});

test("parseSnoonuProductsResponse is defensive — off-shape input yields [] (never throws)", () => {
  for (const bad of [null, undefined, 7, "x", [], {}, { data: {} }, { data: { products: "x" } }]) {
    assert.deepEqual(parseSnoonuProductsResponse(bad, "snoonu:pure_seoul"), []);
  }
});

test("parseSnoonuProductsResponse keeps the requested storefront on every candidate (isolation)", () => {
  const c = parseSnoonuProductsResponse(RESPONSE, "snoonu:pure_seoul");
  assert.ok(c.every((x) => x.storefrontKey === "snoonu:pure_seoul"));
});

test("filterExactName: trimmed case-insensitive equality; blank target matches nothing", () => {
  const c = parseSnoonuProductsResponse(RESPONSE, "snoonu:malikas");
  assert.equal(filterExactName(c, "  cosrx snail mucin 96%  ").length, 1);
  assert.equal(filterExactName(c, "COSRX Snail").length, 0, "partial is not exact");
  assert.equal(filterExactName(c, "   ").length, 0);
});
