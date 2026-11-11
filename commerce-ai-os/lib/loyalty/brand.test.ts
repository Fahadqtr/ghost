import test from "node:test";
import assert from "node:assert/strict";

import { BRAND_INFO, brandVoucherCode, parseBrand, withBrand } from "./brand.ts";

test("parseBrand accepts only known brands and defaults to malikas", () => {
  assert.equal(parseBrand("pureseoul"), "pureseoul");
  assert.equal(parseBrand("malikas"), "malikas");
  assert.equal(parseBrand(undefined), "malikas");
  assert.equal(parseBrand(""), "malikas");
  assert.equal(parseBrand("PURESEOUL"), "malikas");
  assert.equal(parseBrand(["pureseoul"]), "malikas");
  assert.equal(parseBrand("pureseoul' or 1=1"), "malikas");
});

test("voucher codes keep the existing MU format and get a PS prefix for Pure Seoul", () => {
  const id = "ab12cd34-0000-0000-0000-000000000000";
  assert.equal(brandVoucherCode("malikas", id, 0), "MU-AB12CD-1");
  assert.equal(brandVoucherCode("pureseoul", id, 2), "PS-AB12CD-3");
});

test("each brand has its own public page and device storage key", () => {
  assert.equal(BRAND_INFO.malikas.publicPath, "/rewards");
  assert.equal(BRAND_INFO.pureseoul.publicPath, "/rewards/pureseoul");
  assert.notEqual(BRAND_INFO.malikas.storageKey, BRAND_INFO.pureseoul.storageKey);
});

test("withBrand only adds the query for non-default brands", () => {
  assert.equal(withBrand("/v2/loyalty", "malikas"), "/v2/loyalty");
  assert.equal(withBrand("/v2/loyalty", "pureseoul"), "/v2/loyalty?brand=pureseoul");
  assert.equal(withBrand("/v2/loyalty/cards?n=4", "pureseoul"), "/v2/loyalty/cards?n=4&brand=pureseoul");
});
