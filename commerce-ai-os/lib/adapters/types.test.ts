// CH.4 — contract shape tests.
// node --conditions=react-server --experimental-strip-types --test lib/adapters/types.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { ADAPTER_CAPABILITIES, CAPABILITY_METHODS, type AdapterCapability } from "./types.ts";

test("the nine required capabilities are declared", () => {
  const required: AdapterCapability[] = [
    "identity", "listings", "catalogSync", "imageSync", "availabilitySync",
    "priceSync", "publish", "unpublish", "orderIngestion",
  ];
  assert.equal(ADAPTER_CAPABILITIES.length, 9);
  for (const cap of required) assert.ok(ADAPTER_CAPABILITIES.includes(cap), `${cap} declared`);
});

test("every capability maps to an adapter method name", () => {
  for (const cap of ADAPTER_CAPABILITIES) {
    assert.equal(typeof CAPABILITY_METHODS[cap], "string", `${cap} has a method`);
  }
  // spot-check the non-obvious mappings
  assert.equal(CAPABILITY_METHODS.listings, "listListings");
  assert.equal(CAPABILITY_METHODS.catalogSync, "syncCatalog");
  assert.equal(CAPABILITY_METHODS.orderIngestion, "ingestOrders");
});
