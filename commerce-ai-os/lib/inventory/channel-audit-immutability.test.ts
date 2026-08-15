// INV.5 — channel sale audit immutability rule.
//
// A sale written by the canonical sale primitive (Shopify / Talabat) carries
// details.immutable=true AND details.source in ('talabat','shopify'). The manual
// movement/approval endpoints consult isChannelSaleAudit() and refuse to edit,
// delete, reverse, or approve such a row (source wiring pinned by
// inv-5-sales-guard.test.ts). Manual staff/admin/malak movements stay editable.
//
// Run: node --conditions=react-server --experimental-strip-types --test lib/inventory/channel-audit-immutability.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { isChannelSaleAudit, CHANNEL_SALE_LOCKED_MSG } from "./channel-immutability.ts";

test("Talabat + Shopify sale rows are locked (immutable / channel source)", () => {
  assert.equal(isChannelSaleAudit({ details: { source: "talabat", immutable: true, reason: "sale" } }), true);
  assert.equal(isChannelSaleAudit({ details: { source: "shopify", immutable: true, reason: "sale" } }), true);
  // either signal alone is sufficient (defense in depth)
  assert.equal(isChannelSaleAudit({ details: { immutable: true } }), true);
  assert.equal(isChannelSaleAudit({ details: { source: "shopify" } }), true);
});

test("manual staff / admin / malak movements remain editable (not locked)", () => {
  assert.equal(isChannelSaleAudit({ details: { by: "staff:sara", reason: "count" } }), false);
  assert.equal(isChannelSaleAudit({ details: { source: "staff" } }), false);
  assert.equal(isChannelSaleAudit({ details: { by: "malak", reason: "adjust" } }), false);
  assert.equal(isChannelSaleAudit({ details: {} }), false);
  assert.equal(isChannelSaleAudit({}), false);
  assert.equal(isChannelSaleAudit(null), false);
  assert.equal(isChannelSaleAudit(undefined), false);
});

test("the fixed refusal message carries no raw/PII detail", () => {
  assert.ok(CHANNEL_SALE_LOCKED_MSG.length > 0);
  assert.equal(/uuid|sql|select|null|undefined/i.test(CHANNEL_SALE_LOCKED_MSG), false);
});
