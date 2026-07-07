// Tests for the Shopify OAuth helpers.
// Run: node --experimental-strip-types --test lib/shopify/oauth-compute.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";

import { buildAuthorizeUrl, verifyShopifyHmac, isExpectedShop, SHOPIFY_SCOPES } from "./oauth-compute.ts";

test("authorize URL carries client, scopes, redirect and state", () => {
  const u = new URL(buildAuthorizeUrl({
    shop: "516wu8-0g.myshopify.com", clientId: "cid", redirectUri: "https://app.example.com/cb", state: "n0nce",
  }));
  assert.equal(u.hostname, "516wu8-0g.myshopify.com");
  assert.equal(u.pathname, "/admin/oauth/authorize");
  assert.equal(u.searchParams.get("client_id"), "cid");
  assert.equal(u.searchParams.get("scope"), SHOPIFY_SCOPES);
  assert.equal(u.searchParams.get("redirect_uri"), "https://app.example.com/cb");
  assert.equal(u.searchParams.get("state"), "n0nce");
});

test("verifyShopifyHmac accepts a correctly signed callback and rejects tampering", () => {
  const secret = "shhh";
  const params: Record<string, string> = { code: "abc", shop: "x.myshopify.com", state: "s", timestamp: "123" };
  const message = Object.keys(params).sort().map((k) => `${k}=${params[k]}`).join("&");
  const hmac = crypto.createHmac("sha256", secret).update(message).digest("hex");

  assert.equal(verifyShopifyHmac({ ...params, hmac }, secret), true);
  assert.equal(verifyShopifyHmac({ ...params, code: "evil", hmac }, secret), false);
  assert.equal(verifyShopifyHmac({ ...params, hmac: "00" }, secret), false);
  assert.equal(verifyShopifyHmac({ ...params }, secret), false); // no hmac at all
});

test("isExpectedShop pins the one configured store", () => {
  assert.equal(isExpectedShop("516wu8-0g.myshopify.com", "516wu8-0g.myshopify.com"), true);
  assert.equal(isExpectedShop("516WU8-0G.MYSHOPIFY.COM", "516wu8-0g.myshopify.com"), true);
  assert.equal(isExpectedShop("evil.myshopify.com", "516wu8-0g.myshopify.com"), false);
  assert.equal(isExpectedShop("516wu8-0g.myshopify.com.evil.com", "516wu8-0g.myshopify.com"), false);
  assert.equal(isExpectedShop("", "516wu8-0g.myshopify.com"), false);
});
