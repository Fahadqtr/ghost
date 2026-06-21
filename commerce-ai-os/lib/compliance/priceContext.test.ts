// Tests for price-consistency wiring (channel_products → platform_prices →
// checker). Run: node --experimental-strip-types --test lib/compliance/priceContext.test.ts

import test from "node:test";
import assert from "node:assert/strict";

import { buildPlatformPrices, withPlatformPrices } from "./priceContext.ts";
import { runChecks, DEFAULT_RULES } from "./checker.ts";
import type { Draft } from "./types.ts";

const R = DEFAULT_RULES;
const baseDraft = (over: Partial<Draft>): Draft => ({
  sku: "mk1234",
  title_en: "X",
  title_ar: "س",
  name_en: "X",
  name_ar: "س",
  main_category: "Body Care",
  desc_en: "ok",
  desc_ar: "تمام",
  keywords_en: "a, b, c, d, e",
  keywords_ar: "ا, ب, ت, ث, ج",
  size: "50g",
  price: 89,
  discount_price: null,
  image_url: "https://cdn/x.jpg",
  ...over,
});
const priceCheck = (d: Draft) => runChecks(d, R).checks.find((c) => c.name === "price_consistency")!;

test("buildPlatformPrices: channel_price overrides; null falls back to base", () => {
  const map = buildPlatformPrices(
    [
      { channel: "Shopify", channel_price: null },
      { channel: "Snoonu", channel_price: null },
      { channel: "Talabat", channel_price: 95 },
      { channel: "Rafeeq", channel_price: null },
    ],
    89
  );
  assert.deepEqual(map, { Shopify: 89, Snoonu: 89, Talabat: 95, Rafeeq: 89 });
});

test("consistent channel prices → price_consistency PASS", () => {
  const d = withPlatformPrices(baseDraft({}), [
    { channel: "Shopify", channel_price: null },
    { channel: "Talabat", channel_price: 89 },
    { channel: "Snoonu", channel_price: null },
  ]);
  assert.equal(priceCheck(d).severity, "PASS");
});

test("a channel price mismatch with NO discount → price_consistency BLOCK", () => {
  const d = withPlatformPrices(baseDraft({ discount_price: null }), [
    { channel: "Shopify", channel_price: null },
    { channel: "Talabat", channel_price: 95 },
    { channel: "Rafeeq", channel_price: null },
  ]);
  const c = priceCheck(d);
  assert.equal(c.severity, "BLOCK");
  assert.match(c.evidence ?? "", /Talabat=95/);
  assert.equal(runChecks(d, R).publish_allowed, false);
});

test("same mismatch but discount_price set → price_consistency PASS", () => {
  const d = withPlatformPrices(baseDraft({ discount_price: 79 }), [
    { channel: "Shopify", channel_price: null },
    { channel: "Talabat", channel_price: 95 },
  ]);
  assert.equal(priceCheck(d).severity, "PASS");
});
